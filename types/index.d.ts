export type LogTimeView = 'day' | 'week' | 'month'

declare module 'claude-code' {
  interface PluginState {
    'log-time': { date: string; view: LogTimeView; account: string }
  }
}
