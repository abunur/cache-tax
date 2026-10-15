import type { EngineInterface, Register } from 'claude-code'
import { statusIcons } from './status-icons'

// After every warm ping, so a cache display (cache-meter) can restart its countdown; contract in types/index.d.ts.
const LAST_PING = { plugin: 'cache-tax', key: 'lastPing' } as const

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
const KEY_REC = 'rec'
const RECORD_KEEP_MS = 7 * 24 * 60 * 60 * 1000
// A session revived with less warm time than this would only ping into a cache about to expire.
const REVIVE_MARGIN_MS = 3 * 60 * 1000
const REVIVE_MARK = '[cache-tax revive]'
const REVIVE_TEXT = `${REVIVE_MARK} Claude restarted while this session's cache was still warm; keepwarm resumes here. No reply needed.`
// Origins a person typed or sent; everything else (peer sessions, triggers, relays) has no one to resend a refused send.
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
// Claude Desktop hands some automated deliveries in as SDK turns; their envelope is the only tell.
const ENVELOPE = /^\s*<(cross-session-message|side-sessions-event|ci-monitor-event|task-notification)[\s>]/
const DESKTOP_SESSIONS = 'Library/Application Support/Claude/claude-code-sessions'
const BEAR_CLI = '/Applications/Bear.app/Contents/MacOS/bearcli'
const REPORT_TAG = 'claude/keepwarm'
const WATCH_LOCK = '.claude/cache-tax-revive.lock'

// Left behind by a session that ends with a live window: waits for Claude to quit and come back
// while the cache is still warm, then opens this one session; its start revives the rest by message.
// Args: $1 the epoch second the cache goes cold, $2 the session's claude:// link, $3 the lock dir.
const WATCH_SCRIPT = [
  'until=$1; link=$2; lock=$3',
  // Only a quit of the whole app counts; a single session stopping leaves Claude running.
  'i=0; while pgrep -x Claude >/dev/null; do i=$((i+1)); [ $i -gt 24 ] && exit 0; sleep 5; done',
  'while ! pgrep -x Claude >/dev/null; do [ "$(date +%s)" -ge "$until" ] && exit 0; sleep 10; done',
  'sleep 30',
  '[ "$(date +%s)" -ge "$until" ] && exit 0',
  // A session already started revives the others itself.
  "pgrep -f 'MacOS/claude ' >/dev/null && exit 0",
  'find "$lock" -maxdepth 0 -mmin +90 -exec rmdir {} \\; 2>/dev/null',
  'mkdir "$lock" 2>/dev/null || exit 0',
  'open -g "$link"',
  'sleep 120; rmdir "$lock" 2>/dev/null',
].join('\n')
const DETACH = 'exit 0 if fork; POSIX::setsid(); open STDIN, "</dev/null"; open STDOUT, ">/dev/null"; open STDERR, ">&STDOUT"; exec "/bin/sh", "-c", shift, "cache-tax-watch", @ARGV'

// $ per million tokens, [cache read, 1h cache write, output], list prices September 2026.
// Longer family names first: a model id matches the first row it contains.
const PRICES: Array<[string, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  /** The text of the prompt the guard dropped, kept so the band can offer to resend it. */
  blocked: string | null
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  cwd: string | null
  title: string | null
  /** The desktop's own id for this session (local_…), null outside Claude Desktop, undefined until looked up. */
  local: string | null | undefined
  version: string | null
  /** Why and when the loop last stopped on its own, kept across restarts so a later status can say. */
  lastStop: { at: number; why: string } | null
}

/** What a session with a live window leaves in the store, so the next session after a quit can report and revive it. */
export type Rec = {
  at: number
  /** The last request that touched the cache, pings included; the resume payload only knows the last reply. */
  warmAt: number
  ctx: number
  model: string | null
  cwd: string | null
  title: string | null
  local: string | null
  version: string | null
  deadline: number
  every: number
  endedAt?: number
  endReason?: string
  stop?: { at: number; why: string }
  handledAt?: number
}

export type ReviveRow = { sid: string; rec: Rec; warmLeft: number; revived: 'sent' | 'skipped' | string }

function priceOf(model: string | null): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.ackedAt = 0
  s.coldWritePending = false
  s.blocked = null
  s.misses = []
  s.local = undefined
  s.lastStop = null
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = now - e.seconds_since_last_response * 1000
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
}

function clearBlocked($: EngineInterface, s: State) {
  if (s.blocked === null) return
  s.blocked = null
  if (s.hasBand) $.ui.invalidate('ui.render')
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  const now = await $.clock.now()
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) {
    s.always = false
    await $.store.delete(KEY_ALWAYS)
  }
  // A loop that stopped itself keeps its reason for a later status, even after a restart; one turned off or run out leaves nothing.
  if (why) {
    s.lastStop = { at: now, why }
    await save($, s, { stop: s.lastStop })
  } else {
    await $.store.delete(recKey(s.sid))
  }
  updateStatus($, s, now)
}

function recKey(sid: string): string {
  return `${KEY_REC}:${sid}`
}

function asRec(v: unknown): Rec | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Rec
  return typeof r.deadline === 'number' && typeof r.warmAt === 'number' && typeof r.at === 'number' ? r : null
}

/** Writes this session's record; a store failure must never break a turn, a ping or the end. */
async function save($: EngineInterface, s: State, extra: Partial<Rec> = {}) {
  if (!s.sid) return
  try {
    const rec: Rec = {
      at: await $.clock.now(), warmAt: s.lastRequestAt, ctx: s.ctx, model: s.lastModel, cwd: s.cwd, title: s.title,
      local: s.local ?? null, version: s.version, deadline: s.deadline, every: s.every, ...extra,
    }
    await $.store.set(recKey(s.sid), rec)
  } catch {
    // The record only serves a report after a quit.
  }
}

type DesktopRow = { local: string; title: string | null; isArchived: boolean }

/** Claude Desktop keeps one file per session naming its own id beside the CLI's; outside the desktop there is none. */
async function desktopRow($: EngineInterface, sid: string): Promise<DesktopRow | null> {
  try {
    const home = await $.env.get('HOME')
    if (!home || !sid) return null
    const { exitCode, stdout } = await $.process.run([
      '/bin/sh', '-c', 'f=$(grep -rlF --include="local_*.json" "$1" "$2" 2>/dev/null | head -1); [ -n "$f" ] && cat "$f"',
      'cache-tax-lookup', sid, `${home}/${DESKTOP_SESSIONS}`,
    ], { timeoutMs: 5000 })
    if (exitCode !== 0 || !stdout) return null
    const row = JSON.parse(stdout) as { sessionId?: unknown; cliSessionId?: unknown; title?: unknown; isArchived?: unknown }
    if (row.cliSessionId !== sid || typeof row.sessionId !== 'string') return null
    return { local: row.sessionId, title: typeof row.title === 'string' && row.title ? row.title : null, isArchived: row.isArchived === true }
  } catch {
    return null
  }
}

/** Once per process: the desktop id that a claude:// link and a peer message need, and the title the sidebar shows. */
async function lookupDesktop($: EngineInterface, s: State) {
  if (s.local !== undefined) return
  const row = await desktopRow($, s.sid)
  s.local = row?.local ?? null
  if (row?.title) s.title = row.title
}

/**
 * Leaves a detached watcher behind a session that Claude is shutting down with its cache still warm.
 * If the whole app comes back before the cache goes cold and nothing has started, it opens this
 * session, whose start then revives the others by message.
 */
async function watchForRelaunch($: EngineInterface, s: State, now: number) {
  const until = s.lastRequestAt + TTL_MS - REVIVE_MARGIN_MS
  if (!s.local || s.compacted || until - now < 5 * 60 * 1000) return
  const home = await $.env.get('HOME')
  if (!home) return
  await $.process.run([
    '/usr/bin/perl', '-MPOSIX', '-e', DETACH, WATCH_SCRIPT,
    String(Math.floor(until / 1000)), `claude://code/continue?session=${s.local}`, `${home}/${WATCH_LOCK}`,
  ], { timeoutMs: 1000 })
}

/**
 * Run by the first session to start after Claude quit: every other session that was shut down with a
 * live window is either revived (its cache still warm, same Claude Code version, still in the sidebar)
 * or listed with the price of reopening it.
 */
async function reviveOthers($: EngineInterface, s: State) {
  try {
    const now = await $.clock.now()
    const rows: ReviveRow[] = []
    for (const key of await $.store.keys()) {
      if (!key.startsWith(KEY_REC + ':')) continue
      const sid = key.slice(KEY_REC.length + 1)
      if (sid === s.sid) continue
      const rec = asRec(await $.store.get(key))
      if (!rec) continue
      if (now - rec.at > RECORD_KEEP_MS) {
        await $.store.delete(key)
        continue
      }
      // Only a session shut down under it, not one left by choice, and each shutdown once.
      if (!rec.endedAt || !(rec.endReason === 'other' || (rec.local && rec.endReason === 'prompt_input_exit'))) continue
      if (rec.deadline <= now || (rec.handledAt ?? 0) >= rec.endedAt) continue
      await $.store.set(key, { ...rec, handledAt: now })
      const row = rec.local ? await desktopRow($, sid) : null
      if (row?.isArchived) continue
      const warmLeft = rec.warmAt + TTL_MS - now
      let revived: ReviveRow['revived'] = 'skipped'
      // A new Claude Code version builds a different prompt prefix, so its ping would re-write the whole context.
      if (warmLeft > REVIVE_MARGIN_MS && (!rec.version || !s.version || rec.version === s.version)) {
        try {
          const sent = await $.session.send({ to: rec.local ?? { sessionId: sid }, text: REVIVE_TEXT })
          revived = sent.isDelivered ? 'sent' : sent.reason
        } catch (err) {
          revived = err instanceof Error ? err.message : String(err)
        }
      }
      rows.push({ sid, rec: { ...rec, title: row?.title ?? rec.title }, warmLeft, revived })
    }
    if (rows.length) await report($, s, rows, now)
  } catch {
    // A report that fails must not disturb the session that happened to start first.
  }
}

function reviveLine(s: State, now: number): string {
  if (!s.deadline || !s.lastRequestAt || isCold(s, now)) return 'restarted after Claude came back, but the cache had already gone cold; keepwarm waits for the next turn'
  return `restarted after Claude came back with ${fmtDuration(s.lastRequestAt + TTL_MS - now)} of warm cache left; keepwarm carries on and no turn was run`
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function reportText(rows: ReviveRow[], now: number, version: string | null): { title: string; body: string; summary: string } {
  const quitAt = Math.min(...rows.map(r => r.rec.endedAt ?? now))
  const lines = [`Claude quit at ${when(quitAt)} and was back at ${when(now)}. These sessions had /keepwarm on when it quit.`, '']
  for (const r of rows) {
    const name = r.rec.title ?? (r.rec.cwd ? r.rec.cwd.split('/').filter(Boolean).pop() : null) ?? r.sid.slice(0, 8)
    const price = priceOf(r.rec.model)
    const reopen = `reopening it re-writes ${r.rec.ctx.toLocaleString('en-US')} tokens, about ${fmtUsd(price ? r.rec.ctx * price[1] / 1e6 : null)}`
    const what = r.revived === 'sent' ? `restarted automatically with ${fmtDuration(r.warmLeft)} of warm cache left; keepwarm carries on there`
      : r.warmLeft <= REVIVE_MARGIN_MS ? `cold since ${when(r.rec.warmAt + TTL_MS)}; ${reopen}`
      : r.revived === 'skipped' ? `not restarted, because Claude Code changed from ${r.rec.version} to ${version} and the old cache no longer matches; ${reopen}`
      : `could not be restarted (${r.revived}); its cache stays warm until ${when(r.rec.warmAt + TTL_MS)}, then ${reopen}`
    const link = r.rec.local ? ` [Open](claude://code/continue?session=${r.rec.local})` : ''
    lines.push(`- **${name}**: ${what}.${link}`)
  }
  const sent = rows.filter(r => r.revived === 'sent').length
  const summary = `${rows.length} keepwarm session${rows.length === 1 ? ' was' : 's were'} shut down when Claude quit; ` +
    (sent ? `${sent} restarted while still warm` : 'none was still warm') + (rows.length - sent ? `, ${rows.length - sent} left for you to reopen` : '')
  return { title: `Keepwarm sessions after Claude quit, ${when(now)}`, body: lines.join('\n'), summary }
}

/** One Bear note per return, a file when Bear is not there, a line in this session and a desktop notification. */
async function report($: EngineInterface, s: State, rows: ReviveRow[], now: number) {
  const { title, body, summary } = reportText(rows, now, s.version)
  let where = 'Bear'
  try {
    // bearcli reads \n and \\ as escapes in --content.
    const made = await $.process.run([BEAR_CLI, 'create', title, '--content', body.replace(/\\/g, '\\\\'), '--tags', REPORT_TAG], { timeoutMs: 15000 })
    if (made.exitCode !== 0) throw new Error(made.stderr)
  } catch {
    const home = await $.env.get('HOME')
    where = `${home ?? '~'}/.claude/cache-tax-report.md`
    try {
      await $.fs.write(where, `# ${title}\n\n${body}\n`)
    } catch {
      where = 'nowhere, the note and the file both failed'
    }
  }
  $.ui.log(`${summary}. Details in ${where === 'Bear' ? `Bear, "${title}"` : where}.`)
  try {
    await $.process.run(['/usr/bin/osascript', '-e', 'on run argv\ndisplay notification (item 1 of argv) with title "cache-tax"\nend run', summary], { timeoutMs: 5000 })
  } catch {
    // The note and the log line already carry it.
  }
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
    s.pending = $.clock.after(delay, () => { void ping($, s) })
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return arm($, s)
  // A turn in the meantime re-armed the timer; this callback is stale.
  if (isCold(s, now)) return arm($, s)
  if (now - s.lastRequestAt < s.every - 1000) return
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    return stop($, s, `the ping failed, ${err instanceof Error ? err.message : String(err)}`)
  }
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    const reason = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    return stop($, s, reason)
  }
  const u = reply.usage
  const price = priceOf(s.lastModel)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await save($, s)
  try {
    await $.state.set(LAST_PING,{ at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens })
  } catch {
    // A display that misses one ping is harmless; the warming loop must not stop over it.
  }
  await arm($, s)
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  const now = await $.clock.now()
  s.every = every
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  s.deadline = now + windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s), s.deadline)
  await lookupDesktop($, s)
  await save($, s)
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next turn, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  if (s.lastStop && s.lastStop.why !== s.stopped) lines.push(`last stop   ${when(s.lastStop.at)}, ${s.lastStop.why}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-tax guard warn to only show the price)' : 'warn only (/cache-tax guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

/** Pays a held cold write on the person's behalf: the dropped prompt goes back in as their own words. */
async function resend($: EngineInterface, s: State) {
  const text = s.blocked
  if (text === null) return
  const now = await $.clock.now()
  s.blocked = null
  s.ackedAt = 0
  // A plugin's own submission skips this mod's guard, so the cold write is marked here.
  s.coldWritePending = isCold(s, now) && s.ctx >= BIG_TOKENS
  updateStatus($, s, now)
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (err) {
    s.blocked = text
    s.coldWritePending = false
    updateStatus($, s, await $.clock.now())
    $.ui.toast(`cache-tax: resend failed, ${err instanceof Error ? err.message : String(err)}`)
  }
}

function preview(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > 48 ? line.slice(0, 47) + '…' : line
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    guard: 'refuse', ackedAt: 0, coldWritePending: false, blocked: null, misses: [], pending: null, last: null, stopped: null,
    cwd: null, title: null, local: undefined, version: null, lastStop: null,
  }
}

export const register: Register = on => {
  const s = freshState()
  let light = false
  let noColor = false

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const text = statusText(s, now)
    const showStatus = Boolean(text) && !(s.deadline && now >= s.deadline)
    const held = s.blocked
    if (!showStatus && held === null) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = [rest]
    if (showStatus) {
      const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
      const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
      const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
      const icon = noColor ? Text({ bold: true, children: ['[>]'] })
        : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
        : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Tax' })
        : Text({ color, bold: true, children: ['[>]'] })
      rows.push(Box({ flexDirection: 'row', alignItems: 'center', children: [
        Box({ flexShrink: 0, children: [icon] }),
        Text({ children: [
          ' cache-tax · ',
          Text({ color, bold: true, children: [state] }),
          ` · ${text}`,
        ] }),
      ] }))
    }
    if (held !== null) {
      rows.push(Box({ flexDirection: 'row', alignItems: 'center', gap: 1, children: [
        Text({ dimColor: true, children: [` held: "${preview(held)}"`] }),
        Button({ key: 'resend', label: 'Resend and pay', onPress: () => resend($, s) }),
      ] }))
    }
    return Box({ flexDirection: 'column', children: rows })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    if (s.hasBand) {
      const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
      light = typeof theme === 'string' && theme.startsWith('light')
      noColor = Boolean(await $.env.get('NO_COLOR'))
      $.ui.status(undefined)
    }
    s.sid = await $.session.id()
    s.cwd = typeof e.cwd === 'string' ? e.cwd : null
    try {
      s.version = (await $.session.version()).version
    } catch {
      s.version = null
    }
    const own = asRec(await $.store.get(recKey(s.sid)))
    if (own) {
      s.lastStop = own.stop ?? null
      s.title = own.title
      if (own.local) s.local = own.local
    }
    const now = await $.clock.now()
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means at least a fresh default window every session; a longer one this session set for itself is kept.
    if (s.always && s.deadline < now + DEFAULT_WINDOW_MS) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (cache-tax)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard warn|refuse (cache-tax, the Mod)',
      argumentHint: '[status | guard warn | guard refuse]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.')
    }
    updateStatus($, s, now)
    // Off the start's own path: the first session back after a quit revives or reports the rest.
    $.clock.after(3000, () => { void reviveOthers($, s) })
    return r
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      updateStatus($, s, await $.clock.now())
      return r
    }
    const now = await $.clock.now()
    let line = seedFromResume(s, e, now)
    if (!s.title && typeof e.session_title === 'string' && e.session_title) s.title = e.session_title
    if (e.source === 'resume') {
      // The payload dates the last reply, not the last ping; this session's own record knows when the cache was last touched.
      const own = asRec(await $.store.get(recKey(s.sid)))
      if (own && own.warmAt > s.lastRequestAt) {
        s.lastRequestAt = own.warmAt
        if (!s.ctx) s.ctx = own.ctx
        if (!s.lastModel) s.lastModel = own.model
        if (!isCold(s, now)) line = null
      }
      // Back up again: the record must no longer read as shut down.
      if (own?.endedAt && s.deadline) await save($, s)
    }
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    if (!s.lastModel) s.lastModel = await $.session.model()
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session stays warm until ${fmtDuration(DEFAULT_WINDOW_MS)} after its last turn; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (window == null) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        if (period == null || period < MIN_PING_MS) return { text: 'every takes a period of at least 1m' }
        every = period
      }
      await startWindow($, s, window, every)
      return { text: armedText(s, now, window) }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/cache-tax guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // A revive that came as a peer delivery: the process restart was the point, so nothing is queued.
  on('session.receive', async ($, e, next) => {
    if (!e.text.includes(REVIVE_MARK)) return next(e)
    $.ui.log(reviveLine(s, await $.clock.now()))
    return { consumed: 'cache-tax revive' }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    // Nobody is there to resend a refused peer message or trigger, so those are priced, never dropped.
    const automated = !HUMAN_ORIGINS.has(e.origin.kind) || ENVELOPE.test(e.text)
    // A revive Claude Desktop handed in as a turn: the restart already re-armed keepwarm, a turn would only spend.
    if (automated && e.text.includes(REVIVE_MARK)) return { drop: `cache-tax: ${reviveLine(s, now)}` }
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) {
      clearBlocked($, s)
      return next(e)
    }
    if (s.guard === 'warn' || automated) {
      clearBlocked($, s)
      const who = s.guard === 'warn' ? 'Sending anyway' : 'It came from another session or a trigger, so it goes through'
      $.ui.log(`${guardText(s, now)} ${who}; keepwarm will hold the cache for ${fmtDuration(AUTO_WARM_MS)} once it lands.`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      clearBlocked($, s)
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    s.blocked = e.text
    if (s.hasBand) $.ui.invalidate('ui.render')
    return { drop: `cache-tax: ${guardText(s, now)} Send it again${s.hasBand ? ' or press Resend' : ''} to pay it, and keepwarm will then hold the cache for ${fmtDuration(AUTO_WARM_MS)}. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) s.lastRequestAt = await $.clock.now()
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // Always is a rolling window: each main-session turn pushes the deadline to six hours past it.
    if (s.always && s.deadline < now + DEFAULT_WINDOW_MS) {
      s.deadline = now + DEFAULT_WINDOW_MS
      s.stopped = null
      await $.store.set(deadlineKey(s), s.deadline)
    }
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    s.ackedAt = 0
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || s.coldWritePending) {
        const price = priceOf(s.lastModel)
        const usd = price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        if (s.deadline < now + AUTO_WARM_MS) {
          await startWindow($, s, AUTO_WARM_MS, s.every)
          $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}). Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.`)
        }
      }
    }
    s.coldWritePending = false
    if (s.deadline) {
      await lookupDesktop($, s)
      await save($, s)
    }
    await arm($, s)
    return r
  })

  // Shut down under a live window: leave the record the next session reports from, and a watcher for a quick relaunch.
  on('session.end', async ($, e, next) => {
    try {
      if (e.reason !== 'clear' && s.deadline) {
        const now = await $.clock.now()
        await save($, s, { endedAt: now, endReason: e.reason })
        if (e.reason === 'other' || e.reason === 'prompt_input_exit') await watchForRelaunch($, s, now)
      }
    } catch {
      // The end has a short budget; a missing record only means no report.
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.ctx = 0
      s.ackedAt = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
