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
    // Secondary text stays readable on the terminal theme: no border-grey `subtle`, no dimmed run.
    if (surface === 'terminal') {
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.length > 10).toBe(true)
      expect(texts.some(t => t.props.color === 'inactive')).toBe(true)
      // Every run names a theme colour there: an uncoloured run would take the terminal's own grey.
      expect(texts.filter(t => t.props.color === undefined).map(t => t.text)).toEqual([])
      expect(texts.filter(t => t.props.color === 'subtle' || t.props.dimColor === true).length).toBe(0)
    }
    await ui.unmount()
  }
})

test('an account picks its PMS server from the connected ones, for the main account too', async ($, on) => {
  const SETTINGS = '/home/test/.local/share/log-time/settings.json'
  const files: Record<string, string> = {
    [SETTINGS]: JSON.stringify({ accounts: [{ id: 'me', label: 'Tôi', server: 'old-pms', role: '' }] }),
  }
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('tool.call', () => ({ result: '[]', text: '[]' }))
  // Two servers can log time; a third connected one has no worklog tools and is not offered.
  on('tool.list', () => ({
    value: [
      { name: 'mcp__new-pms__worklog_create', description: '', mcp: true },
      { name: 'mcp__pms-minh__worklog_create', description: '', mcp: true },
      { name: 'mcp__slack__slack_read_thread', description: '', mcp: true },
    ],
  }))
  const saved = () => JSON.parse(files[SETTINGS] ?? '{}') as { accounts: { label: string; server: string }[] }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  const picker = await ui.find({ key: 'account-server-me' })
  expect((picker?.props.options as { value: string }[]).map(o => o.value)).toEqual(['old-pms', 'new-pms', 'pms-minh'])
  await ui.select({ key: 'account-server-me', value: 'new-pms' })
  expect(saved().accounts[0]?.server).toBe('new-pms')

  // Adding an account offers only the servers no account uses yet.
  await ui.press({ key: 'account-add' })
  const free = await ui.find({ key: 'account-server' })
  expect((free?.props.options as { value: string }[]).map(o => o.value)).toEqual(['', 'pms-minh'])
  await ui.select({ key: 'account-server', value: 'pms-minh' })
  await ui.input({ key: 'account-label-pms-minh', text: 'Minh', kind: 'submit' })
  expect(saved().accounts.map(a => `${a.label}:${a.server}`)).toEqual(['Tôi:new-pms', 'Minh:pms-minh'])
  await ui.unmount()
})
