import { describe, expect, test } from 'claude-code/testing'

import { describeActivity } from '../hooks/ai'

describe('describeActivity', () => {
  test('counts sessions, their minutes, commits and repositories', () => {
    const text = describeActivity(
      JSON.stringify({
        sessions: [{ activeMinutes: 30 }, { activeMinutes: 15 }],
        commits: [{ subjects: ['a', 'b'] }, { subjects: ['c'] }],
      }),
    )
    expect(text.startsWith('2 phiên Claude Code (45 phút')).toBe(true)
    expect(text.includes('3 commit trong 2 repo')).toBe(true)
  })
})
