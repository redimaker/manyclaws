// The lanes (the page's Timeline): what each session on this computer was about over the last week, as blocks of a few
// words, each a stretch of its conversation on one thing. A session is read as turns: what its person typed, the last
// thing Claude said before the next prompt, and which tools ran. Claude Haiku, run here at high effort, breaks the turns
// into blocks where the work goes on without a break and where the topic turns, and says each block in a few words (deon,
// 2026-10-29: "Use Haiku at high on the remote machines to break down jsonl files into conversational blocks, looking for
// contiguous timelines as well as abrupt topic changes. Go back 7 days through all conversations and cache the results on
// the remote machines"). What it made is kept in the index, and a session is given to it again only for the turns said in
// it since, with the block it was last on, which those may carry on.
//
// Haiku spends Claude tokens, on the Claude account Claude Code is signed in to here: it is run only once one of the
// account's own devices has turned that on for this computer (agent.json, "lanes": { "on": true }). Until then, and for
// what it has not come to yet, a session's turns are put in rough blocks here by the time between them, named by the
// first prompt of each, which costs nothing.
//
// Which session was copied from which is read off the index too, as the page draws a line between them: one Claude Code
// copied (--fork-session) begins with the lines of the one it was copied from, their ids and times as they were; and one
// the page started with reference to another says so in its first prompt, which names the other's transcript.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { typedPrompt } from './store.mjs'

export const LANES_DAYS = 7
const WINDOW_MS = LANES_DAYS * 86400_000
const QUIET_MS = 3 * 60_000 // a session's new turns are given Haiku once it has been quiet this long
const AGAIN_MS = 30 * 60_000 // or, while it goes on without a pause, every half hour; its last turn waits for the pause
const TICK_MS = 20_000 // how often the sessions are looked over for what is to be done
const TURNS_MAX = 80 // the most turns Haiku is given at once
const CHARS_MAX = 40_000 // and the most text
const CALL_MS = 4 * 60_000 // how long Haiku is given for one
const RETRY_MS = 20 * 60_000 // a session Haiku could not do is tried again this long after, and longer each time
const GAP_MS = 20 * 60_000 // a rough block ends where its session was quiet this long
const COPIED_MS = 60_000 // a session whose transcript begins this much later than its first message is a copy of another
const BREAK_MS = 2 * 3600_000 // and a block of Haiku's is carried on past a pause this long as a piece of its own
const MODEL = 'haiku'
const EFFORT = 'high'
// (searches the page asked Haiku for are no conversation of anyone's: web/app.js, HAIKU_SAYS)
const HAIKU_SAYS = 'Search the Claude Code transcripts on this computer for:'
// (the first prompt of a session the page started with reference to another: web/app.js, referAsk)
const REFERRED = /^Forked from (?:the session "([\s\S]*?)"|another Claude Code session)\. You are a new session[\s\S]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl\s+We are forking from it as it stood at (\S+?),/

// What Haiku answers with: its blocks, each from the number of its first turn; and whether the first of them carries on
// with the block the session was on before
const SCHEMA = {
  type: 'object',
  properties: {
    continues: { type: 'boolean' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'integer' }, says: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['from', 'says', 'tags'],
      },
    },
  },
  required: ['continues', 'blocks'],
}

// A session in a folder for what is temporary, or inside one whose name starts with a dot (a test's, a tool's own), is
// nobody's conversation to show
const TEMP = /^(\/private)?\/(tmp|var\/tmp|var\/folders)(\/|$)/
export function shownFolder(cwd) {
  const c = String(cwd ?? '')
  if (!c) return true
  if (c.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..')) return false
  const temp = os.tmpdir()
  return !TEMP.test(c) && !(temp && (c === temp || c.startsWith(temp + path.sep)))
}

const oneLine = (text, max) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

// A session's lines, in order (the index's: `{ uuid, ts, role, origin, text }`, not what tools returned), as turns: each
// begins where its person typed a prompt, and has the last thing Claude said in it and how many times each tool ran
export function turnsOf(docs) {
  const turns = []
  let t = null
  for (const d of docs) {
    const said = d.role === 'user' ? typedPrompt(d.text, d.origin) : ''
    if (said || !t) {
      t = { uuid: d.uuid, ts: d.ts, end: d.ts, you: said, claude: '', tools: {}, told: 0 }
      turns.push(t)
      if (said) continue
    }
    t.end = Math.max(t.end, d.ts)
    if (d.role === 'assistant') t.claude = d.text
    else if (d.role === 'tool') {
      const name = String(d.text).split(' ')[0] || 'tool'
      t.tools[name] = (t.tools[name] ?? 0) + 1
    } else if (d.role === 'user') t.told++
  }
  return turns
}

// Turns put in blocks by the time between them alone, each named by its first prompt: what is shown until Haiku has
// read them, and where it is not asked to
export function roughBlocks(turns) {
  const blocks = []
  let b = null
  for (const t of turns) {
    if (!b || t.ts - b.end >= GAP_MS) {
      b = { uuid: t.uuid, ts: t.ts, end: t.end, says: '', tags: [], n: 0, rough: true }
      blocks.push(b)
    }
    b.end = Math.max(b.end, t.end)
    b.n++
    if (!b.says && t.you) b.says = oneLine(t.you, 60)
  }
  return blocks
}

const clock = (ts) => new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const toolsSaid = (tools) =>
  Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ${n}` : name))
    .join(', ')

// What Haiku is asked, for turns numbered from `first`; `before` is the block the session was on before them, if any
export function lanesAsk({ title, cwd, turns, first, before, fork }) {
  const said = turns.map((t, i) => {
    const lines = [`[${first + i}] ${clock(t.ts)}${t.end - t.ts >= 60_000 ? ' – ' + clock(t.end).split(' ').pop() : ''}`]
    lines.push(t.you ? 'You: ' + oneLine(t.you, 600) : '(no prompt typed: the session went on by itself' + (t.told ? ', or was told something by a task or another session' : '') + ')')
    if (t.claude) lines.push('Claude: ' + oneLine(t.claude, 400))
    const tools = toolsSaid(t.tools)
    if (tools) lines.push('Tools: ' + tools)
    return lines.join('\n')
  })
  return [
    'These are turns of one Claude Code session, in order: what its person typed ("You"), the last thing Claude said in that turn ("Claude"), and the tools it ran. Each turn is numbered, with when it began and ended.',
    'Break them into blocks. A block is a stretch of work on one thing, carried on without a long break. Begin a new block where the topic changes abruptly, or where the person comes back after a long gap to something else. Small follow-ups ("ok", "go on", "commit it", "deploy") belong to the block they follow. A block may be one turn or many.',
    [
      'For each block give:',
      `- from: the number of its first turn (the first block's is ${first})`,
      '- says: what it was about, in two to six words, the way a person would say it in conversation ("Fixing the login redirect", "Release notes for 6.2", "Why the deploy hangs"): no ending punctuation, no quotes, not beginning with "User" or "Claude"',
      '- tags: three to five lowercase keywords for its topic: the names of the particular things worked on, not verbs, and not the name of the project or folder itself, which every block of the session shares. They are how the same topic is recognized in another session.',
    ].join('\n'),
    before
      ? `Before these turns the session was on: "${before.says}" (${before.tags.join(', ')}), last at ${clock(before.end)}. Say continues: true if the first of these turns carries on with that, and false if it starts something else.`
      : 'Say continues: false.',
    `The session${title ? ` is called "${oneLine(title, 120)}", and` : ''} runs in ${cwd || 'an unknown folder'}.${fork?.title ? ` It was forked from the session "${oneLine(fork.title, 120)}".` : ''}`,
    said.join('\n\n'),
  ].join('\n\n')
}

// Haiku's answer, held to the turns it was given: blocks in order, the first from the first turn, each said in a few words
export function blocksFrom(answer, turns, first) {
  const raw = Array.isArray(answer?.blocks) ? answer.blocks : []
  const starts = new Map()
  for (const b of raw) {
    const from = Number(b?.from)
    if (!Number.isInteger(from) || from < first || from >= first + turns.length || starts.has(from)) continue
    const says = oneLine(String(b.says ?? '').replace(/^["'“]+|["'”.]+$/g, ''), 60)
    const tags = (Array.isArray(b.tags) ? b.tags : []).map((t) => oneLine(String(t).toLowerCase(), 32)).filter(Boolean).slice(0, 5)
    starts.set(from, { says, tags })
  }
  if (!starts.size) return null
  // (the first block begins with the first turn, whatever it was said to begin with)
  const order = [...starts.keys()].sort((a, b) => a - b)
  if (order[0] !== first) {
    starts.set(first, starts.get(order[0]))
    starts.delete(order[0])
    order[0] = first
  }
  return order.flatMap((from, i) => {
    const mine = turns.slice(from - first, (order[i + 1] ?? first + turns.length) - first)
    const { says, tags } = starts.get(from)
    return pieces(mine, { says: says || oneLine(mine.find((t) => t.you)?.you ?? '', 60), tags })
  })
}

// A block's turns, as the piece or pieces it is drawn in: one carried on after a pause of hours (overnight, say) goes on
// in a piece of its own, which says the same (`cont`), so that the page's time break falls between the two
function pieces(turns, { says, tags }, cont = false) {
  const out = []
  for (const t of turns) {
    const last = out.at(-1)
    if (last && t.ts - last.end < BREAK_MS) {
      last.end = Math.max(last.end, t.end)
      last.n++
    } else out.push({ uuid: t.uuid, ts: t.ts, end: t.end, says, tags, n: 1, ...(last || cont ? { cont: true } : {}) })
  }
  return out
}
// (the first of Haiku's blocks, which carries on with the block the session was on before: that one goes on, after a
// pause of hours in a piece of its own)
export function carryOn(before, carried) {
  if (carried.ts - before.end >= BREAK_MS) return [{ ...carried, says: before.says, tags: [...new Set([...before.tags, ...carried.tags])].slice(0, 5), cont: true }]
  before.end = Math.max(before.end, carried.end)
  before.n += carried.n
  before.tags = [...new Set([...before.tags, ...carried.tags])].slice(0, 5)
  return []
}

export class Lanes {
  // `claude`: where Claude Code is, asked each time; `env`: the environment it is run with; `on`: whether Haiku is asked
  constructor({ store, claude, env = () => process.env, log = () => {}, on = false, roots = [] }) {
    this.store = store
    this.claude = claude
    this.env = env
    this.log = log
    this.roots = roots
    this.on = false
    this.working = null // the session Haiku is reading now: { sid, proc }
    this.forks = new Map() // sid -> { fork, at }: what it was forked from, or null, and when that was worked out
    this.turnsKept = new Map() // sid -> { key, from, turns }, most recently used last
    this.timer = null
    this.why = '' // why Haiku could not do the last it was asked, if it could not
    this.setOn(on)
  }

  setOn(on) {
    this.on = !!on
    clearTimeout(this.timer)
    this.timer = null
    if (!this.on) {
      this.working?.proc?.kill()
      return
    }
    this.soon(1000)
  }

  soon(ms = TICK_MS) {
    clearTimeout(this.timer)
    if (!this.on) return
    this.timer = setTimeout(() => this.tick().catch((err) => this.log('lanes:', err?.stack ?? err)), ms)
    this.timer.unref?.()
  }

  stop() {
    this.on = false
    clearTimeout(this.timer)
    this.working?.proc?.kill()
  }

  // The sessions of the last week that are shown: with something said in them, in a folder that is somebody's, and not a
  // search the page asked Haiku for
  sessions(since) {
    return this.store.laneSessions(since).filter((s) => shownFolder(s.cwd) && !String(s.first_prompt ?? '').startsWith(HAIKU_SAYS))
  }

  // What a session was forked from (`{ from, at, uuid, how, title? }`: `uuid` is the last line the two have in common, or
  // the new one's first), or null; worked out once (that it was none, again in a while: the one it came from may not
  // have been indexed yet)
  forkOf(s) {
    const kept = this.forks.get(s.sid)
    if (kept && (kept.fork || Date.now() - kept.at < 10 * 60_000)) return kept.fork
    let fork = null
    const head = this.store.laneHead(s.sid)
    const referred = head?.role === 'user' ? REFERRED.exec(head.text) : null
    if (referred && referred[2] !== s.sid) fork = { from: referred[2], at: Date.parse(referred[3]) || head.ts, uuid: head.uuid, how: 'refer', title: referred[1] ?? '' }
    else if (head && s.first_ts - head.ts >= COPIED_MS) {
      // A copy begins with what Claude Code wrote as it made it, at that time, and then the lines it copied, which are
      // older: the one it was copied from began with its own first line. Of the sessions that have that line and were
      // there before it, the one it was copied from is the one it has the most lines in common with (one copied from a
      // copy has the first line of each before it)
      let best = null
      for (const other of this.store.sameLine(head, s.sid)) {
        const them = this.store.session(other)
        if (!them || them.first_ts >= s.first_ts) continue
        const shared = this.store.sharedUntil(s.sid, other)
        if (shared && (!best || shared.ts > best.at || (shared.ts === best.at && them.first_ts < best.born))) best = { from: other, at: shared.ts, uuid: shared.uuid, how: 'copy', born: them.first_ts }
      }
      if (best) delete best.born
      fork = best
    }
    this.forks.set(s.sid, { fork, at: Date.now() })
    return fork
  }

  // A session's turns since `since`: after the lines it has in common with the one it was copied from, if it was
  // (kept while the session is as it was)
  turns(s, since) {
    const key = `${s.last_ts}:${s.size}`
    const kept = this.turnsKept.get(s.sid)
    this.turnsKept.delete(s.sid)
    if (kept?.key === key && kept.since === since) {
      this.turnsKept.set(s.sid, kept)
      return kept.turns
    }
    const fork = this.forkOf(s)
    let docs = this.store.laneDocs(s.sid, since)
    if (fork?.how === 'copy') {
      const at = docs.findIndex((d) => d.uuid === fork.uuid)
      docs = at >= 0 ? docs.slice(at + 1) : docs.filter((d) => d.ts > fork.at)
    }
    const turns = turnsOf(docs)
    // (the page's own first prompt for a fork is no conversation: it is said as what it is)
    if (fork?.how === 'refer' && turns[0]?.uuid === fork.uuid) turns[0].you = `(forked from the session "${fork.title || 'another'}")`
    this.turnsKept.set(s.sid, { key, since, turns })
    while (this.turnsKept.size > 64) this.turnsKept.delete(this.turnsKept.keys().next().value)
    return turns
  }

  // Of a session's turns, the one Haiku was last given (`at`, -1 where it was given none, or that one is gone) and the
  // ones after it
  split(turns, state) {
    if (!state?.upto) return { at: -1, fresh: turns }
    const at = turns.findIndex((t) => t.uuid === state.upto.uuid)
    return { at, fresh: at >= 0 ? turns.slice(at + 1) : turns.filter((t) => t.ts > state.upto.ts) }
  }

  // The week that is shown (or less, where the page asks for less), from the start of an hour, so that what is kept of a
  // session's turns is kept for an hour
  windowFrom(since = 0, now = Date.now()) {
    return Math.floor(Math.max(Number(since) || 0, now - WINDOW_MS) / 3600_000) * 3600_000
  }

  // The page's read: every session shown, with its blocks; what Haiku has not read yet is in rough ones
  read({ since } = {}) {
    const from = this.windowFrom(since)
    const sessions = []
    let pending = 0
    for (const s of this.sessions(from)) {
      const state = this.store.lane(s.sid)
      let blocks = (state?.blocks ?? []).filter((b) => b.end >= from)
      let lastInput = state?.lastInput ?? 0
      if (!state || s.last_ts > state.seen) {
        const turns = this.turns(s, from)
        const { at, fresh } = this.split(turns, state)
        // (what has been said since in the turn Haiku was last given is still that turn's block)
        if (at >= 0 && blocks.length) blocks.at(-1).end = Math.max(blocks.at(-1).end, turns[at].end)
        // (what is to come of it: not the turn that is still being said in one that is going on)
        if (fresh.length > (Date.now() - s.last_ts < QUIET_MS ? 1 : 0)) pending++
        blocks = blocks.concat(roughBlocks(fresh))
        lastInput = Math.max(lastInput, ...fresh.filter((t) => t.you).map((t) => t.ts))
      }
      if (!blocks.length) continue
      const fork = this.forkOf(s)
      sessions.push({
        sid: s.sid,
        cwd: s.cwd ?? '',
        title: s.title ?? '',
        // (a fork's own: the first of a copy's is the one it was copied from, and the page's first prompt for one is no prompt)
        first_prompt: fork ? (this.turns(s, from).find((t) => t.you && !t.you.startsWith('(forked from'))?.you ?? '').slice(0, 200) : String(s.first_prompt ?? '').slice(0, 200),
        first_ts: s.first_ts,
        last_ts: s.last_ts,
        lastInput,
        fork: fork ? { from: fork.from, at: fork.at, how: fork.how } : null,
        blocks,
      })
    }
    return { on: this.on, sessions, pending: this.on ? pending : 0, working: this.working?.sid ?? null, since: from, why: this.why || undefined }
  }

  // What is to be done next: the session with new turns that was last heard from, once it is quiet (or has gone on for
  // half an hour), and not one Haiku could not do a moment ago
  next(now = Date.now()) {
    const since = this.windowFrom(0, now)
    for (const s of this.sessions(since).sort((a, b) => b.last_ts - a.last_ts)) {
      const state = this.store.lane(s.sid)
      if (state && s.last_ts <= state.seen) continue
      if (state?.fails && now - state.at < RETRY_MS * Math.min(2 ** (state.fails - 1), 16)) continue
      const quiet = now - s.last_ts >= QUIET_MS
      if (state && !state.more && !quiet && now - state.at < AGAIN_MS) continue
      return { s, state, quiet, since }
    }
    return null
  }

  async tick() {
    if (!this.on || this.working) return
    const job = this.next()
    if (!job) {
      this.store.pruneLanes(this.windowFrom())
      return this.soon()
    }
    const { s, state, quiet, since } = job
    const fork = this.forkOf(s)
    const turns = this.turns(s, since)
    const { at, fresh } = this.split(turns, state)
    // (the last turn of a session that is going on is still being said: it waits for the session to pause)
    const ready = quiet ? fresh : fresh.slice(0, -1)
    const blocks = (state?.blocks ?? []).filter((b) => b.end >= since)
    if (at >= 0 && blocks.length) blocks.at(-1).end = Math.max(blocks.at(-1).end, turns[at].end)
    const kept = { seen: 0, upto: null, lastInput: 0, ...(state ?? {}), blocks, more: false, fails: 0 }
    if (!ready.length) {
      // Nothing new to give Haiku yet: seen as far as it goes, and the turn that is still being said waits
      this.store.saveLane(s.sid, { ...kept, seen: fresh.length ? kept.seen : s.last_ts, at: Date.now() })
      return this.soon(1000)
    }
    // As many as one ask takes
    const take = []
    let chars = 0
    for (const t of ready) {
      const size = (t.you?.length ?? 0) + Math.min(400, t.claude.length) + 80
      if (take.length && (take.length >= TURNS_MAX || chars + size > CHARS_MAX)) break
      take.push(t)
      chars += size
    }
    const before = blocks.at(-1) ?? null
    const prompt = lanesAsk({ title: s.title || '', cwd: s.cwd, turns: take, first: 1, before, fork: fork ? { title: fork.title || this.store.session(fork.from)?.title || '' } : null })
    const root = this.roots.find((r) => String(s.path ?? '').startsWith(r + path.sep)) ?? null
    this.working = { sid: s.sid, proc: null }
    let answer = null
    let why = ''
    try {
      answer = await this.haiku(prompt, root)
    } catch (err) {
      why = err.message
    }
    this.working = null
    // (turned off meanwhile, which stopped it: that is no failure)
    if (!this.on) return
    const made = answer && blocksFrom(answer, take, 1)
    if (!made) {
      // (tried again later, and later each time it is not done: a session Haiku cannot do is not asked of it over and over)
      const fails = (state?.fails ?? 0) + 1
      this.why = why || 'what Claude Haiku answered could not be read'
      this.log(`lanes: Haiku could not read ${s.sid} (${fails} time${fails === 1 ? '' : 's'}): ${this.why}`)
      this.store.saveLane(s.sid, { ...kept, at: Date.now(), fails })
      return this.soon(5000)
    }
    this.why = ''
    // (the first block may be the one the session was on before, carried on)
    if (answer.continues === true && before && made.length) {
      const carried = made.shift()
      const after = []
      while (made[0]?.cont) after.push({ ...made.shift(), says: before.says })
      made.unshift(...carryOn(before, carried), ...after)
    }
    const upto = take.at(-1)
    const more = take.length < ready.length
    this.store.saveLane(s.sid, {
      ...kept,
      // (seen to the end where every new turn was given, else as far as those that were)
      seen: take.length < fresh.length ? Math.max(kept.seen, upto.end) : s.last_ts,
      upto: { uuid: upto.uuid, ts: upto.ts },
      blocks: blocks.concat(made),
      lastInput: Math.max(kept.lastInput, ...take.filter((t) => t.you).map((t) => t.ts)),
      at: Date.now(),
      more,
    })
    this.log(`lanes: ${s.sid}: ${take.length} turn${take.length === 1 ? '' : 's'} read by Haiku, ${blocks.length + made.length} block${blocks.length + made.length === 1 ? '' : 's'}${more ? ', more to come' : ''}`)
    this.soon(1000)
  }

  // One ask of Claude Haiku, at high effort, through Claude Code: with no tools, no MCP servers, no hooks, and not the
  // ManyClaws plugin (whose session it would otherwise be, on the page), and with nothing of it kept on disk. Its answer,
  // as the schema has it
  haiku(prompt, root) {
    const claude = this.claude()
    if (!claude) return Promise.reject(new Error('Claude Code was not found on this machine'))
    const env = { ...this.env() }
    if (root && path.resolve(root) !== path.join(os.homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = root
    const settings = JSON.stringify({ enabledPlugins: { 'manyclaws@manyclaws': false }, disableAllHooks: true })
    const argv = ['-p', '--model', MODEL, '--effort', EFFORT, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence', '--settings', settings, '--tools', '', '--strict-mcp-config']
    return new Promise((done, failed) => {
      const proc = spawn(claude, argv, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      if (this.working) this.working.proc = proc
      let out = ''
      let err = ''
      const timer = setTimeout(() => proc.kill(), CALL_MS)
      proc.stdout.on('data', (c) => (out += c))
      proc.stderr.on('data', (c) => (err = (err + c).slice(-2000)))
      proc.on('error', (e) => (err += e.message))
      proc.on('close', (code, signal) => {
        clearTimeout(timer)
        let result = null
        try {
          result = JSON.parse(out)
        } catch {}
        if (result && !result.is_error && result.structured_output && typeof result.structured_output === 'object') return done(result.structured_output)
        const why = result?.is_error ? String(result.result ?? result.subtype ?? 'it failed') : signal ? `it was stopped (${signal})` : `it ended with ${code}`
        failed(new Error(oneLine(why + (err.trim() ? ': ' + err.trim().split('\n').at(-1) : ''), 300)))
      })
      proc.stdin.on('error', () => {})
      proc.stdin.end(prompt)
    })
  }
}
