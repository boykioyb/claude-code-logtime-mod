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
  // Each server answers its own projects.
  const PROJECTS: Record<string, string> = {
    'mcp__new-pms__worklog_list_projects': JSON.stringify([{ id: 'p1', name: 'YAHAGI 168' }]),
    'mcp__pms-minh__worklog_list_projects': JSON.stringify([{ id: 'p2', name: 'LUNCHBOX' }]),
  }
  on('tool.call', (_, e) => {
    const out = PROJECTS[(e as unknown as { tool: string }).tool] ?? '[]'
    return { result: out, text: out }
  })
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
  // The project-keyed settings cover every account: the added server's projects are fetched without a reload.
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'settings' })
  expect((await ui.find({ key: 'skip-p1' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'skip-p2' })) !== undefined).toBe(true)
  await ui.unmount()
})

test("the panel's own worklog calls are allowed, anyone else's go to the ordinary check", async ($, on) => {
  const SETTINGS = '/home/test/.local/share/log-time/settings.json'
  const files: Record<string, string> = {
    [SETTINGS]: JSON.stringify({ accounts: [{ id: 'me', label: 'Tôi', server: 'new-pms', role: '' }] }),
  }
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__new-pms__worklog_create', description: '', mcp: true }] }))
  // Beneath the plugins, no settings rule allows anything; what reaches here was not allowed above.
  const reached: string[] = []
  on('tool.check', (_, e) => {
    reached.push(e.tool)
    return { decision: 'ask' as const, reason: 'no rule' }
  })
  const called: string[] = []
  on('tool.call', (_, e) => {
    called.push((e as unknown as { tool: string }).tool)
    return { result: '[]', text: '[]' }
  })

  // Mounting reads the settings; a check raised by the test itself, not by log-time, is left to the ordinary rules.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The panel's own calls (the projects on mounting and in the settings) go to the account's server and are
  // allowed by log-time, so none of them gets here.
  await ui.press({ key: 'settings' })
  expect(reached).toEqual([])
  const verdict = await $.tool.check({ tool: 'mcp__new-pms__worklog_create', input: {} })
  expect(verdict.decision).toBe('ask')
  expect(reached).toEqual(['mcp__new-pms__worklog_create'])
  expect(called.length > 0 && called.every(t => t.startsWith('mcp__new-pms__'))).toBe(true)
  await ui.unmount()
})
