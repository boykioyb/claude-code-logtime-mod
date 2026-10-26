import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { LogTimeView } from '../types'
import type { Option } from './pms'
import type { Suggestion } from './ai'
import { composeLines, describeActivity, readActivity, refineNote, useNode } from './ai'
import type { IconName, IconTone } from './icons'
import { icon } from './icons'
import { linkIssues, useGh } from './link'
import { createWorklog, listPmsServers, listProjects, listTasks, listWorklogs, useServer } from './pms'
import type { Account, Line, Settings, Task } from './rules'
import {
  accountBudget,
  addDays,
  addLine,
  balance,
  dayStatus,
  drafts,
  fillToBudget,
  isRepo,
  issueNumbers,
  fromIso,
  MAIN_ACCOUNT,
  mergePulled,
  calendarWeeks,
  monthDays,
  stepHours,
  STEPS,
  toIso,
  totalHours,
  weekDays,
  weekTable,
} from './rules'
import {
  currentAccount,
  readDay,
  readDayOf,
  readDays,
  readSettings,
  useAccount,
  writeDay,
  writeSettings,
} from './store'

const PANE = 'log-time'
const PULL_DAYS = 7

const dateAtom = atom({ plugin: 'log-time', key: 'date' } as const, '')
const viewAtom = atom({ plugin: 'log-time', key: 'view' } as const, 'day' as LogTimeView)
const accountAtom = atom({ plugin: 'log-time', key: 'account' } as const, MAIN_ACCOUNT)

// Drawing state: rebuilt after a reload, which only loses an unsent form.
let settings: Settings | null = null
let projects: Option[] = []
let projectsError = ''
let isLoadingProjects = false
let notice: { text: string; tone: 'ok' | 'warn' | 'error' } | null = null
const form = { projectId: '', note: '', hours: 1, taskQuery: '', taskOptions: [] as Task[], tasks: [] as Task[] }
let isPushConfirming = false
let isBusy = false
let isSettingsOpen = false
let isAddOpen = false
// The half-typed "add a repository" row of the settings.
const repoDraft = { projectLabel: '', repo: '' }
// The half-typed "add an account" row of the settings.
const accountDraft = { label: '', server: '' }
// Which add-form of the settings is open, and which account's role is being edited.
let settingsForm: 'account' | 'repo' | null = null
let roleEditId: string | null = null
let monthLayout: 'list' | 'grid' = 'list'
let removeConfirmId: string | null = null
const pushState = new Map<string, string>()
// Lines whose note is shown whole; the rest show one row, so a long note never makes a tall card.
const expandedIds = new Set<string>()
const LONG_NOTE = 90

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
const say = ($: EngineInterface, text: string, tone: 'ok' | 'warn' | 'error' = 'ok') => {
  notice = { text, tone }
  void redraw($)
}

const today = () => toIso(new Date())
const currentDate = async ($: EngineInterface) => (await read($, dateAtom)) || today()
const getSettings = async ($: EngineInterface) => (settings ??= await readSettings($))

// --- accounts: which PMS identity the pane reads and sends as ---

const activeAccount = async ($: EngineInterface): Promise<Account> => {
  const { accounts } = await getSettings($)
  const id = await read($, accountAtom)
  return accounts.find(a => a.id === id) ?? accounts[0]!
}

// Point the store and the PMS calls at the chosen account; a new server means a new project list.
const syncAccount = async ($: EngineInterface) => {
  const account = await activeAccount($)
  if (currentAccount() === account.id) return account
  useAccount(account.id)
  useServer(account.server)
  projects = []
  projectsError = ''
  form.projectId = ''
  form.tasks = []
  form.taskOptions = []
  ai.suggestions = []
  ai.log = []
  return account
}

// What this account may still log on a day: the person's day, less what their other accounts already hold.
const otherAccountsLines = async ($: EngineInterface, date: string) => {
  const { accounts } = await getSettings($)
  const mine = currentAccount()
  const out: Line[] = []
  for (const a of accounts) if (a.id !== mine) out.push(...(await readDayOf($, a.id, date)))
  return out
}

const dayBudget = async ($: EngineInterface, date: string) =>
  accountBudget((await getSettings($)).dailyHours, totalHours(await otherAccountsLines($, date)))

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const dayLabel = (iso: string) => {
  const d = fromIso(iso)
  return `${WEEKDAYS[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}
const shortDay = (iso: string) => `${WEEKDAYS[fromIso(iso).getDay()]} ${iso.slice(8, 10)}`
const fmtHours = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')}h`
const newId = () => crypto.randomUUID()

// The day's progress as a thin bar; an Svg is drawn as an image, so the colours are fixed, not themed.
const progressBar = (total: number, budget: number, kind: 'short' | 'full' | 'over') => {
  const ratio = budget > 0 ? Math.min(1, total / budget) : 0
  const fill = kind === 'full' ? '#2da44e' : kind === 'short' ? '#d4a72c' : '#cf222e'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="8" viewBox="0 0 600 8"><rect width="600" height="8" rx="4" fill="#8c959f" fill-opacity="0.25"/><rect width="${Math.round(600 * ratio)}" height="8" rx="4" fill="${fill}"/></svg>`
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

// A day's hours as a short bar for the month list: the track is the budget, the fill its status colour.
// A full-width 1px hairline for table rows and section heads; its colour follows light / dark like the icons.
const RULE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1" viewBox="0 0 4000 1" preserveAspectRatio="none">' +
  '<style>rect{fill:#d0d7de}@media (prefers-color-scheme: dark){rect{fill:#30363d}}</style>' +
  '<rect width="4000" height="1"/></svg>'

const dayBar = (total: number, budget: number, kind: string) => {
  const ratio = budget > 0 ? Math.min(1, total / budget) : 0
  const fill = kind === 'full' ? '#2da44e' : kind === 'short' ? '#d4a72c' : kind === 'over' ? '#cf222e' : '#8c959f'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="6" viewBox="0 0 96 6"><rect width="96" height="6" rx="3" fill="#8c959f" fill-opacity="0.2"/><rect width="${Math.round(96 * ratio)}" height="6" rx="3" fill="${fill}"/></svg>`
}

const REASON: Record<'duplicate' | 'full' | 'invalid', string> = {
  duplicate: 'Trùng dự án và ghi chú với một dòng đã có trong ngày.',
  full: 'Ngày đã đủ giờ.',
  invalid: 'Cần chọn dự án, nhập ghi chú và số giờ từ 0,25.',
}

const loadProjects = async ($: EngineInterface) => {
  if (isLoadingProjects) return
  isLoadingProjects = true
  try {
    projects = await listProjects($)
    projectsError = ''
    if (!form.projectId && projects[0]) form.projectId = projects[0].value
  } catch (error) {
    projectsError = String(error).slice(0, 300)
  } finally {
    isLoadingProjects = false
  }
  await redraw($)
}

const projectLabel = (id: string) => projects.find(p => p.value === id)?.label ?? id

// --- actions shared by the pane and the model's tools ---

// The #numbers a note cites become its links; a lookup failure keeps the line and leaves it unlinked.
const withLinks = async <T extends Pick<Line, 'projectId' | 'projectLabel' | 'note' | 'tasks' | 'issueUrls'>>(
  $: EngineInterface,
  line: T,
): Promise<T & { skipped: string[] }> => {
  if (issueNumbers(line.note).length === 0) return { ...line, skipped: [] }
  const { repos } = await getSettings($)
  try {
    const linked = await linkIssues($, {
      projectId: line.projectId,
      note: line.note,
      repo: repos[line.projectLabel],
      known: line.tasks,
    })
    return {
      ...line,
      tasks: linked.tasks,
      issueUrls: [...new Set([...(line.issueUrls ?? []), ...linked.issueUrls])],
      skipped: linked.skipped,
    }
  } catch (error) {
    return { ...line, skipped: [`không tra được issue: ${String(error).slice(0, 120)}`] }
  }
}

const addToDay = async ($: EngineInterface, date: string, draft: Omit<Line, 'id' | 'status'>) => {
  const budget = await dayBudget($, date)
  const { skipped: _skipped, ...linked } = await withLinks($, draft)
  const result = addLine(await readDay($, date), { ...linked, id: newId(), status: 'draft' }, budget)
  if (result.ok) await writeDay($, date, result.lines)
  return result
}

const removeDraft = async ($: EngineInterface, date: string, id: string) => {
  const lines = await readDay($, date)
  const target = lines.find(l => l.id === id)
  if (!target) return 'Không thấy dòng này.'
  if (target.status === 'locked') return 'Dòng đã khoá trên PMS, không xoá được.'
  await writeDay(
    $,
    date,
    lines.filter(l => l.id !== id),
  )
  return null
}

const submitForm = async ($: EngineInterface) => {
  const date = await currentDate($)
  const result = await addToDay($, date, {
    projectId: form.projectId,
    projectLabel: projectLabel(form.projectId),
    note: form.note.trim(),
    hours: form.hours,
    tasks: form.tasks,
  })
  if (!result.ok) return say($, REASON[result.reason], 'warn')
  form.note = ''
  form.tasks = []
  form.taskOptions = []
  form.taskQuery = ''
  say(
    $,
    result.isCut ? `Đã thêm, cắt còn ${fmtHours(result.hours)} cho vừa ngày.` : 'Đã thêm dòng.',
    result.isCut ? 'warn' : 'ok',
  )
}

const copyYesterday = async ($: EngineInterface) => {
  const date = await currentDate($)
  const source = await readDay($, addDays(date, -1))
  if (source.length === 0) return say($, 'Hôm trước không có dòng nào.', 'warn')
  let added = 0
  for (const line of source) {
    const r = await addToDay($, date, {
      projectId: line.projectId,
      projectLabel: line.projectLabel,
      note: line.note,
      hours: line.hours,
      tasks: line.tasks,
    })
    if (r.ok) added++
  }
  say($, `Đã chép ${added}/${source.length} dòng (bỏ qua dòng trùng hoặc ngày đã đủ).`, added ? 'ok' : 'warn')
}

const pullRange = async ($: EngineInterface, from: string, to: string) => {
  isBusy = true
  say($, `Đang kéo từ PMS ${from} → ${to}…`)
  try {
    const rows = await listWorklogs($, from, to)
    for (let day = from; day <= to; day = addDays(day, 1)) {
      await writeDay(
        $,
        day,
        mergePulled(
          await readDay($, day),
          rows.filter(r => r.date === day),
        ),
      )
    }
    say($, `Đã kéo ${rows.length} dòng từ PMS (${from} → ${to}); draft trên máy được giữ nguyên.`)
  } catch (error) {
    say($, `Kéo từ PMS lỗi: ${String(error).slice(0, 300)}`, 'error')
  } finally {
    isBusy = false
  }
}

const pull = async ($: EngineInterface) => {
  const date = await currentDate($)
  return pullRange($, addDays(date, -(PULL_DAYS - 1)), date)
}

// --- AI: compose a day from what was done, and rewrite one note ---

const ai = {
  date: '',
  hint: '',
  isOpen: false,
  isComposing: false,
  suggestions: [] as Suggestion[],
  refineId: null as string | null,
  isRefining: false,
  // The run log of the last compose: each step with the seconds since it started.
  log: [] as { at: number; text: string; tone?: 'error' }[],
  isLogOpen: true,
  startedAt: 0,
}

const aiLog = ($: EngineInterface, text: string, tone?: 'error') => {
  ai.log.push({ at: Date.now() - ai.startedAt, text, tone })
  void redraw($)
}

const compose = async ($: EngineInterface) => {
  const date = await currentDate($)
  if (projects.length === 0) await loadProjects($)
  const { step } = await getSettings($)
  const account = await activeAccount($)
  const otherLines = await otherAccountsLines($, date)
  const dailyHours = accountBudget((await getSettings($)).dailyHours, totalHours(otherLines))
  const { aiSkipLabels } = await getSettings($)
  const clientProjects = projects.filter(p => !aiSkipLabels.includes(p.label))
  const existing = await readDay($, date)
  const hoursLeft = Math.max(0, dailyHours - totalHours(existing))
  if (hoursLeft < 0.25) return say($, 'Ngày đã đủ giờ, không cần soạn thêm.', 'warn')
  Object.assign(ai, { date, isComposing: true, suggestions: [], log: [], startedAt: Date.now() })
  notice = null
  aiLog(
    $,
    `Bắt đầu soạn cho ${date}: đã có ${existing.length} dòng, còn ${hoursLeft}h${ai.hint.trim() ? ', kèm gợi ý của bạn' : ''}`,
  )
  try {
    aiLog($, 'Đọc hoạt động trong ngày (phiên Claude Code, commit git)…')
    const activity = await readActivity($, date)
    aiLog($, `Tìm thấy ${describeActivity(activity)}`)
    if (aiSkipLabels.length) aiLog($, `Bỏ qua dự án nội bộ: ${aiSkipLabels.join(', ')}`)
    // With no project to map the day onto, the model can only answer nothing: say why instead.
    if (clientProjects.length === 0) {
      const why = projectsError
        ? `không lấy được danh sách dự án từ MCP server "${account.server}": ${projectsError}`
        : `MCP server "${account.server}" không trả về dự án khách hàng nào`
      aiLog($, `Dừng: ${why}. Kiểm tra tên server ở Cài đặt → Tài khoản PMS.`, 'error')
      return say($, `Không soạn được: ${why}.`, 'error')
    }
    aiLog($, `${clientProjects.length} dự án khách hàng: ${clientProjects.map(p => p.label).join(', ')}`)
    aiLog($, `Tài khoản ${account.label}${account.role.trim() ? ` · chỉ lấy việc: ${account.role.trim()}` : ''}`)
    if (otherLines.length)
      aiLog($, `Tài khoản khác đã log ${totalHours(otherLines)}h hôm nay — không soạn lại các việc đó`)
    ai.suggestions = await composeLines(
      $,
      {
        date,
        activity,
        projects: clientProjects,
        existing,
        hoursLeft,
        step,
        hint: ai.hint,
        role: account.role,
        otherLines,
      },
      (text, tone) => aiLog($, text, tone),
    )
    aiLog($, 'Xong.')
    say(
      $,
      ai.suggestions.length
        ? `AI đề xuất ${ai.suggestions.length} dòng — xem lại rồi thêm.`
        : 'AI không tìm thấy việc nào để log cho ngày này.',
      ai.suggestions.length ? 'ok' : 'warn',
    )
  } catch (error) {
    aiLog($, `Lỗi: ${String(error).slice(0, 300)}`, 'error')
    say($, `Soạn bằng AI lỗi: ${String(error).slice(0, 300)}`, 'error')
  } finally {
    ai.isComposing = false
    await redraw($)
  }
}

const acceptSuggestions = async ($: EngineInterface, picked: readonly Suggestion[]) => {
  let added = 0
  const reasons: string[] = []
  for (const sug of picked) {
    const r = await addToDay($, ai.date, {
      projectId: sug.projectId,
      projectLabel: sug.projectLabel,
      note: sug.note,
      hours: sug.hours,
      tasks: [],
    })
    if (r.ok) added++
    else reasons.push(REASON[r.reason])
  }
  ai.suggestions = ai.suggestions.filter(s => !picked.includes(s))
  say(
    $,
    reasons.length
      ? `Đã thêm ${added} dòng; ${reasons.length} dòng bị bỏ: ${[...new Set(reasons)].join(' ')}`
      : `Đã thêm ${added} dòng draft.`,
    reasons.length ? 'warn' : 'ok',
  )
}

const refineLine = async ($: EngineInterface, date: string, id: string, instruction: string) => {
  const line = (await readDay($, date)).find(l => l.id === id)
  if (!line || line.status !== 'draft') return say($, 'Chỉ sửa được dòng draft.', 'warn')
  ai.isRefining = true
  await redraw($)
  try {
    const note = await refineNote($, { note: line.note, projectLabel: line.projectLabel, instruction })
    await writeDay(
      $,
      date,
      (await readDay($, date)).map(l => (l.id === id ? { ...l, note } : l)),
    )
    ai.refineId = null
    say($, 'Đã sửa ghi chú bằng AI.')
  } catch (error) {
    say($, `Sửa bằng AI lỗi: ${String(error).slice(0, 300)}`, 'error')
  } finally {
    ai.isRefining = false
    await redraw($)
  }
}

const refineFormNote = async ($: EngineInterface) => {
  if (!form.note.trim()) return say($, 'Gõ ghi chú trước rồi mới viết lại bằng AI.', 'warn')
  ai.isRefining = true
  await redraw($)
  try {
    form.note = await refineNote($, { note: form.note, projectLabel: projectLabel(form.projectId), instruction: '' })
    say($, 'Đã viết lại ghi chú — xem lại rồi thêm.')
  } catch (error) {
    say($, `Viết lại bằng AI lỗi: ${String(error).slice(0, 300)}`, 'error')
  } finally {
    ai.isRefining = false
    await redraw($)
  }
}

// Each draft is posted alone and its worklogId saved at once, so a rerun never posts it twice.
const push = async ($: EngineInterface) => {
  const date = await currentDate($)
  isPushConfirming = false
  isBusy = true
  pushState.clear()
  let sent = 0
  let failed = 0
  for (const draft of drafts(await readDay($, date))) {
    pushState.set(draft.id, 'đang gửi…')
    await redraw($)
    // A draft from before linking existed, or edited since, is linked once more right before it is sent.
    const isUnlinked = draft.tasks.length === 0 && (draft.issueUrls ?? []).length === 0
    const { skipped: _skipped, ...line } = isUnlinked ? await withLinks($, draft) : { ...draft, skipped: [] }
    try {
      const worklogId = await createWorklog($, {
        projectId: line.projectId,
        date,
        hours: line.hours,
        note: line.note,
        taskIds: line.tasks.map(t => t.id),
        issueUrls: line.issueUrls ?? [],
      })
      const lines = await readDay($, date)
      await writeDay(
        $,
        date,
        lines.map(l => (l.id === line.id ? { ...line, status: 'posted' as const, worklogId } : l)),
      )
      pushState.delete(line.id)
      sent++
    } catch (error) {
      pushState.set(draft.id, `lỗi: ${String(error).slice(0, 160)}`)
      failed++
    }
  }
  isBusy = false
  say(
    $,
    failed ? `Đã gửi ${sent} dòng, ${failed} dòng lỗi (xem từng dòng).` : `Đã gửi ${sent} dòng lên PMS.`,
    failed ? 'error' : 'ok',
  )
}

const searchTasks = async ($: EngineInterface, q: string) => {
  if (!form.projectId) return say($, 'Chọn dự án trước khi tìm task.', 'warn')
  form.taskQuery = q
  try {
    form.taskOptions = await listTasks($, form.projectId, q.trim())
    if (form.taskOptions.length === 0) say($, 'Không thấy task nào khớp.', 'warn')
    else await redraw($)
  } catch (error) {
    say($, `Tìm task lỗi: ${String(error).slice(0, 200)}`, 'error')
  }
}

// --- the model's tools: the panel's "compose with AI", minus a model call of its own ---

const TOOLS = [
  {
    name: 'logtime_projects',
    description: 'List the PMS projects the user can log time on, as { label, value } where value is the projectId.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'logtime_day',
    description:
      "Read one day's logged lines (draft, posted, locked) and its hours budget. date is YYYY-MM-DD, default today.",
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
  },
  {
    name: 'logtime_add',
    description:
      'Add a DRAFT line to a day in the Log time panel; it is not sent to the PMS (the user pushes from the panel). ' +
      'Rejected when the same project + note exists that day or the day is full; cut down when it overruns the day. ' +
      'Write the note in Vietnamese, one concrete outcome. hours is 0.25-24 in quarter hours.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        projectId: { type: 'string' },
        note: { type: 'string' },
        hours: { type: 'number' },
      },
      required: ['projectId', 'note', 'hours'],
    },
  },
  {
    name: 'logtime_remove',
    description: 'Remove a DRAFT line by id from a day (posted or locked lines are refused).',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string' }, lineId: { type: 'string' } },
      required: ['lineId'],
    },
  },
] as const

// A plugin tool's result is text (or content blocks); the model reads the JSON.
const answer = (value: unknown) => {
  const text = JSON.stringify(value)
  return { result: text, text }
}

// What `node --version` / `gh --version` answered, checked once per opening of the settings.
let tooling: { node: string; gh: string } | null = null
let binaries = { node: 'node', gh: 'gh' }

const versionOf = async ($: EngineInterface, bin: string) => {
  try {
    const ran = await $.process.run([bin, '--version'], { timeoutMs: 10000 })
    return ran.exitCode === 0 ? (ran.stdout.trim().split('\n')[0] ?? 'ok') : ''
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  binaries = { node: String(options.nodePath ?? 'node'), gh: String(options.ghPath ?? 'gh') }
  useNode(binaries.node)
  useGh(binaries.gh)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'log-time', description: 'Mở panel Log time (nhập giờ làm, gửi lên PMS)' })
    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })
    return next(e)
  })

  // A failure here must still answer the command, so the person sees why the pane did not open.
  on('command.run', { command: 'log-time' }, async $ => {
    try {
      await syncAccount($)
      await update($, dateAtom, () => today())
      await $.ui.open({ id: PANE, title: 'Log time' })
      if (projects.length === 0) void loadProjects($)
      return { text: 'Đã mở panel Log time.' }
    } catch (error) {
      return { text: `Không mở được panel Log time: ${String(error).slice(0, 400)}` }
    }
  })

  on('tool.call', { tool: 'mcp__log-time__logtime_projects' }, async $ => {
    await syncAccount($)
    if (projects.length === 0) await loadProjects($)
    return projectsError ? { deny: projectsError } : answer(projects)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'log-time: logtime_projects failed' }))

  on('tool.call', { tool: 'mcp__log-time__logtime_day' }, async ($, e) => {
    const account = await syncAccount($)
    const date = String((e as { date?: string }).date ?? '') || today()
    const lines = await readDay($, date)
    return answer({ account: account.label, date, ...balance(lines, await dayBudget($, date)), lines })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'log-time: logtime_day failed' }))

  on('tool.call', { tool: 'mcp__log-time__logtime_add' }, async ($, e) => {
    await syncAccount($)
    const input = e as { date?: string; projectId?: string; note?: string; hours?: number }
    const date = input.date || today()
    if (projects.length === 0) await loadProjects($)
    const result = await addToDay($, date, {
      projectId: String(input.projectId ?? ''),
      projectLabel: projectLabel(String(input.projectId ?? '')),
      note: String(input.note ?? '').trim(),
      hours: Number(input.hours ?? 0),
      tasks: [],
    })
    await redraw($)
    return answer(
      result.ok
        ? { added: true, date, hours: result.hours, isCut: result.isCut }
        : { added: false, reason: REASON[result.reason] },
    )
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'log-time: logtime_add failed' }))

  on('tool.call', { tool: 'mcp__log-time__logtime_remove' }, async ($, e) => {
    await syncAccount($)
    const input = e as { date?: string; lineId?: string }
    const date = input.date || today()
    const lines = await readDay($, date)
    if (lines.find(l => l.id === input.lineId)?.status !== 'draft')
      return answer({ removed: false, reason: 'Chỉ xoá được dòng draft.' })
    const error = await removeDraft($, date, String(input.lineId))
    await redraw($)
    return answer(error ? { removed: false, reason: error } : { removed: true })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'log-time: logtime_remove failed' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // The mobile app draws no input or select yet; every other surface can run the whole pane.
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Panel Log time cần ô nhập và danh sách chọn: mở trên Claude Desktop hoặc terminal.</Text>
    }
    const elements = $.ui.resolve(e)
    const { Box, Input, Select } = elements
    // On the terminal an uncoloured run takes the terminal's own grey, `subtle` is a border colour and a dimmed run
    // nearly vanishes, so every run there names a theme colour: `text` (white on a dark theme, black on a light one)
    // for primary text, `inactive` (the theme's readable secondary text) for the rest. Desktop keeps its own greys.
    const isTerminal = e.surface === 'terminal'
    const BaseText = elements.Text
    const BaseButton = elements.Button
    const Text = (props: Parameters<typeof BaseText>[0]) => {
      if (!isTerminal) return BaseText(props)
      const isSecondary = props.color === 'subtle' || (props.dimColor === true && props.color === undefined)
      return BaseText({ ...props, color: isSecondary ? 'inactive' : (props.color ?? 'text'), dimColor: false })
    }
    // A plain or secondary button's label is drawn as a `text`-coloured child there; the primary one keeps the
    // theme's accent, which is what marks the current tab.
    const Button = (props: Parameters<typeof BaseButton>[0]) => {
      if (!isTerminal) return BaseButton(props)
      const isPrimary = props.variant === 'primary'
      const label = props.label
      return BaseButton({
        ...props,
        dimColor: false,
        ...(!isPrimary && label ? { children: BaseText({ color: 'text', children: label }) } : {}),
      })
    }
    // The terminal has no Svg (its table still answers the name, with an empty element): bars and rules are drawn
    // there in block and line characters instead.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const columns = e.viewport?.columns ?? 80
    const KIND_COLOR: Record<string, 'success' | 'warning' | 'error' | 'subtle'> = {
      full: 'success',
      short: 'warning',
      over: 'error',
    }
    const Bar = (props: {
      source: string
      alt: string
      ratio: number
      kind: string
      cells: number
      width?: number
      height?: number
    }) => {
      if (Svg) return <Svg source={props.source} alt={props.alt} width={props.width} height={props.height} />
      const filled = Math.round(Math.max(0, Math.min(1, props.ratio)) * props.cells)
      return (
        <Text>
          <Text color={KIND_COLOR[props.kind] ?? 'subtle'}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(props.cells - filled)}</Text>
        </Text>
      )
    }
    const date = await currentDate($)
    const view = await read($, viewAtom)
    const conf = await getSettings($)
    const account = await syncAccount($)
    if (projects.length === 0 && !projectsError) void loadProjects($)
    const isToday = date === today()

    // ‹ › move by the unit of the view: a day, a week, or to the 1st of the next/previous month.
    const stepDate = (direction: 1 | -1) => {
      if (view === 'day') return addDays(date, direction)
      if (view === 'week') return addDays(date, 7 * direction)
      const days = monthDays(date)
      return direction === 1
        ? addDays(days[days.length - 1] ?? date, 1)
        : `${addDays(days[0] ?? date, -1).slice(0, 7)}-01`
    }
    const goto = (d: string) => () => void update($, dateAtom, () => d).then(() => redraw($))
    // From the week or month view: show that day from the top of the pane, not where the list was scrolled to.
    const openDay = (d: string) => () =>
      void update($, dateAtom, () => d)
        .then(() => update($, viewAtom, () => 'day'))
        .then(() => redraw($))
        .then(() => $.ui.scroll({ in: PANE, to: 'start' }))
        .catch(() => undefined)
    const setView = (v: LogTimeView) => () => void update($, viewAtom, () => v).then(() => redraw($))
    const run = (task: () => Promise<unknown>) => () => {
      if (isBusy) return
      void task().catch(error => say($, String(error).slice(0, 300), 'error'))
    }
    const toneColor = (tone: 'ok' | 'warn' | 'error') =>
      tone === 'error' ? 'error' : tone === 'warn' ? 'warning' : 'success'

    // --- building blocks ---

    const Card = (props: { children: RenderChildren; tone?: 'warning' | 'error' }) => (
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor={props.tone} paddingX={2} paddingY={1}>
        {props.children}
      </Box>
    )
    const SectionTitle = (props: { text: string; hint?: string }) => (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text weight="semibold">{props.text}</Text>
        {props.hint && (
          <Text size="footnote" color="subtle">
            {props.hint}
          </Text>
        )}
      </Box>
    )
    const Field = (props: { label: string; children: RenderChildren }) => (
      <Box flexDirection="column" gap={0} alignItems="stretch">
        {props.label !== '' && (
          <Text size="footnote" weight="medium" color="subtle">
            {props.label}
          </Text>
        )}
        {props.children}
      </Box>
    )
    const Spacer = () => <Box flexGrow={1} />
    const Divider = () =>
      Svg ? (
        <Svg source={RULE} alt="─" height={1} />
      ) : (
        <Text dimColor wrap="truncate">
          {'─'.repeat(Math.max(10, columns - 8))}
        </Text>
      )
    // A quiet action: a Lucide icon beside a plain Button (a Button holds text only, so the icon sits outside it).
    // The one button of the pane is the app's own outline button: its hover covers the whole button and its height
    // matches the app's inputs and selects. It draws text only, so no icon and no colour inside; the current tab
    // reads by its full-strength label against dimmed siblings. (icon/tone stay accepted for call sites, unused.)
    const Act = (props: {
      k: string
      icon?: IconName
      label: string
      tone?: IconTone
      active?: boolean
      dim?: boolean
      onPress: () => void
    }) => (
      // The terminal cannot dim a button legibly, so there the current tab is the accented (primary) one.
      <Button
        key={props.k}
        variant={props.active ? 'primary' : 'secondary'}
        dimColor={props.dim}
        label={props.label}
        onPress={props.onPress}
      />
    )

    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexDirection="row" gap={0}>
            <Act k="view-day" label="Ngày" active={view === 'day'} onPress={setView('day')} />
            <Act k="view-week" label="Tuần" active={view === 'week'} onPress={setView('week')} />
            <Act k="view-month" label="Tháng" active={view === 'month'} onPress={setView('month')} />
          </Box>
          <Spacer />
          {conf.accounts.length > 1 && (
            <Select
              key="account"
              label="Tài khoản"
              value={account.id}
              options={conf.accounts.map(a => ({
                value: a.id,
                label: a.role.trim() ? `${a.label} · ${a.role}` : a.label,
              }))}
              onSelect={v => {
                // Switching mid-push or mid-compose would send or save lines under the wrong person.
                if (isBusy || ai.isComposing) return say($, 'Đợi gửi / kéo / soạn xong rồi mới đổi tài khoản.', 'warn')
                void update($, accountAtom, () => v).then(() => redraw($))
              }}
            />
          )}
          <Act
            k="settings"
            icon="settings"
            label="Cài đặt"
            dim={!isSettingsOpen}
            onPress={() => {
              isSettingsOpen = !isSettingsOpen
              void redraw($)
            }}
          />
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Act k="prev" icon="back" label="Trước" onPress={goto(stepDate(-1))} />
          <Text size="heading" weight="semibold">
            {view === 'week'
              ? `${shortDay(weekDays(date)[0] ?? date)} – ${shortDay(weekDays(date)[6] ?? date)}`
              : view === 'month'
                ? `Tháng ${date.slice(5, 7)}/${date.slice(0, 4)}`
                : dayLabel(date)}
          </Text>
          <Act k="next" icon="open" label="Sau" onPress={goto(stepDate(1))} />
          <Spacer />
          {!isToday && <Act k="today" icon="today" label="Về hôm nay" onPress={goto(today())} />}
        </Box>
      </Box>
    )

    // Settings on one grid for the whole card: a fixed label column, every value starting at the same edge,
    // actions pushed to the right edge. Inputs appear only while adding or editing, with placeholders that fit.
    const saveSettings = (next: Settings) => void writeSettings($, (settings = next)).then(() => redraw($))
    const LABEL_COL = 20
    const ACTION_COL = 12
    const Group = (props: { title: string; hint: string; children: RenderChildren }) => (
      <Box flexDirection="column" gap={1} borderStyle="round" paddingX={2} paddingY={1}>
        <Box flexDirection="column" gap={0}>
          <Text weight="semibold">{props.title}</Text>
          <Text size="footnote" color="subtle">
            {props.hint}
          </Text>
        </Box>
        <Divider />
        <Box flexDirection="column" gap={1}>
          {props.children}
        </Box>
      </Box>
    )
    const Row = (props: { label: string; strong?: boolean; children?: RenderChildren; action?: RenderChildren }) => (
      <Box flexDirection="row" gap={2} alignItems="center">
        <Box width={LABEL_COL} flexShrink={0}>
          <Text
            size={props.strong ? undefined : 'footnote'}
            weight={props.strong ? 'medium' : 'regular'}
            color={props.strong ? undefined : 'subtle'}
            wrap="truncate-end"
          >
            {props.label}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} flexDirection="row" gap={1} alignItems="center">
          {props.children}
        </Box>
        <Box width={ACTION_COL} flexShrink={0} justifyContent="flex-end">
          {props.action}
        </Box>
      </Box>
    )
    const closeForms = () => {
      settingsForm = null
      roleEditId = null
    }
    // Which accounts' MCP servers are connected right now; only asked while the settings are open.
    if (isSettingsOpen && !tooling)
      tooling = { node: await versionOf($, binaries.node), gh: await versionOf($, binaries.gh) }
    if (!isSettingsOpen) tooling = null
    // The PMS servers this session can log through, offered as a list instead of a name to type.
    const pmsServers = isSettingsOpen ? await listPmsServers($) : []
    const connected = new Set(pmsServers)
    const freeServers = pmsServers.filter(name => !conf.accounts.some(a => a.server === name))
    const repoRows = projects.filter(p => conf.repos[p.label])
    const repoCandidates = projects.filter(p => !conf.repos[p.label] && !conf.aiSkipLabels.includes(p.label))
    const skipped = conf.aiSkipLabels

    const settingsCard = isSettingsOpen && (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center">
          <Text size="heading" weight="semibold">
            Cài đặt
          </Text>
          <Spacer />
          <Act
            k="settings-close"
            icon="close"
            label="Đóng"
            dim
            onPress={() => {
              isSettingsOpen = false
              closeForms()
              void redraw($)
            }}
          />
        </Box>

        <Box flexDirection="column" gap={2}>
          <Group
            title="Môi trường"
            hint="Công cụ trên máy mà mod gọi. Đổi đường dẫn trong cấu hình plugin log-time (nodePath, ghPath)."
          >
            {(
              [
                ['Node', binaries.node, tooling?.node ?? '', 'Soạn bằng AI cần Node để đọc hoạt động trong ngày'],
                ['GitHub CLI', binaries.gh, tooling?.gh ?? '', 'Gắn #số trong ghi chú với issue cần gh đã đăng nhập'],
              ] as const
            ).map(([name, bin, version, need], i) => [
              i > 0 && <Divider />,
              <Row label={name} strong>
                <Text mono size="footnote" color={version ? 'success' : 'error'} wrap="truncate-end">
                  {version ? `● ${bin} · ${version}` : `○ ${bin} · không chạy được`}
                </Text>
                {!version && (
                  <Text size="footnote" color="subtle" wrap="truncate-end">
                    · {need}
                  </Text>
                )}
              </Row>,
            ])}
          </Group>

          <Group title="Ngày làm việc" hint="Số giờ chuẩn mỗi ngày và bước của nút −/+.">
            <Row label="Giờ chuẩn / ngày">
              <Act
                k="daily-minus"
                label="−"
                onPress={() => saveSettings({ ...conf, dailyHours: Math.max(1, conf.dailyHours - 0.5) })}
              />
              <Box width={10} justifyContent="center">
                <Text weight="semibold" tabular>
                  {fmtHours(conf.dailyHours)}
                </Text>
              </Box>
              <Act
                k="daily-plus"
                label="+"
                onPress={() => saveSettings({ ...conf, dailyHours: Math.min(24, conf.dailyHours + 0.5) })}
              />
            </Row>
            <Row label="Bước làm tròn">
              <Act
                k="step-minus"
                label="−"
                onPress={() => {
                  const i = STEPS.findIndex(x => x === conf.step)
                  saveSettings({ ...conf, step: STEPS[Math.max(0, i - 1)] ?? conf.step })
                }}
              />
              <Box width={10} justifyContent="center">
                <Text weight="semibold" tabular>
                  {fmtHours(conf.step)}
                </Text>
              </Box>
              <Act
                k="step-plus"
                label="+"
                onPress={() => {
                  const i = STEPS.findIndex(x => x === conf.step)
                  saveSettings({ ...conf, step: STEPS[Math.min(STEPS.length - 1, i + 1)] ?? conf.step })
                }}
              />
            </Row>
          </Group>

          <Group
            title="Tài khoản PMS"
            hint="Mỗi tài khoản là một MCP server đã đăng nhập bằng tài khoản đó. Giờ trong ngày chia cho các tài khoản."
          >
            {conf.accounts.map((a, i) => [
              i > 0 && <Divider />,
              <Row
                label={a.label}
                strong
                action={
                  a.id === MAIN_ACCOUNT ? undefined : (
                    <Act
                      k={`account-drop-${a.id}`}
                      icon="trash"
                      tone="danger"
                      label="Gỡ"
                      onPress={() => {
                        if (account.id === a.id) void update($, accountAtom, () => MAIN_ACCOUNT)
                        saveSettings({ ...conf, accounts: conf.accounts.filter(x => x.id !== a.id) })
                      }}
                    />
                  )
                }
              >
                {/* The server is picked from the connected ones; one no longer connected stays listed, marked ○. */}
                <Select
                  key={`account-server-${a.id}`}
                  value={a.server}
                  options={[...new Set([a.server, ...pmsServers])].map(name => ({
                    value: name,
                    label: `${connected.has(name) ? '●' : '○'} ${name}`,
                  }))}
                  onSelect={v => {
                    if (v === a.server) return
                    if (conf.accounts.some(x => x.id !== a.id && x.server === v))
                      return say($, `Server ${v} đã thuộc một tài khoản khác.`, 'warn')
                    saveSettings({
                      ...conf,
                      accounts: conf.accounts.map(x => (x.id === a.id ? { ...x, server: v } : x)),
                    })
                    // A new server means a new project list for the account in use.
                    if (account.id === a.id) {
                      useServer(v)
                      projects = []
                      projectsError = ''
                      void loadProjects($)
                    }
                    say($, `Tài khoản ${a.label} giờ log qua ${v}. Nhớ cho phép sẵn mcp__${v} để mod gọi được.`)
                  }}
                />
                <Text size="footnote" color="subtle">
                  · {connected.has(a.server) ? '' : 'chưa nối · '}AI: {a.role.trim() || 'mọi việc'}
                </Text>
                <Act
                  k={`role-edit-${a.id}`}
                  icon="edit"
                  label={roleEditId === a.id ? 'Huỷ' : 'Sửa vai trò'}
                  dim
                  onPress={() => {
                    roleEditId = roleEditId === a.id ? null : a.id
                    void redraw($)
                  }}
                />
              </Row>,
              roleEditId === a.id && (
                <Row label="Vai trò cho AI">
                  <Input
                    key={`role-${a.id}`}
                    autoFocus
                    placeholder="dev và DevOps"
                    submitLabel="Lưu"
                    value={a.role}
                    onSubmit={v => {
                      roleEditId = null
                      saveSettings({
                        ...conf,
                        accounts: conf.accounts.map(x => (x.id === a.id ? { ...x, role: v.trim() } : x)),
                      })
                    }}
                  />
                </Row>
              ),
            ])}
            {settingsForm === 'account' ? (
              [
                <Row
                  label="MCP server"
                  action={
                    <Act
                      k="account-cancel"
                      icon="close"
                      label="Huỷ"
                      dim
                      onPress={() => {
                        closeForms()
                        void redraw($)
                      }}
                    />
                  }
                >
                  {freeServers.length === 0 ? (
                    <Text size="footnote" color="subtle">
                      Không còn MCP server nào có tool worklog chưa gắn tài khoản. Kết nối server PMS của người đó
                      trước.
                    </Text>
                  ) : (
                    <Select
                      key="account-server"
                      value={accountDraft.server}
                      options={[
                        { value: '', label: 'Chọn server…' },
                        ...freeServers.map(name => ({ value: name, label: `● ${name}` })),
                      ]}
                      onSelect={v => {
                        accountDraft.server = v
                        if (!accountDraft.label.trim()) accountDraft.label = v
                        void redraw($)
                      }}
                    />
                  )}
                </Row>,
                accountDraft.server && (
                  <Row label="Tên tài khoản">
                    <Input
                      key={`account-label-${accountDraft.server}`}
                      placeholder="Tên hiển thị"
                      submitLabel="Thêm"
                      value={accountDraft.label}
                      onInput={v => {
                        accountDraft.label = v
                      }}
                      onSubmit={v => {
                        const server = accountDraft.server
                        const label = v.trim() || server
                        if (conf.accounts.some(a => a.server === server))
                          return say($, 'Server này đã có tài khoản.', 'warn')
                        const id = `${label.toLowerCase().replace(/[^\w]+/g, '-')}-${Date.now().toString(36)}`
                        saveSettings({ ...conf, accounts: [...conf.accounts, { id, label, server, role: '' }] })
                        accountDraft.label = ''
                        accountDraft.server = ''
                        closeForms()
                        say($, `Đã thêm tài khoản ${label}. Nhớ cho phép sẵn mcp__${server} để mod gọi được.`)
                      }}
                    />
                  </Row>
                ),
              ]
            ) : (
              <Row label="">
                <Act
                  k="account-add"
                  icon="plus"
                  label="Thêm tài khoản"
                  onPress={() => {
                    closeForms()
                    settingsForm = 'account'
                    void redraw($)
                  }}
                />
              </Row>
            )}
          </Group>

          <Group
            title="Liên kết GitHub"
            hint="Ghi chú có #số được gắn vào issue của repo dự án khi thêm dòng và khi gửi."
          >
            {repoRows.length === 0 && (
              <Row label="">
                <Text size="footnote" color="subtle">
                  Chưa dự án nào có repo.
                </Text>
              </Row>
            )}
            {repoRows.map((p, i) => [
              i > 0 && <Divider />,
              <Row
                label={p.label}
                strong
                action={
                  <Act
                    k={`repo-drop-${p.value}`}
                    icon="trash"
                    tone="danger"
                    label="Gỡ"
                    onPress={() => {
                      const repos = { ...conf.repos }
                      delete repos[p.label]
                      saveSettings({ ...conf, repos })
                    }}
                  />
                }
              >
                <Text mono size="footnote" color="subtle" wrap="truncate-end">
                  {conf.repos[p.label]}
                </Text>
              </Row>,
            ])}
            {settingsForm === 'repo'
              ? [
                  <Row label="Dự án">
                    <Select
                      key="repo-project"
                      value={repoDraft.projectLabel}
                      options={[
                        { value: '', label: 'Chọn dự án' },
                        ...repoCandidates.map(p => ({ value: p.label, label: p.label })),
                      ]}
                      onSelect={v => {
                        repoDraft.projectLabel = v
                        void redraw($)
                      }}
                    />
                  </Row>,
                  <Row
                    label="Repo (owner/name)"
                    action={
                      <Act
                        k="repo-cancel"
                        icon="close"
                        label="Huỷ"
                        dim
                        onPress={() => {
                          closeForms()
                          void redraw($)
                        }}
                      />
                    }
                  >
                    <Input
                      key="repo-value"
                      placeholder="owner/name"
                      submitLabel="Thêm"
                      value={repoDraft.repo}
                      onInput={v => {
                        repoDraft.repo = v
                      }}
                      onSubmit={v => {
                        const repo = v.trim()
                        if (!repoDraft.projectLabel) return say($, 'Chọn dự án trước.', 'warn')
                        if (!isRepo(repo)) return say($, 'Repo phải có dạng owner/name.', 'warn')
                        saveSettings({ ...conf, repos: { ...conf.repos, [repoDraft.projectLabel]: repo } })
                        repoDraft.projectLabel = ''
                        repoDraft.repo = ''
                        closeForms()
                      }}
                    />
                  </Row>,
                ]
              : repoCandidates.length > 0 && (
                  <Row label="">
                    <Act
                      k="repo-add"
                      icon="plus"
                      label="Thêm repo"
                      onPress={() => {
                        closeForms()
                        settingsForm = 'repo'
                        void redraw($)
                      }}
                    />
                  </Row>
                )}
          </Group>

          <Group
            title="Soạn bằng AI"
            hint={
              skipped.length
                ? `AI không gán việc vào: ${skipped.join(', ')}. Bấm một dự án để bật hoặc tắt.`
                : 'AI được gán việc vào mọi dự án. Bấm một dự án để AI bỏ qua (việc nội bộ).'
            }
          >
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {projects.map(p => {
                const isSkipped = skipped.includes(p.label)
                return (
                  <Act
                    k={`skip-${p.value}`}
                    label={isSkipped ? `Bỏ qua · ${p.label}` : p.label}
                    active={isSkipped}
                    onPress={() =>
                      saveSettings({
                        ...conf,
                        aiSkipLabels: isSkipped ? skipped.filter(l => l !== p.label) : [...skipped, p.label],
                      })
                    }
                  />
                )
              })}
            </Box>
          </Group>
        </Box>
      </Box>
    )

    const noticeBanner = notice && (
      <Box
        flexDirection="row"
        gap={1}
        alignItems="center"
        borderStyle="round"
        borderColor={toneColor(notice.tone)}
        paddingX={2}
      >
        <Box flexGrow={1} flexShrink={1}>
          <Text color={toneColor(notice.tone)}>{notice.text}</Text>
        </Box>
        <Act
          k="notice-close"
          icon="close"
          label="Đóng"
          dim
          onPress={() => {
            notice = null
            void redraw($)
          }}
        />
      </Box>
    )

    // --- month: one row per day, to see what is missing and what is logged ---

    if (view === 'month') {
      const days = monthDays(date)
      const byDay = await readDays($, days)
      const now = today()
      const statuses = days.map(d => ({ day: d, ...dayStatus(d, byDay[d] ?? [], conf.dailyHours, now) }))
      const count = (kinds: readonly string[]) => statuses.filter(s => kinds.includes(s.kind)).length
      const monthTotal = statuses.reduce((sum, s) => sum + s.total, 0)
      const pendingDrafts = statuses.reduce((sum, s) => sum + s.drafts, 0)
      const lastPullDay = days[days.length - 1] ?? date
      const KIND = {
        future: { text: '', color: undefined },
        off: { text: 'Nghỉ', color: 'subtle' },
        missing: { text: 'Chưa log', color: 'error' },
        short: { text: 'Thiếu', color: 'warning' },
        full: { text: 'Đủ', color: 'success' },
        over: { text: 'Thừa', color: 'error' },
      } as const
      const Stat = (props: { label: string; value: string; tone?: 'warning' | 'success' | 'error' }) => (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={2} paddingY={1}>
          <Text size="footnote" color="subtle">
            {props.label}
          </Text>
          <Text size="title" weight="semibold" color={props.tone}>
            {props.value}
          </Text>
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          {header}
          {settingsCard}
          <Box flexDirection="row" gap={1}>
            <Stat label="Tổng tháng" value={fmtHours(monthTotal)} />
            <Stat
              label="Ngày chưa log"
              value={String(count(['missing']))}
              tone={count(['missing']) ? 'error' : 'success'}
            />
            <Stat
              label="Ngày thiếu giờ"
              value={String(count(['short']))}
              tone={count(['short']) ? 'warning' : 'success'}
            />
            <Stat label="Draft chưa gửi" value={String(pendingDrafts)} tone={pendingDrafts ? 'warning' : undefined} />
          </Box>
          {noticeBanner}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text size="footnote" color="subtle">
              Bấm một ngày để mở.
            </Text>
            <Spacer />
            <Box flexDirection="row" gap={0}>
              <Act
                k="layout-list"
                icon="list"
                label="Danh sách"
                active={monthLayout === 'list'}
                onPress={() => {
                  monthLayout = 'list'
                  void redraw($)
                }}
              />
              <Act
                k="layout-grid"
                icon="calendar"
                label="Lịch"
                active={monthLayout === 'grid'}
                onPress={() => {
                  monthLayout = 'grid'
                  void redraw($)
                }}
              />
            </Box>
            <Act
              k="pull-month"
              icon="pull"
              label="Kéo cả tháng từ PMS"
              onPress={run(() => pullRange($, days[0] ?? date, lastPullDay < now ? lastPullDay : now))}
            />
          </Box>
          {monthLayout === 'list' && (
            <Card>
              {/* Column heads, then one block per week (newest first), each with its own total. */}
              <Box flexDirection="row" gap={2} paddingX={1}>
                <Box width={12} flexShrink={0}>
                  <Text size="footnote" weight="medium" color="subtle">
                    Ngày
                  </Text>
                </Box>
                <Box width={11} flexShrink={0}>
                  <Text size="footnote" weight="medium" color="subtle">
                    Trạng thái
                  </Text>
                </Box>
                <Box width={22} flexShrink={0}>
                  <Text size="footnote" weight="medium" color="subtle">
                    Giờ
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text size="footnote" weight="medium" color="subtle">
                    Đã gửi / draft
                  </Text>
                </Box>
              </Box>
              <Divider />
              {calendarWeeks(days)
                .map(week => week.filter(d => d !== '' && d <= now))
                .filter(week => week.length > 0)
                .reverse()
                .map(week => {
                  const rows = week
                    .map(d => statuses.find(x => x.day === d))
                    .filter(s => s !== undefined)
                    .reverse()
                  const weekTotal = rows.reduce((sum, s) => sum + s.total, 0)
                  return (
                    <Box flexDirection="column" gap={0}>
                      <Box flexDirection="row" gap={1} alignItems="center" paddingX={1} paddingTop={1}>
                        <Text size="footnote" weight="semibold">
                          {`Tuần ${ddmm(weekDays(week[0] ?? date)[0] ?? date)} – ${ddmm(weekDays(week[0] ?? date)[6] ?? date)}`}
                        </Text>
                        <Spacer />
                        <Text size="footnote" tabular color="subtle">
                          {fmtHours(weekTotal)}
                        </Text>
                      </Box>
                      {rows.map(s => {
                        const kind = KIND[s.kind]
                        const isToday = s.day === now
                        const isOff = s.kind === 'off'
                        return [
                          <Divider />,
                          <Box flexDirection="row" gap={2} alignItems="center" paddingX={1}>
                            <Box width={12} flexShrink={0}>
                              <Button
                                key={`md-${s.day}`}
                                plain
                                dimColor={isOff}
                                label={`${shortDay(s.day)}/${s.day.slice(5, 7)}`}
                                onPress={openDay(s.day)}
                              />
                            </Box>
                            <Box width={11} flexShrink={0}>
                              <Text size="footnote" weight={isOff ? 'regular' : 'semibold'} color={kind.color}>
                                {isOff ? kind.text : `● ${kind.text}`}
                              </Text>
                            </Box>
                            <Box width={22} flexShrink={0} flexDirection="row" gap={1} alignItems="center">
                              <Box width={6} flexShrink={0}>
                                <Text tabular weight="semibold" dimColor={!s.total}>
                                  {s.total ? fmtHours(s.total) : '–'}
                                </Text>
                              </Box>
                              {!isOff && (
                                <Bar
                                  source={dayBar(s.total, conf.dailyHours, s.kind)}
                                  alt={`${fmtHours(s.total)} trên ${fmtHours(conf.dailyHours)}`}
                                  ratio={s.total / conf.dailyHours}
                                  kind={s.kind}
                                  cells={12}
                                  width={96}
                                  height={6}
                                />
                              )}
                            </Box>
                            <Box flexGrow={1} flexShrink={1}>
                              <Text size="footnote" color="subtle">
                                {[
                                  isToday ? 'Hôm nay' : '',
                                  s.posted ? `${s.posted} đã gửi` : '',
                                  s.drafts ? `${s.drafts} draft` : '',
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </Text>
                            </Box>
                            <Act k={`open-${s.day}`} icon="open" label="Mở ngày" dim onPress={openDay(s.day)} />
                          </Box>,
                        ]
                      })}
                    </Box>
                  )
                })}
            </Card>
          )}
          {monthLayout === 'grid' && (
            <Card>
              <Box flexDirection="row" gap={1}>
                {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map(name => (
                  <Box width="14%" flexGrow={1} justifyContent="center">
                    <Text size="footnote" weight="semibold" color="subtle">
                      {name}
                    </Text>
                  </Box>
                ))}
              </Box>
              {calendarWeeks(days).map(week => (
                <Box flexDirection="row" gap={1}>
                  {week.map(day => {
                    const st = statuses.find(x => x.day === day)
                    if (!st) return <Box width="14%" flexGrow={1} />
                    const kind = KIND[st.kind]
                    const isQuiet = st.kind === 'future' || st.kind === 'off'
                    return (
                      <Box
                        width="14%"
                        flexGrow={1}
                        flexDirection="column"
                        borderStyle="round"
                        borderColor={day === now ? 'claude' : st.kind === 'missing' ? 'error' : undefined}
                        paddingX={1}
                      >
                        {/* A Button draws its content on one row, in its own colour: so each row of the cell is its
                            own Button (any of them opens the day), and the status colour lives in the bar and border. */}
                        <Button
                          key={`cal-${day}`}
                          plain
                          dimColor={isQuiet}
                          label={String(Number(day.slice(8, 10)))}
                          onPress={openDay(day)}
                        />
                        <Button
                          key={`cal-h-${day}`}
                          plain
                          dimColor={!st.total}
                          label={st.total ? fmtHours(st.total) : st.kind === 'missing' ? 'Chưa log' : '–'}
                          onPress={openDay(day)}
                        />
                        {!isQuiet && st.kind !== 'missing' && (
                          <Bar
                            source={dayBar(st.total, conf.dailyHours, st.kind)}
                            alt={`${kind.text} ${fmtHours(st.total)}`}
                            ratio={st.total / conf.dailyHours}
                            kind={st.kind}
                            cells={6}
                            width={64}
                            height={4}
                          />
                        )}
                        <Button
                          key={`cal-n-${day}`}
                          plain
                          dimColor
                          label={st.drafts ? `${st.drafts} draft` : st.posted ? `${st.posted} đã gửi` : ' '}
                          onPress={openDay(day)}
                        />
                      </Box>
                    )
                  })}
                </Box>
              ))}
            </Card>
          )}
        </Box>
      )
    }

    // --- week ---

    if (view === 'week') {
      const days = weekDays(date)
      const byDay = await readDays($, days)
      const table = weekTable(days, byDay)
      const weekTotal = table.dayTotals.reduce((a, b) => a + b, 0)
      const shortDays = table.dayTotals.filter((t, i) => t < conf.dailyHours && i < 5).length
      const Stat = (props: { label: string; value: string; tone?: 'warning' | 'success' }) => (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={2} paddingY={1}>
          <Text size="footnote" color="subtle">
            {props.label}
          </Text>
          <Text size="title" weight="semibold" color={props.tone}>
            {props.value}
          </Text>
        </Box>
      )
      // One column spec for every row (head, projects, totals): same width, numbers right-aligned, no row-only
      // borders or padding, so the columns line up exactly.
      const COL = 8
      const cell = (text: string, opts: { bold?: boolean; color?: string; dim?: boolean; size?: 'footnote' } = {}) => (
        <Box width={COL} flexShrink={0} justifyContent="flex-end">
          <Text
            tabular
            size={opts.size}
            weight={opts.bold ? 'semibold' : 'regular'}
            color={opts.color}
            dimColor={opts.dim}
          >
            {text}
          </Text>
        </Box>
      )
      const label = (text: string, opts: { bold?: boolean; subtle?: boolean } = {}) => (
        <Box flexGrow={1} flexShrink={1}>
          <Text
            size={opts.subtle ? 'footnote' : undefined}
            weight={opts.bold ? 'semibold' : 'regular'}
            color={opts.subtle ? 'subtle' : undefined}
            wrap="truncate-end"
          >
            {text}
          </Text>
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {settingsCard}
          <Box flexDirection="row" gap={1}>
            <Stat label="Tổng tuần" value={fmtHours(weekTotal)} />
            <Stat label="Đã gửi PMS" value={fmtHours(table.posted)} tone={table.posted > 0 ? 'success' : undefined} />
            <Stat
              label="Ngày thiếu giờ (T2–T6)"
              value={String(shortDays)}
              tone={shortDays > 0 ? 'warning' : 'success'}
            />
          </Box>
          <Card>
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row">
                {label('Dự án', { subtle: true })}
                {days.map(d => cell(shortDay(d), { size: 'footnote', bold: d === date, dim: d !== date }))}
                {cell('Tổng', { size: 'footnote', bold: true })}
              </Box>
              <Divider />
              {table.rows.length === 0 && <Text color="subtle">Tuần này chưa có giờ nào.</Text>}
              {table.rows.map((row, i) => [
                i > 0 && <Divider />,
                <Box flexDirection="row">
                  {label(row.projectLabel)}
                  {row.perDay.map(h => cell(h ? fmtHours(h) : '–', { dim: !h }))}
                  {cell(fmtHours(row.total), { bold: true })}
                </Box>,
              ])}
              <Divider />
              <Box flexDirection="row">
                {label('Tổng ngày', { bold: true })}
                {table.dayTotals.map((h, i) =>
                  cell(h ? fmtHours(h) : '–', {
                    bold: true,
                    color: i < 5 && h < conf.dailyHours ? 'warning' : h ? 'success' : undefined,
                    dim: !h && i >= 5,
                  }),
                )}
                {cell(fmtHours(weekTotal), { bold: true })}
              </Box>
            </Box>
          </Card>
          {noticeBanner}
        </Box>
      )
    }

    // --- day ---

    const lines = await readDay($, date)
    const othersToday = totalHours(await otherAccountsLines($, date))
    const budget = accountBudget(conf.dailyHours, othersToday)
    const bal = balance(lines, budget)
    const pending = drafts(lines)
    const posted = lines.filter(l => l.status !== 'draft')
    const balTone = bal.kind === 'full' ? 'success' : bal.kind === 'short' ? 'warning' : 'error'
    const balText =
      bal.kind === 'full'
        ? 'Đủ giờ'
        : bal.kind === 'short'
          ? `Thiếu ${fmtHours(bal.diff)}`
          : `Thừa ${fmtHours(bal.diff)}`
    const STATUS = {
      draft: { text: 'Draft', color: 'warning' },
      posted: { text: 'Đã gửi', color: 'success' },
      locked: { text: 'Đã khoá', color: 'subtle' },
    } as const

    const summary = (
      <Card>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text size="title" weight="bold" tabular>
            {fmtHours(bal.total)}
          </Text>
          <Text size="heading" color="subtle" tabular>
            / {fmtHours(bal.budget)}
          </Text>
          <Spacer />
          <Text weight="semibold" color={balTone}>
            {balText}
          </Text>
        </Box>
        <Bar
          source={progressBar(bal.total, bal.budget, bal.kind)}
          alt={`${fmtHours(bal.total)} trên ${fmtHours(bal.budget)}`}
          ratio={bal.budget > 0 ? bal.total / bal.budget : 0}
          kind={bal.kind}
          cells={Math.max(10, Math.min(60, columns - 12))}
        />
        {othersToday > 0 && (
          <Text size="footnote" color="subtle">
            Ngày {fmtHours(conf.dailyHours)}: tài khoản khác đã giữ {fmtHours(othersToday)}, tài khoản {account.label}{' '}
            còn {fmtHours(budget)}.
          </Text>
        )}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text size="footnote" color="subtle">
            {pending.length} draft · {fmtHours(totalHours(pending))} chưa gửi · {posted.length} dòng đã gửi
          </Text>
          <Spacer />
          {bal.kind === 'short' && pending.length > 0 && (
            <Act
              k="fill-day"
              icon="plus"
              label={`Lấp đủ ${fmtHours(bal.diff)} vào ${pending.length} draft`}
              onPress={run(async () => {
                const filled = fillToBudget(await readDay($, date), budget)
                if (filled.added <= 0) return say($, 'Không có dòng draft nào để chia thêm giờ.', 'warn')
                await writeDay($, date, filled.lines)
                say(
                  $,
                  `Đã chia thêm ${fmtHours(filled.added)} vào ${filled.touched} dòng draft theo tỷ lệ — xem lại trước khi gửi.`,
                )
              })}
            />
          )}
        </Box>
      </Card>
    )

    // One line: a header (status, project, hours), the note held to one row until opened, then a quiet footer.
    const lineCard = (line: Line) => {
      const isDraft = line.status === 'draft'
      const isOpen = expandedIds.has(line.id)
      const isLong = line.note.length > LONG_NOTE || line.note.includes('\n')
      const bump = (direction: 1 | -1) =>
        run(async () =>
          writeDay($, date, stepHours(await readDay($, date), line.id, direction, conf.step, budget)).then(() =>
            redraw($),
          ),
        )
      const toggleOpen = () => {
        if (isOpen) expandedIds.delete(line.id)
        else expandedIds.add(line.id)
        void redraw($)
      }
      return (
        <Box flexDirection="column" gap={1} borderStyle="round" paddingX={2} paddingY={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text size="footnote" weight="semibold" color={STATUS[line.status].color}>
              ● {STATUS[line.status].text}
            </Text>
            <Box flexShrink={1}>
              <Text size="footnote" color="subtle" wrap="truncate-end">
                {line.projectLabel}
              </Text>
            </Box>
            <Spacer />
            {isDraft && <Act k={`m-${line.id}`} label="−" onPress={bump(-1)} />}
            <Box minWidth={6} justifyContent="center">
              <Text size="heading" weight="bold" tabular>
                {fmtHours(line.hours)}
              </Text>
            </Box>
            {isDraft && <Act k={`p-${line.id}`} label="+" onPress={bump(1)} />}
          </Box>

          <Text wrap={isOpen ? 'wrap' : 'truncate-end'}>{line.note}</Text>

          {pushState.has(line.id) && (
            <Text size="footnote" color="error">
              {pushState.get(line.id)}
            </Text>
          )}

          {ai.refineId === line.id && (
            <Box flexDirection="column" gap={0}>
              <Text size="footnote" weight="medium" color="subtle">
                {ai.isRefining ? 'AI đang sửa…' : 'Muốn sửa thế nào? Để trống rồi Enter = viết lại gọn, rõ kết quả'}
              </Text>
              <Input
                key={`ai-ins-${line.id}`}
                rows={2}
                autoFocus
                placeholder="Ví dụ: thêm số PR, bỏ phần review, viết ngắn hơn"
                submitLabel="Sửa bằng AI"
                onSubmit={v => void refineLine($, date, line.id, v)}
              />
            </Box>
          )}

          <Box flexDirection="row" gap={2} alignItems="center">
            <Box flexShrink={1} flexGrow={1}>
              <Text size="footnote" color="subtle" wrap="truncate-end">
                {[
                  ...line.tasks.map(t => t.label.split(' · ')[0]),
                  ...(line.issueUrls ?? []).map(u => `#${u.split('/').pop()} (sẽ đồng bộ từ GitHub)`),
                ].join(', ')}
              </Text>
            </Box>
            {/* Buttons sit together at the pane's button gap (1); the wider gap (2) only separates them from the text. */}
            <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
              {isLong && (
                <Act
                  k={`x-${line.id}`}
                  icon={isOpen ? 'collapse' : 'expand'}
                  label={isOpen ? 'Thu gọn' : 'Xem đủ'}
                  dim
                  onPress={toggleOpen}
                />
              )}
              {isDraft && removeConfirmId !== line.id && (
                <Act
                  k={`ai-${line.id}`}
                  icon={ai.refineId === line.id ? 'close' : 'ai'}
                  label={ai.refineId === line.id ? 'Đóng sửa AI' : 'Sửa bằng AI'}
                  dim={ai.refineId !== line.id}
                  onPress={() => {
                    ai.refineId = ai.refineId === line.id ? null : line.id
                    void redraw($)
                  }}
                />
              )}
              {line.status !== 'locked' &&
                (removeConfirmId === line.id ? (
                  [
                    <Text size="footnote" color="warning">
                      Xoá khỏi máy? Bản trên PMS vẫn còn.
                    </Text>,
                    <Act
                      k={`rc-${line.id}`}
                      icon="trash"
                      tone="danger"
                      label="Xoá"
                      onPress={run(async () => {
                        removeConfirmId = null
                        await removeDraft($, date, line.id)
                        await redraw($)
                      })}
                    />,
                    <Act
                      k={`rx-${line.id}`}
                      label="Thôi"
                      onPress={() => {
                        removeConfirmId = null
                        void redraw($)
                      }}
                    />,
                  ]
                ) : (
                  <Act
                    k={`r-${line.id}`}
                    icon="trash"
                    tone="danger"
                    label="Xoá"
                    onPress={run(async () => {
                      if (line.status === 'posted') removeConfirmId = line.id
                      else await removeDraft($, date, line.id)
                      return redraw($)
                    })}
                  />
                ))}
            </Box>
          </Box>
        </Box>
      )
    }

    const addCard = (
      <Card>
        <Box flexDirection="row" gap={1} alignItems="center">
          <SectionTitle text="Thêm dòng" hint="lưu thành draft, chưa gửi PMS" />
          <Spacer />
          <Act
            k="add-close"
            icon="close"
            label="Đóng"
            dim
            onPress={() => {
              isAddOpen = false
              void redraw($)
            }}
          />
        </Box>
        {/* Row 1: project | hours, half and half */}
        <Box flexDirection="row" gap={2} alignItems="flex-start">
          <Box width="50%" flexDirection="column">
            <Field label="Dự án">
              {projectsError ? (
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Box flexShrink={1}>
                    <Text size="footnote" color="error">
                      Không tải được dự án: {projectsError}
                    </Text>
                  </Box>
                  <Act k="retry-projects" icon="retry" label="Thử lại" onPress={() => void loadProjects($)} />
                </Box>
              ) : projects.length === 0 ? (
                <Text size="footnote" color="subtle">
                  Đang tải dự án từ PMS…
                </Text>
              ) : (
                <Select
                  key="project"
                  value={form.projectId}
                  options={projects}
                  onSelect={v => {
                    form.projectId = v
                    form.tasks = []
                    form.taskOptions = []
                    void redraw($)
                  }}
                />
              )}
            </Field>
          </Box>
          <Box width="50%" flexDirection="column">
            <Field label="Số giờ">
              <Box flexDirection="row" gap={1} alignItems="center">
                <Act
                  k="h-minus"
                  label="−"
                  onPress={() => {
                    form.hours = Math.max(0.25, form.hours - conf.step)
                    void redraw($)
                  }}
                />
                <Box minWidth={5} justifyContent="center">
                  <Text weight="bold" tabular>
                    {fmtHours(form.hours)}
                  </Text>
                </Box>
                <Act
                  k="h-plus"
                  label="+"
                  onPress={() => {
                    form.hours = Math.min(Math.max(0.25, budget), form.hours + conf.step)
                    void redraw($)
                  }}
                />
                <Text size="footnote" color="subtle">
                  bước {conf.step}h
                </Text>
              </Box>
            </Field>
          </Box>
        </Box>
        <Field label="Task">
          <Input
            key="task-q"
            placeholder="Số issue hoặc tên task"
            submitLabel="Tìm"
            value={form.taskQuery}
            onSubmit={q => void searchTasks($, q)}
          />
        </Field>
        {form.taskOptions.length > 0 && (
          <Field label="">
            <Select
              key="task-pick"
              value=""
              options={[
                { value: '', label: `Chọn trong ${form.taskOptions.length} task` },
                ...form.taskOptions.map(t => ({ value: t.id, label: t.label })),
              ]}
              onSelect={v => {
                const task = form.taskOptions.find(t => t.id === v)
                if (task && !form.tasks.some(t => t.id === v)) form.tasks = [...form.tasks, task]
                void redraw($)
              }}
            />
          </Field>
        )}
        {form.tasks.map(task => (
          <Field label="">
            <Box flexDirection="row" gap={1} alignItems="center">
              <Box flexShrink={1}>
                <Text size="footnote">{task.label}</Text>
              </Box>
              <Act
                k={`t-${task.id}`}
                icon="close"
                label="Bỏ"
                dim
                onPress={() => {
                  form.tasks = form.tasks.filter(t => t.id !== task.id)
                  void redraw($)
                }}
              />
            </Box>
          </Field>
        ))}
        <Field label="Ghi chú">
          <Input
            key="note"
            rows={4}
            placeholder="Làm gì, kết quả gì (Enter để thêm, xuống dòng như ô chat)"
            submitLabel="Enter ↵"
            value={form.note}
            onInput={v => {
              form.note = v
            }}
            onSubmit={v => {
              form.note = v
              void submitForm($)
            }}
          />
        </Field>
        {/* Last row: AI rewrite on the left, the form's one primary action on the right */}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Act
            k="rewrite-note"
            icon={ai.isRefining ? 'busy' : 'ai'}
            label={ai.isRefining ? 'AI đang viết lại…' : 'Viết lại ghi chú bằng AI'}
            dim={ai.isRefining}
            onPress={() => void refineFormNote($)}
          />
          <Spacer />
          <Act k="add" icon="plus" label="Thêm dòng" active onPress={() => void submitForm($)} />
        </Box>
      </Card>
    )

    const linesSection = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <SectionTitle text="Các dòng" hint={lines.length ? `${lines.length} dòng` : undefined} />
          <Spacer />
          <Act
            k="add-toggle"
            icon={isAddOpen ? 'close' : 'plus'}
            label={isAddOpen ? 'Đóng form' : 'Thêm dòng'}
            onPress={() => {
              isAddOpen = !isAddOpen
              void redraw($)
            }}
          />
        </Box>
        {isAddOpen && addCard}
        {lines.length === 0 && !isAddOpen ? (
          <Box flexDirection="column" borderStyle="dashed" paddingX={2} paddingY={1}>
            <Text color="subtle">Chưa có dòng nào cho ngày này.</Text>
            <Text size="footnote" color="subtle">
              Bấm + Thêm dòng, Soạn bằng AI, hoặc Chép hôm qua / Kéo từ PMS.
            </Text>
          </Box>
        ) : (
          lines.map(lineCard)
        )}
      </Box>
    )

    // --- compose with AI: suggestions from the day's sessions and commits, accepted one by one ---
    const visibleSuggestions = ai.date === date ? ai.suggestions : []
    const aiCard = (
      <Card>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text weight="semibold">Soạn bằng AI</Text>
          <Text size="footnote" color="subtle">
            từ phiên Claude Code và commit git trong ngày
          </Text>
          <Spacer />
          <Act
            k="ai-compose"
            icon={ai.isComposing ? 'busy' : visibleSuggestions.length ? 'redo' : 'ai'}
            label={ai.isComposing ? 'AI đang soạn…' : visibleSuggestions.length ? 'Soạn lại' : 'Soạn bằng AI'}
            onPress={() => {
              if (!ai.isComposing) void compose($)
            }}
          />
          <Act
            k="ai-toggle"
            icon={ai.isOpen ? 'collapse' : 'edit'}
            label={ai.isOpen ? 'Thu gọn' : 'Thêm gợi ý'}
            dim
            onPress={() => {
              ai.isOpen = !ai.isOpen
              void redraw($)
            }}
          />
        </Box>
        {ai.isOpen && (
          <Field label="Gợi ý thêm cho AI (không bắt buộc)">
            <Input
              key="ai-hint"
              rows={2}
              placeholder="Ví dụ: buổi chiều họp sprint 1h"
              submitLabel={ai.isComposing ? 'Đang soạn…' : 'Soạn'}
              value={ai.hint}
              onInput={v => {
                ai.hint = v
              }}
              onSubmit={v => {
                ai.hint = v
                if (!ai.isComposing) void compose($)
              }}
            />
          </Field>
        )}
        {ai.date === date && ai.log.length > 0 && (
          <Box flexDirection="column" gap={0}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text size="footnote" weight="medium" color="subtle">
                Nhật ký chạy
              </Text>
              <Spacer />
              <Act
                k="ai-log-toggle"
                icon={ai.isLogOpen ? 'collapse' : 'expand'}
                label={ai.isLogOpen ? 'Ẩn' : `Hiện ${ai.log.length} bước`}
                dim
                onPress={() => {
                  ai.isLogOpen = !ai.isLogOpen
                  void redraw($)
                }}
              />
            </Box>
            {ai.isLogOpen && (
              <Box flexDirection="column" gap={0} borderStyle="single" borderDimColor paddingX={1}>
                {ai.log.map(entry => (
                  <Box flexDirection="row" gap={1}>
                    <Box width={7} flexShrink={0}>
                      <Text size="footnote" mono tabular color="subtle">
                        {`${(entry.at / 1000).toFixed(1)}s`}
                      </Text>
                    </Box>
                    <Box flexShrink={1}>
                      <Text size="footnote" mono color={entry.tone}>
                        {entry.text}
                      </Text>
                    </Box>
                  </Box>
                ))}
                {ai.isComposing && (
                  <Text size="footnote" mono color="claude">
                    …
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )}
        {visibleSuggestions.map((sug, i) => (
          <Box flexDirection="column" borderStyle="dashed" paddingX={2}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text size="footnote" weight="semibold" color="claude">
                Đề xuất
              </Text>
              <Text size="footnote" color="subtle">
                · {sug.projectLabel}
              </Text>
              <Spacer />
              <Text weight="bold" tabular>
                {fmtHours(sug.hours)}
              </Text>
            </Box>
            <Text>{sug.note}</Text>
            {sug.why && (
              <Text size="footnote" color="subtle">
                {sug.why}
              </Text>
            )}
            <Box flexDirection="row" gap={1}>
              <Spacer />
              <Act
                k={`sug-drop-${i}`}
                icon="close"
                label="Bỏ"
                dim
                onPress={() => {
                  ai.suggestions = ai.suggestions.filter(s => s !== sug)
                  void redraw($)
                }}
              />
              <Act k={`sug-add-${i}`} icon="plus" label="Thêm" onPress={run(() => acceptSuggestions($, [sug]))} />
            </Box>
          </Box>
        ))}
        {visibleSuggestions.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Spacer />
            <Act
              k="ai-accept-all"
              icon="plus"
              label={`Thêm cả ${visibleSuggestions.length} dòng`}
              active
              onPress={run(() => acceptSuggestions($, visibleSuggestions))}
            />
          </Box>
        )}
      </Card>
    )

    const actionBar = (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Act k="copy-yesterday" icon="copy" label="Chép hôm qua" onPress={run(() => copyYesterday($))} />
        <Act k="pull" icon="pull" label={`Kéo từ PMS · ${PULL_DAYS} ngày`} onPress={run(() => pull($))} />
        <Spacer />
        {pending.length > 0 ? (
          <Act
            k="push"
            icon="send"
            label={`Gửi ${pending.length} draft · ${fmtHours(totalHours(pending))}`}
            active
            onPress={() => {
              if (!isBusy) {
                isPushConfirming = true
                void redraw($)
              }
            }}
          />
        ) : (
          <Text size="footnote" color="subtle">
            Chưa có draft để gửi
          </Text>
        )}
      </Box>
    )

    const pushCard = isPushConfirming && (
      <Card tone="warning">
        <SectionTitle text={`Gửi ${pending.length} dòng lên PMS`} hint={dayLabel(date)} />
        {pending.map(l => (
          <Box flexDirection="row" gap={1}>
            <Box minWidth={5}>
              <Text weight="semibold" tabular>
                {fmtHours(l.hours)}
              </Text>
            </Box>
            <Box flexShrink={1}>
              <Text>
                <Text color="subtle">{l.projectLabel} · </Text>
                {l.note}
              </Text>
            </Box>
          </Box>
        ))}
        <Text size="footnote" color="subtle">
          Đã gửi rồi thì sửa trên máy không cập nhật được bản trên PMS.
        </Text>
        <Box flexDirection="row" gap={1}>
          <Spacer />
          <Act
            k="push-cancel"
            label="Huỷ"
            onPress={() => {
              isPushConfirming = false
              void redraw($)
            }}
          />
          <Act k="push-confirm" icon="send" label="Đã xem lại, gửi" active onPress={run(() => push($))} />
        </Box>
      </Card>
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {header}
        {settingsCard}
        {summary}
        {noticeBanner}
        {linesSection}
        {aiCard}
        {actionBar}
        {pushCard}
      </Box>
    )
  })
}
