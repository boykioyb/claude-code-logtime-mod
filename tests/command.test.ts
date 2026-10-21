import { describe, expect, test } from 'claude-code/testing'

describe('/log-time', () => {
  test('is answered with text, even where the data folder cannot be read', async $ => {
    const ran = await $.command.run({ command: 'log-time' })
    expect(typeof ran.text).toBe('string')
    expect(ran.text?.includes('no command.run hook answered')).toBe(false)
  })
})
