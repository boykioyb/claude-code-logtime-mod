import { describe, expect, test } from 'claude-code/testing'

import type { Line } from '../hooks/rules'
import {
  accountBudget,
  addLine,
  balance,
  calendarWeeks,
  dayStatus,
  fillToBudget,
  isRepo,
  issueNumbers,
  mergePulled,
  monthDays,
  normalizeSettings,
  stepHours,
  weekDays,
  weekTable,
} from '../hooks/rules'

const line = (over: Partial<Line> = {}): Line => ({
  id: 'a',
  projectId: 'p1',
  projectLabel: 'ACME SHOP',
  note: 'Review PR',
  hours: 2,
  status: 'draft',
  tasks: [],
  ...over,
})

describe('addLine', () => {
  test('adds a line that fits', () => {
    const r = addLine([], line(), 8)
    expect(r.ok && r.lines.length).toBe(1)
  })

  test('rejects the same project and note on one day, ignoring case and spaces', () => {
    const r = addLine([line()], line({ id: 'b', note: '  review pr ' }), 8)
    expect(r).toEqual({ ok: false, reason: 'duplicate' })
  })

  test('rejects a line once the day is full', () => {
    expect(addLine([line({ hours: 8 })], line({ id: 'b', note: 'x' }), 8)).toEqual({ ok: false, reason: 'full' })
  })

  test('cuts a line down to what is left of the day', () => {
    const r = addLine([line({ hours: 7 })], line({ id: 'b', note: 'x', hours: 3 }), 8)
    expect(r.ok && [r.hours, r.isCut]).toEqual([1, true])
  })

  test('rejects an empty note or a zero line', () => {
    expect(addLine([], line({ note: ' ' }), 8)).toEqual({ ok: false, reason: 'invalid' })
    expect(addLine([], line({ hours: 0 }), 8)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('stepHours', () => {
  test('moves a draft by the step, capped by the day budget', () => {
    const lines = [line({ hours: 6 }), line({ id: 'b', note: 'x', hours: 1.5 })]
    expect(stepHours(lines, 'b', 1, 0.5, 8)[1]?.hours).toBe(2)
    expect(stepHours(stepHours(lines, 'b', 1, 0.5, 8), 'b', 1, 0.5, 8)[1]?.hours).toBe(2)
  })

  test('never goes below a quarter hour and leaves posted lines alone', () => {
    expect(stepHours([line({ hours: 0.5 })], 'a', -1, 1, 8)[0]?.hours).toBe(0.25)
    expect(stepHours([line({ status: 'posted' })], 'a', 1, 1, 8)[0]?.hours).toBe(2)
  })
})

describe('balance and settings', () => {
  test('says how far the day is from its budget', () => {
    expect(balance([line({ hours: 6 })], 8)).toEqual({ total: 6, budget: 8, diff: 2, kind: 'short' })
    expect(balance([line({ hours: 9 })], 8).kind).toBe('over')
  })

  test('falls back to defaults for an unknown step and clamps daily hours to quarters', () => {
    expect(normalizeSettings({ step: 0.3, dailyHours: 7.4 })).toEqual({
      step: 0.5,
      dailyHours: 7.5,
      aiSkipLabels: [],
      repos: {},
      accounts: [{ id: 'me', label: 'Tôi', server: 'pms', role: '' }],
    })
  })

  test('keeps an explicit empty skip list, so the internal project can be turned back on', () => {
    expect(normalizeSettings({ aiSkipLabels: [] }).aiSkipLabels).toEqual([])
  })
})

describe('mergePulled', () => {
  test('keeps drafts and replaces posted lines with the PMS rows', () => {
    const local = [line(), line({ id: 'old', status: 'posted', worklogId: 'w0' })]
    const merged = mergePulled(local, [
      {
        id: 'w1',
        projectId: 'p1',
        projectName: 'ACME SHOP',
        date: '2026-10-20',
        hours: 1,
        note: 'n',
        isLocked: true,
        tasks: [],
      },
    ])
    expect(merged.map(l => [l.id, l.status])).toEqual([
      ['a', 'draft'],
      ['pms-w1', 'locked'],
    ])
  })
})

describe('week', () => {
  test('starts on Monday', () => {
    expect(weekDays('2026-10-21')[0]).toBe('2026-10-19')
    expect(weekDays('2026-10-25')[6]).toBe('2026-10-25')
  })

  test('sums hours per project and per day', () => {
    const days = weekDays('2026-10-21')
    const table = weekTable(days, {
      '2026-10-19': [line({ hours: 2, status: 'posted' })],
      '2026-10-21': [line({ id: 'b', hours: 3 })],
    })
    expect(table.rows[0]?.perDay.slice(0, 3)).toEqual([2, 0, 3])
    expect([table.rows[0]?.total, table.posted, table.dayTotals[2]]).toEqual([5, 2, 3])
  })
})

describe('month history', () => {
  test('lists every day of the month', () => {
    const days = monthDays('2026-02-14')
    expect([days.length, days[0], days[27]]).toEqual([28, '2026-02-01', '2026-02-28'])
  })

  test('flags an empty past weekday as missing, an empty weekend as off, a later empty day as future', () => {
    expect(dayStatus('2026-10-20', [], 8, '2026-10-21').kind).toBe('missing')
    expect(dayStatus('2026-10-18', [], 8, '2026-10-21').kind).toBe('off')
    expect(dayStatus('2026-10-22', [], 8, '2026-10-21').kind).toBe('future')
  })

  test('counts drafts and posted lines and compares the total with the budget', () => {
    const s = dayStatus(
      '2026-10-20',
      [line({ hours: 3 }), line({ id: 'b', note: 'x', hours: 2, status: 'posted' })],
      8,
      '2026-10-21',
    )
    expect(s).toEqual({ kind: 'short', total: 5, drafts: 1, posted: 1 })
  })
})

describe('calendarWeeks', () => {
  test('pads October 2026 (starts on a Thursday) to whole Monday-first weeks', () => {
    const weeks = calendarWeeks(monthDays('2026-10-21'))
    expect(weeks.length).toBe(5)
    expect(weeks[0]).toEqual(['', '', '', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(weeks[4]?.slice(-2)).toEqual(['2026-10-31', ''])
  })
})

describe('issue references', () => {
  test('reads each #number once, in order', () => {
    expect(issueNumbers('ghi chú (issue #123), sửa #45 và #123 (PR #678)')).toEqual([123, 45, 678])
    expect(issueNumbers('không có số')).toEqual([])
  })

  test('accepts owner/name repositories only', () => {
    expect([isRepo('acme/shop-web'), isRepo('https://github.com/a/b'), isRepo('a')]).toEqual([true, false, false])
  })
})

describe('fillToBudget', () => {
  test('spreads the missing hours over drafts in proportion, to the exact budget', () => {
    const lines = [
      line({ hours: 3 }),
      line({ id: 'b', note: 'x', hours: 1 }),
      line({ id: 'c', note: 'y', hours: 2, status: 'posted' }),
    ]
    const r = fillToBudget(lines, 8)
    expect(r.lines.map(l => l.hours)).toEqual([4.5, 1.5, 2])
    expect([r.added, r.touched]).toEqual([2, 2])
  })

  test('rounds to quarter hours and still lands on the budget', () => {
    const r = fillToBudget(
      [line({ hours: 1 }), line({ id: 'b', note: 'x', hours: 1 }), line({ id: 'c', note: 'y', hours: 1 })],
      8,
    )
    expect(r.lines.reduce((s, l) => s + l.hours, 0)).toBe(8)
    expect(r.lines.every(l => (l.hours * 4) % 1 === 0)).toBe(true)
  })

  test('adds nothing without drafts, and never invents a line', () => {
    const r = fillToBudget([line({ hours: 5, status: 'posted' })], 8)
    expect([r.added, r.lines.length]).toEqual([0, 1])
  })
})

describe('accounts', () => {
  test('keeps the main account first, drops malformed servers, keeps the rest in order', () => {
    const { accounts } = normalizeSettings({
      accounts: [
        { id: 'second-1', label: 'Second', server: 'pms-second', role: 'dev và DevOps' },
        { id: 'bad', label: 'Bad', server: 'has space', role: '' },
      ],
    })
    expect(accounts.map(a => a.id)).toEqual(['me', 'second-1'])
    expect(accounts[1]?.role).toBe('dev và DevOps')
  })

  test('one day is split between accounts, never logged twice', () => {
    expect(accountBudget(8, 3)).toBe(5)
    expect(accountBudget(8, 9)).toBe(0)
  })
})
