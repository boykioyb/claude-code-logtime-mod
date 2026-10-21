import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'log-time',
  component: 'Pane',
  requestId: 'log-time',
  props: {
    title: 'Log time',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the day view draws on the terminal and on desktop', async ($, on) => {
  // Nothing sits beneath the plugin: these hooks stand for the engine with an empty data folder and no PMS projects.
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', () => ({ result: '[]', text: '[]' }))
  on('tool.list', () => ({ value: [] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Chưa có dòng nào/ }))?.text).toBe('Chưa có dòng nào cho ngày này.')
    // The terminal has no Svg: the day's bar is drawn in block characters there.
    const bar = await ui.find({ type: 'Text', text: /░/ })
    expect(bar !== undefined).toBe(surface === 'terminal')
    await ui.unmount()
  }
})
