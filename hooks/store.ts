import type { EngineInterface } from 'claude-code'

import type { Line, Settings } from './rules'
import { MAIN_ACCOUNT, monthOf, normalizeSettings } from './rules'

// One JSON file per month and account, plus one settings file, under ~/.local/share/log-time.
// The main account keeps the top folder (where its data lived before accounts existed); others get accounts/<id>/.
type MonthFile = { days: Record<string, Line[]> }

let dirCache: string | null = null
let activeAccount = MAIN_ACCOUNT

// The home folder: HOME on macOS / Linux, USERPROFILE on Windows. No shell command is run here, so the same
// code works on every platform; $.fs.write creates missing folders itself.
async function dataDir($: EngineInterface) {
  if (dirCache) return dirCache
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '.'
  dirCache = `${home.replace(/\\/g, '/')}/.local/share/log-time`
  return dirCache
}

async function accountDir($: EngineInterface, account: string) {
  const base = await dataDir($)
  if (account === MAIN_ACCOUNT) return base
  return `${base}/accounts/${account.replace(/[^\w-]/g, '_')}`
}

async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  const isThere = await $.fs.exists(path)
  if (!isThere) return fallback
  return JSON.parse(await $.fs.read(path)) as T
}

async function writeJson($: EngineInterface, path: string, value: unknown) {
  await $.fs.write(path, `${JSON.stringify(value, null, 2)}\n`)
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
