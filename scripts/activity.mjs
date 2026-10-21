// What the user worked on during one local day, for the log-time mod's "compose with AI":
// the prompts they typed in Claude Code sessions (~/.claude/projects/*/*.jsonl) with each
// session's active minutes, and their git commits in the repositories those sessions ran in.
// Usage: node activity.mjs YYYY-MM-DD  →  JSON on stdout.
import { execFileSync } from 'node:child_process'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const date = process.argv[2]
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  process.stderr.write('usage: activity.mjs YYYY-MM-DD\n')
  process.exit(2)
}

const IDLE_GAP_MS = 15 * 60 * 1000 // a pause longer than this is not counted as work
const MAX_PROMPTS = 12
const pad = n => String(n).padStart(2, '0')
const localDay = ts => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const dayStart = new Date(`${date}T00:00:00`).getTime()

const promptText = message => {
  const content = message?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : ''
  const trimmed = text.trim()
  // Wrapped command and system text is not something the user wrote.
  if (!trimmed || trimmed.startsWith('<')) return null
  // A leading slash command names the tool, not the work; keep only what it was asked to do.
  const work = trimmed.replace(/^\/[\w:-]+(?=\s|$)\s*/, '')
  if (!work) return null
  return work.replace(/\s+/g, ' ').slice(0, 240)
}

const root = join(homedir(), '.claude', 'projects')
const files = []
for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  for (const f of readdirSync(join(root, dir.name), { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
    const path = join(root, dir.name, f.name)
    if (statSync(path).mtimeMs >= dayStart) files.push(path)
  }
}

const sessions = new Map()
for (const path of files) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const raw of lines) {
    if (!raw.includes(`"timestamp":"`)) continue
    let entry
    try {
      entry = JSON.parse(raw)
    } catch {
      continue // a line still being written
    }
    if (!entry.timestamp || entry.isSidechain || localDay(entry.timestamp) !== date) continue
    const id = entry.sessionId ?? path
    const s = sessions.get(id) ?? { cwd: entry.cwd, stamps: [], prompts: [] }
    s.cwd ??= entry.cwd
    s.stamps.push(new Date(entry.timestamp).getTime())
    if (entry.type === 'user' && !entry.isMeta) {
      const text = promptText(entry.message)
      if (text && s.prompts.at(-1) !== text) s.prompts.push(text)
    }
    sessions.set(id, s)
  }
}

const activeMinutes = stamps => {
  const sorted = [...stamps].sort((a, b) => a - b)
  let ms = 0
  for (let i = 1; i < sorted.length; i++) ms += Math.min(sorted[i] - sorted[i - 1], IDLE_GAP_MS)
  return Math.round(ms / 60000)
}

const out = [...sessions.values()]
  .filter(s => s.prompts.length > 0)
  .map(s => ({
    cwd: s.cwd ?? '',
    activeMinutes: activeMinutes(s.stamps),
    prompts: s.prompts.length > MAX_PROMPTS ? [...s.prompts.slice(0, 6), '…', ...s.prompts.slice(-6)] : s.prompts,
  }))
  .sort((a, b) => b.activeMinutes - a.activeMinutes)

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const repos = new Map()
for (const cwd of new Set(out.map(s => s.cwd).filter(Boolean))) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel'])
    if (repos.has(top)) continue
    const email = git(top, ['config', 'user.email'])
    const subjects = git(top, ['log', '--all', `--since=${date} 00:00`, `--until=${date} 23:59:59`, `--author=${email}`, '--pretty=format:%s'])
    repos.set(top, subjects ? [...new Set(subjects.split('\n'))].slice(0, 20) : [])
  } catch {
    // not a git repository, or git is missing: the prompts still say what was done
  }
}

process.stdout.write(
  JSON.stringify({ date, sessions: out, commits: [...repos].filter(([, s]) => s.length).map(([repo, subjects]) => ({ repo, subjects })) }),
)
