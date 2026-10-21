import type { EngineInterface } from 'claude-code'

import { listTasks } from './pms'
import type { Task } from './rules'
import { issueNumbers } from './rules'

// The GitHub CLI: the plugin's `ghPath` option, set once by register().
let gh = 'gh'

export function useGh(path: string) {
  gh = path.trim() || 'gh'
}

export type Linked = { tasks: Task[]; issueUrls: string[]; skipped: string[] }

// Is #n of the repository an issue, a pull request, or neither? GitHub numbers both in one sequence.
async function issueKind($: EngineInterface, repo: string, n: number): Promise<'issue' | 'pr' | 'none'> {
  const ran = await $.process.run(
    [gh, 'api', `repos/${repo}/issues/${n}`, '--jq', 'if has("pull_request") then "pr" else "issue" end'],
    { timeoutMs: 20000 },
  )
  if (ran.exitCode !== 0) return 'none'
  return ran.stdout.trim() === 'pr' ? 'pr' : 'issue'
}

// Turn the #numbers a note cites into what worklog_create links: a PMS task when one exists, else the GitHub
// issue URL (the PMS syncs that issue in). A pull request is never sent: a PR URL breaks worklog_create.
export async function linkIssues(
  $: EngineInterface,
  input: { projectId: string; note: string; repo: string | undefined; known: Task[] },
): Promise<Linked> {
  const out: Linked = { tasks: [...input.known], issueUrls: [], skipped: [] }
  for (const n of issueNumbers(input.note)) {
    if (out.tasks.some(t => t.label.startsWith(`#${n} ·`))) continue
    const task = (await listTasks($, input.projectId, String(n))).find(t => t.label.startsWith(`#${n} ·`))
    if (task) {
      out.tasks.push(task)
      continue
    }
    if (!input.repo) {
      out.skipped.push(`#${n} (dự án chưa có repo GitHub)`)
      continue
    }
    const kind = await issueKind($, input.repo, n)
    if (kind === 'issue') out.issueUrls.push(`https://github.com/${input.repo}/issues/${n}`)
    else out.skipped.push(kind === 'pr' ? `#${n} là PR` : `#${n} không có trên ${input.repo}`)
  }
  return out
}
