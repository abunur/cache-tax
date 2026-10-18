import type { EngineInterface, Register } from 'claude-code'
import { statusIcons } from './status-icons'

// After every warm ping, so a cache display (cache-meter) can restart its countdown; contract in types/index.d.ts.
const LAST_PING = { plugin: 'cache-tax', key: 'lastPing' } as const

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
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
// Origins a person typed or sent keep the guard. Every other origin (task notifications, schedules, peer
// sessions, relays, observers, and also channels, auto-continuations and unclassified prompts, which upstream
// 2.2.2 still guards) has no one to resend a refused send, so it goes through priced.
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

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
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
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  inFlight: boolean
  stepWrites: { usd: number; priced: boolean } | null
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

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
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
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
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
  s.waitForTurn = false
  s.stepWrites = null
  outdate(s)
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
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
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

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
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
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  const offs = s.offs
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) await $.store.delete(KEY_ALWAYS)
  const now = await $.clock.now()
  // A loop that stopped itself keeps its reason for a later status, even after a restart; one turned off or run out leaves nothing.
  if (why) {
    s.lastStop = { at: now, why }
    // An off that landed during the deletes above has already removed the record; the reason is not written back.
    if (s.offs === offs) await save($, s, { stop: s.lastStop })
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
  const offs = s.offs
  try {
    const at = await $.clock.now()
    // A /keepwarm off before or during the clock read deleted the window and its record; writing now would bring
    // the record back. Only a loop's own stop reason outlives its window. Nothing awaits from here to the write.
    if (s.offs !== offs || (!s.deadline && !extra.stop)) return
    const rec: Rec = {
      at, warmAt: s.lastRequestAt, ctx: s.ctx, model: s.lastModel, cwd: s.cwd, title: s.title,
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
      // No cache clock: the session ended before any turn reached its cache, so there is nothing to revive or price.
      if (!rec.warmAt) continue
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
  return `restarted after Claude came back with ${fmtDuration(s.lastRequestAt + TTL_MS - now)} of warm cache left; the window is kept and no turn was run, and pings resume after the next turn here, since a new process has nothing to fork before one`
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function reportText(rows: ReviveRow[], now: number, version: string | null): { title: string; body: string; summary: string } {
  const quitAt = Math.min(...rows.map(r => r.rec.endedAt ?? now))
  const lines = [`Claude quit at ${when(quitAt)} and was back at ${when(now)}. These sessions had /keepwarm on when it quit.`, '']
  for (const r of rows) {
    const name = r.rec.title ?? (r.rec.cwd ? r.rec.cwd.split('/').filter(Boolean).pop() : null) ?? r.sid.slice(0, 8)
    const price = priceOf(r.rec.model, r.rec.ctx)
    const reopen = `reopening it re-writes ${r.rec.ctx.toLocaleString('en-US')} tokens, about ${fmtUsd(price ? r.rec.ctx * price[1] / 1e6 : null)}`
    const what = r.revived === 'sent' ? `restarted automatically with ${fmtDuration(r.warmLeft)} of warm cache left; its window is kept and pings resume after its next turn, so one message there before ${when(r.rec.warmAt + TTL_MS)} keeps it warm`
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
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + TTL_MS - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + TTL_MS - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
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

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  // A /keepwarm off that lands while this awaits wins: the window it cancelled is not written back.
  const offs = s.offs
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
  // An off during the arm took the window and its record with it; nothing below may write them back.
  if (s.offs !== offs) return
  // Armed straight after the deadline is stored; the desktop lookup, a process run, and the record follow.
  // save() itself skips the write if an off lands during the lookup.
  await lookupDesktop($, s)
  await save($, s)
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
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, inFlight: false, stepWrites: null,
  }
}

export const register: Register = on => {
  const s = freshState()
  let light = false
  let noColor = false
  // This session's record as session.start found it. Always re-arming there saves a new record before the
  // resume handler runs, with no cache clock yet, so the resume reads this copy instead.
  let startRec: { sid: string; rec: Rec } | null = null

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
    startRec = own ? { sid: s.sid, rec: own } : null
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
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_MS ? savedEvery : PING_AFTER_MS
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
    // Only the first SessionStart after this process's session.start may use the record read there.
    const fromStart = startRec && startRec.sid === s.sid ? startRec.rec : null
    startRec = null
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      // No session.start fires after /clear, so this is where always arms the new conversation.
      if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      // A window armed while this handler awaited lost its timer to resetForClear; arm it again.
      else if (s.deadline) await arm($, s)
      else updateStatus($, s, await $.clock.now())
      return r
    }
    const now = await $.clock.now()
    let line = seedFromResume(s, e, now)
    if (!s.title && typeof e.session_title === 'string' && e.session_title) s.title = e.session_title
    if (e.source === 'resume') {
      // The payload dates the last reply, not the last ping; this session's own record knows when the cache was last touched.
      const own = fromStart ?? asRec(await $.store.get(recKey(s.sid)))
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
      // As at each turn's roll: a longer window the user set keeps its deadline, and the period goes back to the default.
      const windowMs = Math.max(DEFAULT_WINDOW_MS, s.deadline - now)
      await startWindow($, s, windowMs, PING_AFTER_MS)
      const kept = windowMs > DEFAULT_WINDOW_MS && s.deadline ? `, and this one keeps its ${fmtDuration(s.deadline - now)} window` : ''
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session stays warm until ${fmtDuration(DEFAULT_WINDOW_MS)} after its last turn${kept}; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (!window) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        // A period of the cache's whole hour or more would fire only once the cache is already cold.
        if (period == null || period < MIN_PING_MS || period >= TTL_MS) return { text: 'every takes a period from 1m to 59m' }
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
    // A refused prompt that no person sent would be lost: nobody is there to send it again. That is every
    // origin but the human ones, and an SDK turn in a known automated envelope, named by its envelope.
    const envelope = ENVELOPE.exec(e.text)
    const unattended = !HUMAN_ORIGINS.has(e.origin.kind) || envelope !== null
    // A revive Claude Desktop handed in as a turn: the restart already re-armed keepwarm, a turn would only spend.
    if (unattended && e.text.includes(REVIVE_MARK)) return { drop: `cache-tax: ${reviveLine(s, now)}` }
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) {
      clearBlocked($, s)
      return next(e)
    }
    if (s.guard === 'warn' || unattended) {
      clearBlocked($, s)
      $.ui.log(`${guardText(s, now)} Sending anyway${unattended ? `, since this ${envelope?.[1] ?? e.origin.kind} prompt cannot be sent again` : ''}; keepwarm will hold the cache for ${fmtDuration(AUTO_WARM_MS)} once it lands.`)
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
    const r = yield* next(e)
    // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
    const u = r.usage
    if (!e.agentId && u) {
      const price = priceOf(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      const was = s.stepWrites ?? { usd: 0, priced: true }
      s.stepWrites = { usd: was.usd + (price ? u.cache_creation_input_tokens * price[1] / 1e6 : 0), priced: was.priced && price != null }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break up to six hours: each turn that reached the cache opens a window of at least six hours
    // at the default period, which brings back a stopped window, lengthens a shorter one and replaces a testing period.
    // Unlike upstream, a longer window the user set (/keepwarm 48h) keeps its deadline, and a turn with no usage,
    // which never reached the cache, rolls nothing.
    if (s.always && e.usage) await startWindow($, s, Math.max(DEFAULT_WINDOW_MS, s.deadline - now), PING_AFTER_MS)
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
        // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
        const price = priceOf(s.lastModel, prev || s.ctx)
        const usd = s.stepWrites?.priced ? s.stepWrites.usd : price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        if (s.deadline < now + AUTO_WARM_MS) {
          await startWindow($, s, AUTO_WARM_MS, s.every)
          $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}). Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.`)
        }
      }
    }
    s.coldWritePending = false
    s.stepWrites = null
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
      outdate(s)
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
