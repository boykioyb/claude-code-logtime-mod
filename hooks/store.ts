import type { EngineInterface } from 'claude-code'

import type { Line, Settings } from './rules'
import { MAIN_ACCOUNT, monthOf, normalizeSettings } from './rules'

// One JSON file per month and account, plus one settings file, under ~/.local/share/log-time.
// The main account keeps the top folder (where its data lived before accounts existed); others get accounts/<id>/.
type MonthFile = { days: Record<string, Line[]> }

let dirCache: string | null = null
let activeAccount = MAIN_ACCOUNT

async function dataDir($: EngineInterface) {
  if (dirCache) return dirCache
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const dir = `${home}/.local/share/log-time`
  await $.process.run(['mkdir', '-p', dir])
  dirCache = dir
  return dir
}

async function accountDir($: EngineInterface, account: string) {
  const base = await dataDir($)
  if (account === MAIN_ACCOUNT) return base
  const dir = `${base}/accounts/${account.replace(/[^\w-]/g, '_')}`
  await $.process.run(['mkdir', '-p', dir])
  return dir
}

async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  const isThere = await $.fs.exists(path)
  if (!isThere) return fallback
  return JSON.parse(await $.fs.read(path)) as T
}

// Write a sibling then rename it over the target, so a crash never leaves half a file.
async function writeJson($: EngineInterface, path: string, value: unknown) {
  const tmp = `${path}.tmp`
  await $.fs.write(tmp, `${JSON.stringify(value, null, 2)}\n`)
  const moved = await $.process.run(['mv', '-f', tmp, path])
  if (moved.exitCode !== 0) throw new Error(`could not save ${path}: ${moved.stderr.trim()}`)
}

const months = new Map<string, MonthFile>()

async function loadMonth($: EngineInterface, account: string, month: string) {
  const key = `${account}|${month}`
  const cached = months.get(key)
  if (cached) return cached
  const file = await readJson<MonthFile>($, `${await accountDir($, account)}/${month}.json`, { days: {} })
  months.set(key, file)
  return file
}

// Which account readDay / writeDay act on. The pane switches it only while no push, pull or compose runs.
export function useAccount(account: string) {
  activeAccount = account
}

export function currentAccount() {
  return activeAccount
}

export async function readDayOf($: EngineInterface, account: string, date: string): Promise<Line[]> {
  return (await loadMonth($, account, monthOf(date))).days[date] ?? []
}

export async function readDay($: EngineInterface, date: string): Promise<Line[]> {
  return readDayOf($, activeAccount, date)
}

export async function readDays($: EngineInterface, dates: readonly string[]) {
  const out: Record<string, Line[]> = {}
  for (const date of dates) out[date] = await readDay($, date)
  return out
}

export async function writeDay($: EngineInterface, date: string, lines: Line[]) {
  const account = activeAccount
  const month = monthOf(date)
  const file = await loadMonth($, account, month)
  const next: MonthFile = { days: { ...file.days, [date]: lines } }
  if (lines.length === 0) delete next.days[date]
  await writeJson($, `${await accountDir($, account)}/${month}.json`, next)
  months.set(`${account}|${month}`, next)
}

export async function readSettings($: EngineInterface): Promise<Settings> {
  return normalizeSettings(await readJson<Partial<Settings>>($, `${await dataDir($)}/settings.json`, {}))
}

export async function writeSettings($: EngineInterface, settings: Settings) {
  return writeJson($, `${await dataDir($)}/settings.json`, settings)
}
