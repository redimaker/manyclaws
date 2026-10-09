// Sessions the agent runs itself. Started or resumed on request, they run headless
// (Claude Code's stream-json mode, the way an editor hosts it) and stay open for more
// prompts until they've sat idle for a while. With the ManyClaws mod installed they
// report to the server like any session, and their permission prompts go to the page.
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
// The ones a machine allows where its owner named none
export const DEFAULT_MODES = MODES.filter((m) => m !== 'bypassPermissions')
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// What a Claude Code session tells its children about itself, which a session the agent
// starts must not take for its own. A service's environment is the account's, and the
// CLAUDE_CODE_ settings in it are the owner's choices (a Git Bash path, a token limit):
// those are passed on. An agent started from inside a session (by hand, by the tests)
// can't tell the two apart, and passes none.
const OF_A_SESSION = /^(CLAUDECODE$|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT)$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK|AI_AGENT$|MANYCLAWS_)/
const INHERITED = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK|AI_AGENT$|MANYCLAWS_)/
const insideSession = (env = process.env) => Object.keys(env).some((k) => k.toUpperCase() === 'CLAUDECODE')

// The environment a session the agent starts is given, from the one a terminal would have
export function sessionEnv(base, { inside = insideSession() } = {}) {
  const env = { ...base }
  const drop = inside ? INHERITED : OF_A_SESSION
  for (const k of Object.keys(env)) if (drop.test(k.toUpperCase())) delete env[k]
  return env
}

export class HostError extends Error {}

export class Host {
  constructor(config, { store, onChange = () => {}, log = () => {} }) {
    this.config = config
    // args and env are added to every session the agent starts: a default model, say.
    // max: how many it runs at once. One left idle keeps its place until it is closed
    // (idleMinutes), so the number is of those started in that long, working or not: at
    // 4 the fifth asked for within a quarter of an hour was refused. 64 is the owner's number.
    // modes: the permission modes a session may be started in or switched to. With no list
    // of its own a machine allows every one but bypassPermissions: a session with its
    // permissions bypassed does whatever it is prompted to, with nobody asked, so one is
    // started from a phone or a browser only where the machine's owner said so, on the
    // machine. A list in its agent.json ("spawn": { "modes": [...] }, or the installer's
    // --mode) is how its owner names them.
    this.spawnConfig = { enabled: false, folders: [], modes: DEFAULT_MODES, idleMinutes: 30, max: 64, args: [], env: {}, ...(config.spawn ?? {}) }
    this.store = store
    this.onChange = onChange
    this.log = log
    this.hosted = new Map() // sid -> { sid, proc, cwd, state, startedAt, lastActive, timer, tail }
    this.env = null
  }

  // What the server and the page are told about them
  list() {
    return [...this.hosted.values()].map(({ sid, cwd, state, startedAt, lastActive, proc, mode, model, effort }) => ({ sid, cwd, state, startedAt, lastActive, pid: proc.pid, mode, model, effort }))
  }

  // Every session open in a Claude Code process on this machine, the agent's own or
  // not, from the records Claude Code keeps: sid -> { pid, status, kind, entrypoint, cwd, name }
  open() {
    const out = {}
    for (const root of this.config.roots) {
      let names = []
      try {
        names = fs.readdirSync(path.join(root, 'sessions')).filter((n) => /^\d+\.json$/.test(n))
      } catch {}
      for (const name of names) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(root, 'sessions', name), 'utf8'))
          if (!r.sessionId || !alive(r.pid)) continue
          const mine = this.hosted.get(r.sessionId)?.proc.pid === r.pid // one the agent runs itself
          out[r.sessionId] = { pid: r.pid, status: r.status ?? '', kind: r.kind ?? '', entrypoint: r.entrypoint ?? '', cwd: r.cwd ?? '', name: r.name ?? '', updatedAt: r.updatedAt ?? 0, mine }
        } catch {}
      }
    }
    return out
  }

  // ---- Starting and resuming

  // `create`: the folder is made if it isn't there (a new project), inside a folder the owner listed.
  // `like`, in place of `cwd`: the folder a session ran in on another machine, for the one
  // here that is most like it. `idle`: started with nothing to do yet, waiting for its first prompt.
  // `listed`: whether Claude Code's own lists of sessions to resume are to show it (see setListing)
  start({ cwd, like, prompt, mode, model, effort, name, create = false, idle = false, listed }) {
    this.allow(mode)
    this.allowEffort(effort)
    if (!idle && !String(prompt ?? '').trim()) throw new HostError('a prompt is required')
    const folder = String(cwd ?? '').trim() ? this.folder(cwd, { create: create === true }) : this.folderLike(like)
    const sid = crypto.randomUUID()
    this.launch({ sid, cwd: folder, args: ['--session-id', sid], mode, model, effort, name, prompt, listed })
    return { sid, cwd: folder }
  }

  // The folder here that a session from elsewhere would run in: the same path if this
  // machine has it and allows it, else a folder of the same name under one the owner
  // listed, else the first of those the owner listed. A session is never started outside them.
  folderLike(like) {
    const roots = this.roots()
    if (!roots.length) throw new HostError('starting sessions is turned off on this machine (spawn.folders in agent.json)')
    const wanted = String(like ?? '').trim()
    if (wanted) {
      try {
        return this.folder(wanted)
      } catch {}
      // (a path from a machine of another kind: the name of its last folder is what carries over)
      const name = wanted.split(/[\\/]/).filter(Boolean).pop()
      if (name && name !== '.' && name !== '..') {
        for (const root of roots) {
          try {
            return this.folder(path.join(root, name))
          } catch {}
        }
      }
    }
    return roots[0]
  }

  // ---- A session carried from one machine to another: its transcript, whole, as Claude
  // Code wrote it, so that what the copy knows is exactly what the original knew

  // The transcript, packed small. `max`: what is too much to hold and send.
  exportSession({ sid, max = CARRY_MAX }) {
    const session = this.store.session(sid)
    if (!session?.path) throw new HostError('no such session on this machine')
    let packed
    try {
      packed = zlib.gzipSync(fs.readFileSync(session.path))
    } catch (err) {
      throw new HostError('the transcript could not be read: ' + err.message)
    }
    if (packed.length > max) throw new HostError(`the transcript is too large to carry over whole (${(packed.length / 1e6).toFixed(1)} MB packed)`)
    return { cwd: session.cwd ?? '', packed }
  }

  // A transcript from another machine, written here as a session of this one, in the
  // folder most like the one it ran in, and opened: idle, with all it knew, waiting for
  // its next prompt. Its lines are given the new session's id and folder, as Claude
  // Code would have written them had it run here.
  importSession({ packed, like, mode, model, effort, listed }) {
    this.allow(mode)
    this.allowEffort(effort)
    let lines
    try {
      lines = zlib.gunzipSync(packed).toString('utf8').split('\n')
    } catch {
      throw new HostError('what arrived is not a transcript')
    }
    const folder = this.folderLike(like)
    const sid = crypto.randomUUID()
    const out = []
    let rows = 0
    for (const line of lines) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!row || typeof row !== 'object') continue
      if (typeof row.sessionId === 'string') row.sessionId = sid
      if (typeof row.cwd === 'string') row.cwd = folder
      out.push(JSON.stringify(row))
      rows++
    }
    if (!rows) throw new HostError('the transcript that arrived is empty')
    // (written here, it is marked here: shown or not, whatever the one it was copied from was)
    if (typeof listed === 'boolean') out[0] = relabelled(out, listed)
    const root = this.config.roots[0] ?? path.join(os.homedir(), '.claude')
    const dir = path.join(root, 'projects', projectFolder(folder))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), out.join('\n') + '\n', { mode: 0o600 })
    this.launch({ sid, cwd: folder, root, args: ['--resume', sid], mode, model, effort, listed })
    return { sid, cwd: folder, rows }
  }

  // A reply to a session nobody has open: Claude Code is started on it again. One that
  // is open elsewhere would get a second writer, so that takes `fork`, which continues
  // in a copy under a new id.
  // (`idle`, with `fork`: the copy is opened with nothing to do yet, waiting for its first prompt)
  async resume({ sid, prompt, mode, model, effort, fork = false, idle = false, listed }) {
    this.allow(mode, { counted: false })
    this.allowEffort(effort)
    if (!(fork && idle) && !String(prompt ?? '').trim()) throw new HostError('a prompt is required')
    let mine = this.hosted.get(sid)
    // One that's on its way out is waited for: a reply written to it now would be lost
    if (mine?.closing) {
      await new Promise((done) => mine.proc.once('exit', done))
      mine = null
    }
    // (a reply to one it is running starts nothing, and one that has just gone left its place: neither is refused for room)
    if (mine && !fork) return this.send({ sid, text: prompt })
    this.room()
    const session = this.store.session(sid)
    if (!session) throw new HostError('no such session on this machine')
    const elsewhere = this.open()[sid]
    if (elsewhere && !elsewhere.mine && !fork) throw new HostError(`this session is open in another Claude Code (pid ${elsewhere.pid}${elsewhere.entrypoint ? ', ' + elsewhere.entrypoint : ''}); reply there, or continue in a copy`)
    const folder = this.folder(session.cwd)
    const id = fork ? crypto.randomUUID() : sid
    // (a copy is shown or not as asked; a session resumed in place stays as it was)
    this.launch({ sid: id, cwd: folder, root: session.root, args: fork ? ['--resume', sid, '--fork-session', '--session-id', id] : ['--resume', sid], mode, model, effort, prompt, listed: fork ? listed : undefined })
    return { sid: id, forked: fork, cwd: folder }
  }

  send({ sid, text }) {
    const h = this.hosted.get(sid)
    if (!h || h.closing) throw new HostError('the agent is not running this session')
    if (!String(text ?? '').trim()) throw new HostError('a prompt is required')
    h.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } }) + '\n')
    this.active(h, 'working')
    return { sid }
  }

  // A running session's permission mode is changed the way an editor changes it: a
  // control request down the session's input, answered on its output
  setMode({ sid, mode }) {
    const h = this.hosted.get(sid)
    if (!h || h.closing) throw new HostError('the agent is not running this session')
    this.allowMode(mode)
    if (!mode) throw new HostError('a permission mode is required')
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        h.asked.delete(id)
        reject(new HostError('Claude Code did not answer'))
      }, 15_000)
      h.asked.set(id, (response) => {
        clearTimeout(timer)
        if (response?.subtype !== 'success') return reject(new HostError(String(response?.error ?? 'Claude Code refused the change')))
        h.mode = mode
        this.onChange()
        resolve({ sid, mode })
      })
      h.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'set_permission_mode', mode } }) + '\n')
    })
  }

  stop({ sid }) {
    const h = this.hosted.get(sid)
    if (!h) throw new HostError('the agent is not running this session')
    this.close(h)
    setTimeout(() => this.hosted.get(sid) === h && h.proc.kill(), 10_000).unref()
    return { sid }
  }

  // With nothing more to read, it finishes what it's doing and exits
  close(h) {
    h.closing = true
    h.proc.stdin.end()
  }

  stopAll() {
    for (const h of this.hosted.values()) h.proc.kill()
  }

  // ---- The rules

  // (`counted`: whether room for one more is looked for here, or by the caller once it knows a session is to be started)
  allow(mode, { counted = true } = {}) {
    const c = this.spawnConfig
    if (!c.enabled) throw new HostError('starting sessions is turned off on this machine (spawn.enabled in agent.json)')
    if (counted) this.room()
    this.allowMode(mode)
  }

  // Room for one more session. The machine is said by name: the page shows the refusal
  // beside whichever device is chosen there, which need not be the one that refused.
  room() {
    const c = this.spawnConfig
    if (this.hosted.size >= c.max) throw new HostError(`${this.config.label || os.hostname()} is already running ${c.max} sessions for ManyClaws, the most it runs at once (spawn.max in its agent.json)`)
  }

  allowEffort(effort) {
    if (effort && !EFFORTS.includes(effort)) throw new HostError(`${effort} is not an effort level (${EFFORTS.join(', ')})`)
  }

  allowMode(mode) {
    if (mode && (!MODES.includes(mode) || !this.spawnConfig.modes.includes(mode))) throw new HostError(`permission mode ${mode} is not allowed on this machine`)
  }

  // The folders the machine's owner listed, as they really are on disk
  roots() {
    return this.spawnConfig.folders
      .map((f) => {
        try {
          return fs.realpathSync(path.resolve(expandHome(f)))
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  inside(real) {
    return this.roots().some((f) => sameCase(real) === sameCase(f) || sameCase(real).startsWith(sameCase(f) + path.sep))
  }

  // The folder a session may run in: one that exists, under a folder the machine's owner
  // listed. `create`: one that isn't there yet is made first, if where it would be is
  // under such a folder (judged by the nearest folder that does exist, links followed).
  folder(cwd, { create = false } = {}) {
    const wanted = path.resolve(expandHome(String(cwd ?? '')))
    if (create && String(cwd ?? '').trim() && !fs.existsSync(wanted)) {
      let nearest = wanted
      while (!fs.existsSync(nearest) && path.dirname(nearest) !== nearest) nearest = path.dirname(nearest)
      if (!this.inside(fs.realpathSync(nearest))) throw new HostError(`${wanted} is outside the folders this machine allows (spawn.folders in agent.json)`)
      fs.mkdirSync(wanted, { recursive: true })
      this.log(`made the folder ${wanted}`)
    }
    let real
    try {
      real = fs.realpathSync(wanted)
      if (!String(cwd ?? '').trim() || !fs.statSync(real).isDirectory()) throw new Error()
    } catch {
      throw new HostError(`${cwd || 'the folder'} is not a folder on this machine`)
    }
    if (!this.inside(real)) throw new HostError(`${real} is outside the folders this machine allows (spawn.folders in agent.json)`)
    return real
  }

  // The folders right under the ones the owner listed: projects a session could be
  // started in, whether or not one ever was. `unread` names the listed folders that
  // didn't answer in time.
  //
  // Read off the main thread and given only so long. macOS holds a service's first
  // read of some folders (an external disk, Documents) until someone answers a prompt on
  // the screen; read the plain way, the whole agent waited with it, and was offline.
  async subfolders({ limit = 500, waitMs = 2000 } = {}) {
    const roots = this.roots()
    const lists = await Promise.all(roots.map((root) => this.listing(root, waitMs)))
    const others = []
    lists.forEach((entries, i) => {
      for (const e of entries ?? []) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') others.push(path.join(roots[i], e.name))
    })
    return { others: others.sort((a, b) => a.localeCompare(b)).slice(0, limit), unread: roots.filter((_, i) => lists[i] === null) }
  }

  // A folder's entries, or null if it hasn't answered in `waitMs`. One read of a folder
  // at a time: each one held takes a thread the agent's name lookups need too.
  listing(dir, waitMs) {
    this.reading ??= new Map()
    let read = this.reading.get(dir)
    if (!read) {
      read = fs.promises
        .readdir(dir, { withFileTypes: true })
        .catch(() => [])
        .finally(() => this.reading.delete(dir))
      this.reading.set(dir, read)
    }
    let timer
    return Promise.race([read, new Promise((done) => (timer = setTimeout(() => done(null), waitMs)))]).finally(() => clearTimeout(timer))
  }

  // ---- The process

  launch({ sid, cwd, root, args, mode, model, effort, name, prompt, listed }) {
    const claude = this.config.claude || findClaude(this.shellEnv())
    if (!claude) throw new HostError('claude was not found on this machine; set "claude" in agent.json')
    const env = sessionEnv(this.shellEnv())
    Object.assign(env, this.spawnConfig.env)
    if (root && path.resolve(root) !== path.join(os.homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = root
    const argv = sessionArgs(this.spawnConfig, { args, mode, model, effort, name })
    const proc = spawn(claude, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    // (one started with nothing to do is idle from the first, and is closed in time like any other left idle)
    const waiting = !String(prompt ?? '').trim()
    const h = { sid, proc, cwd, root, mode: mode ?? '', model: model ?? '', effort: effort ?? '', state: 'working', startedAt: Date.now(), lastActive: Date.now(), timer: null, tail: '', asked: new Map(), listed: typeof listed === 'boolean' ? listed : undefined }
    this.hosted.set(sid, h)
    this.log(`started ${sid} in ${cwd} (pid ${proc.pid})`)
    let buffered = ''
    proc.stdout.on('data', (chunk) => {
      buffered += chunk
      let nl
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        // An answer to something the agent asked of it
        if (msg.type === 'control_response') {
          const answer = h.asked.get(msg.response?.request_id)
          h.asked.delete(msg.response?.request_id)
          answer?.(msg.response)
          continue
        }
        // The mode it's in, as it says at the start and whenever that changes
        if (msg.type === 'system' && typeof msg.permissionMode === 'string' && msg.permissionMode !== h.mode) {
          h.mode = msg.permissionMode
          this.onChange()
        }
        // A turn ends with a result; until the next prompt the session is idle
        if (msg.type === 'result') this.active(h, 'idle')
        else if (msg.type === 'assistant' || msg.type === 'user') this.active(h, 'working')
        // (by its first reply its transcript is written, and can be marked)
        if (msg.type === 'assistant' || msg.type === 'result') this.mark(h)
      }
    })
    proc.stderr.on('data', (chunk) => (h.tail = (h.tail + chunk).slice(-2000)))
    proc.on('error', (err) => (h.tail += '\n' + err.message))
    proc.on('exit', (code) => {
      clearTimeout(h.timer)
      if (this.hosted.get(h.sid) === h) this.hosted.delete(h.sid)
      // (what couldn't be marked in place while Claude Code was writing it is marked now)
      this.mark(h, { whole: true })
      this.log(`${h.sid} exited (${code})${code ? ': ' + h.tail.trim().split('\n').at(-1) : ''}`)
      this.onChange()
    })
    proc.stdin.on('error', () => {})
    if (waiting) this.active(h, 'idle')
    else proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: String(prompt) } }) + '\n')
    this.onChange()
    return h
  }

  // A session started to be shown, or not, in Claude Code's own lists: its transcript is
  // marked once it is written. In place where that fits, which is safe while Claude Code
  // adds to the file's end; otherwise when the process has gone.
  mark(h, { whole = false } = {}) {
    if (h.listed === undefined || (h.marked && !whole)) return
    try {
      const file = this.transcriptOf(h)
      if (!file) return
      // (written again only when nothing else has it open: another Claude Code may have taken it up)
      const did = setListing(file, h.listed, { whole: whole && !this.open()[h.sid] })
      if (did === 'ok') h.marked = true
      if (did === 'ok' || whole) this.log(`${h.sid} ${did === 'ok' ? 'is marked to be ' + (h.listed ? 'shown in' : 'left out of') + " Claude Code's own lists" : 'could not be marked (' + did + ')'}`)
      // (marked to be shown while it runs: a list that is open now is given cause to read again)
      if (did === 'ok' && h.listed && !whole) this.haveListsRead(h)
    } catch (err) {
      this.log(`${h.sid} could not be marked: ${err.message}`)
    }
  }

  // A list of sessions already open in VS Code reads again (see saysTerminal): the
  // session's record says for a moment that a terminal has it, and then what it said
  haveListsRead(h) {
    try {
      const record = this.recordOf(h)
      if (!record || !saysTerminal(record, true)) return
      this.log(`${h.sid} says for a moment that a terminal has it, so that a list of sessions open in VS Code reads again`)
      setTimeout(() => {
        try {
          saysTerminal(record, false)
        } catch {} // (the session has gone, and its record with it)
      }, LISTS_READ_MS).unref()
    } catch (err) {
      this.log(`${h.sid} is marked, and a list that is open was not given cause to read again: ${err.message}`)
    }
  }

  // Claude Code's own record of a session the agent runs, among those of its open sessions
  recordOf(h) {
    for (const root of [h.root, ...this.config.roots, path.join(os.homedir(), '.claude')]) {
      if (!root) continue
      const file = path.join(root, 'sessions', h.proc.pid + '.json')
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).sessionId === h.sid) return file
      } catch {}
    }
    return null
  }

  // Where Claude Code writes a session's transcript: as the index has it, else where one in that folder goes
  transcriptOf(h) {
    const known = this.store?.session?.(h.sid)?.path
    if (known && fs.existsSync(known)) return known
    for (const root of [h.root, ...this.config.roots, path.join(os.homedir(), '.claude')]) {
      if (!root) continue
      const file = path.join(root, 'projects', projectFolder(h.cwd), h.sid + '.jsonl')
      if (fs.existsSync(file)) return file
    }
    return null
  }

  active(h, state) {
    const changed = h.state !== state
    h.state = state
    h.lastActive = Date.now()
    clearTimeout(h.timer)
    // Left idle long enough, it's closed; a later reply resumes it
    if (state === 'idle') h.timer = setTimeout(() => this.close(h), this.spawnConfig.idleMinutes * 60_000)
    if (changed) this.onChange()
  }

  // The environment a terminal would give: launchd and systemd start the agent with
  // next to nothing on PATH
  shellEnv() {
    if (this.env) return this.env
    this.env = { ...process.env }
    if (process.platform === 'win32') return this.env
    try {
      // The account's own shell: a service isn't told what it is
      const shell = os.userInfo().shell || process.env.SHELL || '/bin/sh'
      const out = execFileSync(shell, ['-lic', 'printf "\\0ENV\\0"; env -0'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
      const vars = out.slice(out.indexOf('\0ENV\0') + 5).split('\0')
      for (const v of vars) {
        const eq = v.indexOf('=')
        if (eq > 0) this.env[v.slice(0, eq)] = v.slice(eq + 1)
      }
    } catch {}
    return this.env
  }
}

// ---- Whether Claude Code's own lists of sessions to resume show a session (VS Code's
// session list, for one). They leave out the ones a program started: those whose
// transcript says so where it first says how the session was started, which is the
// first "entrypoint" in its first 64 KB (sdk-cli for anything started headless, as the
// agent starts them; Claude Code sets that itself, whatever it is told). That one word
// is all they go by, so it is all that is changed: the session runs as it did, and
// says of itself to everyone else what it did.

const LISTING_HEAD = 65536
const UNLISTED = new Set(['sdk-cli', 'sdk-ts', 'sdk-py'])
const ENTRY = Buffer.from('"entrypoint":"')

// Marks a transcript to be shown (`listed`) or left out. 'ok' when it is as asked;
// 'none' when it says nothing yet; 'later' when it can't be done in place (the word
// would be longer than the one there, or the first 64 KB have none), which `whole`
// does by writing the file again: only for a file nothing else is writing.
export function setListing(file, listed, { whole = false } = {}) {
  const want = listed ? 'cli' : 'sdk-cli'
  const fd = fs.openSync(file, 'r+')
  try {
    const head = Buffer.alloc(LISTING_HEAD)
    const n = fs.readSync(fd, head, 0, LISTING_HEAD, 0)
    if (!n) return 'none'
    const at = head.subarray(0, n).indexOf(ENTRY)
    const from = at + ENTRY.length
    const to = at < 0 ? -1 : head.subarray(0, n).indexOf(0x22, from)
    if (at >= 0 && to >= 0) {
      const now = head.toString('utf8', from, to)
      if (UNLISTED.has(now) !== listed) return 'ok'
      // In place: the word and its closing quote, then spaces, which JSON allows there
      if (want.length <= now.length) {
        const patch = Buffer.from(want + '"' + ' '.repeat(now.length - want.length))
        fs.writeSync(fd, patch, 0, patch.length, from)
        return 'ok'
      }
    } else if (n < LISTING_HEAD && !head.subarray(0, n).includes(0x0a)) return 'none'
  } finally {
    fs.closeSync(fd)
  }
  if (!whole) return 'later'
  // Written again, with the word at the very start of its first line
  const text = fs.readFileSync(file, 'utf8')
  const nl = text.indexOf('\n')
  const first = nl < 0 ? text : text.slice(0, nl)
  const next = file + '.marking'
  fs.writeFileSync(next, relabelled([first], listed) + (nl < 0 ? '' : text.slice(nl)), { mode: 0o600 })
  fs.renameSync(next, file)
  return 'ok'
}

// A transcript's first line, saying at its start whether the session is to be shown
export function relabelled(lines, listed) {
  let row
  try {
    row = JSON.parse(lines[0])
  } catch {
    return lines[0]
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return lines[0]
  const { entrypoint, ...rest } = row
  return JSON.stringify({ entrypoint: listed ? 'cli' : 'sdk-cli', ...rest })
}

// ---- Having a list that is already open read again. VS Code's list of a project's
// sessions reads when it is opened, and after that of itself only for a session of its
// own or for one in that project, not in the list, that is open in a terminal: which is
// what it takes a session to be whose record among Claude Code's open sessions has cli
// for its "entrypoint". It does not read for one a program runs (sdk-cli), as the agent
// runs these, since it would leave that out. So a session just marked to be shown was
// in no list that was open until something else had the list read. The session's own
// record is made to say cli for a moment, in place and to the same length, as the
// transcript's word is; the list reads, and has the session from then on; and the
// record says what it said. VS Code reads within a quarter of a second of the change.

const AS_STARTED = Buffer.from('"entrypoint":"sdk-cli"')
const AS_A_TERMINAL = Buffer.from('"entrypoint":"cli"    ')
const LISTS_READ_MS = 3000

// Has the record of an open session say that a terminal has it (`on`), or what Claude
// Code wrote of it. False, and nothing written, where it does not say the other.
export function saysTerminal(file, on) {
  const [from, to] = on ? [AS_STARTED, AS_A_TERMINAL] : [AS_A_TERMINAL, AS_STARTED]
  const fd = fs.openSync(file, 'r+')
  try {
    const head = Buffer.alloc(8192)
    const n = fs.readSync(fd, head, 0, head.length, 0)
    const at = head.subarray(0, n).indexOf(from)
    if (at < 0) return false
    fs.writeSync(fd, to, 0, to.length, at)
    return true
  } finally {
    fs.closeSync(fd)
  }
}

// The largest transcript carried to another machine, packed (one with many screenshots in it packs to tens of megabytes)
export const CARRY_MAX = 96 * 1024 * 1024

// The folder under <config dir>/projects that Claude Code keeps a working folder's
// transcripts in: the folder's path, with everything that isn't a letter or a digit made a dash
export const projectFolder = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-')

// What Claude Code is started with for a session the agent runs: headless, the way an
// editor hosts it. Where the machine allows bypassing permissions, the session is told
// it may be switched to that later; Claude Code refuses the switch otherwise.
export function sessionArgs(spawnConfig, { args = [], mode, model, effort, name } = {}) {
  return [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...args,
    ...(spawnConfig.args ?? []),
    ...(mode ? ['--permission-mode', mode] : []),
    ...((spawnConfig.modes ?? []).includes('bypassPermissions') ? ['--allow-dangerously-skip-permissions'] : []),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(name ? ['--name', name] : []),
  ]
}

// ~ and ~/x (or ~\x) are the account's home
export const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir())

// Windows takes C:\Git and c:\git for one folder
const sameCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// The first claude on the PATH that isn't one npm left in a node_modules/.bin
export function findClaude(env = process.env) {
  // A copy of Windows' environment keeps the name as it was set: Path
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  for (const dir of String((key && env[key]) ?? '').split(path.delimiter)) {
    if (!dir || dir.includes('node_modules')) continue
    const candidate = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}
