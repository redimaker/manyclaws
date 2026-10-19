// Sessions the agent starts, on request. Each opens in a terminal of its own: a Terminal
// window on a Mac (or the app spawn.terminal names), a tmux session elsewhere, a console
// window on Windows. There it is an ordinary interactive Claude Code session, the
// terminal's and not the agent's: it runs until it is closed there (or ended from the page,
// as closing it would end it), whatever becomes of the agent, which can be stopped, started
// again or updated under it. With the ManyClaws plugin installed it reports to the server
// like any session, and what the page says to it reaches it through the plugin, as it
// reaches one a person started in a terminal.
// A search (`background`) is the one kind the agent still runs itself, headless (Claude
// Code's stream-json mode, the way an editor hosts it): it does its one turn and ends.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
// The ones a machine allows where its owner named none: every one, bypassing permissions too (deon, 2026-10-18, as on
// 2026-10-08: "It should default to everything allowed if not specified"); a list in agent.json narrows them
export const DEFAULT_MODES = MODES
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
  // (`usedFolder`: the rule a folder a person used is judged by, mayBeUsedFolder; given in its place only by a test, whose
  // own folders are under one whose name starts with a dot)
  // (`startedFile`: where what it started is remembered; with none, as the tests' own hosts have, it is not written down)
  // (`launchDir`: where what opens a session in a terminal is written for the moment, which is in the agent's own folder)
  constructor(config, { store, onChange = () => {}, log = () => {}, usedFolder = mayBeUsedFolder, startedFile = null, launchDir = null }) {
    this.config = config
    // args and env are added to every session the agent starts: a default model, say.
    // max: how many of the sessions it started may be open at once, working or not: one
    // stays open until it is closed in its terminal, or ended from the page. 64 is the owner's number.
    // terminal: what a session is opened in. On a Mac the name of an app that runs a
    // .command file it is given (Terminal, the default; iTerm), or tmux; tmux elsewhere
    // (tmuxPrefix: what its tmux sessions' names start with). Windows has a console window.
    // modes: the permission modes a session may be started in or switched to. With no list
    // of its own a machine allows every one, bypassPermissions too: what a session is
    // started in is what one of the account's own devices asked, signed. A list in its
    // agent.json ("spawn": { "modes": [...] }, or the installer's --mode) is how its owner
    // narrows them, and one without bypassPermissions has no session started so that it
    // could be switched to it.
    // auto: the folders a person has used Claude Code in (autoFolders, below) are allowed too, and autoOff names the
    // ones of those that are not; folders: the ones the owner listed. A session may be started anywhere under either,
    // and a new folder made only under one the owner listed.
    this.spawnConfig = { enabled: false, folders: [], auto: false, autoOff: [], modes: DEFAULT_MODES, max: 64, args: [], env: {}, terminal: process.platform === 'darwin' ? 'Terminal' : 'tmux', tmuxPrefix: 'manyclaws-', ...(config.spawn ?? {}) }
    this.store = store
    this.onChange = onChange
    this.log = log
    this.hosted = new Map() // the searches it runs itself: sid -> { sid, proc, cwd, state, startedAt, lastActive, tail }
    this.env = null
    // What is checked before any session is started here (the service's: that the plugin it loads is a release, or allowed)
    this.guard = null
    // The folders a person used, as last worked out (refreshAuto)
    this.autoList = []
    this.usedFolder = usedFolder
    // The sessions this agent has started, kept across restarts: what they ran in is not a folder a person chose
    this.startedFile = startedFile
    // Where what starts a session in its terminal is written, for the moment until it runs
    this.launchDir = launchDir ?? path.join(os.homedir(), '.manyclaws', 'launch')
    try {
      this.started = new Set(startedFile ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [])
    } catch {
      this.started = new Set()
    }
  }

  // What the server and the page are told about the searches it runs
  list() {
    return [...this.hosted.values()].map(({ sid, cwd, state, startedAt, lastActive, proc, mode, model, effort }) => ({ sid, cwd, state, startedAt, lastActive, pid: proc.pid, mode, model, effort }))
  }

  // Every session open in a Claude Code process on this machine, the agent's own or
  // not, from the records Claude Code keeps: sid -> { pid, status, kind, entrypoint, cwd, name }
  // (`mine`: a search it runs itself; `started`: one it started, in a terminal or as a search)
  open() {
    const out = {}
    for (const [sid, r] of Object.entries(this.records())) {
      const mine = this.hosted.get(sid)?.proc.pid === r.pid // one the agent runs itself
      out[sid] = { pid: r.pid, status: r.status ?? '', kind: r.kind ?? '', entrypoint: r.entrypoint ?? '', cwd: r.cwd ?? '', name: r.name ?? '', updatedAt: r.updatedAt ?? 0, mine, started: this.started.has(sid) }
    }
    return out
  }

  // Claude Code's own records of the sessions open in it here, of processes still alive: sid -> the record
  records() {
    const out = {}
    for (const root of this.config.roots) {
      let names = []
      try {
        names = fs.readdirSync(path.join(root, 'sessions')).filter((n) => /^\d+\.json$/.test(n))
      } catch {}
      for (const name of names) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(root, 'sessions', name), 'utf8'))
          if (r.sessionId && alive(r.pid)) out[r.sessionId] = r
        } catch {}
      }
    }
    return out
  }

  // ---- Starting and resuming

  // `create`: the folder is made if it isn't there (a new project), inside a folder the owner listed.
  // `like`, in place of `cwd`: the folder a session ran in on another machine, for the one
  // here that is most like it. `idle`: started with nothing to do yet, waiting for its first prompt.
  // `background`: a search, run by the agent itself and ended with its turn, not opened in a terminal.
  start({ cwd, like, prompt, mode, model, effort, name, create = false, idle = false, background = false }) {
    this.allow(mode)
    this.allowEffort(effort)
    if ((background || !idle) && !String(prompt ?? '').trim()) throw new HostError('a prompt is required')
    const folder = String(cwd ?? '').trim() ? this.folder(cwd, { create: create === true }) : this.folderLike(like)
    const sid = crypto.randomUUID()
    const how = { sid, cwd: folder, args: ['--session-id', sid], mode, model, effort, name, prompt }
    if (background) {
      this.launch(how)
      return { sid, cwd: folder }
    }
    return { sid, cwd: folder, ...this.window(how) }
  }

  // The folder here that a session from elsewhere would run in: the same path if this
  // machine has it and allows it, else a folder of the same name under one the owner
  // listed, else the first of those the owner listed. A session is never started outside them.
  folderLike(like) {
    const roots = [...(this.spawnConfig.enabled ? this.roots() : []), ...this.autoRoots()]
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
  // folder most like the one it ran in, and opened in a terminal: idle, with all it knew,
  // waiting for its next prompt. Its lines are given the new session's id and folder, as
  // Claude Code would have written them had it run here.
  importSession({ packed, like, mode, model, effort }) {
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
    // (opened in a terminal, it is a session as one started there is, and Claude Code's own lists show it, whatever the
    // one it was copied from was)
    out[0] = relabelled(out, true)
    const root = this.config.roots[0] ?? path.join(os.homedir(), '.claude')
    const dir = path.join(root, 'projects', projectFolder(folder))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), out.join('\n') + '\n', { mode: 0o600 })
    return { sid, cwd: folder, rows, ...this.window({ sid, cwd: folder, root, args: ['--resume', sid], mode, model, effort }) }
  }

  // A reply to a session nobody has open: Claude Code is started on it again, in a
  // terminal. One that is open elsewhere would get a second writer, so that takes `fork`,
  // which continues in a copy under a new id.
  // (`idle`, with `fork`: the copy is opened with nothing to do yet, waiting for its first prompt)
  async resume({ sid, prompt, mode, model, effort, fork = false, idle = false }) {
    this.allow(mode)
    this.allowEffort(effort)
    if (!(fork && idle) && !String(prompt ?? '').trim()) throw new HostError('a prompt is required')
    const mine = this.hosted.get(sid)
    // A search on its way out is waited for: it is about to be a session nobody has open
    if (mine?.closing) await new Promise((done) => mine.proc.once('exit', done))
    else if (mine && !fork) throw new HostError('this session is a search the agent here is running: it ends with its turn, and can be replied to then')
    const session = this.store.session(sid)
    if (!session) throw new HostError('no such session on this machine')
    const elsewhere = this.open()[sid]
    if (elsewhere && !elsewhere.mine && !fork) throw new HostError(`this session is open in another Claude Code (pid ${elsewhere.pid}${elsewhere.entrypoint ? ', ' + elsewhere.entrypoint : ''}); reply there, or continue in a copy`)
    const folder = this.folder(session.cwd)
    const id = fork ? crypto.randomUUID() : sid
    const opened = this.window({ sid: id, cwd: folder, root: session.root, args: fork ? ['--resume', sid, '--fork-session', '--session-id', id] : ['--resume', sid], mode, model, effort, prompt })
    return { sid: id, forked: fork, cwd: folder, ...opened }
  }

  // A session is ended: a search the agent runs, or one it opened in a terminal, and no other. One in a terminal is
  // ended as closing its window would end it (Claude Code is told to go, and is made to if it has not in ten seconds);
  // it stays on the machine, where a reply from the page, or claude --resume, picks it up again.
  stop({ sid }) {
    const h = this.hosted.get(sid)
    if (h) {
      this.close(h)
      setTimeout(() => this.hosted.get(sid) === h && h.proc.kill(), 10_000).unref()
      return { sid }
    }
    const open = this.started.has(sid) ? this.records()[sid] : null
    if (!open || !sameProcess(open)) throw new HostError('the agent is not running this session, and did not open it in a terminal here')
    try {
      process.kill(open.pid, 'SIGTERM')
    } catch (err) {
      throw new HostError(`Claude Code (pid ${open.pid}) could not be ended: ${err.message}`)
    }
    this.log(`ended ${sid}, which it opened in a terminal (pid ${open.pid})`)
    setTimeout(() => {
      if (!sameProcess(open)) return
      try {
        process.kill(open.pid, 'SIGKILL')
      } catch {}
    }, 10_000).unref()
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

  allow(mode) {
    if (!this.canStart()) throw new HostError('starting sessions is turned off on this machine (spawn.enabled in agent.json)')
    this.room()
    this.allowMode(mode)
  }

  // Room for one more session. The machine is said by name: the page shows the refusal
  // beside whichever device is chosen there, which need not be the one that refused.
  room() {
    const c = this.spawnConfig
    if (this.running() >= c.max) throw new HostError(`${this.config.label || os.hostname()} already has ${c.max} sessions open that were started for ManyClaws, the most it has at once (spawn.max in its agent.json): close one in its terminal, or with Exit on the page, first`)
  }

  // How many of the sessions it started are open now: in their terminals, or searches it runs
  running() {
    return new Set([...Object.keys(this.open()).filter((sid) => this.started.has(sid)), ...this.hosted.keys()]).size
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

  inside(real, roots = this.roots()) {
    return roots.some((f) => sameCase(real) === sameCase(f) || sameCase(real).startsWith(sameCase(f) + path.sep))
  }
  // The folders a person used, where those are allowed (spawn.auto), as they really are on disk
  autoRoots() {
    return this.spawnConfig.auto ? this.autoList : []
  }
  // Whether a session may be started here at all: the owner listed a folder, or allowed the ones they used
  canStart() {
    return !!(this.spawnConfig.enabled && this.spawnConfig.folders.length) || this.autoRoots().length > 0
  }
  // Every folder a session may be started in: the owner's, then the ones they used
  startFolders() {
    return [...(this.spawnConfig.enabled ? this.spawnConfig.folders : []), ...this.autoRoots().filter((f) => !this.inside(f))]
  }

  // The folder a session may run in: one that exists, under a folder the machine's owner
  // listed or one they used (where those are allowed). `create`: one that isn't there yet
  // is made first, if where it would be is under a folder the owner listed (judged by the
  // nearest folder that does exist, links followed): never under one that was only used.
  folder(cwd, { create = false } = {}) {
    const wanted = path.resolve(expandHome(String(cwd ?? '')))
    if (create && String(cwd ?? '').trim() && !fs.existsSync(wanted)) {
      let nearest = wanted
      while (!fs.existsSync(nearest) && path.dirname(nearest) !== nearest) nearest = path.dirname(nearest)
      if (!this.inside(fs.realpathSync(nearest))) throw new HostError(`${wanted} is outside the folders this machine allows new ones to be made in (spawn.folders in agent.json): a folder is made only under one its owner listed`)
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
    if (!this.inside(real) && !this.inside(real, this.autoRoots())) throw new HostError(`${real} is outside the folders this machine allows (spawn.folders in agent.json)`)
    return real
  }

  // ---- The folders a person used. Where its owner allows it (spawn.auto), a session may be
  // started in a folder a person has used Claude Code in here: one a session started at a
  // terminal, in an editor or in the desktop app ran in, not one a program started (its
  // transcript says sdk-…) or this agent did. Never the home folder or one above it, a
  // folder for what is temporary, or one inside a folder whose name starts with a dot
  // (~/.claude, ~/.ssh, ~/.manyclaws); only one that is there now, used in the last 90
  // days, and not one the owner turned off (spawn.autoOff). Worked out again as the index
  // is brought up to date: true where the list changed.
  refreshAuto({ now = Date.now() } = {}) {
    const off = new Set((this.spawnConfig.autoOff ?? []).map((f) => sameCase(realOr(path.resolve(expandHome(f))))))
    const out = []
    for (const { cwd } of this.store?.peopleFolders?.(now - AUTO_DAYS * 86400_000, this.started) ?? []) {
      let real
      try {
        real = fs.realpathSync(cwd)
        if (!fs.statSync(real).isDirectory()) continue
      } catch {
        continue
      }
      if (!this.usedFolder(real) || off.has(sameCase(real)) || out.some((f) => sameCase(f) === sameCase(real))) continue
      out.push(real)
    }
    out.sort((a, b) => a.localeCompare(b))
    const changed = JSON.stringify(out) !== JSON.stringify(this.autoList)
    this.autoList = out
    return changed
  }

  // A session this agent started, remembered (the last few thousand)
  remember(sid) {
    this.started.add(sid)
    if (this.started.size > 5000) this.started.delete(this.started.values().next().value)
    if (!this.startedFile) return
    try {
      fs.writeFileSync(this.startedFile, JSON.stringify([...this.started]), { mode: 0o600 })
    } catch {}
  }

  // The folders right under the ones the owner listed: projects a session could be
  // started in, whether or not one ever was. `unread` names the listed folders that
  // didn't answer in time.
  //
  // Read off the main thread and given only so long. macOS holds a service's first
  // read of some folders (an external disk, Documents) until someone answers a prompt on
  // the screen; read the plain way, the whole agent waited with it, and was offline.
  async subfolders({ limit = 500, waitMs = 2000 } = {}) {
    const roots = this.spawnConfig.enabled ? this.roots() : []
    const lists = await Promise.all(roots.map((root) => this.listing(root, waitMs)))
    const others = []
    lists.forEach((entries, i) => {
      for (const e of entries ?? []) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') others.push(path.join(roots[i], e.name))
    })
    // (and the folders a person used, where those are allowed: each one, as it is)
    for (const f of this.autoRoots()) if (!others.includes(f) && !roots.includes(f)) others.push(f)
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

  // A search, run here headless: its prompt is its first and only one, and it ends with its turn
  launch({ sid, cwd, root, args, mode, model, effort, name, prompt }) {
    this.guard?.()
    const claude = this.claude()
    const env = this.sessionEnv(root)
    const argv = sessionArgs(this.spawnConfig, { args, mode, model, effort, name })
    const proc = spawn(claude, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const h = { sid, proc, cwd, root, mode: mode ?? '', model: model ?? '', effort: effort ?? '', state: 'working', startedAt: Date.now(), lastActive: Date.now(), tail: '' }
    this.hosted.set(sid, h)
    this.remember(sid)
    this.log(`started ${sid} in ${cwd}, in the background (pid ${proc.pid})`)
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
        // The mode it's in, as it says at the start and whenever that changes
        if (msg.type === 'system' && typeof msg.permissionMode === 'string' && msg.permissionMode !== h.mode) {
          h.mode = msg.permissionMode
          this.onChange()
        }
        // A turn ends with a result: its one turn, after which it has nothing more to read, and exits
        if (msg.type === 'result') {
          this.active(h, 'idle')
          this.close(h)
        } else if (msg.type === 'assistant' || msg.type === 'user') this.active(h, 'working')
      }
    })
    proc.stderr.on('data', (chunk) => (h.tail = (h.tail + chunk).slice(-2000)))
    proc.on('error', (err) => (h.tail += '\n' + err.message))
    proc.on('exit', (code) => {
      if (this.hosted.get(h.sid) === h) this.hosted.delete(h.sid)
      this.log(`${h.sid} exited (${code})${code ? ': ' + h.tail.trim().split('\n').at(-1) : ''}`)
      this.onChange()
    })
    proc.stdin.on('error', () => {})
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: String(prompt) } }) + '\n')
    this.onChange()
    return h
  }

  active(h, state) {
    const changed = h.state !== state
    h.state = state
    h.lastActive = Date.now()
    if (changed) this.onChange()
  }

  // A session opened in a terminal of its own, and left to it. What starts it there is
  // written to a file the terminal runs, which removes itself as it does: so nothing of
  // the prompt, or of the environment, is on a command line the terminal is started with.
  // What it is opened in is said back: { terminal } ('tmux', with the session's name there).
  window({ sid, cwd, root, args, mode, model, effort, name, prompt }) {
    this.guard?.()
    const claude = this.claude()
    const env = this.sessionEnv(root)
    const argv = windowArgs(this.spawnConfig, { args, mode, model, effort, name, prompt })
    // (a folder Claude Code has not been told it may trust asks that first, and nobody may be at the computer to say: told
    // so in the config folder the session is to be in, its own where it has one, else the usual one)
    trust(cwd, env.CLAUDE_CONFIG_DIR, this.log)
    fs.mkdirSync(this.launchDir, { recursive: true, mode: 0o700 })
    this.tidyLaunches()
    const terminal = String(this.spawnConfig.terminal || 'tmux')
    let opened
    if (process.platform === 'win32') opened = this.console({ sid, cwd, env, claude, argv })
    else if (terminal === 'tmux') opened = this.tmux({ sid, cwd, env, claude, argv })
    else opened = this.app(terminal, { sid, cwd, env, claude, argv })
    this.remember(sid)
    this.log(`opened ${sid} in ${cwd}, in ${opened.tmux ? 'tmux (' + opened.tmux + ')' : opened.terminal}`)
    this.onChange()
    return opened
  }

  // On a Mac: a window of the app named (Terminal, iTerm), which runs a .command file it is opened with
  app(terminal, { sid, cwd, env, claude, argv }) {
    const file = this.launchFile(sid + '.command', starter({ cwd, env, claude, argv }))
    const r = spawnSync('open', ['-a', terminal, file], { encoding: 'utf8', timeout: 20_000 })
    if (r.status !== 0) {
      fs.rmSync(file, { force: true })
      throw new HostError(`${terminal} did not open a window for the session: ${String(r.stderr || r.error?.message || '').trim() || 'open said nothing of why'} (spawn.terminal in agent.json names what a session is opened in)`)
    }
    return { terminal }
  }

  // A tmux session, left detached for anyone to attach to (tmux attach -t <name>). Where the agent runs under systemd,
  // the tmux it starts is put in a scope of its own: in the agent's own, it would be ended when the agent is.
  tmux({ sid, cwd, env, claude, argv }) {
    const tmux = this.config.tmux || findTool('tmux', this.shellEnv())
    if (!tmux) throw new HostError('tmux was not found on this machine, and a session started for ManyClaws opens in tmux here: install it, or set "tmux" in agent.json')
    // (named for the session; where that name is taken, as by a pane tmux keeps after what ran in it has ended, the next free one)
    const taken = (n) => spawnSync(tmux, ['has-session', '-t', '=' + n], { stdio: 'ignore', env: sessionEnv(this.shellEnv()) }).status === 0
    const base = this.spawnConfig.tmuxPrefix + sid.slice(0, 8)
    let name = base
    for (let n = 2; taken(name) && n < 100; n++) name = base + '-' + n
    const file = this.launchFile(sid + '.sh', starter({ cwd, env, claude, argv }))
    const command = [tmux, 'new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', cwd, 'exec /bin/sh ' + shellQuote(file)]
    const scoped = process.platform === 'linux' && process.env.INVOCATION_ID && findTool('systemd-run', this.shellEnv())
    // (tmux itself is given what a terminal has, and not the session's own settings: a tmux server it starts keeps what it
    // was started with for every pane it has. What the session runs with is in the file it runs.)
    const run = (cmd) => spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', env: sessionEnv(this.shellEnv()), cwd, timeout: 20_000 })
    let r = scoped ? run([scoped, '--user', '--scope', '--quiet', '--collect', ...command]) : null
    // (where systemd would not have it, as where the account has no session bus, it is started without)
    if (!r || (r.status !== 0 && !taken(name))) r = run(command)
    if (r.status !== 0) {
      fs.rmSync(file, { force: true })
      throw new HostError(`tmux did not start the session: ${String(r.stderr || r.error?.message || '').trim() || 'it said nothing of why'}`)
    }
    return { terminal: 'tmux', tmux: name }
  }

  // On Windows: a console window of its own, in which the agent's launch.mjs runs Claude Code with what it was given in
  // a file. Nothing of it but the names of files is on the line cmd reads: a prompt there would be read as commands.
  console({ sid, cwd, env, claude, argv }) {
    const file = this.launchFile(sid + '.json', JSON.stringify({ cwd, env, claude, argv }))
    const parts = [process.execPath, path.join(import.meta.dirname, 'launch.mjs'), file]
    if (parts.some((p) => /["%^&|<>]/.test(p))) throw new HostError('a console window could not be opened from where the agent is: its path has a character cmd reads as a command')
    const shell = process.env.ComSpec || 'cmd.exe'
    const proc = spawn(shell, ['/d', '/s', '/c', '"start "ManyClaws" ' + parts.map((p) => '"' + p + '"').join(' ') + '"'], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true })
    proc.on('error', (err) => this.log(`${sid} could not be opened: ${err.message}`))
    proc.unref()
    return { terminal: 'console' }
  }

  // A file in the launch folder, for the owner alone
  launchFile(name, text) {
    const file = path.join(this.launchDir, name)
    fs.writeFileSync(file, text, { mode: 0o700 })
    fs.chmodSync(file, 0o700)
    return file
  }

  // What was written for a terminal that never ran it: gone after a minute
  tidyLaunches() {
    try {
      for (const name of fs.readdirSync(this.launchDir)) {
        const file = path.join(this.launchDir, name)
        if (Date.now() - fs.statSync(file).mtimeMs > 60_000) fs.rmSync(file, { force: true })
      }
    } catch {}
  }

  claude() {
    const claude = this.config.claude || findClaude(this.shellEnv())
    if (!claude) throw new HostError('claude was not found on this machine; set "claude" in agent.json')
    return claude
  }

  // What a session it starts runs with: what a terminal would have, its own settings (spawn.env), and the folder of
  // Claude Code's own that the session is in, where that is not the usual one
  sessionEnv(root) {
    const env = sessionEnv(this.shellEnv())
    Object.assign(env, this.spawnConfig.env)
    if (root && path.resolve(root) !== path.join(os.homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = root
    return env
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

// A transcript's first line, saying at its start whether Claude Code's own lists of
// sessions to resume (VS Code's, for one) are to show the session. They leave out the
// ones a program started: those whose transcript says so where it first says how the
// session was started, the first "entrypoint" (sdk-cli for anything started headless).
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

// The largest transcript carried to another machine, packed (one with many screenshots in it packs to tens of megabytes)
export const CARRY_MAX = 96 * 1024 * 1024

// The folder under <config dir>/projects that Claude Code keeps a working folder's
// transcripts in: the folder's path, with everything that isn't a letter or a digit made a dash
export const projectFolder = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-')

// What Claude Code is started with for a search the agent runs: headless, the way an
// editor hosts it
export function sessionArgs(spawnConfig, how = {}) {
  return ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...options(spawnConfig, how)]
}

// And for a session opened in a terminal: interactive, with its first prompt, where it has one, as the one thing after
// the options (after --, so that nothing in it is read as one)
export function windowArgs(spawnConfig, { prompt, ...how } = {}) {
  return [...options(spawnConfig, how), ...(String(prompt ?? '').trim() ? ['--', String(prompt)] : [])]
}

// Where the machine allows bypassing permissions, a session is told it may be switched
// to that later; Claude Code refuses the switch otherwise.
function options(spawnConfig, { args = [], mode, model, effort, name } = {}) {
  return [
    ...args,
    ...(spawnConfig.args ?? []),
    ...(mode ? ['--permission-mode', mode] : []),
    ...((spawnConfig.modes ?? []).includes('bypassPermissions') ? ['--allow-dangerously-skip-permissions'] : []),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(name ? ['--name', name] : []),
  ]
}

// What a terminal runs to start a session, as a shell reads it (a .command file, or what
// tmux runs): it removes itself, goes to the session's folder, and runs Claude Code with
// the environment the agent made for it, beside what the terminal says of itself, and
// nothing else of the terminal's. Every word the agent puts in it is quoted whole.
export function starter({ cwd, env, claude, argv }) {
  const pairs = Object.entries({ ...env, PWD: cwd })
    .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !OF_THE_TERMINAL.includes(k) && !SHELL_OWN.includes(k) && v !== undefined)
    .map(([k, v]) => shellQuote(`${k}=${v}`))
  return [
    '#!/bin/sh',
    '# A Claude Code session the ManyClaws agent opened here, as one of your devices asked. This file removes itself.',
    'rm -f -- "$0"',
    `cd -- ${shellQuote(cwd)} || exit 1`,
    'set --',
    'for v in ' + OF_THE_TERMINAL.join(' ') + '; do eval "if [ -n \\"\\${$v+x}\\" ]; then set -- \\"\\$@\\" \\"$v=\\${$v}\\"; fi"; done',
    `exec env -i "$@" ${pairs.join(' ')} ${[claude, ...argv].map(shellQuote).join(' ')}`,
    '',
  ].join('\n')
}
// What the terminal says of itself, which the session is to have as the terminal has it
const OF_THE_TERMINAL = ['TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'TMUX', 'TMUX_PANE', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'ITERM_SESSION_ID', 'ITERM_PROFILE', '__CFBundleIdentifier', 'COLUMNS', 'LINES', 'SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT', 'DISPLAY', 'WAYLAND_DISPLAY']
// And what a shell keeps of its own, which is the agent's in what it made
const SHELL_OWN = ['OLDPWD', 'SHLVL', '_']

export const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

// A folder Claude Code asks about before anything else, where it has not been told it may trust it or a folder above it:
// "Do you trust the files in this folder?". A session started headless never asked; one in a terminal would wait on
// it, with nobody there to answer. A folder a session is started in is one the machine's owner listed, or used Claude
// Code in, so it is said to be trusted, as answering there would have it: in Claude Code's own record of folders.
export function trust(cwd, root, log = () => {}) {
  const file = !root || path.resolve(root) === path.join(os.homedir(), '.claude') ? path.join(os.homedir(), '.claude.json') : path.join(root, '.claude.json')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }
  let config
  try {
    config = JSON.parse(text)
  } catch {
    return false
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  const projects = config.projects && typeof config.projects === 'object' ? config.projects : (config.projects = {})
  for (let p = cwd; ; p = path.dirname(p)) {
    if (projects[p]?.hasTrustDialogAccepted === true) return false
    if (path.dirname(p) === p) break
  }
  projects[cwd] = { ...(projects[cwd] ?? {}), hasTrustDialogAccepted: true }
  // (written whole and put in place in one step, as Claude Code writes it)
  const next = `${file}.manyclaws.${process.pid}`
  fs.writeFileSync(next, JSON.stringify(config, null, 2), { mode: fs.statSync(file).mode & 0o777 })
  fs.renameSync(next, file)
  log(`${cwd} is trusted by Claude Code now, as a folder sessions are started in from ManyClaws`)
  return true
}

// ~ and ~/x (or ~\x) are the account's home
export const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir())

// How many days a folder a person used is allowed for, after it was last used
const AUTO_DAYS = 90
const realOr = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}
// The folders for what is temporary, as they really are on disk
const tempFolders = () => [...new Set([os.tmpdir(), '/tmp', '/var/tmp', '/var/folders', '/private/tmp', '/private/var/tmp', '/private/var/folders'].map(realOr))]
// Whether a folder (as it really is on disk) may be one a person used that the page starts sessions in: not the home
// folder or one above it, not a temporary one, and not inside one whose name starts with a dot
export function mayBeUsedFolder(real, { home = realOr(os.homedir()), temps = tempFolders() } = {}) {
  if (!path.isAbsolute(real)) return false
  const [r, h] = [sameCase(real), sameCase(home)]
  if (r === h || h.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return false
  if (temps.some((t) => r === sameCase(t) || r.startsWith(sameCase(t) + path.sep))) return false
  return !real.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..')
}

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

// Whether the process a record of Claude Code's names is still the one that wrote it, and not another given its number
// since: Claude Code says when its process started (procStart, as ps says it in UTC), where ps can say it too. Where
// either says nothing of it (Windows has no ps), the record is gone when the process is.
function sameProcess(r) {
  if (!alive(r.pid)) return false
  if (process.platform === 'win32' || typeof r.procStart !== 'string') return true
  const said = spawnSync('ps', ['-o', 'lstart=', '-p', String(r.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, timeout: 5_000 })
  if (said.error) return said.error.code === 'ENOENT'
  return said.status === 0 && said.stdout.trim().replace(/\s+/g, ' ') === r.procStart.trim().replace(/\s+/g, ' ')
}

// The first claude on the PATH that isn't one npm left in a node_modules/.bin
export const findClaude = (env = process.env) => findTool('claude', env, { npm: false })

// Git Bash on Windows, which runs the agent's installer there, as Claude Code finds it: where CLAUDE_CODE_GIT_BASH_PATH
// says, else beside git on the PATH, else where Git for Windows puts it. A bash found on the PATH may be WSL's, which is
// another computer as far as this one is concerned, so none is taken by its name alone. null where there is none
export function findGitBash(env = process.env) {
  const git = findTool('git', env)
  const near = git ? path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe') : ''
  for (const candidate of [env.CLAUDE_CODE_GIT_BASH_PATH, near, 'C:\\Program Files\\Git\\bin\\bash.exe']) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

// What a one-time task of Task Scheduler's runs, on Windows: a .cmd file that runs `argv` with `env` set (a task sets
// none of its own) and appends what it says to `log`. A file, because conhost, which keeps the task off the screen,
// takes what follows it apart and puts it together again without the quotes inside it: one file's name is all it can be
// given whole.
export function taskCmd({ argv, env = {}, log }) {
  const quote = (t) => '"' + String(t) + '"'
  return ['@echo off', ...Object.entries(env).map(([k, v]) => `set ${quote(`${k}=${v}`)}`), argv.map(quote).join(' ') + ` >> ${quote(log)} 2>&1`, 'exit /b %ERRORLEVEL%', ''].join('\r\n')
}
// And the task, as XML: it runs the file `cmd` once, as `user`, in their own session and with no window of its own
// (conhost --headless)
export function taskXml({ user, cmd, description }) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const windir = process.env.SystemRoot || 'C:\\Windows'
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${esc(description)}</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
    <AllowStartOnDemand>true</AllowStartOnDemand>
  </Settings>
  <Actions Context="Author"><Exec><Command>${esc(path.win32.join(windir, 'System32', 'conhost.exe'))}</Command><Arguments>--headless "${esc(cmd)}"</Arguments></Exec></Actions>
</Task>
`
}
// (written as Task Scheduler reads it: UTF-16, little-endian, with its mark)
export const taskFile = (file, xml) => fs.writeFileSync(file, Buffer.from('\ufeff' + xml, 'utf16le'))

// A program on the PATH, by name
export function findTool(name, env = process.env, { npm = true } = {}) {
  // A copy of Windows' environment keeps the name as it was set: Path
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  for (const dir of String((key && env[key]) ?? '').split(path.delimiter)) {
    if (!dir || (!npm && dir.includes('node_modules'))) continue
    const candidate = path.join(dir, process.platform === 'win32' ? name + '.exe' : name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}
