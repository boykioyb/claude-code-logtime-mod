import type { EngineInterface } from 'claude-code'

import type { PmsRow, Task } from './rules'

// The PMS is reached only through its worklog MCP tools, so the mod never holds a token. Each account is a
// separate MCP server signed in as that person; the active account picks which server's tools are called.
let server = 'pms'

export function useServer(name: string) {
  server = name
}

const TOOL = {
  get projects() {
    return `mcp__${server}__worklog_list_projects` as const
  },
  get tasks() {
    return `mcp__${server}__worklog_list_tasks` as const
  },
  get list() {
    return `mcp__${server}__worklog_list` as const
  },
  get create() {
    return `mcp__${server}__worklog_create` as const
  },
}

// Whether a server's worklog tools are connected in this session, for the settings' account status.
export async function hasServer($: EngineInterface, name: string) {
  const tools = await $.tool.list()
  return tools.some(t => t.name === `mcp__${name}__worklog_create`)
}

// Every MCP server connected in this session that can log time: the ones offering worklog_create.
export async function listPmsServers($: EngineInterface): Promise<string[]> {
  const tools = await $.tool.list()
  return tools.flatMap(t => t.name.match(/^mcp__(.+)__worklog_create$/)?.slice(1, 2) ?? []).sort()
}

export type Option = { label: string; value: string }

async function call(
  $: EngineInterface,
  tool: `mcp__${string}__${string}`,
  input: Record<string, unknown>,
): Promise<unknown> {
  const ran = await $.tool.call({ tool, ...input })
  if (ran.deny !== undefined) throw new Error(`${tool}: ${ran.deny}`)
  if (ran.isError) throw new Error(`${tool}: ${(ran.text ?? '').slice(0, 300)}`)
  const text = ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result))
  return JSON.parse(text)
}

const asOptions = (raw: unknown): Option[] => {
  const list = Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] } | null)?.rows ?? [])
  return list.flatMap(item => {
    const o = item as Record<string, unknown>
    const value = String(o.value ?? o.id ?? '')
    const label = String(o.label ?? o.name ?? o.title ?? value)
    return value ? [{ label, value }] : []
  })
}

export async function listProjects($: EngineInterface) {
  return asOptions(await call($, TOOL.projects, {}))
}

export async function listTasks($: EngineInterface, projectId: string, q: string): Promise<Task[]> {
  return asOptions(await call($, TOOL.tasks, q ? { projectId, q } : { projectId })).map(o => ({
    id: o.value,
    label: o.label,
  }))
}

type RawRow = {
  id: string
  projectId: string
  date: string
  hours: string | number
  note: string | null
  lockedAt: string | null
  project?: { name?: string }
  tasks?: { task?: { id?: string; title?: string; githubIssueId?: number | null } }[]
}

export async function listWorklogs($: EngineInterface, from: string, to: string): Promise<PmsRow[]> {
  const rows: PmsRow[] = []
  for (let page = 1; page <= 20; page++) {
    const res = (await call($, TOOL.list, { from, to, page, pageSize: 100 })) as { rows: RawRow[]; total: number }
    for (const r of res.rows) {
      rows.push({
        id: r.id,
        projectId: r.projectId,
        projectName: r.project?.name ?? r.projectId,
        date: r.date.slice(0, 10),
        hours: Number(r.hours),
        note: r.note ?? '',
        isLocked: r.lockedAt !== null,
        tasks: (r.tasks ?? []).flatMap(t =>
          t.task?.id
            ? [
                {
                  id: t.task.id,
                  label: `${t.task.githubIssueId ? `#${t.task.githubIssueId} · ` : ''}${t.task.title ?? ''}`,
                },
              ]
            : [],
        ),
      })
    }
    if (page * 100 >= res.total) break
  }
  return rows
}

export async function createWorklog(
  $: EngineInterface,
  input: { projectId: string; date: string; hours: number; note: string; taskIds: string[]; issueUrls: string[] },
): Promise<string> {
  const res = (await call($, TOOL.create, {
    projectId: input.projectId,
    date: input.date,
    hours: input.hours,
    note: input.note,
    ...(input.taskIds.length ? { taskIds: input.taskIds } : {}),
    ...(input.issueUrls.length ? { githubIssueUrls: input.issueUrls } : {}),
  })) as { id?: string }
  if (!res.id) throw new Error('worklog_create returned no id')
  return res.id
}
