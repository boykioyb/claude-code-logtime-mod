// Business rules for logged hours: what a day may hold, how hours step and round, how a pull merges.

export type LineStatus = 'draft' | 'posted' | 'locked'

export type Task = { id: string; label: string }

export type Line = {
  id: string
  projectId: string
  projectLabel: string
  note: string
  hours: number
  status: LineStatus
  worklogId?: string
  tasks: Task[]
  // GitHub issues the PMS has no task for yet; worklog_create syncs them in.
  issueUrls?: string[]
}

// A PMS identity to log under: the MCP server signed in as it, and the kind of work it logs ("" = any).
export type Account = { id: string; label: string; server: string; role: string }

export const MAIN_ACCOUNT = 'me'

// aiSkipLabels: PMS projects (by label) the AI never logs to, such as the team's internal one.
// repos: the GitHub repository (owner/name) whose issues a project's tasks come from, by project label.
export type Settings = {
  dailyHours: number
  step: number
  aiSkipLabels: string[]
  repos: Record<string, string>
  accounts: Account[]
}

export const DEFAULT_SETTINGS: Settings = {
  dailyHours: 8,
  step: 0.5,
  aiSkipLabels: [],
  repos: {},
  accounts: [{ id: MAIN_ACCOUNT, label: 'Tôi', server: 'pms', role: '' }],
}

export const isServerName = (value: string) => /^[\w-]+$/.test(value.trim())

// The main account always exists and comes first; the others keep their order, malformed ones dropped.
const normalizeAccounts = (raw: unknown): Account[] => {
  const list = Array.isArray(raw) ? raw : []
  const valid = list.flatMap(item => {
    const a = item as Partial<Account>
    if (typeof a.id !== 'string' || typeof a.server !== 'string' || !isServerName(a.server)) return []
    return [{ id: a.id, label: String(a.label ?? a.id), server: a.server, role: String(a.role ?? '') }]
  })
  const main = valid.find(a => a.id === MAIN_ACCOUNT) ?? DEFAULT_SETTINGS.accounts[0]!
  return [main, ...valid.filter(a => a.id !== MAIN_ACCOUNT)]
}

// The day's hours belong to one person: what other accounts already hold that day is not this account's to fill.
export const accountBudget = (dailyHours: number, otherAccountsHours: number) =>
  Math.max(0, toQuarter(dailyHours - otherAccountsHours))
export const STEPS = [0.25, 0.5, 1] as const
export const MIN_HOURS = 0.25
export const MAX_HOURS = 24

// Quarter hours are the finest unit the PMS accepts.
export const toQuarter = (hours: number) => Math.round(hours * 4) / 4

export const normalizeSettings = (raw: Partial<Settings> | undefined): Settings => {
  const step = STEPS.find(s => s === raw?.step) ?? DEFAULT_SETTINGS.step
  const daily = toQuarter(Number(raw?.dailyHours ?? DEFAULT_SETTINGS.dailyHours))
  const skip = Array.isArray(raw?.aiSkipLabels)
    ? raw.aiSkipLabels.filter(l => typeof l === 'string')
    : DEFAULT_SETTINGS.aiSkipLabels
  const repos = raw?.repos && typeof raw.repos === 'object' ? { ...raw.repos } : { ...DEFAULT_SETTINGS.repos }
  return {
    step,
    dailyHours: Math.min(MAX_HOURS, Math.max(1, Number.isFinite(daily) ? daily : 8)),
    aiSkipLabels: skip,
    repos,
    accounts: normalizeAccounts(raw?.accounts),
  }
}

export const totalHours = (lines: readonly Line[]) => lines.reduce((sum, line) => sum + line.hours, 0)

export type DayBalance = { total: number; budget: number; kind: 'short' | 'full' | 'over'; diff: number }

export const balance = (lines: readonly Line[], budget: number): DayBalance => {
  const total = totalHours(lines)
  const diff = Math.abs(budget - total)
  return { total, budget, diff, kind: total < budget ? 'short' : total > budget ? 'over' : 'full' }
}

const sameNote = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export type AddResult =
  | { ok: true; lines: Line[]; isCut: boolean; hours: number }
  | { ok: false; reason: 'duplicate' | 'full' | 'invalid' }

// One gate for every new line, from the form, the model's tool or "copy yesterday":
// the same project + note twice in a day is a duplicate, a full day takes nothing,
// and a line longer than what is left of the day is cut down to fit.
export const addLine = (lines: readonly Line[], line: Line, budget: number): AddResult => {
  if (!line.projectId || !line.note.trim() || !(line.hours >= MIN_HOURS)) return { ok: false, reason: 'invalid' }
  if (lines.some(l => l.projectId === line.projectId && sameNote(l.note, line.note))) {
    return { ok: false, reason: 'duplicate' }
  }
  const left = toQuarter(budget - totalHours(lines))
  if (left < MIN_HOURS) return { ok: false, reason: 'full' }
  const hours = Math.min(toQuarter(Math.min(line.hours, MAX_HOURS)), left)
  return { ok: true, lines: [...lines, { ...line, hours }], isCut: hours < line.hours, hours }
}

export const canEdit = (line: Line) => line.status === 'draft'

// ± moves a draft by the rounding step, never below a quarter hour nor past the day's budget.
export const stepHours = (lines: readonly Line[], id: string, direction: 1 | -1, step: number, budget: number) =>
  lines.map(line => {
    if (line.id !== id || !canEdit(line)) return line
    const others = totalHours(lines.filter(l => l.id !== id))
    const cap = Math.max(MIN_HOURS, toQuarter(budget - others))
    const next = toQuarter(line.hours + direction * step)
    return { ...line, hours: Math.min(cap, Math.max(MIN_HOURS, next)) }
  })

export const drafts = (lines: readonly Line[]) => lines.filter(line => line.status === 'draft')

export type PmsRow = {
  id: string
  projectId: string
  projectName: string
  date: string
  hours: number
  note: string
  isLocked: boolean
  tasks: Task[]
}

// A pull keeps every local draft and replaces what was posted with what the PMS now holds.
export const mergePulled = (local: readonly Line[], rows: readonly PmsRow[]): Line[] => [
  ...local.filter(line => line.status === 'draft'),
  ...rows.map(row => ({
    id: `pms-${row.id}`,
    projectId: row.projectId,
    projectLabel: row.projectName,
    note: row.note,
    hours: row.hours,
    status: row.isLocked ? ('locked' as const) : ('posted' as const),
    worklogId: row.id,
    tasks: row.tasks,
  })),
]

// --- dates: local calendar days as YYYY-MM-DD, weeks start on Monday ---

const pad = (n: number) => String(n).padStart(2, '0')
export const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const fromIso = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}
export const addDays = (iso: string, days: number) => {
  const d = fromIso(iso)
  d.setDate(d.getDate() + days)
  return toIso(d)
}
export const weekStart = (iso: string) => addDays(iso, -((fromIso(iso).getDay() + 6) % 7))
export const weekDays = (iso: string) => Array.from({ length: 7 }, (_, i) => addDays(weekStart(iso), i))
export const monthOf = (iso: string) => iso.slice(0, 7)

export type WeekRow = { projectId: string; projectLabel: string; perDay: number[]; total: number }

export const weekTable = (days: readonly string[], linesByDay: Readonly<Record<string, readonly Line[]>>) => {
  const rows = new Map<string, WeekRow>()
  days.forEach((day, i) => {
    for (const line of linesByDay[day] ?? []) {
      const row = rows.get(line.projectId) ?? {
        projectId: line.projectId,
        projectLabel: line.projectLabel,
        perDay: days.map(() => 0),
        total: 0,
      }
      row.perDay[i] = (row.perDay[i] ?? 0) + line.hours
      row.total += line.hours
      rows.set(line.projectId, row)
    }
  })
  const dayTotals = days.map(day => totalHours(linesByDay[day] ?? []))
  const posted = days.reduce(
    (sum, day) => sum + totalHours((linesByDay[day] ?? []).filter(l => l.status !== 'draft')),
    0,
  )
  return { rows: [...rows.values()].sort((a, b) => b.total - a.total), dayTotals, posted }
}

export const monthDays = (iso: string) => {
  const d = fromIso(`${monthOf(iso)}-01`)
  const month = d.getMonth()
  const days: string[] = []
  while (d.getMonth() === month) {
    days.push(toIso(d))
    d.setDate(d.getDate() + 1)
  }
  return days
}

export const isWeekend = (iso: string) => [0, 6].includes(fromIso(iso).getDay())

export type DayStatusKind = 'future' | 'off' | 'missing' | 'short' | 'full' | 'over'
export type DayStatus = { kind: DayStatusKind; total: number; drafts: number; posted: number }

// What one day of the history list says: an empty past weekday is "missing", an empty weekend is "off".
export const dayStatus = (iso: string, lines: readonly Line[], budget: number, todayIso: string): DayStatus => {
  const total = totalHours(lines)
  const draftCount = drafts(lines).length
  const posted = lines.length - draftCount
  const base = { total, drafts: draftCount, posted }
  if (iso > todayIso && lines.length === 0) return { ...base, kind: 'future' }
  if (lines.length === 0) return { ...base, kind: isWeekend(iso) ? 'off' : 'missing' }
  return { ...base, kind: total < budget ? 'short' : total > budget ? 'over' : 'full' }
}

// The month as calendar rows, Monday first, padded with '' outside the month.
export const calendarWeeks = (days: readonly string[]): string[][] => {
  const first = days[0]
  if (!first) return []
  const lead = (fromIso(first).getDay() + 6) % 7
  const cells = [...Array<string>(lead).fill(''), ...days]
  while (cells.length % 7) cells.push('')
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
}

// The issue/PR numbers a note cites, in order, once each ("#123", "issue #45").
export const issueNumbers = (note: string) => [...new Set([...note.matchAll(/#(\d{1,6})\b/g)].map(m => Number(m[1])))]

export const isRepo = (value: string) => /^[\w.-]+\/[\w.-]+$/.test(value.trim())

export type FillResult = { lines: Line[]; added: number; touched: number }

// Spread what the day is short across its own draft lines, in proportion to their hours, in quarter hours
// (largest remainder first). Real lines only: posted and locked lines stay as sent, and no line is invented.
export const fillToBudget = (lines: readonly Line[], budget: number): FillResult => {
  const missing = toQuarter(budget - totalHours(lines))
  const pool = drafts(lines)
  const base = totalHours(pool)
  if (missing < MIN_HOURS || pool.length === 0 || base <= 0) return { lines: [...lines], added: 0, touched: 0 }
  const quarters = Math.round(missing * 4)
  const shares = pool.map(line => {
    const exact = (quarters * line.hours) / base
    return { id: line.id, whole: Math.floor(exact), rest: exact - Math.floor(exact) }
  })
  let left = quarters - shares.reduce((sum, s) => sum + s.whole, 0)
  for (const share of [...shares].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break
    share.whole += 1
    left -= 1
  }
  const extra = new Map(shares.map(s => [s.id, s.whole / 4]))
  const next = lines.map(line => {
    const add = extra.get(line.id) ?? 0
    return add > 0 ? { ...line, hours: Math.min(MAX_HOURS, line.hours + add) } : line
  })
  return {
    lines: next,
    added: totalHours(next) - totalHours(lines),
    touched: [...extra.values()].filter(v => v > 0).length,
  }
}
