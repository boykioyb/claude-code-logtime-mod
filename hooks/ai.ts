import type { EngineInterface } from 'claude-code'

import type { Option } from './pms'
import type { Line } from './rules'
import { toQuarter } from './rules'

// The node that runs scripts/activity.mjs: the plugin's `nodePath` option, set once by register().
let node = 'node'

export function useNode(path: string) {
  node = path.trim() || 'node'
}
const COMPOSE_MODEL = 'sonnet'
const REFINE_MODEL = 'haiku'

export type Suggestion = { projectId: string; projectLabel: string; note: string; hours: number; why: string }

// The PMS reader is a manager, not the AI tooling: housekeeping of the assistant itself is folded into the work it served.
const NOTE_STYLE =
  'Each note is Vietnamese, one short sentence (at most ~140 characters), saying what was done at the level of the ' +
  'work itself, e.g. "Chuẩn hoá quy trình review và thêm template issue (#123)" or "Bật đồng bộ file trên ' +
  'môi trường dev (#456) và kiểm tra lại". Name the issue/PR number when there is one; leave out step-by-step detail ' +
  "(accounts used, commands run, checkpoints). Never mention the AI assistant's own setup: saving to memory, writing or " +
  'editing skills, prompts, CLAUDE.md, rules files, mods/plugins or MCP config for Claude. Drop such work entirely, or ' +
  'when it served a real task, count its time under that task without naming it. Tools are not work: never name a ' +
  'slash command, skill, agent or tool the work was done with (a /command, a skill, an agent, Claude Code, MCP), only ' +
  'the work itself ("Rà scope issue #123, review PR, xử lý comment"). No filler such as "làm việc về", ' +
  'no English unless it is a technical term or identifier.'

// The first JSON value in a reply, tolerating a fenced block or prose around it.
const firstJson = (text: string): unknown => {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error('the model returned no JSON')
  const open = body[start]
  const end = body.lastIndexOf(open === '[' ? ']' : '}')
  return JSON.parse(body.slice(start, end + 1))
}

export async function readActivity($: EngineInterface, date: string): Promise<string> {
  const ran = await $.process.run([node, `${$.plugin.root}/scripts/activity.mjs`, date], { timeoutMs: 60000 })
  if (ran.exitCode !== 0) throw new Error(`could not read the day's activity: ${ran.stderr.trim().slice(0, 200)}`)
  return ran.stdout
}

export async function composeLines(
  $: EngineInterface,
  input: {
    date: string
    activity: string
    projects: Option[]
    existing: Line[]
    hoursLeft: number
    step: number
    hint: string
    // The account's kind of work ("" = any), and what the person's other accounts already hold that day.
    role: string
    otherLines: Line[]
  },
  log: (text: string, tone?: 'error') => void = () => undefined,
): Promise<Suggestion[]> {
  const system =
    'You draft a timesheet for one work day from the activity the user recorded. Reply with JSON only: an array of ' +
    '{"projectId": string, "note": string, "hours": number, "why": string}. projectId must be one of the given project ' +
    'values. Log only client work for those projects: map a session or a repository to a project only when its folder ' +
    'clearly is that project\'s codebase or documents (for example a folder "acme-shop-web" is the project labelled ' +
    '"ACME SHOP"). Work in internal or personal folders (the team\'s own internal tools, dotfiles, ' +
    '~/.claude) is not client work: leave it out, never guess a project from a loose name match. Group the activity into a few meaningful lines (usually 2-6), one outcome each. ' +
    `${NOTE_STYLE} Hours: quarter-hour multiples, rounded to the step; sessions can run in parallel, so scale the ` +
    'active minutes so the lines together fill the hours left, never more. Skip work already covered by an existing line ' +
    "(same project and the same outcome), and work already logged under the person's other accounts: one piece of " +
    'work is logged once, under one account. "why" is a short Vietnamese reason naming the sessions or commits used.' +
    (input.role.trim()
      ? ` This account logs only this kind of work: ${input.role.trim()}. Leave out everything else, even if hours ` +
        'stay unfilled.'
      : '')
  const prompt = [
    `Date: ${input.date}`,
    `Hours left to fill: ${input.hoursLeft} (step ${input.step}h)`,
    `Projects: ${JSON.stringify(input.projects)}`,
    `Existing lines: ${JSON.stringify(input.existing.map(l => ({ project: l.projectLabel, note: l.note, hours: l.hours })))}`,
    input.otherLines.length
      ? `Already logged under the other accounts (do not log again): ${JSON.stringify(input.otherLines.map(l => ({ project: l.projectLabel, note: l.note, hours: l.hours })))}`
      : '',
    input.hint.trim() ? `The user adds: ${input.hint.trim()}` : '',
    `Activity: ${input.activity}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  log(`Gửi cho model ${COMPOSE_MODEL} (${prompt.length.toLocaleString('en')} ký tự), còn ${input.hoursLeft}h cần lấp…`)
  const startedAt = Date.now()
  const reply = await $.model.complete({ model: COMPOSE_MODEL, system, prompt, maxTokens: 2000, timeoutMs: 120000 })
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (!reply.isAnswered) throw new Error(`the model did not answer after ${seconds}s (${reply.reason})`)
  log(`Model trả lời sau ${seconds}s · ${reply.usage.input_tokens} token vào, ${reply.usage.output_tokens} token ra`)
  const raw = firstJson(reply.text)
  if (!Array.isArray(raw)) throw new Error('the model did not return a list')
  const known = new Map(input.projects.map(p => [p.value, p.label]))
  const kept = raw.flatMap(item => {
    const o = item as Record<string, unknown>
    const projectId = String(o.projectId ?? '')
    const hours = toQuarter(Number(o.hours))
    const note = String(o.note ?? '').trim()
    if (!known.has(projectId)) {
      log(`Bỏ 1 mục: dự án không có trong PMS (${projectId || 'trống'})`, 'error')
      return []
    }
    if (!note || !(hours >= 0.25)) {
      log('Bỏ 1 mục: thiếu ghi chú hoặc số giờ dưới 0,25', 'error')
      return []
    }
    return [{ projectId, projectLabel: known.get(projectId) ?? projectId, note, hours, why: String(o.why ?? '') }]
  })
  log(`Model đề xuất ${raw.length} mục, giữ ${kept.length} · tổng ${kept.reduce((sum, k) => sum + k.hours, 0)}h`)
  return kept
}

// A one-line count of what the activity script found, for the run log.
export const describeActivity = (activity: string) => {
  const parsed = JSON.parse(activity) as {
    sessions?: { activeMinutes?: number }[]
    commits?: { subjects?: string[] }[]
  }
  const sessions = parsed.sessions ?? []
  const minutes = sessions.reduce((sum, s) => sum + (s.activeMinutes ?? 0), 0)
  const commits = (parsed.commits ?? []).reduce((sum, c) => sum + (c.subjects?.length ?? 0), 0)
  return `${sessions.length} phiên Claude Code (${minutes} phút hoạt động, có thể chạy song song) · ${commits} commit trong ${(parsed.commits ?? []).length} repo · ${(activity.length / 1024).toFixed(1)} KB`
}

export async function refineNote(
  $: EngineInterface,
  input: { note: string; projectLabel: string; instruction: string },
): Promise<string> {
  const system =
    'You rewrite one timesheet note. Reply with JSON only: {"note": string}. Keep every fact (numbers, issue and PR ' +
    `references, names); do not invent work. ${NOTE_STYLE}`
  const prompt = [
    `Project: ${input.projectLabel}`,
    `Note: ${input.note}`,
    `How to change it: ${input.instruction.trim() || 'make it concise and outcome-first'}`,
  ].join('\n')
  const reply = await $.model.complete({ model: REFINE_MODEL, system, prompt, maxTokens: 600, timeoutMs: 60000 })
  if (!reply.isAnswered) throw new Error(`the model did not answer (${reply.reason})`)
  const note = String((firstJson(reply.text) as { note?: unknown }).note ?? '').trim()
  if (!note) throw new Error('the model returned an empty note')
  return note
}
