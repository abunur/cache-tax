/** Published after every warm keepwarm ping, so a cache display (cache-meter) can restart its countdown from it. */
export type LastPing = { at: number; read: number; write: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-tax': { lastPing: LastPing | null }
  }
}
