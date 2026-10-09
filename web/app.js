// ManyClaws web page: the session list, one session's chat, and the reply box.

const el = (id) => document.getElementById(id)

// Where the browser has Trusted Types, this policy is the only thing that can make HTML
// for the page (the server's Content-Security-Policy names it, and allows no other), and
// all it makes is what markdown() writes, which escapes everything it is given. So
// nothing is put into the page as HTML unescaped, by this code or by a later change to
// it: the browser refuses a plain string. The policy also names the one script the page
// starts beside itself, its service worker.
const trusted = window.trustedTypes?.createPolicy('manyclaws', {
  createHTML: (src) => markdown(src),
  createScriptURL: (url) => {
    if (url !== '/sw.js') throw new TypeError('not a script of this page: ' + url)
    return url
  },
})
// A text written in Markdown, as what the page draws of it: all the HTML this page ever sets
const rendered = (src) => (trusted ? trusted.createHTML(src) : markdown(src))
// What a session's tile shows beside its name, until this device says otherwise (the settings): the project
// and computer it is on, the last thing its user typed, the last thing Claude said, when it was last heard
// from, and how many lines each thing said may take
const TILE = { where: true, prompt: true, reply: true, time: true, lines: 1 }
// A phone's one pane at a time; and the page kept on a home screen as an app of its own
const phoneLayout = () => matchMedia('(max-width: 760px)').matches
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
let pastTimer = 0 // follows a past session that's still being written
let searchTimer = 0

const STATE_LABEL = { working: 'Working', attention: 'Needs you', idle: 'Ready', offline: 'Offline', ended: 'Not running' }
const STATE_ORDER = { attention: 0, working: 1, idle: 2, offline: 3, ended: 4 }

// The page's two looks: the VS Code extension's, and Claude Code's in the terminal
const VIEWS = ['vscode', 'terminal']

const app = {
  view: 'vscode',
  sessions: new Map(), // id -> summary
  tellings: 0, // how many times the stream has said how a session is
  told: new Map(), // id -> which of those was the last of it
  current: null, // id of the open session
  // The chat that's showing, of which only a window is read and drawn: the numbers of
  // its last and first rows, whether there are rows before those, and the numbering it
  // was read in (the server renumbers when it rebuilds a session's history)
  lastSeq: 0,
  firstSeq: 0,
  earlier: false,
  epoch: null,
  loaded: false, // that chat's rows have been read from the server
  early: [], // rows that came by the stream before they had been: drawn after them
  promptBefore: null, // the last prompt before the first row drawn, when the rows start partway through its turn: { seq, text }
  quietMs: 50_000, // a stream not heard from for this long is opened again (the server says how often it speaks)
  pending: [], // replies sent but not yet seen in the transcript: { text, node }
  tools: new Map(), // toolUseId -> the row drawn for that call
  openTools: new Set(), // calls drawn that haven't reported back
  rowKeys: new Set(), // the rows of a transcript drawn so far, so reading it again adds only what's new
  views: new Map(), // the chats looked at lately, kept as they were drawn: "s:<session>" or "m:<machine>/<session>/<subagent>" -> view
  listTimer: 0,
  unread: new Set(),
  showEnded: false,
  tile: { ...TILE }, // what a session's tile in the list shows, as this device has it (the settings)
  typed: new Map(), // session id -> the last thing its user typed, as this page read it: for a session whose card does not say
  stream: null,
  partial: '', // the open session's reply as it streams
  attachments: [], // photos uploaded for the next reply: { id, name, url }
  uploads: Promise.resolve(), // settles when every photo picked so far has been uploaded
  uploading: 0,
  results: new Map(), // tool results that arrived before their call: toolUseId -> message
  refoldTimer: 0,
  machines: new Map(), // id -> machine: each runs an agent that carries its sessions, running or not
  latest: {}, // the plugin and the agent the server hands out now: { plugin, agent }, each a version or null
  footMenu: null, // what is open over the reply box: { kind: 'modes' | 'model' | 'effort' }
  modeMenu: null, // the modes that menu offers: { mode, allowed, onPick }
  setting: null, // a model or effort asked for and not yet shown by the session: { sid, kind, value }
  modelRows: new Map(), // session id -> { value, options }: its models, as its own settings list them
  catalog: new Map(), // machine id -> { sessions, more, at }: its past sessions, newest first
  shut: new Set(), // the machines whose sessions are folded away under their names in the list, by id
  pastBy: 'time', // how a machine's past sessions are listed: by 'time', or by 'project' (the folder they ran in)
  projects: new Map(), // machine id -> [{ cwd, last_ts, sessions }]: its projects, most recent first
  projectOpen: new Map(), // "machine|folder" -> { sessions, more }: the projects opened in the list
  past: null, // the open session when it's read from a machine's transcript: { mid, sid, at, sub, from, session }
  // The search: its words, the machines and projects with matches (`data`), which rows are
  // open ("m:<machine>", "p:<machine>|<folder>", "s:<machine>|<session>"), and what's been read under them
  search: { q: '', seq: 0, data: null, open: new Set(), sessions: new Map(), hits: new Map() },
  drafts: {}, // what's typed and not sent, by session: { text, at }
  expect: null, // a session just started or resumed, not reporting yet: { sid, mid, until }
  computer: null, // the computer whose own page is showing: { mid, known, cwd, mode, read, reading, starting, error, colorError }
  favorites: [], // the sessions kept at the top of the list, in the order they were put in: { id, machine, title, project, where }
  marks: new Map(), // what the account has put on its sessions: session id -> { id, machine, title, project, where, name, label, color, remind, notice }
  marking: null, // the session the box for that is open on, and what is chosen in it and not yet saved: { s, color, when, at }
  reminded: new Map(), // the reminders that have come due and been seen to on this page: session id -> the time each was for
  resumePick: null, // the permission mode picked for a session a reply will start again: { sid, mode }
  dragging: false, // a favorite is being moved: the list is left as it is until it's let go
  branching: null, // a new session asked for here that takes a while (a handoff being written, a transcript on its way): { id, from, mid, how, at }
  stopping: null, // a Stop that was taken and hasn't shown in the session's state yet: { sid }
  pressed: 0, // when something in the list was pressed, while it still is
  listStale: false, // the list changed while it couldn't be drawn again
  key: null, // what this device holds of the account's key (keys.js, `held`): what its sessions are opened and sealed with here, and this device's own key, which signs what it asks of the account's computers. Made here from the passphrase, kept where no script can read it back, and never on the server
  firstId: null, // the id of the account's own small session, which a passphrase typed here is tried on (firstSession)
  first: null, // that session as the server has it, opened where this device's key opens it: null where there is none
  tourFor: undefined, // the account the tour of using ManyClaws on a phone is due to on this browser, as this page knows it (tourKeep): null once it has been seen
  tourAt: 0, // which of the tour's steps is showing
  keyLater: undefined, // the sign-in "Not now" was said of to the passphrase's card on this page, where it was (keyLater): null once that is taken back
  unopenedWas: '', // what did not open here when that was last looked at (lookAgain), to tell when it has changed
  auto: new Map(), // the sessions this browser says yes to by itself (auto approve), each with when that ends: session id -> time
}

// Everything about the account's key and the keys drawn from a password is keys.js's, and
// happens on this device: the server is sent neither the password nor the key.
// (the browser does that work only on a page it holds to be secure: https, or this computer itself)
// How what a session says is sealed (seal.js: the same code its computer seals with),
// and what opens and seals it here (keys.js, with the keys this device holds, which the
// browser does the sums with and no script reads). Both loaded before anything is read
// from the server.
let sealing = null
let vault = null
// Everything sealed inside something, opened with what this device holds (where it holds nothing, each reads as "🔒 (encrypted)")
const openHere = async (data) => (vault && app.key ? vault.openAll(data, app.key) : sealing.openAll(data, null))

// Every answer the server gives is opened as it's read: what a session said comes
// sealed, and this device opens it with the account's key where it has it (where it
// doesn't, each sealed thing reads as "🔒 (encrypted)")
{
  const read = Response.prototype.json
  Response.prototype.json = async function () {
    const data = await read.call(this)
    return shaped(sealing?.hasSealed(data) ? opened(await openHere(data)) : data)
  }
}
// What was sealed, opened: noted on the way is that there is something sealed. Whether
// any of it did not open is not told here, by reading what was opened: a session may
// well say "🔒 (encrypted)" itself (one that works on this page does), and nothing is
// closed for that. It is told by what this page holds of each session and each computer
// (unopened): what a key failed to open stands there as those words and nothing else.
function opened(data) {
  if (!app.sawSealed) {
    app.sawSealed = true
    showNotices()
  }
  return data
}

// ---- What the server has of a session is closed to it: each row of its chat is sealed
// whole, what it asks is sealed whole, and everything it says of itself (where it runs,
// its model, its state, what it is about) is one sealed card. The server passes those on
// with what is its own to say beside them (a row's number, whether the session is heard
// from, which machine carries it). Here, once opened, they are put into the shapes the
// rest of this page reads. What this device cannot open reads as "🔒 (encrypted)", and
// has no shape but that.

const folderOf = (path) => String(path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
const isLocked = (v) => typeof v === 'string' && v === sealing?.UNOPENED

// A session's summary (the server marks one `closed`), with its card laid out as a summary's own fields. `devices`:
// the account's machines, where they came with it (else the ones this page has).
function sessionOf(s, devices) {
  if (!s || s.closed !== true || s.shaped) return s
  const card = s.card && typeof s.card === 'object' ? s.card : {}
  // Which machine it is on, where the server cannot say (its agent has not told of it): the one whose agent its plugin found beside it,
  // or failing that the one with its host's name. Only the card says either.
  const known = devices ?? [...app.machines.values()]
  const onHost = s.machine ? null : ((known.find((m) => card.agent?.id && m.id === card.agent.id) ?? (card.host ? known.find((m) => m.name && m.name === card.host) : null))?.id ?? null)
  const locked = isLocked(s.card)
  const repo = card.repo?.remote ? card.repo.remote.replace(/\.git$/, '').split(/[/:]/).pop() : (card.repo?.name?.split('/').pop() ?? '')
  const project = folderOf(card.cwd) || repo || null
  const named = typeof s.named === 'string' && !isLocked(s.named) ? s.named : ''
  const topic = typeof card.topic === 'string' ? card.topic : ''
  return {
    // What the server says of it beside the card, and of that only what is the server's own to say: which session
    // it is, whether it is heard from, which machine carries it, what it counts and times. Nothing else it might say
    // in the open is taken: what the session is called, where it runs and how it stands are the card's alone.
    id: s.id,
    sealed: true,
    closed: true,
    card: s.card ?? null,
    named: s.named ?? null,
    hosted: !!s.hosted,
    ended: !!s.ended,
    online: !!s.online,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    messageCount: s.messageCount ?? 0,
    pendingCalls: s.pendingCalls ?? 0,
    policy: s.policy,
    title: locked ? sealing.UNOPENED : named || topic.slice(0, 80) || project || s.id.slice(0, 8),
    project,
    topic: locked ? sealing.UNOPENED : topic,
    preview: locked ? sealing.UNOPENED : (card.preview ?? ''),
    // (the last thing its user typed to it, and what Claude has said since: said by a plugin from 4.1.0 on,
    // and not at all, which is not the same as nothing said, by one before it)
    // (plugin 4.1.0 alone took Claude in Chrome's instructions, which the app puts in front of a prompt typed in VS
    // Code, for the start of what was typed, and cut the prompt short inside them: such a card says nothing of it)
    lastPrompt: !locked && typeof card.prompt === 'string' && !card.prompt.startsWith('<browser_instruction>') ? card.prompt : '',
    lastReply: !locked && typeof card.reply === 'string' ? card.reply : null,
    detail: card.detail ?? '',
    host: card.host ?? null,
    label: card.label ?? null,
    platform: card.platform ?? null,
    entrypoint: card.entrypoint ?? null,
    account: card.account ?? null,
    cwd: card.cwd ?? null,
    model: card.model ?? null,
    version: card.version ?? null,
    plugin: card.plugin ?? null,
    // (the machine's agent as its plugin found it beside it: which machine's, or null where there is none. Not said at all by a card that does not say)
    agentBeside: card.agent === null || (card.agent && typeof card.agent === 'object') ? card.agent : undefined,
    protocol: card.protocol ?? null,
    capabilities: Array.isArray(card.capabilities) ? card.capabilities : [],
    interactive: card.interactive !== false,
    endReason: card.endReason ?? null,
    contextPercent: card.contextPercent ?? null,
    costUsd: card.costUsd ?? null,
    permissionMode: card.permissionMode ?? null,
    effort: card.effort ?? null,
    since: card.since ?? s.lastActivity,
    shaped: true,
    machine: s.machine ?? onHost,
    // Someone can be there to reply to: a terminal, VS Code, Desktop; not claude -p. One the machine's agent runs takes replies through the agent.
    attended: (card.attended ?? card.interactive !== false) || !!s.hosted,
    // (the server says only that it has ended or is not heard from: while it is heard from, its card says how it stands)
    state: s.state === 'ended' || s.state === 'offline' ? s.state : (card.state ?? 'idle'),
    agents: s.ended || !s.online || !Array.isArray(card.agents) ? [] : card.agents,
    pendingRequests: (s.pendingRequests ?? []).map(requestOf),
  }
}

// A row of a session's chat: what was sealed, with the number the server gave it. A row
// with nothing sealed in it is no row: nothing that came in the open is something the
// session said, whoever it says said it, and the server writes none of its own.
function rowOf(m) {
  if (!m || !('row' in m)) return null
  if (m.row && typeof m.row === 'object') return { ...m.row, ts: m.row.ts ?? m.ts, seq: m.seq, ...(m.hist ? { hist: true } : {}) }
  return { seq: m.seq, ts: m.ts, role: 'assistant', text: sealing?.UNOPENED ?? '' }
}

// A machine's own reason for something that failed, which came sealed beside the server's words and was opened here
const whyOf = (b) => (typeof b?.why === 'string' && b.why && !isLocked(b.why) ? ` (${b.why})` : '')

// The permission mode a session is in. One a machine's agent runs is in the mode that
// machine says (the agent sets it, and says so at once: the session's own card says it
// only at its next turn); any other, the mode on its card.
const modeOf = (s) => (s?.hosted ? app.machines.get(s.machine)?.hosted?.find((x) => x.sid === s.id)?.mode : '') || s?.permissionMode || null

// Something a session asks: what was sealed, under the id the server holds it by
// (and beside it only what the server says of its own: where it stands, and how it was answered)
function requestOf(r) {
  if (!r || !('q' in r)) return r
  const { q } = r
  const held = Object.fromEntries(['rid', 'sid', 'status', 'createdAt', 'answeredAt', 'closedAt', 'answer', 'resolution'].filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))
  return q && typeof q === 'object' ? { ...q, ...held } : { kind: 'approval', tool: sealing?.UNOPENED ?? '', input: {}, ...held }
}

// A machine (the server marks one `sealed: 3`, as its agent does). Its agent seals all it says of its sessions: its
// folders and what it has indexed are on its card, and of each session it runs or has open there is one sealed thing
function deviceOf(m) {
  if (!m || m.sealed !== 3 || m.shaped) return m
  const card = m.card && typeof m.card === 'object' ? m.card : {}
  const part = (x) => (x && typeof x === 'object' ? x : {})
  return {
    ...m,
    shaped: true,
    roots: card.roots ?? [],
    spawn: m.spawn ? (card.spawn ?? { folders: [], modes: [] }) : null,
    stats: card.stats ?? {},
    hosted: (m.hosted ?? []).map((h) => ({ ...part(h.s), sid: h.sid })),
    open: Object.fromEntries(Object.entries(m.open ?? {}).map(([sid, o]) => [sid, { ...part(o?.s), title: typeof o?.named === 'string' && !isLocked(o.named) ? o.named : '' }])),
  }
}

// A session from a machine's index, in this page's terms: `open` is what the machine says
// is open in a Claude Code process there, `hosted` what its agent runs itself
function catalogOf(mid, row, open = {}, hosted = []) {
  const live = app.sessions.get(row.sid)
  const running = open?.[row.sid] ?? null
  return {
    id: row.sid,
    machine: mid,
    title: row.title || (row.first_prompt ? String(row.first_prompt).slice(0, 80) : '') || folderOf(row.cwd) || row.sid.slice(0, 8),
    topic: row.first_prompt ?? '',
    cwd: row.cwd ?? '',
    project: folderOf(row.cwd),
    model: row.model ?? '',
    mode: row.mode ?? '',
    messages: row.messages ?? 0,
    prompts: row.prompts ?? 0,
    firstActivity: row.first_ts ?? 0,
    lastActivity: row.last_ts ?? 0,
    branch: row.branch ?? '',
    gone: !!row.gone,
    open: running ? { status: running.status, entrypoint: running.entrypoint, kind: running.kind } : null,
    hosted: (hosted ?? []).some((h) => h.sid === row.sid) || !!running?.mine,
    live: live && !live.ended && live.online ? live.state : null,
  }
}

// What a machine answered (`r`, opened), put into the shape the page reads: `of` says what was asked
const NOT_OPENED = 'what this computer answered could not be opened with the key this device has'
function machineAnswer({ of, machine, r, sid }) {
  const m = deviceOf(machine)
  const mid = m?.id
  const got = r && typeof r === 'object' ? r : null
  switch (of) {
    case 'sessions':
      return { machine: m, sessions: (got?.sessions ?? []).map((row) => catalogOf(mid, row, got.open, got.hosted)), ...(isLocked(r) ? { locked: true } : {}) }
    case 'messages':
      // (rows keep their order across pages)
      return got ? { session: got.session ? catalogOf(mid, got.session, got.open ? { [sid]: got.open } : {}, m.hosted) : null, messages: (got.rows ?? []).map((row, i) => ({ ...row, text: String(row.text ?? ''), ts: row.ts ?? Date.now(), seq: got.from * 1000 + i + 1 })), from: got.from, to: got.to, total: got.total } : { session: null, messages: [], from: 0, to: 0, total: 0, error: NOT_OPENED }
    case 'search.sessions':
      return { total: got?.total ?? 0, sessions: (got?.sessions ?? []).map((g) => ({ ...(g.session ? catalogOf(mid, g.session, m.open ?? {}, m.hosted) : { id: g.sid, machine: mid, title: g.sid.slice(0, 8), gone: true }), hits: g.hits, lastHit: g.last })) }
    case 'search.hits':
      return got ?? { total: 0, hits: [] }
    case 'folders':
      return got ?? { folders: [], allowed: [], others: [], unread: [] }
  }
  return got ?? { error: NOT_OPENED }
}
// One machine's part of a search across them all: null where it found nothing
function searchedOf(x) {
  const r = x.r && typeof x.r === 'object' ? x.r : null
  if (!r?.sessions) return null
  return { machine: x.machine, sessions: r.sessions, hits: r.hits, last: r.last, indexing: r.indexing ?? 0, projects: (r.projects ?? []).map((p) => ({ cwd: p.cwd, name: folderOf(p.cwd), sessions: p.sessions, hits: p.hits, last: p.last })) }
}

// Whatever came from the server, with what is a session's or a machine's put into shape
function shaped(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  if (data.closed === true) return sessionOf(data)
  if (typeof data.of === 'string' && 'r' in data) return machineAnswer(data)
  if (data.sealed === 3 && Array.isArray(data.capabilities)) return deviceOf(data)
  if (Array.isArray(data.machines)) {
    // (a list of the account's machines, or what each of them found in a search)
    const searched = data.machines.some((x) => x && 'r' in x && x.machine)
    data.machines = data.machines.map((x) => (x && 'r' in x && x.machine ? searchedOf(x) : deviceOf(x))).filter(Boolean)
    if (searched) {
      data.indexing = (data.indexing ?? 0) + data.machines.reduce((n, x) => n + (x.indexing ?? 0), 0)
      data.machines.sort((a, b) => (b.last ?? 0) - (a.last ?? 0))
    }
  }
  if (data.machine && typeof data.machine === 'object') data.machine = deviceOf(data.machine)
  if (Array.isArray(data.sessions)) data.sessions = data.sessions.map((s) => sessionOf(s, Array.isArray(data.machines) ? data.machines : undefined))
  if (data.session && typeof data.session === 'object') data.session = sessionOf(data.session)
  // (a chat's rows: the ones that came sealed, and no others)
  if (Array.isArray(data.messages)) data.messages = data.messages.map(rowOf).filter(Boolean)
  if (data.message && typeof data.message === 'object') data.message = rowOf(data.message)
  // (the reply as it is written comes in sealed pieces, each with where in the turn it belongs)
  const piece = (x) => (x && typeof x === 'object' ? String(x.text ?? '') : isLocked(x) ? '' : x)
  if (Array.isArray(data.partial)) data.partial = data.partial.map((p) => (Array.isArray(p?.pieces) ? { ...p, text: p.text ?? '', pieces: p.pieces.map(piece) } : p))
  if ('append' in data && 'sid' in data) data.append = piece(data.append)
  // (what a call came to: `r`, sealed whole)
  if ('r' in data && 'status' in data) {
    const { r, ...call } = data
    return r && typeof r === 'object' ? { ...call, ...r } : { ...call, ...(isLocked(r) ? { error: 'what it answered could not be opened with the key this device has' } : {}) }
  }
  // (and what a session said to the account's phones: `n`)
  if ('n' in data && 'sid' in data) {
    const { n, ...note } = data
    return n && typeof n === 'object' ? { ...note, kind: n.kind, title: n.title, message: n.body } : { ...note, kind: 'locked', message: sealing?.UNOPENED ?? '' }
  }
  return data
}

// A value sealed with this device's key: null when it has none. Nothing of a session
// leaves this page any other way, and nothing is asked of a session or a machine any
// other way: where this device has no key, that is said here and nothing is sent.
const sealFor = async (value) => (app.key ? vault.seal(value, app.key) : null)
const NO_KEY = 'this session is end-to-end encrypted, and this device does not have your key: type your passphrase under Account first'
const NO_KEY_MACHINE = 'What is asked of this computer is end-to-end encrypted, and this device does not have your key: type your passphrase under Account first.'

// What is asked of a computer is signed here (seal.js, orders): with this device's own
// key, which the browser made and keeps, and which the account's computers go by because
// the passphrase put this device on the list of the account's devices. The computer does
// what the order says, once, and nothing that came without one: so nobody between here
// and there, the server included, can ask anything of it in this account's name, or ask
// again what was asked before. `to` is the session or machine asked, `what` the kind of
// thing asked, `rest` all of it. undefined where this device has not been given the passphrase.
const orderFor = async (to, what, rest = {}) => (app.key ? vault.makeOrder({ to, do: what, with: rest }, app.key) : undefined)
// A prompt for a session, signed for the one that is to run it: the session's own plugin,
// or, for a session its machine's agent runs or is to start again (`viaAgent`), that
// machine's agent. One order has one runner, and so one memory of having been run: what
// was signed for the one is refused by the other, and by every other machine.
const promptOrder = (sid, machine, viaAgent, rest) => (viaAgent ? orderFor(machine, 'prompt', { ...rest, sid }) : orderFor(sid, 'prompt', rest))
// What follows "?" when a machine is asked to read something: one sealed thing (`c`).
// Which session, which folder, what words and how many are not the server's to read, and
// a machine reads nothing it was asked any other way.
const askOf = async (asked = {}) => 'c=' + encodeURIComponent((await sealFor(asked)) ?? '')
// A machine's folders, read from it: asked that way too, though there is nothing to say of which
const readFolders = async (mid) => (app.key ? fetch(`/api/machines/${mid}/folders?` + (await askOf())).catch(() => null) : null)
// The stream's first word is everything as it stands. Until it has come this page does
// not know the account's computers: what goes by what one of them allows waits for it.
let snapshotCame = () => {}
const snapshotSeen = new Promise((done) => (snapshotCame = done))

let keysModule = null
const keys = () => (crypto.subtle ? (keysModule ??= import('./keys.js')) : Promise.reject(new Error('A password can only be used on a secure page: open this server by its https address.')))

// Small DOM builder: h('div', { class: 'x' }, 'text', child)
function h(tag, attrs, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) listen(node, k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c)
  return node
}

// What a node made by h() does about an event is kept on the node and looked up as the
// event comes, so a node that stays on the page while its part is drawn again (`redraw`)
// can be handed what the new drawing does: that may be about newer things
function listen(node, type, fn) {
  const does = (node._does ??= {})
  if (!(type in does)) node.addEventListener(type, (ev) => node._does[type]?.call(node, ev))
  does[type] = fn
}

// ---- What the page asks before it does what is not put back with a press, and what it
// has to say that can't wait: in a box of its own (#ask-box), dressed as the rest of the
// page's boxes are, where the browser's own ("manyclaws.dev says") was. One at a time:
// what is asked while the box is open waits its turn.
//
//   await ask('Remove it?', { says: 'What comes of it.', yes: 'Remove', danger: true })   true, or false
//   await ask('Why not?', { text: '', yes: 'Deny' })      what was typed, or null where the box was left
//   tell('Not sent', 'Why not.')                          nothing to choose: read, and shut
//
// `yes` and `no` are what its two ways out are called (`no: null`: there is one way out);
// `danger`: what it does is not put back, so the way ahead is in the mark's colour and the
// box opens with the other one in hand. Escape, a press beside the box and going to
// another part of the page all leave it: false, or null.
let asking = Promise.resolve()
let askDone = null
function ask(title, about = {}) {
  const turn = asking.then(() => askNow(title, about))
  asking = turn.catch(() => {})
  return turn
}
const tell = (title, says = '') => ask(title, { says, no: null })

function askNow(title, { says = '', yes = 'OK', no = 'Cancel', danger = false, text = null, type = 'text' }) {
  const box = el('ask-box')
  const typed = text !== null
  el('ask-title').textContent = title
  fill(el('ask-says'), ...[says].flat().filter(Boolean).map((p) => h('p', null, p)))
  el('ask-text').hidden = !typed
  el('ask-text').type = type
  el('ask-text').value = text ?? ''
  el('ask-yes').textContent = yes
  el('ask-no').textContent = no ?? ''
  el('ask-no').hidden = no === null
  box.classList.toggle('danger', danger)
  if (!box.open) box.showModal()
  if (typed) el('ask-text').select()
  else (danger && no !== null ? el('ask-no') : el('ask-yes')).focus()
  return new Promise((answered) => {
    askDone = (went) => {
      askDone = null
      const value = typed ? (went ? el('ask-text').value : null) : went
      if (box.open) box.close()
      answered(value)
    }
  })
}
el('ask-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  askDone?.(true)
})
el('ask-no').addEventListener('click', () => askDone?.(false))
// (a press beside the box, on what is behind it, leaves it; so does Escape, which shuts it itself)
el('ask-box').addEventListener('click', (ev) => ev.target === el('ask-box') && askDone?.(false))
el('ask-box').addEventListener('close', () => {
  // (a browser says a box was shut with its next frame: by then it may be open again, on what is asked next)
  if (!el('ask-box').open) askDone?.(false)
})
window.addEventListener('hashchange', () => askDone?.(false))

// ---- Drawing a part of the page again without taking it down. `redraw` makes what is
// there into what it should be now and touches only what differs. A row that hasn't
// changed is left as the node it was: it keeps its place under a finger, a press that's
// on it, and where its blinking had got to. One that has moved is moved, not made again.

// Makes `old` into what `fresh` is. Gives the node that stands there now.
function morph(old, fresh) {
  if (old.nodeType !== fresh.nodeType || old.nodeName !== fresh.nodeName) {
    old.replaceWith(fresh)
    return fresh
  }
  if (old.nodeType !== Node.ELEMENT_NODE) {
    if (old.data !== fresh.data) old.data = fresh.data
    return old
  }
  for (const { name, value } of [...fresh.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value)
  for (const { name } of [...old.attributes]) if (!fresh.hasAttribute(name)) old.removeAttribute(name)
  for (const type in old._does ?? {}) old._does[type] = null
  for (const type in fresh._does ?? {}) listen(old, type, fresh._does[type])
  const mine = [...old.childNodes]
  const theirs = [...fresh.childNodes]
  theirs.forEach((child, i) => (mine[i] ? morph(mine[i], child) : old.append(child)))
  for (const gone of mine.slice(theirs.length)) gone.remove()
  return old
}

// Of `nodes`, the most of those already in `box` that stand in this order as they are:
// the ones that needn't be moved (the longest run of rising places among them)
function inOrder(nodes, box) {
  const place = new Map([...box.children].map((node, i) => [node, i]))
  const ends = [] // ends[k]: where in `nodes` the best run of k + 1 ends
  const before = new Array(nodes.length).fill(-1)
  nodes.forEach((node, i) => {
    const at = place.get(node)
    if (at === undefined) return
    let lo = 0
    let hi = ends.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (place.get(nodes[ends[mid]]) < at) lo = mid + 1
      else hi = mid
    }
    before[i] = lo ? ends[lo - 1] : -1
    ends[lo] = i
  })
  const stay = new Set()
  for (let i = ends.length ? ends.at(-1) : -1; i >= 0; i = before[i]) stay.add(nodes[i])
  return stay
}

// The children of `box` made into `nodes`. A node goes on being the one it was where it
// has a key (data-key: the same thing as before, wherever it stands now), and failing
// that by its place among those that have none.
function redraw(box, nodes) {
  // (two with one key are told apart by which comes first)
  const keys = (list) => {
    const seen = new Map()
    let unkeyed = 0
    return list.map((node) => {
      const key = node.dataset.key ?? '#' + unkeyed++
      const times = seen.get(key) ?? 0
      seen.set(key, times + 1)
      return times ? key + '\u0000' + times : key
    })
  }
  const there = [...box.children]
  const had = new Map(keys(there).map((key, i) => [key, there[i]]))
  const wanted = keys(nodes)
  const now = nodes.map((fresh, i) => {
    const old = had.get(wanted[i])
    had.delete(wanted[i])
    return old ? morph(old, fresh) : fresh
  })
  for (const gone of had.values()) gone.remove()
  // Their order: each one out of place is put before the one it comes before, last first
  const stay = inOrder(now, box)
  let next = null
  for (let i = now.length - 1; i >= 0; i--) {
    const node = now[i]
    if (!stay.has(node)) {
      // (a move, where the browser has one, keeps what a node moved is in the middle of)
      try {
        if (node.parentNode === box && box.moveBefore) box.moveBefore(node, next)
        else box.insertBefore(node, next)
      } catch {
        box.insertBefore(node, next)
      }
    }
    next = node
  }
}

// ---- The look: VS Code's (the default) or the terminal's, remembered on this device

function setView(view, { save = false } = {}) {
  const box = el('messages')
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  app.view = VIEWS.includes(view) ? view : 'vscode'
  document.documentElement.dataset.view = app.view
  if (app.footMenu) closeFootMenu()
  for (const b of document.querySelectorAll('[data-set-view]')) b.setAttribute('aria-pressed', String(b.dataset.setView === app.view))
  if (save) {
    try {
      localStorage.setItem('mc.view', app.view)
    } catch {}
  }
  fitTerminalGrid()
  autosize()
  refoldSoon()
  if (nearEnd) scrollToEnd()
}

// Terminal.app sets its text on a grid of whole points: SF Mono 11 sits in cells 7
// wide and 14 tall. The stylesheet has the cell (--cell-w, and the line height);
// the space between letters that fills it out depends on which fixed-width font
// this browser found, so it's measured.
function fitTerminalGrid() {
  const root = document.documentElement
  root.style.removeProperty('--track')
  if (app.view !== 'terminal') return
  const probe = h('span', { class: 'cell-probe' }, 'M'.repeat(100))
  document.body.append(probe)
  const advance = probe.getBoundingClientRect().width / 100
  probe.remove()
  const cell = parseFloat(getComputedStyle(root).getPropertyValue('--cell-w'))
  if (advance && cell) root.style.setProperty('--track', (cell - advance).toFixed(3) + 'px')
}

document.fonts?.ready.then(fitTerminalGrid)

for (const b of document.querySelectorAll('[data-set-view]')) b.addEventListener('click', () => setView(b.dataset.setView, { save: true }))

// ---- The edge between the list and the chat: dragged, or moved with the arrow keys.
// The width is kept on this device; a double-click gives the look's own width back.

const LIST_MIN = 200

function setListWidth(px, { save = false } = {}) {
  const most = Math.max(LIST_MIN, Math.min(innerWidth - 320, innerWidth * 0.7))
  const width = Math.round(Math.min(Math.max(px, LIST_MIN), most))
  document.documentElement.style.setProperty('--list-width', width + 'px')
  if (!save) return
  try {
    localStorage.setItem('mc.listWidth', String(width))
  } catch {}
  // Lines wrap differently at the new width
  refoldSoon()
  autosize()
}

function resetListWidth() {
  document.documentElement.style.removeProperty('--list-width')
  try {
    localStorage.removeItem('mc.listWidth')
  } catch {}
  refoldSoon()
}

el('divider').addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return
  ev.preventDefault()
  const bar = el('divider')
  const left = el('list-pane').getBoundingClientRect().left
  bar.setPointerCapture(ev.pointerId)
  bar.classList.add('dragging')
  document.body.classList.add('resizing')
  const move = (e) => setListWidth(e.clientX - left)
  const done = () => {
    bar.classList.remove('dragging')
    document.body.classList.remove('resizing')
    bar.removeEventListener('pointermove', move)
    bar.removeEventListener('pointerup', done)
    bar.removeEventListener('pointercancel', done)
    setListWidth(el('list-pane').getBoundingClientRect().width, { save: true })
  }
  bar.addEventListener('pointermove', move)
  bar.addEventListener('pointerup', done)
  bar.addEventListener('pointercancel', done)
})
el('divider').addEventListener('dblclick', resetListWidth)
el('divider').addEventListener('keydown', (ev) => {
  const step = { ArrowLeft: -16, ArrowRight: 16 }[ev.key]
  if (!step) return
  ev.preventDefault()
  setListWidth(el('list-pane').getBoundingClientRect().width + step, { save: true })
})
// A narrower window can't keep a list wider than it allows
window.addEventListener('resize', () => {
  if (document.documentElement.style.getPropertyValue('--list-width')) setListWidth(parseFloat(document.documentElement.style.getPropertyValue('--list-width')))
})
// The chat's head says more in words where it has less room for marks: drawn again when the page becomes a phone's or stops being one
matchMedia('(max-width: 760px)').addEventListener('change', () => {
  if (app.past) renderPastHeader()
  else if (app.current && app.sessions.has(app.current)) renderHeader()
})

// ---- Start-up and sign-in

try {
  const width = Number(localStorage.getItem('mc.listWidth'))
  if (width) setListWidth(width)
} catch {}

let stored = null
try {
  stored = localStorage.getItem('mc.view')
} catch {}
setView(stored)
init()

async function init() {
  autoRead()
  dress()
  sealing = await import('./seal.js').catch(() => null)
  vault = await keys().catch(() => null)
  // A link of the form https://server/#login=TOKEN signs a new device in once (the server's web token, to its first account)
  const link = /^#login=(.+)$/.exec(location.hash)
  if (link) {
    history.replaceState(null, '', location.pathname)
    await login({ token: decodeURIComponent(link[1]) })
  }
  // The page to make an account: https://server/#signup, or with an invite, https://server/#invite=CODE
  const invite = /^#invite=([A-Za-z0-9_-]+)$/.exec(location.hash)
  const signup = invite || location.hash === '#signup'
  if (signup) history.replaceState(null, '', location.pathname)
  // Back from Stripe's page (https://server/?paid=SESSION): the server reads from Stripe what was paid for
  const paid = new URLSearchParams(location.search).get('paid')
  let bought = false
  if (paid) {
    history.replaceState(null, '', location.pathname + location.hash)
    bought = (await sendJson('/api/billing/paid', { session: paid })).ok
  }
  if (!(await loadAccount())) return signup ? showSignup(invite?.[1] ?? '') : showLogin()
  // (paid for, on a desk's browser: once it is in, it is shown how ManyClaws is used on a phone)
  if (bought && app.account.billing?.entitled && onDesk()) tourKeep(app.account.user.id)
  enter()
}

// Signed in: to the sessions; or first, on a server that sends mail, to the code its
// email was sent, on one that charges, to the plans, and on a browser that has not been
// given the account's passphrase, to where it is typed
function enter() {
  const b = app.account?.billing
  if (app.account?.user.verified === false) return showVerify()
  if (b?.on && !b.entitled) return showPay()
  return keyWanted() ? showPassphrase() : showApp()
}

// A server that charges has a front door (home.html). The cards to sign in, to make an
// account and to pay are dressed as it is (site/join.css).
async function dress() {
  const plans = await fetch('/api/plans')
    .then((r) => r.json())
    .catch(() => null)
  // (whether this server sends mail: it is what a forgotten password is got past by)
  app.mail = !!plans?.verify
  showRecover()
  if (!plans?.on) return
  document.documentElement.dataset.site = '1'
  el('join-art').hidden = false
  el('signup-terms').hidden = false
  for (const h of document.querySelectorAll('#login [data-site-says]')) h.textContent = h.dataset.siteSays
}

// Who is signed in, and what they need to connect a computer: null when nobody is
async function loadAccount() {
  const r = await fetch('/api/account').catch(() => null)
  app.account = r?.ok ? await r.json() : null
  // Its key, where this browser has it: the one made here from the passphrase that was
  // typed here. The server has nothing to tell it by: whether it is the key the account's
  // computers seal with shows in whether what they send opens (opened, showNotices)
  // (with it, this device's own key, which signs what it asks of the account's computers)
  app.key = app.account && vault && sealing ? await vault.heldKey(app.account.user.id).catch(() => null) : null
  await keepPasswordMark().catch(() => {})
  // Its own small session, which is none of its conversations: read here, so that what
  // is said of the account counts it out, and seen to where this browser has the key
  app.firstId = app.account ? firstIdOf(app.account.user.id) : null
  app.first = app.firstId && app.account.sessions ? await fetch('/api/sessions/' + app.firstId).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null
  showNotices()
  lookAgain()
  await readDrafts()
  seeToFirst().catch(() => {})
  seeToDevice().catch(() => {})
  return app.account
}

// ---- Signed out: the cards to sign in (by email, or by the server's web token) and to make an account

function showCard(id) {
  for (const card of document.querySelectorAll('#login .login-card')) card.hidden = card.id !== id
  el(id).querySelector('input')?.focus()
}
for (const b of document.querySelectorAll('#login [data-card]')) b.addEventListener('click', () => showCard(b.dataset.card))

function showLogin() {
  app.signedOut = true
  app.sawSealed = false
  app.unopenedWas = ''
  app.account = null
  app.firstId = app.first = app.firstSeenTo = null
  clearTimeout(app.reconnect)
  app.stream?.close()
  el('app').hidden = true
  el('login').hidden = false
  showCard('login-form')
  return signupMode()
}

// How this server takes new accounts: from anyone ('open'), by an invite's link ('invite'),
// or not at all ('closed'). Making one is offered where anyone may; an invite's link opens the form itself.
async function signupMode() {
  const mode = await fetch('/api/signup')
    .then((r) => r.json())
    .then((can) => can.mode)
    .catch(() => '')
  if (!mode) return ''
  el('login-new').hidden = mode !== 'open'
  return mode
}

// An invite as it was given: its code, or the whole link the code is in
function inviteCode(text) {
  return /[#?&]invite=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? String(text).trim()
}

// The form to make an account, with the invite a link brought already in it
async function showSignup(invite = '') {
  const say = (id, why) => {
    el(id).textContent = why
    el(id).hidden = false
  }
  const mode = await showLogin()
  if (mode === 'closed') return say('login-error', 'This server is not taking new accounts.')
  if (mode === 'invite' && !invite) return say('login-error', "An account here is made with an invite: open the link you were sent by whoever runs this server.")
  el('signup-invite').value = invite
  showCard('signup-form')
  if (!invite) return
  const can = await fetch('/api/signup?invite=' + encodeURIComponent(invite))
    .then((r) => r.json())
    .catch(() => ({ ok: false, why: 'The server could not be reached.' }))
  if (!can.ok) say('signup-error', can.why)
}

// Sends JSON: { ok, data }, or { ok: false, error } in the server's own words when it says no
async function sendJson(path, body, method = 'POST') {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
  const data = await r?.json().catch(() => null)
  return r?.ok ? { ok: true, data } : { ok: false, error: data?.error ?? 'The server could not be reached.' }
}

// Signs in by the server's web token (the one-time link's way in, to the server's first account)
async function login(body) {
  return (await sendJson('/api/login', body)).error ?? ''
}

// Signs in by email and password. The password stays here: the server tells how it is
// stretched, and is sent what comes of that.
async function signIn(email, password) {
  const K = await keys()
  const params = await fetch('/api/login/params?email=' + encodeURIComponent(email))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (!params) return 'The server could not be reached.'
  const auth = await K.signInKey(password, params)
  const r = await sendJson('/api/login', { email, password: auth })
  if (r.ok) await markPassword(K, auth)
  return r.ok ? '' : r.error
}

// The password this browser signs in with is marked (keys.js, passwordMark), so that it is
// not chosen for the account's passphrase too: what a passphrase typed here is held
// against, on this browser and nowhere else. Made as the password is used; kept once the
// account it is for is known (loadAccount), which is a moment later.
let passwordMarked = null
async function markPassword(K, auth) {
  passwordMarked = await K.passwordMark(auth).catch(() => null)
}
async function keepPasswordMark() {
  const id = app.account?.user.id
  if (!passwordMarked || !id || !vault) return
  await vault.keepMark(id, passwordMarked)
  passwordMarked = null
}

// Makes an account. The password isn't sent: what it is stretched into is, with how.
async function signUp({ email, password, invite }) {
  const K = await keys()
  // (the server never has the password, so it's the page that holds it to a length)
  if (password.length < K.MIN_PASSWORD) return 'The password needs at least 8 characters.'
  const made = await K.newPassword(password)
  const r = await sendJson('/api/signup', { email, password: made.auth, invite, kdf: made.kdf })
  if (r.ok) await markPassword(K, made.auth)
  return r.ok ? '' : r.error
}

// A forgotten password: a code is sent to the account's email, then typed here with a new
// password. The password isn't sent: what it is stretched into is, with how. It has
// nothing to do with the encryption passphrase, which the server has nothing of: the
// key this browser holds, if it holds one, is as it was. A server that sends no mail
// can do none of this, and the card says so.
function showRecover(sent = false) {
  app.recoverSent = sent
  const can = app.mail !== false
  el('recover-note').textContent = !can
    ? 'A forgotten password cannot be reset here: this server sends no mail, and it never has your password. Ask whoever runs it to delete the account, and make a new one with the same email.'
    : sent
      ? 'If that email has an account here, a 6-digit code is on its way to it. Type it here with a new password. Your encryption passphrase stays as it is.'
      : 'Enter your email and we will send it a code to set a new password with.'
  el('recover-email').hidden = !can
  el('recover-email').readOnly = sent
  for (const id of ['recover-code', 'recover-password', 'recover-again']) el(id).hidden = !can || !sent
  for (const id of ['recover-code', 'recover-password']) el(id).required = can && sent
  el('recover-go').hidden = !can
  el('recover-go').textContent = sent ? 'Set the new password' : 'Email me a code'
}
el('recover-again').addEventListener('click', () => {
  for (const id of ['recover-code', 'recover-password']) el(id).value = ''
  el('recover-error').hidden = true
  showRecover(false)
})
async function recover() {
  const email = el('recover-email').value.trim()
  if (!app.recoverSent) {
    const r = await sendJson('/api/reset/send', { email })
    if (!r.ok) return r.error
    showRecover(true)
    el('recover-code').focus()
    return 'sent'
  }
  const K = await keys()
  const password = el('recover-password').value
  if (password.length < K.MIN_PASSWORD) return 'The password needs at least 8 characters.'
  const made = await K.newPassword(password)
  const r = await sendJson('/api/reset', { email, code: el('recover-code').value, password: made.auth, kdf: made.kdf })
  if (r.ok) showRecover(false)
  return r.ok ? '' : r.error
}

// A card's form: what it sends, and where it says why not
function onCard(form, error, send, then = () => {}) {
  el(form).addEventListener('submit', async (ev) => {
    ev.preventDefault()
    el(error).hidden = true
    const button = el(form).querySelector('button[type=submit]')
    button.disabled = true
    const why = await send().catch((err) => err.message || 'That did not work.')
    button.disabled = false
    // (a step of the card taken, with more of it to come)
    if (why === 'sent') return
    if (why) {
      el(error).textContent = why[0].toUpperCase() + why.slice(1) + (/[.?!]$/.test(why) ? '' : '.')
      el(error).hidden = false
      return
    }
    for (const input of el(form).querySelectorAll('input')) input.value = ''
    await loadAccount()
    then()
    enter()
  })
}
onCard('login-form', 'login-error', () => signIn(el('login-email').value, el('login-password').value))
onCard('token-form', 'token-error', () => login({ token: el('login-token').value.trim() }))
onCard('recover-form', 'recover-error', recover)
onCard(
  'signup-form',
  'signup-error',
  () => signUp({ email: el('signup-email').value, password: el('signup-password').value, invite: inviteCode(el('signup-invite').value) }),
  // A new account has nothing connected: it starts at how to connect a computer
  () => (location.hash = '#/setup'),
)

// Signed out, this device is told nothing more of the account: its alerts stop, until
// someone signs in here again. Its key stays where the device is its owner's own, which
// was asked as the passphrase was typed (passphrasePart), and opens the account's sessions
// as soon as it is signed in to again, with no passphrase typed; on any other it goes.
async function signOut() {
  const id = app.account?.user.id
  // (the server forgets where this device's alerts go. The device keeps what its push
  // service gave it, and hands it over again at the next sign-in: syncAlerts)
  const sub = await app.worker?.pushManager?.getSubscription().catch(() => null)
  if (sub) await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
  app.pushOn = false
  await fetch('/api/logout', { method: 'POST' })
  if (id && !app.key?.own) await vault?.dropKey(id).catch(() => {})
  if (id) await vault?.dropMark(id).catch(() => {})
  app.key = null
  app.drafts = {}
  keyLater(false)
  location.hash = ''
  showLogin()
}
el('logout').addEventListener('click', () => signOut())
el('pay-logout').addEventListener('click', () => signOut())
el('verify-logout').addEventListener('click', () => signOut())

// ---- A browser that has not been given the account's passphrase is asked for it as it
// comes in, before the sessions: signed in to, or opened again by someone still signed in
// (a device that is not its owner's own holds the key only while the page is open). Without
// the key it could show them only as encrypted. The box is the one the account's page has
// (passphraseParts), and what is typed goes the same way: made into the key here, with
// nothing of it sent. It can be left for later ("Not now"): the sessions then, closed, with
// the line across the top that leads to the box. That is kept for as long as the tab is, so
// the page loaded again there does not ask again, and it is said of the one sign-in: signed
// in to again, by this account or another, the browser is asked afresh.

// This browser's sign-in, by the name the server gives it (GET /api/account, `login`)
const signInName = () => app.account?.login ?? app.account?.user.id ?? null
// "Not now", said here of this sign-in (true), or taken back
function keyLater(said) {
  app.keyLater = said ? signInName() : null
  try {
    if (app.keyLater) sessionStorage.setItem('mc.keyLater', app.keyLater)
    else sessionStorage.removeItem('mc.keyLater')
  } catch {}
}
function saidLater() {
  const name = signInName()
  let kept = null
  try {
    kept = sessionStorage.getItem('mc.keyLater')
  } catch {}
  return !!name && (app.keyLater ?? kept) === name
}
// Asked as the page comes in, and not of a page that is showing its sessions (one that lets
// go of its key there says so in the line across the top); nor of a browser that can make no
// key (keys.js: not a secure page)
const keyWanted = () => !app.key && !!vault && !!sealing && app.signedOut !== false && !saidLater()

function showPassphrase() {
  app.signedOut = true
  clearTimeout(app.reconnect)
  app.stream?.close()
  el('app').hidden = true
  el('login').hidden = false
  const p = passphraseParts(showPassphrase)
  p.here.classList.add('muted')
  // (what a passphrase is and where to keep one is said under the box: in full to an account with nothing here yet,
  // which may be choosing its first; to one that has sessions here it is a line to open)
  const about = h('details', { class: 'passphrase-about', 'data-part': 'passphrase-about', open: !app.account.sessions }, h('summary', null, 'What a passphrase is, and where to keep it'), p.about, p.vaultSays)
  fill(el('passphrase-ask'), p.here, p.form, about)
  showCard('passphrase-card')
  p.form.querySelector('[data-part=passphrase-new]').focus()
}
el('passphrase-later').addEventListener('click', () => {
  keyLater(true)
  showApp()
})
el('passphrase-logout').addEventListener('click', () => signOut())

// ---- A server that sends mail: the account's email is shown to be its own, by the code sent to it

function showVerify(note = '') {
  app.signedOut = true
  clearTimeout(app.reconnect)
  app.stream?.close()
  el('app').hidden = true
  el('login').hidden = false
  el('verify-note').textContent = `We sent a 6-digit code to ${app.account.user.email}. Type it here to finish making your account.`
  el('verify-error').textContent = note
  el('verify-error').hidden = !note
  showCard('verify-form')
}
onCard('verify-form', 'verify-error', async () => (await sendJson('/api/account/verify', { code: el('verify-code').value })).error ?? '')
el('verify-again').addEventListener('click', async () => {
  const r = await sendJson('/api/account/verify/send', {})
  showVerify(r.ok ? 'Sent. It can take a minute to arrive.' : r.error[0].toUpperCase() + r.error.slice(1) + '.')
})
// A mistyped address is put right here: the code goes to the new one
el('verify-email').addEventListener('click', async () => {
  const email = (await ask('Your email address', { says: 'The code goes to the address you give here.', text: app.account.user.email, type: 'email', yes: 'Send the code' }))?.trim()
  if (!email || email === app.account.user.email) return
  const r = await sendJson('/api/account', { email }, 'PUT')
  if (r.ok) await loadAccount()
  showVerify(r.ok ? '' : r.error[0].toUpperCase() + r.error.slice(1) + '.')
})

// ---- A server that charges: the plans, and the way to Stripe's pages. Paying, and
// changing a card or cancelling, are done on Stripe's own pages: this one only goes there.

const money = (p) => new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency }).format(p.amount / 100)
const planText = (p) => `${money(p)} a ${p.interval}`
const dayText = (ts) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })

// To one of Stripe's pages, which the server makes: it says where, or why not
async function toStripe(path, body = {}) {
  const r = await sendJson(path, body)
  if (r.ok && r.data?.url) location.href = r.data.url
  return r.ok ? '' : r.error
}

function showPay() {
  const b = app.account.billing
  app.signedOut = true
  clearTimeout(app.reconnect)
  app.stream?.close()
  el('app').hidden = true
  el('login').hidden = false
  el('pay-error').hidden = true
  const was = b.subscription && !['incomplete', 'incomplete_expired'].includes(b.subscription.status)
  el('pay-note').textContent = (was ? 'Your subscription has ended. ' : '') + 'Every Claude Code session you have running, on every computer, on one page and on your phone.' + (b.trialDays && !was ? ` Free for ${b.trialDays} days, and you can cancel at any time.` : ' You can cancel at any time.')
  const say = (why) => {
    el('pay-error').textContent = why
    el('pay-error').hidden = !why
  }
  fill(
    el('pay-plans'),
    ...b.prices.map((p) =>
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          'data-plan': p.plan,
          onclick: async (ev) => {
            const button = ev.currentTarget
            button.disabled = true
            say(await toStripe('/api/billing/checkout', { plan: p.plan }))
            button.disabled = false
          },
        },
        h('span', null, p.plan === 'yearly' ? 'Yearly' : 'Monthly'),
        h('small', null, planText(p)),
        // (what a year saves over twelve months, where it does)
        p.plan === 'yearly' && b.prices.some((m) => m.plan === 'monthly' && m.amount * 12 > p.amount) && h('em', null, `${money({ ...p, amount: b.prices.find((m) => m.plan === 'monthly').amount * 12 - p.amount })} less than twelve months`),
      ),
    ),
  )
  if (!b.prices.length) say('What a subscription costs could not be read just now. Try again in a minute.')
  el('pay-manage').hidden = !was
  // (where the plans start with free days, a code has a way of its own: Stripe's page with no trial, which asks for no card where the code leaves nothing to pay)
  el('pay-code').hidden = !b.trialDays || !b.prices.some((p) => p.plan === 'monthly')
  showCard('pay-card')
}
el('pay-manage').addEventListener('click', async () => {
  const why = await toStripe('/api/billing/portal')
  el('pay-error').textContent = why
  el('pay-error').hidden = !why
})
el('pay-code').addEventListener('click', async () => {
  const why = await toStripe('/api/billing/checkout', { plan: 'monthly', code: true })
  el('pay-error').textContent = why
  el('pay-error').hidden = !why
})

function showApp() {
  app.signedOut = false
  el('login').hidden = true
  el('app').hidden = false
  try {
    app.showEnded = localStorage.getItem('mc.showEnded') === '1'
    app.pastBy = localStorage.getItem('mc.pastBy') === 'project' ? 'project' : 'time'
    app.shut = new Set(JSON.parse(localStorage.getItem('mc.shut')) ?? [])
  } catch {}
  app.tile = tileKept()
  el('show-ended').checked = app.showEnded
  markPastBy()
  markTile()
  // Signed in: this device's subscription, if it has one, is handed to the server again
  syncAlerts()
  connect()
  route()
  showTour()
}

// ---- A little tour, once, for an account that has just paid, on a desk's browser: how
// ManyClaws is used on a phone. There is no app to get: a phone opens this same page. The
// first step says so; the second, that the phone is signed in to and given the passphrase as
// this browser was; the third, how it comes to send alerts. Under each is the page's address
// and a code a phone's camera opens it by (qr.js: the address of the page's way in and
// nothing else, nothing of the account's). It is shown as the sessions first are after paying, which is after
// the passphrase's card where that came first, and may be a page load later: so that it
// is due is kept on this browser, by the account, until it has been seen out or shut.
const TOUR = [
  {
    title: 'There is no app to install.',
    says: ['On a phone, ManyClaws is this same page. Open it in your phone’s browser, or point the phone’s camera at this code.'],
    shot: ['shot-list', 'The ManyClaws page on a phone: six Claude Code sessions on four computers, two of them marked as needing an answer'],
  },
  {
    title: 'Sign in there, and type your passphrase.',
    says: ['Sign in with the email and password you use here. Your phone then asks for your encryption passphrase, the same one on every device of yours: your sessions are sealed, and each device opens them itself.'],
    shot: ['shot-question', 'A session on a phone asking a question, with two answers to tap and a box to type another'],
  },
  {
    title: 'Then let it tap you.',
    says: [
      'Under the list of sessions, Notifications turns alerts on: a session that stops to ask, or has finished, sends one to your phone.',
      'On an iPhone, add the page to your Home Screen first, from Safari’s Share menu, and open ManyClaws from there. On Android, the browser asks once.',
    ],
    shot: ['shot-approve', 'A session on a phone, stopped at a permission prompt: Claude wants to use Bash to run a migration on staging, with Allow and Deny'],
  },
]
// A desk's browser, as far as a page can tell: what points at it is not a finger
const onDesk = () => !matchMedia('(pointer: coarse)').matches
// That the tour is due to an account on this browser (its id), or is not any more (null)
function tourKeep(id) {
  app.tourFor = id
  try {
    if (id) localStorage.setItem('mc.tour', id)
    else localStorage.removeItem('mc.tour')
  } catch {}
}
function tourDue() {
  let kept = null
  try {
    kept = localStorage.getItem('mc.tour')
  } catch {}
  return !!app.account && (app.tourFor !== undefined ? app.tourFor : kept) === app.account.user.id
}

async function showTour() {
  const box = el('tour-box')
  if (!tourDue() || box.open) return
  // The page's address, as a phone is given it: said without what a browser puts before it. The code has the page's
  // own way in (/app), which is where a phone that is not signed in is asked to: a server's front door, where it has
  // one, is a step before that
  const address = String(app.account.server || location.origin).replace(/\/+$/, '')
  el('tour-address').textContent = address.replace(/^https?:\/\//, '')
  const code = await import('./qr.js').then((qr) => qr.qrOf(address + '/app')).catch(() => null)
  fill(el('tour-code'), code && qrPicture(code))
  el('tour-code').hidden = !code
  if (!tourDue() || box.open || app.signedOut) return
  app.tourAt = 0
  drawTour()
  box.showModal()
  el('tour-next').focus()
}
function drawTour() {
  const step = TOUR[app.tourAt]
  el('tour-tag').textContent = `On your phone · ${app.tourAt + 1} of ${TOUR.length}`
  el('tour-title').textContent = step.title
  fill(el('tour-says'), ...step.says.map((p) => h('p', null, p)))
  el('tour-shot').src = `/site/img/real/${step.shot[0]}.webp?v=2`
  el('tour-shot').alt = step.shot[1]
  fill(el('tour-dots'), ...TOUR.map((_, i) => h('i', { class: i === app.tourAt ? 'on' : '' })))
  el('tour-back').hidden = app.tourAt === 0
  el('tour-next').textContent = app.tourAt === TOUR.length - 1 ? 'Done' : 'Next'
}
// A code as a picture: its dark modules on a light ground, whatever the page's own colours are (a camera reads dark
// on light), with the plain band about it that a code is told from its surroundings by
function qrPicture({ size, rows }) {
  const NS = 'http://www.w3.org/2000/svg'
  const band = 4
  const make = (tag, attrs) => {
    const node = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    return node
  }
  const svg = make('svg', { viewBox: `0 0 ${size + 2 * band} ${size + 2 * band}`, role: 'img', 'aria-label': 'A code for a phone’s camera: it opens this page on the phone', 'shape-rendering': 'crispEdges' })
  svg.append(
    make('rect', { width: '100%', height: '100%', fill: '#faf9f5' }),
    make('path', { fill: '#141413', d: rows.map((row, y) => row.map((dark, x) => (dark ? `M${x + band} ${y + band}h1v1h-1z` : '')).join('')).join('') }),
  )
  return svg
}
// Seen out, or shut by its cross or by Escape: it is not shown again
// (a browser says a box was shut only with its next frame: what shuts it here says so at once)
function endTour() {
  tourKeep(null)
  if (el('tour-box').open) el('tour-box').close()
}
el('tour-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  if (app.tourAt === TOUR.length - 1) return endTour()
  app.tourAt++
  drawTour()
})
el('tour-back').addEventListener('click', () => {
  app.tourAt = Math.max(0, app.tourAt - 1)
  drawTour()
})
el('tour-close').addEventListener('click', endTour)
el('tour-box').addEventListener('close', endTour)

// ---- Live updates

// The stream is the browser's EventSource. It comes back by itself after a network error,
// but an answer that isn't the stream closes it for good (a proxy's 502 while the server
// restarts), and a connection can die without a word, on a phone above all. Either way
// the page would go on showing the moment it stopped at. So the page opens the stream
// again itself: when it has closed, when nothing has been heard on it for longer than the
// server ever stays quiet, and at once when the page is come back to. A stream's first
// word is everything as it stands, which is how what was missed is caught up with.
function connect() {
  clearTimeout(app.reconnect)
  app.reconnect = null
  app.stream?.close()
  const stream = new EventSource('/api/stream')
  app.stream = stream
  app.heard = Date.now()
  // (opening takes the browser a moment each time. Each thing is begun on as it comes, beside the ones before it, and
  // heard in its turn: what was said first is heard first, and a hundred rows take no longer to open than one)
  let turn = Promise.resolve()
  const on = (type, fn) =>
    stream.addEventListener(type, (ev) => {
      app.heard = Date.now()
      // (what a session said is opened here, as the stream gives it, and put into shape)
      if (typeof ev.data !== 'string') return fn(ev)
      const data = JSON.parse(ev.data)
      const sealed = sealing && ev.data.includes(sealing.SEALED)
      const opening = sealed ? openHere(data) : null
      // (a failure to open is the turn's to report, not a promise nobody is waiting on yet)
      opening?.catch(() => {})
      turn = turn
        .then(async () => {
          if (stream !== app.stream) return
          fn({ data: JSON.stringify(shaped(sealed ? opened(await opening) : data)) })
        })
        .catch((err) => console.error(err))
    })
  on('open', () => {
    app.streamTries = 0
    app.downSince = null
    el('conn').classList.add('live')
    showNotices()
    // (the list of the account's devices may have been put anew while nothing was heard: is this one still on it?)
    seeToDevice().catch(() => {})
  })
  on('ping', (ev) => pageBuild(JSON.parse(ev.data).build))
  // (the list of the account's devices was put anew, from here or from another of them: is this one still on it?)
  on('devices', () => seeToDevice().catch(() => {}))
  stream.addEventListener('error', async () => {
    if (stream !== app.stream) return
    el('conn').classList.remove('live')
    app.downSince ??= Date.now()
    const closed = stream.readyState === EventSource.CLOSED
    // A signed-out page has to sign in again instead
    const r = await fetch('/api/sessions').catch(() => null)
    if (stream !== app.stream) return
    if (r?.status === 401) return showLogin()
    // One whose subscription has ended is shown the plans, and one whose email has changed, the code
    if (r?.status === 402 || r?.status === 403) return (await loadAccount()) ? enter() : showLogin()
    // The browser tries again by itself, unless it has given the stream up
    if (closed) reconnectSoon()
  })
  on('snapshot', (ev) => {
    const snapshot = JSON.parse(ev.data)
    // (the stream was away: what was typed meanwhile in a session that is not open went by unread)
    for (const id of [...app.typed.keys()]) if (id !== app.current) app.typed.delete(id)
    if (snapshot.ping) app.quietMs = Math.max(1000, snapshot.ping * 2.5)
    pageBuild(snapshot.build)
    // (the plugin and the agent the server hands out now: a computer's own are held against them)
    app.latest = snapshot.latest ?? {}
    // (the account's own small session is none of its conversations: kept apart, and out of the list)
    app.first = snapshot.sessions.find((s) => s.id === app.firstId) ?? null
    snapshot.sessions = snapshot.sessions.filter((s) => s.id !== app.firstId)
    app.sessions = new Map(snapshot.sessions.map((s) => [s.id, s]))
    app.tellings++
    app.told = new Map(snapshot.sessions.map((s) => [s.id, app.tellings]))
    app.machines = new Map((snapshot.machines ?? []).map((m) => [m.id, m]))
    autoApprove()
    snapshotCame()
    app.favorites = snapshot.favorites ?? []
    for (const s of app.sessions.values()) favoriteKept(s)
    app.marks = new Map((snapshot.marks ?? []).map((m) => [m.id, markRead(m)]))
    for (const s of app.sessions.values()) markKept(s)
    // (a reminder that came due before the page was opened is not said again here: it is there to be seen)
    for (const m of app.marks.values()) if (isDue(m)) app.reminded.set(m.id, m.remind)
    armReminders()
    lookAgain()
    for (const m of app.machines.values()) {
      if (!m.online) continue
      loadCatalog(m.id)
      if (app.pastBy === 'project') loadProjects(m.id)
    }
    renderList()
    if (app.past) renderPastHeader()
    if (app.current) {
      renderHeader()
      // Messages may have arrived while the stream was down
      loadMessages(app.current)
    }
    app.onSnapshot?.()
    app.onSnapshot = null
  })
  on('session', (ev) => {
    const s = JSON.parse(ev.data)
    // (the account's own small session, made or made again, here or on another device)
    if (s.id === app.firstId) return void ((app.first = s), lookAgain())
    const before = app.sessions.get(s.id)
    // Alert when a session starts waiting for an answer
    // (not for what this browser says yes to by itself: nobody is needed for that)
    const waits = (x) => (x?.pendingRequests ?? []).filter((r) => !autoTakes(s.id, r)).length
    if (waits(s) > waits(before)) alertUser(nameOf(s) + (s.host ? ' · ' + s.host : ''), 'Needs you: ' + (s.detail || 'Claude is waiting'), s.id)
    const isNew = !before
    app.sessions.set(s.id, s)
    autoApprove()
    favoriteKept(s)
    markKept(s)
    app.told.set(s.id, ++app.tellings)
    lookAgain()
    renderListSoon()
    if (s.id === app.current) {
      renderHeader()
      // One that was just started or resumed has begun to report
      if (isNew) loadMessages(s.id)
    }
  })
  on('message', (ev) => {
    const { sid, message } = JSON.parse(ev.data)
    if (sid === app.firstId || !message) return
    if (sid === app.current) {
      addMessage(message)
    } else {
      const told = typedHere(sid, [message])
      if ((message.role === 'assistant' || message.role === 'user') && !app.unread.has(sid)) app.unread.add(sid)
      else if (!told) return
      renderListSoon()
    }
  })
  on('machine', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.removed) app.machines.delete(m.id)
    else app.machines.set(m.id, m)
    lookAgain()
    // Its sessions are read again when it comes online, and when what it runs changes
    if (m.online && Date.now() - (app.catalog.get(m.id)?.at ?? 0) > 3000) {
      loadCatalog(m.id)
      if (app.pastBy === 'project') loadProjects(m.id)
    }
    renderListSoon()
    if (el('ns-box').open) drawNewDevices()
    if (app.computer?.mid === m.id) renderComputer()
    if (app.past?.mid === m.id) renderPastHeader()
    // (one of its sessions that has exited can be started again only while it's there)
    else if (app.sessions.get(app.current)?.machine === m.id) renderHeader()
  })
  on('reset', (ev) => {
    const { sid } = JSON.parse(ev.data)
    if (sid === app.current) reloadMessages()
    else app.views.delete('s:' + sid)
  })
  on('branch', (ev) => branchTold(JSON.parse(ev.data)))
  // The favorites were changed, here or on another device
  on('favorites', (ev) => {
    app.favorites = JSON.parse(ev.data).favorites
    // (one that did not open here may be one this page has kept again since, under its own key)
    lookAgain()
    renderList()
    renderStar()
  })
  // Something was put on a session, or taken off, here or on another device
  on('mark', (ev) => {
    const { id, mark } = JSON.parse(ev.data)
    if (mark) app.marks.set(id, markRead(mark))
    else app.marks.delete(id)
    lookAgain()
    marksChanged()
  })
  on('remove', (ev) => {
    const { id } = JSON.parse(ev.data)
    if (id === app.firstId) return void ((app.first = null), lookAgain())
    app.sessions.delete(id)
    lookAgain()
    app.views.delete('s:' + id)
    if (id === app.current) location.hash = ''
    renderList()
  })
  // The reply as Claude writes it, while this page watches the session
  on('partial', (ev) => {
    const p = JSON.parse(ev.data)
    if (p.sid !== app.current) return
    if (p.clear) return setPartial('')
    setPartial(app.partial + p.append)
  })
  on('notification', (ev) => {
    const n = JSON.parse(ev.data)
    // (a session says to the account's phones that it needs someone, and that it has finished. A page that is open
    // hears of those from the session itself; this is for what Claude wanted said.)
    if (n.kind && n.kind !== 'notify') return
    const s = app.sessions.get(n.sid)
    alertUser((n.title || (s && nameOf(s)) || 'Claude') + (s?.host ? ' · ' + s.host : ''), n.message, n.sid)
  })
}

// The page the server serves now, by name (it says on every stream and every ping). The
// first one heard is this page's own; another one means the server has a newer page, and
// this one has to be read again to be it. A line across the top says so, with a button.
// And it's read again without being asked when that costs nothing: at once if nobody is
// looking, otherwise when they next look away (what's typed and not sent is kept through
// it; a photo attached and not sent isn't, so then it waits).
function pageBuild(build) {
  if (!build) return
  app.build ??= build
  app.old = build !== app.build
  showNotices()
  refreshIfUnseen()
}
function refreshIfUnseen() {
  // (not where this device holds its key only while the page is open: it would be gone, and the passphrase asked for again)
  if (app.old && document.hidden && !app.attachments.length && !app.uploading && (!app.key || app.key.own)) location.reload()
}
el('update-reload').addEventListener('click', () => location.reload())

// The lines across the top: no stream for more than a moment (what's on the page may be
// old), a newer version of the page, and sessions this device can't read yet
function showNotices() {
  el('offline').hidden = !(app.downSince && Date.now() - app.downSince > 4000)
  el('update').hidden = !app.old
  // (sealed things are here and this browser has no key; or it has one, and some of them do not open with it)
  const locked = app.sawSealed && !app.key ? 'none' : unopened().any ? 'other' : ''
  el('locked').hidden = !locked
  el('locked').dataset.why = locked
  // (where it is the account's own small session that does not open, it is this browser that has another passphrase than the account)
  el('locked-says').textContent = locked !== 'other' ? 'Your sessions are encrypted, and this browser has not been given your passphrase.' : firstIsOther() ? 'The passphrase this browser was given is not the one your account has now, so it cannot open your sessions.' : 'Some of your sessions were sealed with a different passphrase from the one this browser was given, and cannot be opened here.'
  // (with no key, the way to where the passphrase is typed; with one, to what does not open with it, whose that is and what to do there)
  el('locked-link').textContent = locked === 'other' ? 'What to do' : 'Type it in'
  el('locked-link').setAttribute('href', locked === 'other' ? '#/account/unopened' : '#/account')
  document.body.classList.toggle('noticed', !el('offline').hidden || !el('update').hidden || !el('locked').hidden)
  // (how far down the list starts, for when it's shown under a chat being swiped away)
  document.documentElement.style.setProperty('--notices-height', el('notices').offsetHeight + 'px')
}

// Another try at a stream the browser gave up: soon, then less often
function reconnectSoon() {
  if (app.reconnect || app.signedOut) return
  app.streamTries = (app.streamTries ?? 0) + 1
  app.reconnect = setTimeout(connect, Math.min(15_000, 500 * 2 ** app.streamTries))
}

// Is the stream still one? `now`: the page has just been come back to, so a try that was
// waiting its turn is made at once.
function checkStream({ now = false } = {}) {
  if (!app.stream || app.signedOut) return
  const closed = app.stream.readyState === EventSource.CLOSED
  if (closed ? now || !app.reconnect : Date.now() - app.heard > app.quietMs) connect()
  showNotices()
}
;(function watchStream() {
  checkStream()
  setTimeout(watchStream, Math.min(5000, app.quietMs))
})()
document.addEventListener('visibilitychange', () => (document.hidden ? refreshIfUnseen() : checkStream({ now: true })))
addEventListener('online', () => checkStream({ now: true }))
addEventListener('pageshow', (ev) => ev.persisted && checkStream({ now: true }))

// ---- Alerts: Claude's notify_user, and sessions that start needing you

// While the page is open it can say so itself. Once this device has subscribed (below),
// the server sends the notifications, and they arrive whether the page is open or not.
function alertUser(title, body, sid) {
  if (app.pushOn || !('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && sid === app.current)) return
  const url = '/#/s/' + encodeURIComponent(sid)
  try {
    // A phone's browser only lets its service worker show one
    if (app.worker) return void app.worker.showNotification(title, { body, tag: sid, icon: '/icons/icon-192.png', data: { url } })
    const n = new Notification(title, { body, tag: sid })
    n.onclick = () => {
      window.focus()
      location.hash = '#/s/' + encodeURIComponent(sid)
    }
  } catch {}
}

// The service worker shows what the server sends this device, and hands back the session a tapped one was about
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(trusted ? trusted.createScriptURL('/sw.js') : '/sw.js')
    .then((worker) => {
      app.worker = worker
      syncAlerts()
    })
    .catch(() => renderAlertsButton())
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const at = String(ev.data?.open ?? '')
    if (at.includes('#')) location.hash = at.slice(at.indexOf('#'))
  })
}

const canPush = () => 'Notification' in window && 'PushManager' in window && !!app.worker
// An iPhone or iPad gives notifications only to a page kept on the Home Screen
const needsHomeScreen = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? !isStandalone() && !('PushManager' in window) : false

function deviceLabel() {
  const ua = navigator.userAgent
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'A device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  return [device, isStandalone() ? 'app' : browser].filter(Boolean).join(' ')
}

// One notification to see it arrive. A push service doesn't always know of a
// subscription made a moment ago: it's given a moment, and asked again if it says so.
async function testAlert() {
  let status = 0
  for (let attempt = 0; attempt < 7; attempt++) {
    await new Promise((done) => setTimeout(done, attempt ? 4000 : 1500))
    const r = await fetch('/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: app.pushId }) }).then((x) => x.json()).catch(() => null)
    // The server has no such device (it was forgotten): it's handed the subscription again
    if (r && !r.sent?.length) await syncAlerts()
    status = r?.sent?.[0]?.status ?? 0
    if (status >= 200 && status < 300) return
    if (status && status !== 404 && status !== 410) break
  }
  sayOfAlerts(`Alerts are on, but a test notification could not be sent to this device (its push service answered ${status || 'nothing'}).`)
}

// What there is to say about alerts is said over the foot of the list, where their button
// is and the settings open: those are shut, so that it is seen
// What there is to say of this device's notifications: over the foot of the list, and in the settings
function sayOfAlerts(text) {
  for (const id of ['alerts-note', 'set-alerts-note']) {
    el(id).textContent = text
    el(id).hidden = false
  }
}

const keyBytes = (key) => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

// This device's subscription with its push service, handed to the server. `ask`: make
// one if there's none (a tap on the button); without it, only what's there is kept in step.
async function syncAlerts({ ask = false } = {}) {
  try {
    if (!canPush() || Notification.permission !== 'granted') return
    const { key } = await (await fetch('/api/push')).json()
    let sub = await app.worker.pushManager.getSubscription()
    // One made for another server's key is no use to this one
    const made = sub?.options?.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null
    if (sub && made && made !== key) {
      await sub.unsubscribe()
      sub = null
    }
    if (!sub && ask) sub = await app.worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })
    if (!sub) return
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel() }) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'the server refused the subscription')
    app.pushOn = true
    app.pushId = (await r.json()).id
    app.pushError = ''
  } catch (err) {
    // While the page is open it still says so itself
    app.pushOn = false
    if (ask) app.pushError = String(err?.message ?? err)
  } finally {
    renderAlertsButton()
  }
}

function renderAlertsButton() {
  const button = el('alerts')
  const note = el('alerts-note')
  const has = 'Notification' in window
  const state = !has ? (needsHomeScreen() ? 'home' : 'none') : Notification.permission === 'denied' ? 'blocked' : app.pushOn ? 'on' : Notification.permission === 'granted' && !canPush() ? 'open' : Notification.permission === 'granted' && app.pushError ? 'open' : 'off'
  button.hidden = state === 'none'
  button.dataset.state = state
  // (it is called Notifications whatever the state, with on or off beside it: its title says the rest)
  el('alerts-state').textContent = { on: 'on', open: 'on', blocked: 'blocked' }[state] ?? 'off'
  button.setAttribute('aria-label', 'Notifications: ' + ({ home: 'how to get them here', blocked: 'blocked', on: 'on', open: 'on while this page is open', off: 'off' }[state] ?? ''))
  button.title = {
    home: 'How to get notifications on this device',
    blocked: "Notifications are turned off for this site in the browser's settings",
    on: 'Notifications are on: this device is told when a session needs you, and when a long turn is done. Tap to turn that off.',
    open: 'Notifications are shown while this page is open',
    off: 'Notifications are off. Turn them on to be told when a session needs you, and when a long turn is done',
  }[state] ?? ''
  if (state !== 'home' && state !== 'open') note.hidden = el('set-alerts-note').hidden = true
  // The same in the settings, in so many words: how it stands on this device, and the way to change it
  el('set-alerts').hidden = state === 'none'
  el('set-alerts').dataset.state = state
  el('set-alerts-says').textContent =
    {
      home: 'On an iPhone or iPad, notifications come to ManyClaws on the Home Screen: tap Share, then Add to Home Screen, open ManyClaws from the Home Screen, and turn them on there.',
      blocked: "Blocked: notifications are turned off for this site in the browser's settings. Allow them there, and they can be turned on here.",
      on: 'On: this device is told when a session needs you, and when a long turn is done.',
      open: 'On while this page is open. They could not be set up to arrive when it is closed.',
      off: 'Off: this device is not told when a session needs you, or when a long turn is done.',
    }[state] ?? ''
  const go = el('set-alerts-go')
  go.hidden = state === 'home' || state === 'blocked' || state === 'none'
  go.textContent = { on: 'Turn off', open: 'Try again', off: 'Turn on' }[state] ?? ''
  go.className = state === 'on' ? 'ghost' : 'primary'
}

// Notifications pressed, under the list or in the settings: turned on where they are off, and off where they are on
async function alertsPressed({ fromList = false } = {}) {
  const note = el('alerts-note')
  const state = el('alerts').dataset.state
  if (state === 'home') {
    // (under the list a second press puts what was said away; the settings say it all the time)
    if (fromList && !note.hidden) return void (note.hidden = el('set-alerts-note').hidden = true)
    return sayOfAlerts('To get notifications here: tap Share, then Add to Home Screen, open ManyClaws from the Home Screen, and turn on alerts there.')
  }
  if (state === 'on') {
    if (!(await ask('Turn notifications off on this device?', { yes: 'Turn off' }))) return
    const sub = await app.worker.pushManager.getSubscription().catch(() => null)
    if (sub) {
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
      await sub.unsubscribe().catch(() => {})
    }
    app.pushOn = false
    return renderAlertsButton()
  }
  if (state === 'blocked') return
  if ((await Notification.requestPermission()) !== 'granted') return renderAlertsButton()
  await syncAlerts({ ask: true })
  if (app.pushOn) {
    buzz()
    testAlert()
  } else if (app.pushError) {
    sayOfAlerts('Notifications could not be set up to arrive when this page is closed (' + app.pushError + '). They are shown while it is open.')
  }
}
el('alerts').addEventListener('click', () => alertsPressed({ fromList: true }))
el('set-alerts-go').addEventListener('click', () => alertsPressed())

// ---- Streaming: a watched session sends its reply as it's written

function setPartial(text) {
  app.partial = text
  let node = el('partial')
  if (!text) return node?.remove()
  if (!node) {
    node = h('div', { id: 'partial', class: 'msg assistant tl md streaming' })
    el('messages').append(node)
    tail()
  }
  const box = el('messages')
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  node.innerHTML = rendered(text)
  if (nearEnd) scrollToEnd()
}

// While a session is open and the page is visible, keep its reply streaming
setInterval(watchCurrent, 30_000)
document.addEventListener('visibilitychange', watchCurrent)

function watchCurrent() {
  if (app.current && !document.hidden) fetch('/api/sessions/' + encodeURIComponent(app.current) + '/watch', { method: 'POST' }).catch(() => {})
}

// ---- Routing: #/s/<id> opens a session, so the phone's back button works

window.addEventListener('hashchange', route)

// The account's pages: the account itself, its password, and what does not open here with whose it is
const ACCOUNT_PAGES = ['#/account', '#/account/password', '#/account/unopened']

// #/s/<session> is a session as it reports; #/m/<machine>/<session> is one read from
// its transcript on a machine; #/new/<machine> starts one there; #/computer/<machine> is a
// computer's own page
function route() {
  const [path, query = ''] = location.hash.split('?')
  const live = /^#\/s\/(.+)$/.exec(path)
  const past = /^#\/m\/([^/]+)\/([^/]+)$/.exec(path)
  const fresh = /^#\/new\/([^/]+)$/.exec(path)
  el('new').hidden = !fresh
  el('setup').hidden = path !== '#/setup'
  el('account').hidden = !ACCOUNT_PAGES.includes(path)
  el('settings-page').hidden = path !== '#/settings'
  if (path !== '#/account') app.passwordSaid = ''
  if (path !== '#/account') app.passphraseChanging = false
  // (a computer's Claude accounts had a page of their own, #/cswap/<machine>: they are a part of the computer's now)
  const swap = /^#\/cswap\/([^/]+)$/.exec(path)
  if (swap) return void location.replace('#/computer/' + swap[1])
  const computer = /^#\/computer\/([^/]+)$/.exec(path)
  el('computer').hidden = !computer
  if (!computer) closeComputer()
  if (computer) return openComputer(decodeURIComponent(computer[1]))
  if (path === '#/setup' || ACCOUNT_PAGES.includes(path)) return openGuide(path.slice(2))
  if (path === '#/settings') return openSettings()
  if (live) return openSession(decodeURIComponent(live[1]))
  if (past) {
    const q = new URLSearchParams(query)
    return openPast(past[1], decodeURIComponent(past[2]), { at: q.get('at') ?? '', sub: q.get('sub') ?? '' })
  }
  if (fresh) return openNew(fresh[1])
  closeSession()
}

function closeSession() {
  clearInterval(pastTimer)
  leaveView()
  app.current = null
  app.past = null
  document.body.classList.remove('chat-open')
  el('chat').hidden = true
  el('empty').hidden = false
  renderList()
}

async function openSession(id) {
  clearInterval(pastTimer)
  if (app.past || app.current !== id || !el('messages').contains(working)) {
    // The chat that was showing is put away as it is, and this one put back if it was kept
    leaveView()
    app.past = null
    app.current = id
    const left = enterView('s:' + id)
    el('messages').prepend(banner)
    tail()
    if (left !== null) el('messages').scrollTop = el('messages').scrollHeight - left
    renderChips()
    showDraft()
    watchCurrent()
  }
  app.unread.delete(id)
  document.body.classList.add('chat-open')
  el('empty').hidden = true
  el('chat').hidden = false
  autosize()
  renderList()
  renderHeader()
  await loadMessages(id)
  if (!matchMedia('(pointer: coarse)').matches) el('input').focus()
}

// The session's rows again, from the latest: the server replaced them
function reloadMessages() {
  const box = el('messages')
  const fromEnd = box.scrollHeight - box.scrollTop
  clearRows()
  return loadMessages(app.current, { fromEnd })
}

// Nothing drawn of the open session but what's waiting to be sent
function clearRows() {
  const pending = app.pending
  blankView()
  app.pending = pending
  el('messages').replaceChildren(banner, ...pending.map((p) => p.node), working)
}

// Reads the open session's rows: the latest window of them the first time, and after
// that only what has come since the last one drawn
async function loadMessages(id, { fromEnd = 0 } = {}) {
  const have = app.loaded && app.lastSeq > 0
  // (how far the stream had got when this was asked for: see where its answer is taken)
  const asOf = app.tellings
  const r = await fetch('/api/sessions/' + encodeURIComponent(id) + '/messages?limit=' + WINDOW + (have ? `&after=${app.lastSeq}&epoch=${app.epoch ?? ''}` : ''))
  if (r.status === 401) return showLogin()
  if (app.current !== id) return
  if (r.status === 404) return awaitSession(id)
  // (the server couldn't say: it's asked again shortly, while this is the chat that's open and it has no rows yet)
  if (r.status >= 500) return void setTimeout(() => app.current === id && !app.loaded && loadMessages(id), 3000)
  if (!r.ok) return
  if (app.expect?.sid === id) app.expect = null
  // (it has started: one with nothing said in it yet is waiting for its first prompt)
  el('messages').querySelector('.starting')?.remove()
  el('composer-note').hidden = true
  const data = await r.json()
  // How the session is, as the server had it when it answered: unless the stream has said
  // since this was asked for, which is how it is now. The answer can come after a word of
  // the stream's that was sent after it, and would put the session back as it was before.
  if ((app.told.get(id) ?? 0) <= asOf) app.sessions.set(id, data.session)
  renderHeader()
  renderListSoon()
  // The rows drawn were renumbered on the server: what came back is the latest window, drawn afresh
  if (data.reset && app.lastSeq) clearRows()
  const box = el('messages')
  const fresh = !app.lastSeq
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  if (fresh) {
    app.firstSeq = data.messages[0]?.seq ?? 0
    app.earlier = !!data.earlier
    app.promptBefore = null
    showEarlier()
    promptBefore(id, data)
  }
  app.epoch = data.epoch ?? null
  addMessages(data.messages)
  // (and what the session said while these were on their way, after them)
  app.loaded = true
  addMessages(app.early.splice(0))
  setPartial((data.partial ?? []).map((p) => p.text + (p.pieces ?? []).join('')).join(''))
  // Drawn afresh: the end, or after a redraw the same distance from it as before. Come
  // back to: where it was left, unless that was the end
  if (fresh && fromEnd > box.clientHeight + 120) box.scrollTop = box.scrollHeight - fromEnd
  else if (fresh || nearEnd) scrollToEnd()
}

// The prompt the first of a window's rows answers (it is kept in sight above the rows).
// The server cannot tell which rows of a chat are the user's, so the page looks itself:
// back through the rows before the window, a few windows at most, for the last prompt
// among them.
async function promptBefore(id, data) {
  const first = data.messages[0]
  if (!data.earlier || !first || first.role === 'user') return
  const epoch = data.epoch
  let before = first.seq
  for (let tries = 0; tries < 3; tries++) {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages?limit=${WINDOW}&before=${before}`).catch(() => null)
    if (!r?.ok) return
    const page = await r.json()
    // (not for a chat that has been left, drawn again, or scrolled further back meanwhile)
    if (app.current !== id || page.epoch !== epoch || app.epoch !== epoch || app.firstSeq !== first.seq) return
    const prompt = page.messages.findLast((m) => m.role === 'user')
    if (prompt) return void (app.promptBefore = { seq: prompt.seq, text: String(prompt.text ?? '').slice(0, 4000) })
    if (!page.earlier || !page.messages.length) return
    before = page.messages[0].seq
  }
}

// ---- Views: a long session is read and drawn a window at a time, and the chats looked
// at lately are kept as they were drawn. Coming back to one is putting it back and
// reading what's new.

const WINDOW = 300 // rows read at a time: the latest, then earlier ones as they're scrolled to
const ROWS_KEPT = 900 // rows drawn before the oldest are let go, while the end is being followed
const VIEWS_KEPT = matchMedia('(pointer: coarse)').matches ? 3 : 6 // a phone has less room for them

const viewKey = () => (app.past ? `m:${app.past.mid}/${app.past.sid}/${app.past.sub}` : app.current ? 's:' + app.current : null)

function blankView() {
  Object.assign(app, { lastSeq: 0, firstSeq: 0, earlier: false, epoch: null, loaded: false, early: [], promptBefore: null, pending: [], partial: '', results: new Map(), tools: new Map(), openTools: new Set(), rowKeys: new Set() })
}

// Puts the chat that's showing away, as it is
function leaveView() {
  const key = viewKey()
  const box = el('messages')
  // What was opened for the last chat is shut for the next
  el('more').closest('.chat-head').classList.remove('more-open')
  el('more').setAttribute('aria-expanded', 'false')
  el('latest').hidden = true
  if (key && (app.past ? app.past.loaded : app.lastSeq > 0)) {
    const fromEnd = box.scrollHeight - box.scrollTop
    // What follows the rows belongs to the page, not to the chat
    for (const node of [banner, working, el('partial')]) node?.remove()
    app.views.delete(key)
    app.views.set(key, { nodes: [...box.childNodes], fromEnd, past: app.past, lastSeq: app.lastSeq, firstSeq: app.firstSeq, earlier: app.earlier, epoch: app.epoch, promptBefore: app.promptBefore, pending: app.pending, results: app.results, tools: app.tools, openTools: app.openTools, rowKeys: app.rowKeys })
    for (const old of [...app.views.keys()].slice(0, Math.max(0, app.views.size - VIEWS_KEPT))) app.views.delete(old)
  }
  box.replaceChildren()
  blankView()
}

// Puts a kept chat's rows back. Gives how far from the end it was left, for the caller
// to scroll to once what the page adds around the rows is there; null when it wasn't kept.
function enterView(key) {
  const view = app.views.get(key)
  if (!view) return null
  app.views.delete(key)
  const { nodes, fromEnd, past, ...state } = view
  Object.assign(app, state, { partial: '', loaded: true })
  el('messages').replaceChildren(...nodes)
  watchEarlier()
  refoldSoon()
  return fromEnd
}

// The way to the rows before the ones drawn, at the top of them
function showEarlier() {
  const box = el('messages')
  let button = box.querySelector(':scope > .earlier')
  if (!app.earlier) return button?.remove()
  if (!button) {
    button = h('button', { type: 'button', class: 'earlier', onclick: loadEarlierRows }, 'Earlier messages…')
    if (banner.parentNode === box) banner.after(button)
    else box.prepend(button)
  }
  watchEarlier()
}

// Scrolled to, it brings the rows before it by itself
const earlierWatch = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && entries[0].target.click(), { root: el('messages'), rootMargin: '600px 0px 0px 0px' })
function watchEarlier() {
  earlierWatch.disconnect()
  const button = el('messages').querySelector(':scope > .earlier')
  if (button) earlierWatch.observe(button)
}

// The window of rows before the first one drawn, added above it with the place on screen kept
async function loadEarlierRows() {
  const id = app.current
  if (!id || !app.earlier || app.loadingEarlier) return
  app.loadingEarlier = true
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages?limit=${WINDOW}&before=${app.firstSeq}`).catch(() => null)
    if (!r?.ok || app.current !== id) return
    const data = await r.json()
    if (data.epoch !== app.epoch) return void reloadMessages()
    const box = el('messages')
    const fromEnd = box.scrollHeight - box.scrollTop
    const nodes = rowNodes(data.messages, { older: true })
    app.firstSeq = data.messages[0]?.seq ?? app.firstSeq
    app.earlier = !!data.earlier && data.messages.length > 0
    app.promptBefore = null
    promptBefore(id, data)
    box.querySelector(':scope > .earlier')?.after(...nodes)
    showEarlier()
    box.scrollTop = box.scrollHeight - fromEnd
    refoldSoon()
  } finally {
    app.loadingEarlier = false
  }
}

// ---- Session list

// The list: the favorites first, in the order they were put in, with any session whose
// reminder has come due above them; then the sessions that are open, the ones that need
// someone first; then each machine with all it has.
function renderList() {
  // (a computer's own page says what the computer needs, which is read off the same sessions and machines as the list: drawn again when that has changed)
  if (app.computer?.known && app.computer.said !== computerSaid(app.computer.mid)) renderComputer()
  // (not under a row that's being moved, or pressed: see below. Eight seconds is longer than a press is held)
  if (app.dragging || Date.now() - app.pressed < 8000) return void (app.listStale = true)
  app.listStale = false
  const list = el('session-list')
  // An account with nothing connected yet is shown the way to connect something, and told when something has
  const nothing = !app.sessions.size && !app.machines.size
  el('empty-pick').hidden = nothing
  el('empty-new').hidden = !nothing
  if (!el('setup').hidden && el('setup-status')) el('setup-status').replaceChildren(connectedLine())
  // (on a phone the list is all there is to see: it says so itself)
  if (nothing && !app.search.q) return redraw(list, [h('div', { class: 'empty list-empty' }, 'No computer is connected to your account yet.', h('br'), h('a', { href: '#/setup', class: 'primary button-link' }, 'Set up a computer'))])
  if (app.search.q) return redraw(list, searchNodes())
  // (the sessions whose reminders have come due, the one that came due last first)
  const due = [...app.marks.values()].filter(isDue).sort((a, b) => b.remind - a.remind)
  const first = new Set(due.map((m) => m.id))
  const kept = new Set([...first, ...app.favorites.map((f) => f.id)])
  const all = [...app.sessions.values()].filter((s) => !kept.has(s.id))
  const visible = all.filter((s) => app.showEnded || !s.ended || s.id === app.current)
  const nodes = []
  if (due.length || app.favorites.length) {
    nodes.push(h('div', { class: 'group-head', 'data-key': 'favorites' }, h('span', null, 'Favorites')))
    // A session whose reminder has come due is at the top of them, favorite or not, until the reminder is cleared or put off
    for (const m of due) nodes.push(favoriteRow(app.favorites.find((f) => f.id === m.id) ?? m, { due: true }))
    for (const f of app.favorites) if (!first.has(f.id)) nodes.push(favoriteRow(f))
  }
  if (visible.length) {
    nodes.push(h('div', { class: 'group-head', 'data-key': 'active' }, h('span', null, app.showEnded ? 'Active and inactive' : 'Active')))
    for (const s of visible.sort(byStanding)) nodes.push(renderRow(s))
  }
  const hidden = all.length - visible.length
  if (!nodes.length && !app.machines.size) {
    nodes.push(
      h('div', { class: 'list-empty', 'data-key': 'none' }, all.length ? `${hidden} inactive session${hidden === 1 ? '' : 's'} hidden.` : 'No sessions yet. Start Claude Code with the ManyClaws mod loaded and it shows up here.'),
    )
  }
  for (const m of [...app.machines.values()].sort((a, b) => machineName(a).localeCompare(machineName(b)))) nodes.push(...machineNodes(m))
  // (and the computers that have no machine, where one needs something: its sessions are heard from, and no agent is)
  for (const c of looseComputers().sort((a, b) => a.name.localeCompare(b.name))) nodes.push(...looseNodes(c))
  // (a grip being moved by the keys is still the one in hand once the rows are drawn again)
  const held = document.activeElement?.matches?.('.grip') ? document.activeElement.closest('.row').dataset.favorite : null
  redraw(list, nodes)
  if (held) list.querySelector(`.row.favorite[data-favorite="${CSS.escape(held)}"] .grip`)?.focus()

  const waiting = [...app.sessions.values()].filter((s) => s.state === 'attention').length
  document.title = waiting ? `(${waiting}) ManyClaws` : 'ManyClaws'
  // On the icon of the app, where the page is kept as one
  if (waiting !== app.badge) {
    app.badge = waiting
    try {
      ;(waiting ? navigator.setAppBadge?.(waiting) : navigator.clearAppBadge?.())?.catch(() => {})
    } catch {}
  }
}

// Updates arrive in bursts, and from sessions at work several times a second: the list
// is drawn once for a burst, and a few times a second at the most
function renderListSoon() {
  if (app.listTimer) return
  app.listTimer = setTimeout(() => {
    app.listTimer = 0
    renderList()
  }, 200)
}

// Where a session stands among the open ones: those that need someone first, then those
// at work, then the rest; and among those alike, the one that came to be so last. So a
// session keeps its place for as long as it stays as it is. (By when each was last heard
// from, the ones at work changed places at every word, several times a second: nothing
// stayed under a finger.)
const sinceOf = (s) => s.since ?? s.lastActivity
const byStanding = (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || sinceOf(b) - sinceOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Where a session runs: the name its mod was given, else its machine's, else the host
const whereOf = (s) => s.label || app.machines.get(s.machine)?.label || s.host
// A computer's name where something says which computer it is: in the color the account
// gave that computer (on its own page), as a label; as it was where it gave none
const whereLabel = (name, mid) => {
  const color = app.machines.get(mid)?.color
  return name && MARK_COLORS.includes(color) ? h('span', { class: 'where-label', 'data-color': color }, name) : name
}
// Things said of a session on one line, a dot between each (one of them may be such a label)
const dotted = (...parts) => parts.filter(Boolean).flatMap((part, i) => (i ? [' · ', part] : [part]))

// How many subagents a session has running, for a row of the list
const agentsMark = (s) => (s?.agents?.length ? h('span', { class: 'agents-mark', title: s.agents.map(agentLabel).join('\n') }, count(s.agents.length, 'subagent')) : null)
const agentLabel = (a) => [a.description || a.type || 'subagent', a.description && a.type ? `(${a.type})` : '', a.background ? 'in the background' : ''].filter(Boolean).join(' ')

// ---- Favorites: the sessions kept at the top of the list. They are the account's, so
// every device signed in to it shows the same ones in the same order.

const isFavorite = (id) => app.favorites.some((f) => f.id === id)
// A favorite is kept with what its session was called, for when the session is not
// reporting. The server cannot keep that up (it reads none of it), so the page does:
// where what is kept is no longer what the session is called, or where it is, it is kept again.
const favoriteSaid = new Map() // id -> what was last sent of it, so that it is sent once
function favoriteKept(s) {
  const f = app.key ? app.favorites.find((x) => x.id === s.id) : null
  if (!f || isLocked(s.title)) return
  const now = [s.title, s.project ?? '', whereOf(s) ?? ''].join('\n')
  if ([f.title, f.project ?? '', f.where ?? ''].join('\n') === now || favoriteSaid.get(s.id) === now) return
  favoriteSaid.set(s.id, now)
  favoriteOf(s)
    .then((kept) => fetch('/api/favorites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kept) }))
    .catch(() => {})
}
// What a favorite is kept as: enough to show it, and to open it from its machine, when it isn't reporting.
// What the session is called, the folder it is in and where it runs are sealed on their way to the server, which
// has them only sealed. (On a device without the key it is kept by its id alone, until one that has the key says the rest.)
async function favoriteOf(s) {
  const kept = async (v) => (v ? ((await sealFor(v)) ?? '') : '')
  return { id: s.id, machine: s.machine ?? '', title: await kept(s.title), project: await kept(s.project ?? ''), where: await kept((app.sessions.has(s.id) ? whereOf(s) : machineName(app.machines.get(s.machine))) ?? '') }
}

// The star on a session: it puts the session among the favorites, or takes it off
function starButton(s) {
  const on = isFavorite(s.id)
  const say = on ? 'Take off the favorites' : 'Keep at the top of the list, as a favorite'
  return h(
    'button',
    {
      type: 'button',
      class: 'star' + (on ? ' on' : ''),
      'aria-pressed': String(on),
      'aria-label': say,
      title: say,
      onclick: (ev) => {
        // (in a row it sits in the row's link, which isn't followed)
        ev.preventDefault()
        ev.stopPropagation()
        favoriteOf(s).then(toggleFavorite)
      },
    },
    on ? '★' : '☆',
  )
}

// Shown at once, then told to the server, which tells every page of the account's
async function toggleFavorite(f) {
  const on = isFavorite(f.id)
  app.favorites = on ? app.favorites.filter((x) => x.id !== f.id) : [...app.favorites, f]
  renderList()
  renderStar()
  const r = await (on ? fetch('/api/favorites/' + encodeURIComponent(f.id), { method: 'DELETE' }) : fetch('/api/favorites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) })).catch(() => null)
  if (r?.ok) app.favorites = (await r.json()).favorites
  renderList()
  renderStar()
}

// The session that's open, as what a star or a mark is put on: one read from its machine's transcript too, not a subagent's
const openOne = () => (app.past ? (app.past.sub ? null : { ...app.past.session, id: app.past.sid, machine: app.past.mid, title: app.past.session?.title ?? app.favorites.find((f) => f.id === app.past.sid)?.title ?? markOf(app.past.sid)?.title ?? '' }) : (app.sessions.get(app.current) ?? null))

// The star in the header of the session that's open
function renderStar() {
  const open = openOne()
  const old = el('favorite')
  el('ns-open').hidden = !open
  renderMarkHead(open)
  if (!open) return void (old.hidden = true)
  const star = starButton(open)
  star.id = 'favorite'
  old.replaceWith(star)
}

// ---- Marks: what the account has put on a session of its own. A name in place of the
// one the session goes by, a label beside it, a colour behind its row, and a reminder:
// a time at which the session comes to the top of the list, lit, where it stays until
// the reminder is cleared or put off. They are the account's, so every device signed in
// to it shows them. Where the account's sessions are sealed, what is written on one is
// sealed here with the same key before it is sent, the reminder's time too, and the
// server keeps it as it came. The server is told a time in the open only where it is
// asked to send a notification then, and the words of that notification go sealed.

const MARK_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']
// A reminder some time from now: how it is said, and how long that is
const REMIND_IN = [
  ['4 hours', 4 * 3600_000],
  ['24 hours', 24 * 3600_000],
  ['3 days', 3 * 86400_000],
]

// A mark as the server told it, opened on its way here, as the page goes by it: what
// this device could not open is left off, as if nothing were written there
// (`shut`: something on it did not open here, so this device does not have all of it)
function markRead(m) {
  const said = (v) => (typeof v === 'string' && v !== sealing?.UNOPENED ? v : '')
  return { ...m, title: said(m.title), project: said(m.project), where: said(m.where), name: said(m.name), label: said(m.label), color: MARK_COLORS.includes(m.color) ? m.color : '', remind: Number.isFinite(m.remind) ? m.remind : 0, shut: [m.title, m.project, m.where, m.name, m.label, m.color, m.remind].some(isLocked) }
}
const markOf = (id) => app.marks.get(id) ?? null
// What a session is called here: the name it was given, else its own
const nameOf = (s) => markOf(s.id)?.name || s.title
const isDue = (m) => !!m?.remind && m.remind <= Date.now()

// A time some way off or not long past, said shortly, and said in full
function fromNow(ts) {
  const s = Math.abs(ts - Date.now()) / 1000
  const far = s < 90 ? 'a minute' : s < 5400 ? Math.round(s / 60) + ' minutes' : s < 129_600 ? Math.round(s / 3600) + ' hours' : Math.round(s / 86400) + ' days'
  return ts > Date.now() ? 'in ' + far : far + ' ago'
}
const whenText = (ts) => new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// What a row shows of its session's mark: the label beside its name; a reminder still to
// come, in the line under it; one that has come due, in a line of its own
const labelChip = (m) => (m?.label ? h('span', { class: 'row-label' }, m.label) : null)
const remindSoon = (m) => (m?.remind && !isDue(m) ? h('span', { class: 'row-remind-at', title: 'A reminder is set for ' + whenText(m.remind) }, '⏰ ' + fromNow(m.remind)) : null)
const remindLine = (m) => h('div', { class: 'row-remind' }, '⏰ Reminder, ' + fromNow(m.remind))
// On the row of one that has come due: the reminder cleared, without opening the session
const doneButton = (s) =>
  h(
    'button',
    {
      type: 'button',
      class: 'remind-done',
      'aria-label': 'Clear the reminder',
      title: 'Clear the reminder',
      onclick: (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        remindAgain(s, 0)
      },
    },
    '✓',
  )
// On a session's row: the pencil that opens the box its mark is set in, for that session, without opening it.
// (`key`: the row's own, which the box opens under: a session can have two rows, among the favorites and under
// its machine. `past`: a row of a machine's list, which is of the session as it is now only while that is reporting.)
const editButton = (s, key, past = false) =>
  h(
    'button',
    {
      type: 'button',
      class: 'row-edit',
      'aria-haspopup': 'dialog',
      'aria-expanded': String(app.marking?.row === key),
      'aria-label': `Name, label, color and reminder for ${markOf(s.id)?.name || s.title || 'this session'}`,
      title: 'Edit: its name, label, color and reminder',
      onclick: (ev) => {
        // (in a row it sits in the row's link, which isn't followed)
        ev.preventDefault()
        ev.stopPropagation()
        // (the session as it is now: the row may have been drawn before it was last heard from)
        openMarkBox((past && !isReporting(s.id) ? null : app.sessions.get(s.id)) ?? s, key)
      },
    },
    icon('pencil'),
  )

// Whether this device can put something on a session: it seals what it writes with the
// account's key, and the server takes it no other way
const canMark = () => !!app.key

// What the server is sent for a session's mark, `to` being all that is to be on it
// ({ name, label, color, remind, notify }): each thing sealed with `key`, and beside them
// what a favorite is kept with, so that the session can be shown when it isn't reporting.
// A notification is asked for by the time alone, with its words sealed.
async function markBody(s, to, key = app.key) {
  const put = async (v) => (v === '' || v === null || v === undefined ? '' : vault.seal(v, key))
  // (where it runs, as it reports now; else its machine's name; else what was last kept of that)
  const live = app.sessions.get(s.id)
  const where = (live ? whereOf(live) : app.machines.has(s.machine) ? machineName(app.machines.get(s.machine)) : s.where) ?? ''
  return {
    machine: s.machine ?? '',
    title: await put(s.title ?? ''),
    project: await put(s.project ?? ''),
    where: await put(where),
    name: await put(to.name),
    label: await put(to.label),
    color: await put(to.color),
    remind: to.remind ? await put(to.remind) : null,
    notice: to.remind && to.notify ? { at: to.remind, title: await put(to.name || s.title || 'A session'), body: await put(to.label ? 'Reminder: ' + to.label : 'Reminder') } : null,
  }
}

// A session's mark made into `to`: shown at once, then told to the server, which tells
// every page of the account's. Resolves with what went wrong, where something did.
async function setMark(s, to) {
  if (!canMark()) return NO_KEY_MARK
  const was = markOf(s.id)
  const body = await markBody(s, to)
  if (to.name || to.label || to.color || to.remind) app.marks.set(s.id, markRead({ ...was, id: s.id, machine: body.machine, title: s.title ?? '', project: s.project ?? '', where: s.where ?? '', name: to.name, label: to.label, color: to.color, remind: to.remind || 0, notice: body.notice ? { at: body.notice.at } : undefined }))
  else app.marks.delete(s.id)
  marksChanged()
  const r = await fetch('/api/marks/' + encodeURIComponent(s.id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
  const data = (await r?.json().catch(() => null)) ?? {}
  if (r?.ok && data.mark) app.marks.set(s.id, markRead(data.mark))
  else if (r?.ok) app.marks.delete(s.id)
  else if (was) app.marks.set(s.id, was)
  else app.marks.delete(s.id)
  marksChanged()
  return r?.ok ? '' : (data.error ?? 'That could not be saved: the server did not answer.')
}
const NO_KEY_MARK = 'What you put on a session is end-to-end encrypted like the session itself, and this device does not have your key: type your passphrase under Account first.'

// A mark is kept with what a favorite is kept with, and that is kept up from here as a
// favorite's is (favoriteKept): where what is kept is no longer what
// the session is called, or where it is, the mark is put again as it stands, with those
// as they are now. Not one this device could not open all of: put again from here, what
// it could not read of it would be gone.
const markSaid = new Map() // id -> what was last sent of it, so that it is sent once
const markAgain = (s, m) => markBody(s, { name: m.name, label: m.label, color: m.color, remind: m.remind, notify: !!m.notice })
function markKept(s) {
  const m = app.key ? markOf(s.id) : null
  if (!m || m.shut || isLocked(s.title)) return
  const now = [s.title, s.project ?? '', whereOf(s) ?? ''].join('\n')
  if ([m.title, m.project, m.where].join('\n') === now || markSaid.get(s.id) === now) return
  markSaid.set(s.id, now)
  markAgain(s, m)
    .then((body) => fetch('/api/marks/' + encodeURIComponent(s.id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    .catch(() => {})
}

// A reminder cleared (`ms`: 0), or put off for that long from now. The rest of the mark
// stays as it is, and a notification is sent again if one was asked for the first time.
function remindAgain(s, ms) {
  const m = markOf(s.id)
  if (!m) return
  buzz()
  return setMark(s, { name: m.name, label: m.label, color: m.color, remind: ms ? Date.now() + ms : 0, notify: !!m.notice })
}

// The marks have changed: the list, the open session's head, and the wait for the next reminder
function marksChanged() {
  armReminders()
  renderList()
  if (app.past) renderPastHeader()
  else if (app.current) renderHeader()
}

// The list is drawn again as each reminder comes due, and the open session's head with
// it. Where a notification was asked for and this device isn't sent the server's, the
// page says so itself while it is open (alertUser).
function armReminders() {
  clearTimeout(app.remindTimer)
  const now = Date.now()
  let next = Infinity
  for (const m of app.marks.values()) if (m.remind > now) next = Math.min(next, m.remind)
  // (looked at again within the hour, however far off the next one is)
  if (next < Infinity) app.remindTimer = setTimeout(remindersDue, Math.min(next - now, 3600_000) + 30)
}
function remindersDue() {
  for (const m of app.marks.values()) {
    if (!isDue(m) || app.reminded.get(m.id) === m.remind) continue
    app.reminded.set(m.id, m.remind)
    if (m.notice) alertUser(m.name || app.sessions.get(m.id)?.title || m.title || 'A session', m.label ? 'Reminder: ' + m.label : 'Reminder', m.id)
  }
  marksChanged()
}

// The open session's mark in its head: the way to it beside the star, its colour under
// the head, and, once its reminder has come due, a line that says so with the ways to
// clear it or put it off
function renderMarkHead(open) {
  const m = open ? markOf(open.id) : null
  const button = el('mark-open')
  button.hidden = !open
  const head = el('chat').querySelector('.chat-head')
  if (m?.color) head.dataset.color = m.color
  else delete head.dataset.color
  const line = el('remind-due')
  line.hidden = !isDue(m)
  if (line.hidden) return
  // (made into what it should be, not made again: the session it is on may be reporting several times a second, and a button made again under a press loses it)
  redraw(line, [
    h('span', { class: 'remind-says' }, `⏰ Reminder${m.label ? ': ' + m.label : ''}, set for ${whenText(m.remind)}`),
    h('button', { type: 'button', class: 'remind-way done', 'data-remind': '0', onclick: () => remindAgain(open, 0) }, 'Done'),
    ...REMIND_IN.map(([says, ms]) => h('button', { type: 'button', class: 'remind-way', 'data-remind': String(ms), title: 'Remind me again in ' + says, onclick: () => remindAgain(open, ms) }, 'In ' + says)),
  ])
}

// ---- The box a session's mark is set in: under its button in the open session's head.
// A name, a label, a colour, and when to be reminded: in 4 hours, 24 hours or 3 days,
// or at a day and time. A label is one the account has on a session already, pressed,
// or a new one typed. With them, for a session that is running, where its prompts are
// answered: the session's own setting, not a mark. Nothing is kept until Save.

// A time as a day-and-time box takes and gives it: this device's own clock, to the minute
const toLocalBox = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const fromLocalBox = (text) => (text ? new Date(text).getTime() : NaN)

// When the box says to be reminded, as it stands: 0 for not at all, NaN for a time not given
function markWhen() {
  const k = app.marking
  if (k.when === 'none') return 0
  if (k.when === 'keep') return k.at
  if (k.when === 'at') return fromLocalBox(el('mk-at').value)
  return Date.now() + Number(k.when)
}

// The labels the account has on its sessions, in the order of the alphabet: the ones a box offers
const labelsInUse = () => [...new Set([...app.marks.values()].map((m) => m.label).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

// The label the box says, as it stands: a new one typed in, else the one pressed
function markLabel() {
  const k = app.marking
  return (k.adding && el('mk-label').value.trim()) || k.label
}

function drawMarkBox() {
  const k = app.marking
  if (!k) return
  const m = markOf(k.s.id)
  // (the one pressed is among them, whether or not a session has it any more)
  const said = markLabel()
  redraw(el('mk-labels'), [
    ...[...new Set([...labelsInUse(), ...(k.label ? [k.label] : [])])].map((l) => h('button', { type: 'button', class: 'mk-way', 'data-label': l, 'aria-pressed': String(said === l), onclick: () => pickMarkLabel(l) }, l)),
    h('button', { type: 'button', class: 'mk-way mk-new', 'aria-expanded': String(k.adding), 'aria-controls': 'mk-label', onclick: newMarkLabel }, '+ New label'),
  ])
  el('mk-label').hidden = !k.adding
  redraw(
    el('mk-colors'),
    ['', ...MARK_COLORS].map((c) => h('button', { type: 'button', class: 'mk-color', 'data-color': c, 'aria-pressed': String(k.color === c), 'aria-label': c || 'No color', title: c ? c[0].toUpperCase() + c.slice(1) : 'No color', onclick: () => ((k.color = c), drawMarkBox()) })),
  )
  const way = (value, says) => h('button', { type: 'button', class: 'mk-way', 'data-when': value, 'aria-pressed': String(k.when === value), onclick: () => pickMarkWhen(value) }, says)
  redraw(el('mk-when'), [way('none', 'No reminder'), k.at ? way('keep', isDue({ remind: k.at }) ? 'Due now' : whenText(k.at)) : null, ...REMIND_IN.map(([says, ms]) => way(String(ms), 'In ' + says)), way('at', 'At a time…')].filter(Boolean))
  el('mk-at').hidden = k.when !== 'at'
  const at = markWhen()
  el('mk-says').textContent = k.when === 'none' ? '' : Number.isNaN(at) ? 'Pick the day and the time.' : at <= Date.now() && k.when !== 'keep' ? 'That time has passed: pick a later one.' : `${whenText(at)} (${fromNow(at)})`
  // A notification is something to ask for only with a reminder still to come
  const ahead = k.when !== 'none' && at > Date.now()
  el('mk-notify-row').hidden = !ahead
  el('mk-notify-hint').textContent = k.devices === null ? '' : k.devices ? `Sent to ${k.devices === 1 ? 'the device' : `the ${k.devices} devices`} you have notifications on for, whether this page is open or not.` : 'None of your devices has notifications on yet. Turn them on under the list of sessions, on each device that should get it.'
  el('mk-clear').hidden = !m
  el('mk-save').disabled = !canMark()
  // (asked for from a row, it is where all of it shows: as what is in it grows, so it is put again)
  if (k.row && el('mk-box').open) placeMarkBox()
}

// A label pressed is the session's; pressed again, the session has none. What was being typed is dropped.
function pickMarkLabel(label) {
  const k = app.marking
  k.label = markLabel() === label ? '' : label
  k.adding = false
  el('mk-label').value = ''
  drawMarkBox()
}

function newMarkLabel() {
  app.marking.adding = true
  drawMarkBox()
  el('mk-label').focus()
}

function pickMarkWhen(value) {
  const k = app.marking
  k.when = value
  // (a day and a time are asked for with one already in the box: the reminder as it is, else an hour from now)
  if (value === 'at' && !el('mk-at').value) el('mk-at').value = toLocalBox(k.at > Date.now() ? k.at : Date.now() + 3600_000)
  drawMarkBox()
  if (value === 'at') el('mk-at').focus()
}

function markNote(text, error = true) {
  const note = el('mk-note')
  note.textContent = text
  note.hidden = !text
  note.classList.toggle('error', error)
}

// The button the box was asked for by: the one in the open session's head, or a row's pencil (the row as it
// stands now: the list is drawn again behind the box)
const markFrom = () => (app.marking?.row ? document.querySelector(`.row[data-key="${CSS.escape(app.marking.row)}"] .row-edit`) : el('mark-open'))
const markFromSays = (open) => {
  for (const b of document.querySelectorAll('#mark-open, .row-edit[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false')
  if (open) markFrom()?.setAttribute('aria-expanded', 'true')
}
// The box opens under the button it was asked for by; asked for by a row's pencil, under the row, which is
// still there to be seen. Under a row low in the list there is not the room for it: there it is as far up as
// shows all of it.
function placeMarkBox() {
  const box = el('mk-box')
  const from = markFrom()
  // (a row that has left the list since: the box stays where it is)
  if (!from) return
  placeUnder(box, from)
  if (!app.marking?.row) return
  const under = Math.round(from.closest('.row').getBoundingClientRect().bottom + 4)
  // (how tall it is with all the room there is, which is what it is measured by)
  box.style.setProperty('--ns-top', '12px')
  box.style.setProperty('--ns-top', Math.max(12, Math.min(under, innerHeight - box.offsetHeight - 12)) + 'px')
}

// (`s`: the session it is for, the open one unless a row's pencil asked for it; `row`: that row's key)
function openMarkBox(s = openOne(), row = '') {
  if (!s) return
  const m = markOf(s.id)
  let notify = app.pushOn
  try {
    notify = { 1: true, 0: false }[localStorage.getItem('mc.remindNotify')] ?? notify
  } catch {}
  // Where its prompts are answered, by the name of what it runs in: asked of a session that is running and takes answers from here
  // (as the server has it now, which one read from its machine's transcript is not)
  const answers = app.sessions.get(s.id) === s && !s.ended && !!s.capabilities?.includes('approve')
  el('mk-answer-row').hidden = !answers
  for (const o of el('mode').options) o.textContent = { auto: `Answer: here + ${appName(s)}`, remote: 'Answer: always here', local: `Answer: ${appName(s)} only` }[o.value] ?? o.textContent
  el('mode').value = s.policy?.overrides?.approvals ?? s.policy?.approvals ?? 'auto'
  app.marking = { s, row, color: m?.color ?? '', label: m?.label ?? '', adding: false, when: m?.remind ? 'keep' : 'none', at: m?.remind ?? 0, devices: null, answer: answers ? el('mode').value : null }
  el('mk-title').textContent = s.title || 'This session'
  el('mk-title').title = s.title ?? ''
  el('mk-name').value = m?.name ?? ''
  el('mk-name').placeholder = s.title || 'A name of your own for it'
  el('mk-label').value = ''
  el('mk-at').value = ''
  el('mk-at').min = toLocalBox(Date.now())
  el('mk-notify').checked = m?.remind ? !!m.notice : !!notify
  markNote(canMark() ? '' : NO_KEY_MARK)
  drawMarkBox()
  if (!el('mk-box').open) el('mk-box').showModal()
  markFromSays(true)
  placeMarkBox()
  if (!matchMedia('(pointer: coarse)').matches) el('mk-name').focus()
  // How many of the account's devices a notification would reach
  fetch('/api/push')
    .then((r) => r.json())
    .then((p) => {
      if (app.marking?.s.id !== s.id) return
      app.marking.devices = p.devices?.length ?? 0
      drawMarkBox()
    })
    .catch(() => {})
}

function closeMarkBox() {
  if (el('mk-box').open) el('mk-box').close()
}

async function saveMarkBox(clear = false) {
  const k = app.marking
  if (!k) return
  const remind = clear ? 0 : markWhen()
  if (Number.isNaN(remind)) return markNote('Pick the day and the time to be reminded.')
  if (remind && remind <= Date.now() && k.when !== 'keep') return markNote('That time has passed: pick a later one.')
  const notify = !!remind && remind > Date.now() ? el('mk-notify').checked : !!markOf(k.s.id)?.notice && k.when === 'keep'
  if (remind > Date.now()) {
    try {
      localStorage.setItem('mc.remindNotify', notify ? '1' : '0')
    } catch {}
  }
  // (where its prompts are answered is told only where that was changed, and is not something Clear everything clears)
  const answer = !clear && k.answer && el('mode').value !== k.answer ? el('mode').value : null
  el('mk-save').disabled = true
  const failed = (await setMark(k.s, clear ? { name: '', label: '', color: '', remind: 0, notify: false } : { name: el('mk-name').value.trim(), label: markLabel(), color: k.color, remind, notify })) || (answer ? await setAnswer(k.s, answer) : '')
  el('mk-save').disabled = false
  if (failed) return markNote(failed)
  closeMarkBox()
}

// Where a session's permission prompts and questions go: the same choice for both.
// Resolves with what went wrong, where something did.
async function setAnswer(s, mode) {
  const r = await fetch('/api/sessions/' + encodeURIComponent(s.id) + '/policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvals: mode, questions: mode }) }).catch(() => null)
  if (r?.ok) return ''
  return (await r?.json().catch(() => null))?.error ?? 'Where its prompts are answered could not be saved: the server did not answer.'
}

el('mark-open').addEventListener('click', () => openMarkBox())
el('mk-close').addEventListener('click', closeMarkBox)
el('mk-clear').addEventListener('click', () => saveMarkBox(true))
el('mk-at').addEventListener('input', drawMarkBox)
el('mk-label').addEventListener('input', drawMarkBox)
el('mk-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  saveMarkBox()
})
// (a press beside the box, on what is behind it, shuts it)
el('mk-box').addEventListener('click', (ev) => ev.target === el('mk-box') && closeMarkBox())
el('mk-box').addEventListener('close', () => {
  // (a browser says a box was shut with its next frame: by then it may be open again, on what is being chosen now)
  if (el('mk-box').open) return
  app.marking = null
  markFromSays(false)
})
window.addEventListener('hashchange', closeMarkBox)
window.addEventListener('resize', () => el('mk-box').open && placeMarkBox())

// ---- A new session from the one that's open: an empty one, a clone of it, or one that
// starts from a handoff it writes; on the device it's on or another that's online, in
// the project it's in or another of that device's

// What the session is asked for a handoff. It goes to it as any prompt does: in an order.
const HANDOFF_ASK =
  'Write a handoff document for a new Claude Code session that will take over this work from you. It will not have this conversation: only what you write now. Say what the goal is, what has been done and decided and why, the state things are in now (the files, branches and commands that matter), what is left to do, and anything that would trip up someone new to it. Reply with the document only: do not write it to a file, and do nothing else.'

// The session the chat shows, as what a new one is made from
function newFrom() {
  if (app.past) return app.past.sub ? null : { id: app.past.sid, machine: app.past.mid, title: app.past.session?.title ?? '', cwd: app.past.session?.cwd ?? '', past: true }
  const s = app.sessions.get(app.current)
  return s ? { id: s.id, machine: s.machine ?? '', title: s.title ?? '', cwd: s.cwd ?? '', past: false } : null
}

// A device can take one when its agent starts sessions
const cantTake = (m) => (m.spawn ? '' : 'starting sessions is off there')

// Every device that's online, the chat's own chosen at first (`keep`: the one chosen
// since stays chosen, as devices come and go); one that can't take a session says why
const NO_DEVICE = ['None of your devices is online.', 'None of the devices that are online can start a session from here.']
function drawNewDevices(keep = true) {
  const from = newFrom()
  const select = el('ns-device')
  const online = [...app.machines.values()].filter((m) => m.online).sort((a, b) => machineName(a).localeCompare(machineName(b)))
  const able = online.filter((m) => !cantTake(m))
  const chosen = (keep && able.find((m) => m.id === select.value)) || able.find((m) => m.id === from?.machine) || able[0]
  select.replaceChildren(
    ...online.map((m) => h('option', { value: m.id, ...(cantTake(m) ? { disabled: '' } : {}) }, machineName(m) + (m.id === from?.machine ? ' (current)' : '') + (cantTake(m) ? ' — ' + cantTake(m) : ''))),
    ...(online.length ? [] : [h('option', { value: '', disabled: '' }, 'No device is online')]),
  )
  select.value = chosen?.id ?? ''
  const busy = el('ns-box').dataset.busy === '1'
  newBusy(busy)
  drawNewProjects()
  drawNewListed()
  if (busy) return
  if (!able.length) newNote(NO_DEVICE[online.length ? 1 : 0], true)
  else if (NO_DEVICE.includes(el('ns-note').textContent)) newNote('')
}

// The projects of the device chosen: the folders sessions have run in there, the folders
// beside them, and the folders it allows sessions in themselves. The chat's own project
// is chosen on its own device; on another, the one of the same path, else of the same
// name, else the first. Read from the device, and kept a minute.
const newProjects = new Map() // machine id -> { at, list: [[label, [cwd]]], allowed } or { reading }
function readProjects(mid) {
  const known = newProjects.get(mid)
  if (known?.reading) return known.reading
  const reading = (async () => {
    const r = await readFolders(mid)
    const { folders = [], allowed = [], others = [] } = r?.ok ? await r.json() : {}
    const recent = folders.map((f) => f.cwd).filter((cwd) => allowed.some((root) => isUnder(cwd, root)))
    const listed = new Set(recent.map(folderKey))
    const list = [['Projects with sessions', recent], ['Other folders', others.filter((cwd) => !listed.has(folderKey(cwd)))], ['The folders themselves', allowed.filter((cwd) => !listed.has(folderKey(cwd)))]]
    newProjects.set(mid, { at: Date.now(), list, allowed })
  })()
  newProjects.set(mid, { ...known, reading })
  return reading
}
async function drawNewProjects() {
  const mid = el('ns-device').value
  const select = el('ns-project')
  const known = newProjects.get(mid)
  if (select.dataset.machine === mid && known?.list && select.options.length && select.value) return
  select.dataset.machine = mid
  const only = (label) => select.replaceChildren(h('option', { value: '' }, label))
  if (!mid) return only('—')
  if (!known?.list || Date.now() - known.at > 60_000) {
    only('Reading the projects…')
    await readProjects(mid)
    return el('ns-device').value === mid ? drawNewProjects() : undefined
  }
  const all = known.list.flatMap(([, cwds]) => cwds)
  const from = newFrom()
  // (the chat's own folder, where its device would start a session in it though it lists it nowhere)
  const own = from && mid === from.machine && from.cwd && !all.some((cwd) => sameFolder(cwd, from.cwd)) && known.allowed.some((root) => isUnder(from.cwd, root)) ? [from.cwd] : []
  const option = (cwd) => h('option', { value: cwd, title: cwd }, folderName(cwd) + (all.filter((x) => folderName(x) === folderName(cwd)).length > 1 ? '  —  ' + cwd : ''))
  const groups = [["This chat's project", own], ...known.list].filter(([, cwds]) => cwds.length)
  // The device says nothing of its folders: the session goes in the one there most like the chat's
  if (!groups.length) return only('Like this chat\'s')
  select.replaceChildren(...groups.map(([label, cwds]) => h('optgroup', { label }, ...cwds.map(option))))
  const every = [...own, ...all]
  const name = from?.cwd ? folderName(from.cwd).toLowerCase() : ''
  select.value = every.find((cwd) => from?.cwd && sameFolder(cwd, from.cwd)) ?? every.find((cwd) => name && folderName(cwd).toLowerCase() === name) ?? every[0]
}

// Whether Claude Code's own list of sessions to resume (VS Code's) is to show a session
// started from here. It leaves out the ones a program started, which is how a machine's
// agent starts them; asked to, the agent marks the new one's transcript as an ordinary
// session's, and the list shows it. Shown unless turned off, and as it was last left.
const LISTED_HINT = "VS Code leaves out sessions a program started, as these are. Ticked, this one is marked on its computer as an ordinary session, so it is listed there."
const wantsListed = () => {
  try {
    return localStorage.getItem('mc.listed') !== '0'
  } catch {
    return true
  }
}
function keepListed(on) {
  try {
    localStorage.setItem('mc.listed', on ? '1' : '0')
  } catch {}
}
function drawNewListed() {
  el('ns-listed').checked = wantsListed()
  el('ns-listed').disabled = el('ns-box').dataset.busy === '1'
  el('ns-listed-hint').textContent = LISTED_HINT
}

function newNote(text, error = false) {
  const note = el('ns-note')
  note.textContent = text
  note.hidden = !text
  note.classList.toggle('error', error)
}

// While one is being made, nothing else is asked for
function newBusy(on) {
  const box = el('ns-box')
  if (on) box.dataset.busy = '1'
  else delete box.dataset.busy
  const none = !el('ns-device').value
  el('ns-device').disabled = on
  el('ns-project').disabled = on
  el('ns-listed').disabled = on
  for (const b of box.querySelectorAll('[data-how]')) b.disabled = on || none
}

// A box opens under its button, its right edge on the button's where there's room
function placeUnder(box, button) {
  const at = button.getBoundingClientRect()
  const width = box.offsetWidth
  box.style.setProperty('--ns-top', Math.round(at.bottom + 8) + 'px')
  box.style.setProperty('--ns-left', Math.round(Math.max(12, Math.min(at.right - width, innerWidth - width - 12))) + 'px')
}
function placeNewBox() {
  placeUnder(el('ns-box'), el('ns-open'))
}

function openNewBox() {
  const from = newFrom()
  if (!from) return
  // (one this session is still being made into is waited for here; not for ever: the
  // server gives a handoff ten minutes, and one it forgot in a restart never ends)
  if (app.branching && Date.now() - app.branching.at > 12 * 60_000) app.branching = null
  const waiting = app.branching?.from === from.id ? app.branching : null
  el('ns-title').textContent = markOf(from.id)?.name || from.title || 'This session'
  el('ns-title').title = from.title
  newNote(waiting ? waitingNote(waiting) : '')
  if (waiting) el('ns-box').dataset.busy = '1'
  else delete el('ns-box').dataset.busy
  delete el('ns-project').dataset.machine
  drawNewDevices(false)
  if (waiting && app.machines.get(waiting.mid)?.online) {
    el('ns-device').value = waiting.mid
    drawNewProjects()
  }
  if (!el('ns-box').open) el('ns-box').showModal()
  el('ns-open').setAttribute('aria-expanded', 'true')
  placeNewBox()
}

function closeNewBox() {
  if (el('ns-box').open) el('ns-box').close()
  el('ns-open').setAttribute('aria-expanded', 'false')
}

// What is said while a handoff is written, or a transcript is on its way to another device
function waitingNote({ how, mid, progress }) {
  const there = machineName(app.machines.get(mid))
  if (how === 'handoff') return `This session is writing its handoff. The new session opens on ${there} when it has; this can be closed meanwhile.`
  return `Copying this session to ${there}…${progress ? ' ' + Math.round(progress * 100) + '%.' : ''} The copy opens when it is there; this can be closed meanwhile.`
}

async function newSession(how) {
  const from = newFrom()
  const mid = el('ns-device').value
  const m = app.machines.get(mid)
  if (!from || !m) return
  // (the project chosen, if its device's projects were read and it's that device's still)
  const cwd = el('ns-project').dataset.machine === mid ? el('ns-project').value : ''
  const listed = { listed: el('ns-listed').checked }
  // Signed: for the computer the new session is to be on, all that it is to be (in the
  // mode the first is in, where that one allows it); and for the session asked to write
  // a handoff, the asking
  const asking = app.sessions.get(from.id)
  const was = modeOf(asking)
  const mode = m.spawn?.modes?.includes(was) ? was : undefined
  const there = app.machines.get(from.machine)
  // (that machine's own copy of a session, in the project it is in: anything else is its transcript carried, to another machine or another project)
  const fork = from.machine === mid && (!cwd || folderKey(cwd) === folderKey(from.cwd))
  const carried = how === 'clone' && !fork && !!from.machine
  const signed = {
    order: await orderFor(mid, 'branch', { how, from: from.id, like: from.cwd, cwd: cwd || undefined, mode, ...listed }),
    // (asked of the session itself where it is running with someone at it; through its machine's agent where the agent runs it or has to start it again)
    ...(how === 'handoff' ? { askOrder: await promptOrder(from.id, from.machine, !(asking && !asking.ended && asking.online && !asking.hosted), { text: HANDOFF_ASK, mode: there?.spawn?.modes?.includes(was) ? was : undefined }) } : {}),
    // (a machine hands a transcript over only for whoever signed for it: which session's is in the order)
    ...(carried ? { fromOrder: await orderFor(from.machine, 'export', { sid: from.id }) } : {}),
  }
  if (!signed.order) return newNote(NO_KEY, true)
  // (whether a session can be asked now is on its card, which the server cannot read: so it is looked at here)
  if (how === 'handoff' && asking && !asking.ended && asking.online) {
    if (asking.state !== 'idle') return newNote('This session is busy: ask for a handoff when it has finished what it is doing.', true)
    if (!asking.hosted && !asking.attended) return newNote('This is a headless session (claude -p or an SDK script): nothing is waiting for a prompt.', true)
  }
  newBusy(true)
  newNote(how === 'new' ? `Starting on ${machineName(m)}…` : how === 'clone' ? `Copying this session to ${machineName(m)}…` : 'Asking this session for a handoff…')
  const r = await fetch(`/api/machines/${mid}/branch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // (where the new one is to be and how are in the order: beside it go only which session, which way, and whether it is
    // that machine's own copy of a session in the same project, which the server cannot tell without the folders)
    body: JSON.stringify({ from: from.id, how, fork, ...(from.past ? { fromMachine: from.machine } : {}), ...signed }),
  }).catch(() => null)
  const data = (await r?.json().catch(() => ({}))) ?? {}
  if (!r?.ok) {
    newBusy(false)
    return newNote((data.error ?? 'The session could not be started.') + whyOf(data), true)
  }
  // A handoff takes the session a while to write, and a long transcript a while to
  // carry to another device: the server says how it goes, and when the new session is there
  if (data.pending) {
    app.branching = { id: data.id, from: from.id, mid, how, at: Date.now() }
    newNote(waitingNote(app.branching))
    // (word of how it ended can get here before the answer that it was begun)
    const ended = branchEnds.get(data.id)
    if (ended) branchTold(ended)
    return
  }
  openBranched(data.sid, mid)
}

// On to the new session, which takes a moment to report
function openBranched(sid, mid) {
  closeNewBox()
  buzz()
  app.expect = { sid, mid, until: Date.now() + 40_000 }
  location.hash = '#/s/' + encodeURIComponent(sid)
}

// Word of one asked for here: how far it is, that it's there, or that it came to nothing
const branchEnds = new Map() // how the last few ended, by id: one of them may be this page's, not yet known to be
function branchTold(b) {
  const mine = app.branching
  if (mine?.id !== b.id) {
    if ('ok' in b) branchEnds.set(b.id, b)
    if (branchEnds.size > 20) branchEnds.delete(branchEnds.keys().next().value)
    return
  }
  branchEnds.delete(b.id)
  const here = newFrom()?.id === b.from
  if ('progress' in b) return void (el('ns-box').open && here && newNote(waitingNote({ ...mine, progress: b.progress })))
  app.branching = null
  // Still with the session it was made from: on to the new one
  if (b.ok) return void (here && openBranched(b.sid, b.machine))
  if (!here) return
  // (said in the box, opened again if it was closed meanwhile)
  openNewBox()
  newNote((mine.how === 'handoff' ? 'No handoff: ' : 'Not copied: ') + (b.error ?? 'the new session could not be started') + whyOf(b), true)
}

el('ns-open').addEventListener('click', openNewBox)
el('ns-close').addEventListener('click', closeNewBox)
// (a click beside the box closes it, as Escape does)
el('ns-box').addEventListener('click', (ev) => ev.target === el('ns-box') && closeNewBox())
el('ns-box').addEventListener('close', () => el('ns-open').setAttribute('aria-expanded', 'false'))
el('ns-device').addEventListener('change', () => {
  drawNewProjects()
  drawNewListed()
})
el('ns-listed').addEventListener('change', () => keepListed(el('ns-listed').checked))
el('ns-form').addEventListener('click', (ev) => {
  const how = ev.target.closest('[data-how]')?.dataset.how
  if (how) newSession(how)
})
window.addEventListener('hashchange', closeNewBox)
window.addEventListener('resize', () => el('ns-box').open && placeNewBox())

// The grip a favorite is moved by: dragged, or with the arrow keys
const gripButton = (id, title) =>
  h(
    'button',
    {
      type: 'button',
      class: 'grip',
      'aria-label': `Move ${title} up or down`,
      title: 'Drag to move up or down',
      onclick: (ev) => ev.preventDefault(),
      onkeydown: (ev) => {
        const by = { ArrowUp: -1, ArrowDown: 1 }[ev.key]
        if (!by) return
        ev.preventDefault()
        // (among the ones in their places: one at the top for its reminder is not there to be moved past)
        const ids = app.favorites.filter((f) => !isDue(markOf(f.id))).map((f) => f.id)
        const at = ids.indexOf(id)
        if (at + by < 0 || at + by >= ids.length) return
        ids.splice(at + by, 0, ...ids.splice(at, 1))
        orderFavorites(ids)
      },
    },
    '⠿',
  )

// A favorite's row: the session as it is now where it's reporting, or known here; else as
// its machine has it, or as it was when last heard of. (`how`: a session brought to the
// top by its reminder has a row made the same way, from its mark where it's no favorite.)
function favoriteRow(f, how = { favorite: true }) {
  const s = app.sessions.get(f.id)
  if (s) return renderRow(s, how)
  const onMachine = app.catalog.get(f.machine)?.sessions.find((x) => x.id === f.id)
  return pastRow(onMachine ?? { ...f, lastActivity: 0, known: false }, how)
}

// The favorites in a new order: shown at once, and told to the server. (`ids` are the ones
// in their places, as they are to be. A favorite that is at the top for its reminder is
// not among them, and keeps the place it has: left out, the server would put it last.)
async function orderFavorites(ids) {
  const moved = new Set(ids)
  const next = [...ids]
  ids = app.favorites.map((f) => (moved.has(f.id) ? next.shift() : f.id))
  const at = new Map(ids.map((id, i) => [id, i]))
  app.favorites = [...app.favorites].sort((a, b) => at.get(a.id) - at.get(b.id))
  renderList()
  const r = await fetch('/api/favorites', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: ids }) }).catch(() => null)
  if (r?.ok) app.favorites = (await r.json()).favorites
  renderList()
}

// While something in the list is pressed, by a mouse button or a finger, the list isn't
// drawn again: a row taken away from under the press would take its click, its drag or
// the rest of its swipe with it (what a finger does goes to what it first touched, even
// once that is gone). What changed meanwhile is drawn when it's let go.
{
  const list = el('session-list')
  const press = () => (app.pressed = Date.now())
  const release = () => {
    if (!app.pressed) return
    app.pressed = 0
    if (app.listStale) renderListSoon()
  }
  list.addEventListener('pointerdown', (ev) => ev.pointerType !== 'touch' && press(), true)
  list.addEventListener('touchstart', press, { capture: true, passive: true })
  for (const over of ['pointerup', 'pointercancel']) window.addEventListener(over, (ev) => ev.pointerType !== 'touch' && release(), true)
  for (const over of ['touchend', 'touchcancel']) window.addEventListener(over, (ev) => ev.touches.length === 0 && release(), true)
}

// Favorites are put in order by dragging: by the grip, or with a mouse by the row itself.
// (A finger on the row scrolls the list, so it's the grip a finger moves one by.) The row
// is carried with the pointer, and the others move aside to show where it would be put
// down; let go, it settles there and the order is kept. The row shows it's in hand: from
// the press on its grip, or once a press on the row is a drag.
{
  const list = el('session-list')
  const rows = () => [...list.querySelectorAll('.row.favorite')]
  let drag = null
  let settling = null // the row let go, on its way to its place: called to have it there at once
  // The pointer's moves come to the list from here on, wherever it goes and whatever becomes of what it pressed
  const take = (pointer) => {
    try {
      list.setPointerCapture(pointer)
    } catch {}
  }
  // The rows are measured once, where they are as the drag starts: the one in hand is
  // carried from there, and the others are moved from there, by the room it leaves
  const pickUp = () => {
    drag.rows = rows()
    drag.at = drag.to = drag.rows.indexOf(drag.row)
    drag.boxes = drag.rows.map((r) => r.getBoundingClientRect())
    const mine = drag.boxes[drag.at]
    drag.room = mine.height + (drag.boxes.length > 1 ? drag.boxes[1].top - drag.boxes[0].bottom : 0)
    drag.scroll = list.scrollTop
  }
  // The others, moved into the room it left so that its place is `to`
  const aside = (d, to) =>
    d.rows.forEach((r, j) => {
      if (j !== d.at) r.style.transform = j > d.at && j <= to ? `translateY(${-d.room}px)` : j < d.at && j >= to ? `translateY(${d.room}px)` : ''
    })
  // Carried to where the pointer is, among the favorites and no further. Its place is
  // past every row it's half over.
  const carry = (y) => {
    const { boxes, at } = drag
    const mine = boxes[at]
    const by = Math.max(boxes[0].top - mine.top, Math.min(boxes.at(-1).bottom - mine.bottom, y - drag.y + list.scrollTop - drag.scroll))
    const middle = (j) => (boxes[j].top + boxes[j].bottom) / 2
    let to = at
    while (to + 1 < boxes.length && mine.bottom + by > middle(to + 1)) to++
    while (to > 0 && to <= at && mine.top + by < middle(to - 1)) to--
    drag.to = to
    drag.row.style.transform = `translateY(${by}px)`
    aside(drag, to)
  }
  // Put down: where it has got to, or (the drag broken off) where it was. It goes the
  // rest of the way there by itself, and then the rows are in their places as they'll be
  // drawn: moved, not drawn again, so that nothing is taken from under a press begun meanwhile.
  const putDown = (keep) => {
    const d = drag
    drag = null
    if (!d) return
    if (!d.moved) return void d.row.classList.remove('dragging')
    const to = keep ? d.to : d.at
    const ids = d.rows.map((r) => r.dataset.favorite)
    ids.splice(to, 0, ...ids.splice(d.at, 1))
    app.pressed = 0
    const done = () => {
      if (settling !== done) return
      settling = null
      app.dragging = false
      list.classList.remove('reordering')
      for (const r of d.rows) r.style.transform = ''
      d.row.classList.remove('settling')
      if (to === d.at) return void (app.listStale && renderListSoon())
      list.insertBefore(d.row, to > d.at ? d.rows[to].nextSibling : d.rows[to])
      orderFavorites(ids)
    }
    settling = done
    const { boxes, at } = d
    aside(d, to)
    d.row.classList.replace('dragging', 'settling')
    d.row.style.transform = `translateY(${to > at ? boxes[to].bottom - boxes[at].bottom : to < at ? boxes[to].top - boxes[at].top : 0}px)`
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done()
    else setTimeout(done, 140)
  }
  list.addEventListener('pointerdown', (ev) => {
    // (one still settling is in its place first, and one whose letting go was never heard of is put back)
    settling?.()
    putDown(false)
    settling?.()
    const row = ev.target.closest('.row.favorite')
    if (!row || ev.button !== 0 || ev.target.closest('.star, .row-edit')) return
    const byGrip = !!ev.target.closest('.grip')
    if (!byGrip && ev.pointerType !== 'mouse') return
    drag = { id: row.dataset.favorite, row, pointer: ev.pointerId, y: ev.clientY, moved: false }
    if (!byGrip) return
    row.classList.add('dragging')
    take(ev.pointerId)
  })
  window.addEventListener(
    'pointermove',
    (ev) => {
      if (!drag || ev.pointerId !== drag.pointer) return
      if (!drag.moved) {
        if (Math.abs(ev.clientY - drag.y) < 5) return
        drag.row.classList.remove('dragging')
        drag.row = rows().find((r) => r.dataset.favorite === drag.id)
        if (!drag.row) return void (drag = null)
        drag.moved = true
        app.dragging = true
        drag.row.classList.add('dragging')
        list.classList.add('reordering')
        take(ev.pointerId)
        pickUp()
      }
      carry(ev.clientY)
    },
    { passive: true },
  )
  const letGo = (ev, keep) => {
    if (!drag || ev.pointerId !== drag.pointer) return
    if (drag.moved) {
      // (the click a mouse makes as it lets go opens nothing: the row was moved)
      const swallow = (click) => {
        click.preventDefault()
        click.stopPropagation()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 50)
    }
    putDown(keep)
  }
  window.addEventListener('pointerup', (ev) => letGo(ev, true))
  window.addEventListener('pointercancel', (ev) => letGo(ev, false))
  window.addEventListener('blur', () => putDown(false))
}

// What a session's user last typed to it: as its card says, or, where the card does not
// (a plugin before 4.1.0), as this page read it in the session's chat or off the stream
const promptOf = (s) => s.lastPrompt || app.typed.get(s.id) || ''
// A row of a chat that its user typed: a prompt, from wherever it was typed. Not a slash
// command or a shell line, and not what the app wrote to Claude by itself. (As the plugin has it.)
// (Of a prompt, what was typed: not Claude in Chrome's instructions, which the app puts in front of one typed in VS Code.)
const typedText = (m) => (typeof m?.text === 'string' ? m.text.replace(/<browser_instruction>[\s\S]*?<\/browser_instruction>\s*/g, '').trim() : '')
const typedRow = (m) => m?.role === 'user' && m.origin !== 'engine' && !!typedText(m) && !/^(\/[\w:.-]+(\s|$)|! )/.test(typedText(m))
// Some rows of a session's chat, as they were read here: the last its user typed is kept. Says whether there was one.
function typedHere(sid, rows) {
  const mine = rows.findLast(typedRow)
  if (!mine) return false
  const text = typedText(mine).slice(0, 200)
  if (app.typed.get(sid) === text) return false
  app.typed.set(sid, text)
  return true
}

// A session's tile in the list. What it shows beside the session's name is as this device
// has it in the settings (`tile`): the project and computer it is on, the last thing its
// user typed (marked ❯, as a prompt is), the last thing Claude said, and when it was last
// heard from. What it is waiting for is always said.
function renderRow(s, { favorite = false, due = false } = {}) {
  const tile = app.tile
  // The project it's in, and the machine: what it's about is its title, or the name it was given here
  const sub = tile.where ? dotted(s.project !== s.title ? s.project : null, whereLabel(whereOf(s), s.machine)) : []
  const mark = markOf(s.id)
  const soon = !due && remindSoon(mark)
  const name = nameOf(s)
  const prompt = promptOf(s)
  // (a session is called by its first prompt until it is given a name: where that is still the last thing typed, its name says it)
  const typed = tile.prompt && prompt.slice(0, 80) !== name ? prompt : ''
  // What Claude has said since: as its card says, or, where the card does not (a plugin before 4.1.0), the
  // last thing said in it, unless that is its user's own last words
  // (nor a prompt with Claude in Chrome's instructions in front of it, which is how an older plugin had one)
  const said = !tile.reply ? '' : (s.lastReply ?? (s.preview !== prompt && !s.preview.startsWith('<browser_instruction>') ? s.preview : ''))
  const key = (due ? 'due:' : favorite ? 'favorite:' : 'open:') + s.id
  return h(
    'a',
    {
      class: ['row', s.id === app.current && 'active', (s.state === 'ended' || s.state === 'offline') && 'dim', favorite && 'favorite', due && 'due'].filter(Boolean).join(' '),
      'data-key': key,
      href: '#/s/' + encodeURIComponent(s.id),
      ...(favorite ? { 'data-favorite': s.id, draggable: 'false' } : {}),
      ...(mark?.color ? { 'data-color': mark.color } : {}),
    },
    h('span', { class: 'dot ' + s.state, title: STATE_LABEL[s.state] }),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-top' }, h('span', { class: 'row-title' + (app.unread.has(s.id) ? ' unread' : '') }, name), labelChip(mark), tile.time && h('span', { class: 'row-time' }, ago(s.lastActivity))),
      (sub.length || s.agents?.length || soon) && h('div', { class: 'row-sub' }, sub, sub.length && s.agents?.length ? ' · ' : '', agentsMark(s), (sub.length || s.agents?.length) && soon ? ' · ' : '', soon),
      due && remindLine(mark),
      typed && h('div', { class: 'row-prompt', title: 'The last thing you typed to it' }, h('span', { class: 'row-prompt-mark', 'aria-hidden': 'true' }, '❯'), h('span', { class: 'row-said' }, typed)),
      s.state === 'attention' ? h('div', { class: 'row-preview' }, '⚠ ' + (s.detail || 'Needs your attention')) : said && h('div', { class: 'row-preview' }, said),
    ),
    due && doneButton(s),
    editButton(s, key),
    starButton(s),
    favorite && gripButton(s.id, nameOf(s)),
  )
}

// ---- The settings (#/settings, from Settings under the list): a page of their own, where a
// conversation is, as the account's is. What the list shows, how the page looks, what a
// session's tile says, and this device's notifications. All of it is this device's own,
// kept in its browser: another device has its own. (Until 2026-10-08 they opened over the
// foot of the list, and were the first three of these.)

function openSettings() {
  leaveChat()
  markTile()
  renderAlertsButton()
}

// What a tile shows, as this device kept it: anything it did not keep is as it is to begin with
function tileKept() {
  let kept = null
  try {
    kept = JSON.parse(localStorage.getItem('mc.tile'))
  } catch {}
  const tile = { ...TILE }
  for (const k of ['where', 'prompt', 'reply', 'time']) if (typeof kept?.[k] === 'boolean') tile[k] = kept[k]
  if ([1, 2, 3].includes(kept?.lines)) tile.lines = kept.lines
  return tile
}
function setTile(change) {
  app.tile = { ...app.tile, ...change }
  try {
    localStorage.setItem('mc.tile', JSON.stringify(app.tile))
  } catch {}
  markTile()
  renderList()
}
// A session made up for the settings, to show a tile on: what it says is long enough to run to three lines
const TILE_SAMPLE = {
  id: 'tile-sample',
  state: 'idle',
  title: 'Fix the flaky login test',
  project: 'ios-app',
  host: 'Mac Studio',
  lastPrompt: 'Find out why the login test is flaky on CI and fix it. Run the suite fifty times before you call it done, and tell me what the cause was.',
  lastReply: 'Reproduced it: the test taps before the keyboard has finished animating. Waiting on the field’s focus fixes it, and fifty runs in a row pass now where one in six failed before.',
}
// The settings say what this device has its tiles show: each choice as it stands, the
// number of lines to the page (app.css clamps by it), and a tile drawn that way
function markTile() {
  document.documentElement.dataset.tileLines = String(app.tile.lines)
  for (const box of document.querySelectorAll('[data-tile]')) box.checked = !!app.tile[box.dataset.tile]
  for (const b of document.querySelectorAll('[data-tile-lines]')) b.setAttribute('aria-pressed', String(Number(b.dataset.tileLines) === app.tile.lines))
  const row = renderRow({ ...TILE_SAMPLE, lastActivity: Date.now() - 3 * 60_000 })
  // (it is a picture of a tile: it goes nowhere, and has no pencil or star to press)
  row.removeAttribute('href')
  for (const b of row.querySelectorAll('.row-edit, .star')) b.remove()
  fill(el('tile-sample'), row)
}
for (const box of document.querySelectorAll('[data-tile]')) box.addEventListener('change', () => setTile({ [box.dataset.tile]: box.checked }))
for (const b of document.querySelectorAll('[data-tile-lines]')) b.addEventListener('click', () => setTile({ lines: Number(b.dataset.tileLines) }))

const markPastBy = () => {
  for (const b of document.querySelectorAll('[data-set-by]')) b.setAttribute('aria-pressed', String(b.dataset.setBy === app.pastBy))
}
for (const b of document.querySelectorAll('[data-set-by]')) b.addEventListener('click', () => setPastBy(b.dataset.setBy))

el('show-ended').addEventListener('change', (ev) => {
  app.showEnded = ev.target.checked
  try {
    localStorage.setItem('mc.showEnded', app.showEnded ? '1' : '0')
  } catch {}
  renderList()
})

setInterval(renderList, 30_000)

// ---- Machines: each carries every session on it, running or not

const machineName = (m) => m?.label || m?.name || 'a machine'
const PAST_PAGE = 15

// ---- What a computer needs done. Its plugin or its agent is older than the one this
// server hands out now; or its sessions are heard from while its agent is not, so that
// no session can be started on it. The server says what it hands out (the snapshot's
// `latest`); what a computer has is the computer's own to say: its agent's version in the
// agent's hello, its plugin's on each session's card, and there too which machine's agent
// the plugin found beside it. This page holds the one against the other: a mark by the
// computer's name in the list, and on the computer's own page what it is and what to do.

// A version: a run of numbers (4.0.1). One is behind another read number by number; what is no version is behind nothing.
const versionOf = (v) => (typeof v === 'string' && /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null)
function behind(has, newest) {
  const [a, b] = [versionOf(has), versionOf(newest)]
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}
// The machine a session is on, among the machines this page has now (one may have said hello since the session was read)
const machineOn = (s) => app.machines.get(s.machine) ?? [...app.machines.values()].find((m) => (s.agentBeside?.id && m.id === s.agentBeside.id) || (s.host && m.name === s.host)) ?? null
// The sessions heard from now
const heardNow = () => [...app.sessions.values()].filter((s) => s.online && !s.ended)
// A machine is not taken for one whose agent has stopped until it has been quiet this long. A computer that goes to
// sleep is not heard from at all, and its agent, which asks the server less often than its sessions do, is the first to
// be missed: by this long its sessions are missed too, and nothing is said of an agent on a computer that is away.
const AGENT_QUIET_MS = 90_000

// A computer, as this page speaks of one: a machine, which is one whose agent has said hello; or one known only by the
// sessions heard from on it, where no agent of the account's is. `id` is the machine's, or `~` and the host's name.
// `live`: its sessions heard from now.
const looseId = (host) => '~' + host
function computerOf(id) {
  const m = app.machines.get(id)
  if (m) return { id, m, name: machineName(m), live: heardNow().filter((s) => machineOn(s) === m) }
  if (!String(id).startsWith('~')) return null
  const live = heardNow().filter((s) => s.host === id.slice(1) && !machineOn(s))
  return live.length ? { id, m: null, name: live.find((s) => s.label)?.label || id.slice(1), live } : null
}
// The computers with no machine: each host a session is heard from on that is on none
const looseComputers = () => [...new Set(heardNow().filter((s) => s.host && !machineOn(s)).map((s) => s.host))].map((host) => computerOf(looseId(host))).filter(Boolean)
// The plugin a computer has, as its sessions say: the newest any of them runs. A session keeps the plugin it started
// with, so that is the one installed unless no session has started there since it was updated.
const pluginOn = (c) => c.live.map((s) => s.plugin).filter(versionOf).sort((a, b) => (behind(a, b) ? -1 : behind(b, a) ? 1 : 0)).at(-1) ?? null

// What it needs, each with what there is to say of it: { kind, has, newest }
function needsOf(c) {
  if (!c) return []
  const needs = []
  const plugin = pluginOn(c)
  if (behind(plugin, app.latest.plugin)) needs.push({ kind: 'plugin-old', has: plugin, newest: app.latest.plugin })
  // Its agent is not running: sessions are heard from on it, and its agent is not (a machine's, for a while now); or it
  // has no machine, and a session's plugin says of the agent beside it that there is none, or names one the account has not
  const down = c.m ? !c.m.online && Date.now() - (c.m.lastSeen ?? 0) > AGENT_QUIET_MS && c.live.length > 0 : c.live.some((s) => s.agentBeside !== undefined)
  // Its agent is too old for the server to hear at all (the server says so of a machine whose hello it refused): that is
  // why nothing is heard of it, whatever else is. Else it is not running; else it is older than the newest, by what it
  // says now or, where it is not heard from, by what it last said: a computer that is away is as old when it is back.
  // Or it is running and has stopped asking the server for what to do (the server says so of a machine whose hello it
  // still has and whose polls it does not; said here only while that hello is a recent one).
  const stalled = !!c.m?.stalled && !c.m.online && Date.now() - (c.m.lastSeen ?? 0) < 2 * AGENT_QUIET_MS
  if (c.m?.refused) needs.push({ kind: 'agent-refused', has: versionOf(c.m.agent) ? c.m.agent : '', newest: app.latest.agent ?? '' })
  else if (stalled) needs.push({ kind: 'agent-stalled' })
  else if (down) needs.push({ kind: 'agent-down' })
  else if (c.m && behind(c.m.agent, app.latest.agent)) needs.push({ kind: 'agent-old', has: c.m.agent, newest: app.latest.agent, heard: !!c.m.online })
  return needs
}
// Each said in a few words, for where the mark is pointed at
const needSays = (n) =>
  ({
    'plugin-old': `its plugin is ${n.has}, and ${n.newest} is the newest`,
    'agent-old': n.heard === false ? `its agent was ${n.has} when it was last heard from, and ${n.newest} is the newest` : `its agent is ${n.has}, and ${n.newest} is the newest`,
    'agent-refused': `its agent is ${n.has ? n.has + ', ' : ''}too old for the server to hear`,
    'agent-down': 'its agent is not running: no session can be started on it',
    'agent-stalled': 'its agent has stopped answering, and wants starting again',
  })[n.kind]
// The way to a computer's own page, at the end of its line: a gear, with a mark on it where the computer needs something
function computerLink(c, says) {
  const needs = needsOf(c)
  const told = needs.length ? c.name + ': ' + needs.map(needSays).join('; ') + '.' : ''
  return h(
    'a',
    { class: 'machine-open' + (app.computer?.mid === c.id ? ' active' : ''), href: '#/computer/' + encodeURIComponent(c.id), 'aria-label': (told ? told + ' ' : c.name + ': ') + says.aria, title: told ? told + '\n' + says.title : says.title },
    icon('gear'),
    needs.length ? h('span', { class: 'machine-note', 'aria-hidden': 'true' }) : null,
  )
}
// A computer with no machine, in the list: only where it needs something, which is what it is listed for. It has no
// sessions of its own to list (those heard from are among the active ones): its name, and the way to its page.
function looseNodes(c) {
  if (!needsOf(c).length) return []
  return [
    h(
      'div',
      { class: 'group-head machine-head loose', 'data-key': 'computer:' + c.id },
      h('span', { class: 'machine-still' }, h('span', { class: 'machine-name' }, c.name), h('span', { class: 'plan' }, 'no agent')),
      computerLink(c, { aria: 'what it needs', title: `What ${c.name} needs` }),
    ),
  ]
}

// A machine's past sessions, newest first; `more` adds the next page
// What is said under a computer whose answer this browser's key does not open
const OTHER_KEY = 'This computer answered with something this browser cannot open: it was given a different passphrase.'
async function loadCatalog(mid, more = false) {
  // (a machine reads only what was sealed for it: where this device has no key, there is nothing to ask it with)
  if (!app.key) return void (app.catalog.set(mid, { sessions: [], more: false, loaded: false, failed: false, locked: true, at: Date.now() }), renderList())
  const have = app.catalog.get(mid)
  const before = more && have?.sessions.length ? have.sessions.at(-1).lastActivity : 0
  // `loaded` says the machine has answered at least once: until then its list is being read, not empty
  app.catalog.set(mid, { sessions: [], more: false, loaded: false, ...have, failed: false, locked: false, at: Date.now() })
  const r = await fetch(`/api/machines/${mid}/sessions?` + (await askOf({ limit: PAST_PAGE, before: before || 0 }))).catch(() => null)
  if (!r?.ok) {
    // (why not, as the server said it: that it is offline, that its agent has stopped answering, that it took too long.
    // What the machine itself answered comes sealed: where this browser's key does not open that, it has another passphrase.)
    const said = r ? (await r.json().catch(() => null))?.error : null
    const why = typeof said !== 'string' || !said ? '' : isLocked(said) ? OTHER_KEY : sentence(said)
    app.catalog.set(mid, { ...app.catalog.get(mid), failed: why || true })
    return renderList()
  }
  const { sessions, locked } = await r.json()
  // (an answer this browser cannot open is no list: the computer sealed it with the key of another passphrase)
  if (locked) {
    app.catalog.set(mid, { ...app.catalog.get(mid), failed: OTHER_KEY })
    return renderList()
  }
  const kept = more ? (app.catalog.get(mid)?.sessions ?? []) : []
  // A first page read again keeps the pages already added below it
  // (but not one that has been worked in since, and so is in the first page now)
  const again = new Set(sessions.map((x) => x.id))
  const rest = more ? [] : (have?.sessions ?? []).filter((old) => sessions.length && old.lastActivity < sessions.at(-1).lastActivity && !again.has(old.id))
  app.catalog.set(mid, { sessions: [...kept, ...sessions, ...rest], more: more ? sessions.length === PAST_PAGE : (have?.more ?? sessions.length === PAST_PAGE), loaded: true, failed: false, at: Date.now() })
  renderList()
}

function machineNodes(m) {
  const catalog = app.catalog.get(m.id)
  const shut = app.shut.has(m.id)
  const nodes = [
    h(
      'div',
      { class: 'group-head machine-head', 'data-key': 'machine:' + m.id },
      // (its name, and the rest of its line up to the links, folds its sessions away and brings them back)
      h(
        'button',
        { type: 'button', class: 'machine-fold', 'aria-expanded': String(!shut), title: (shut ? 'Show the sessions on ' : 'Hide the sessions on ') + machineName(m), onclick: () => toggleMachine(m.id) },
        h('span', { class: 'project-mark', 'aria-hidden': 'true' }, shut ? '▸' : '▾'),
        h('span', { class: 'machine-name' }, whereLabel(machineName(m), m.id)),
        h('span', { class: 'plan' }, m.online ? (m.stats?.pending ? `indexing, ${m.stats.pending} files left` : '') : 'offline'),
      ),
      // (its own page: its color, a new session on it, and the Claude accounts on it where it has cswap; and what it needs, where it needs something)
      computerLink(computerOf(m.id), { aria: 'its color, a new session, and its settings', title: computerSays(m) }),
    ),
  ]
  if (shut) return nodes
  if (app.pastBy === 'project' && m.online) return [...nodes, ...projectNodes(m)]
  // Every session on the machine, the ones running now among them
  const all = catalog?.sessions ?? []
  for (const s of all) nodes.push(pastRow(s))
  if (catalog?.more) nodes.push(h('button', { type: 'button', class: 'more-link', 'data-key': 'more:' + m.id, onclick: () => loadCatalog(m.id, true) }, 'Earlier sessions…'))
  if (m.online && catalog && !all.length) nodes.push(h('div', { class: 'list-empty', 'data-key': 'none:' + m.id }, catalog.locked ? 'Its sessions are end-to-end encrypted: type your passphrase under Account to read them.' : catalog.failed ? (typeof catalog.failed === 'string' ? catalog.failed : "The machine didn't answer.") : catalog.loaded ? 'No sessions yet.' : 'Reading the sessions…'))
  return nodes
}

// A machine's sessions are folded away under its name, and brought back, by a press on
// its name. Which machines are folded is kept on this device.
function toggleMachine(mid) {
  const list = el('session-list')
  const head = list.querySelector(`[data-key="machine:${CSS.escape(mid)}"]`)
  // (where its name is in the list, when it isn't held at the top of it)
  const place = () => {
    head.style.position = 'static'
    const top = head.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    head.style.position = ''
    return top
  }
  // Its name is held at the top of the list while its sessions go by under it. Folded
  // from there, the list stays at its name, with what comes after it under it. (Left to
  // itself the list would be somewhere in the next machine's sessions, or wherever the
  // browser thought best: not the same in any two of them.)
  const held = !!head && !app.shut.has(mid) && place() < list.scrollTop
  if (!app.shut.delete(mid)) app.shut.add(mid)
  try {
    localStorage.setItem('mc.shut', JSON.stringify([...app.shut]))
  } catch {}
  renderList()
  if (held && !app.listStale && head.isConnected) list.scrollTop = place()
}

// ---- Past sessions by project: the folder they ran in. Each project opens to its
// own sessions. Which it is, is one of the settings (Group by), for every machine alike.

function setPastBy(how) {
  app.pastBy = how === 'project' ? 'project' : 'time'
  try {
    localStorage.setItem('mc.pastBy', app.pastBy)
  } catch {}
  markPastBy()
  if (app.pastBy === 'project') for (const m of app.machines.values()) if (m.online) loadProjects(m.id)
  renderList()
}

async function loadProjects(mid) {
  const r = await readFolders(mid)
  if (!r?.ok) return
  app.projects.set(mid, (await r.json()).folders)
  // The ones that are open are read again too: a session may have ended into one
  for (const key of app.projectOpen.keys()) if (key.startsWith(mid + '|')) loadProject(mid, key.slice(mid.length + 1))
  renderList()
}

async function loadProject(mid, cwd, more = false) {
  const key = mid + '|' + cwd
  const have = app.projectOpen.get(key)
  const before = more && have?.sessions.length ? have.sessions.at(-1).lastActivity : 0
  const r = await fetch(`/api/machines/${mid}/sessions?` + (await askOf({ limit: PAST_PAGE, cwd, before: before || 0 }))).catch(() => null)
  if (!r?.ok || !app.projectOpen.has(key)) return
  const { sessions } = await r.json()
  const again = new Set(sessions.map((x) => x.id))
  const shown = more ? [...(have?.sessions ?? []), ...sessions] : [...sessions, ...(have?.sessions ?? []).filter((old) => sessions.length && old.lastActivity < sessions.at(-1).lastActivity && !again.has(old.id))]
  app.projectOpen.set(key, { sessions: shown, more: more ? sessions.length === PAST_PAGE : (have?.more ?? sessions.length === PAST_PAGE) })
  renderList()
}

function toggleProject(mid, cwd) {
  const key = mid + '|' + cwd
  if (app.projectOpen.delete(key)) return renderList()
  app.projectOpen.set(key, { sessions: [], loading: true })
  renderList()
  loadProject(mid, cwd)
}

function projectNodes(m) {
  const projects = app.projects.get(m.id)
  if (!projects) return [h('div', { class: 'list-empty', 'data-key': 'none:' + m.id }, 'Reading the projects…')]
  if (!projects.length) return [h('div', { class: 'list-empty', 'data-key': 'none:' + m.id }, 'No past sessions.')]
  const nodes = []
  // Two folders can share a name: then where each is tells them apart at a glance
  const names = new Map()
  for (const p of projects) names.set(folderName(p.cwd), (names.get(folderName(p.cwd)) ?? 0) + 1)
  for (const p of projects) {
    const key = m.id + '|' + p.cwd
    const open = app.projectOpen.get(key)
    nodes.push(
      h(
        'button',
        { type: 'button', class: 'project', 'data-key': 'project:' + key, 'aria-expanded': String(!!open), title: p.cwd, onclick: () => toggleProject(m.id, p.cwd) },
        h('span', { class: 'project-mark', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        // A session is running in it now
        liveIn(m.id, p.cwd) ? h('span', { class: 'dot live', title: 'A session is live here' }) : null,
        h('span', { class: 'project-name' }, folderName(p.cwd), names.get(folderName(p.cwd)) > 1 ? h('span', { class: 'project-where' }, ' ' + p.cwd.slice(0, -folderName(p.cwd).length - 1)) : null),
        h('span', { class: 'row-time' }, `${p.sessions} · ${ago(p.last_ts)}`),
      ),
    )
    if (!open) continue
    for (const s of open.sessions) nodes.push(pastRow(s, { inProject: true }))
    if (open.more) nodes.push(h('button', { type: 'button', class: 'more-link in-project', 'data-key': 'more:' + key, onclick: () => loadProject(m.id, p.cwd, true) }, 'Earlier sessions…'))
  }
  return nodes
}

const folderName = (cwd) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

// Whether a session reporting now is on this machine, in this folder
const liveIn = (mid, cwd) => [...app.sessions.values()].some((s) => s.machine === mid && sameFolder(s.cwd, cwd) && isReporting(s.id))

// Windows takes c:\git\x and C:\Git\X for one folder
const folderKey = (cwd) => (/^[a-z]:[\\/]/i.test(cwd ?? '') ? cwd.toLowerCase().replace(/\//g, '\\') : cwd)
const sameFolder = (a, b) => folderKey(a) === folderKey(b)

const isReporting = (sid) => {
  const s = app.sessions.get(sid)
  return !!s && !s.ended && s.online
}

// A session in a machine's list. One that's reporting now is marked live (a green dot)
// and opens as the live session it is; one that isn't opens from its transcript.
function pastRow(s, { inProject = false, favorite = false, due = false } = {}) {
  const live = isReporting(s.id)
  const now = live ? app.sessions.get(s.id) : null
  const active = live ? app.current === s.id : app.past?.sid === s.id && !app.past.sub
  const state = live ? ['live', 'Live'] : s.open ? ['open', 'Open in Claude Code on the machine, not reporting'] : ['past', 'Not running']
  // (a favorite whose machine isn't connected here can be seen, not opened)
  const reachable = live || app.machines.has(s.machine)
  const mark = markOf(s.id)
  // (one kept with nothing of what it is called, by a device that had no key: the start of its id)
  const name = mark?.name || (now?.title ?? s.title) || s.id.slice(0, 8)
  const soon = !due && remindSoon(mark)
  // (among the favorites it says which machine it's on: there it isn't under its machine's name)
  // (which project and which computer, where this device has its tiles say so: the settings)
  const key = due ? 'due:' + s.id : favorite ? 'favorite:' + s.id : `past:${s.machine}/${s.id}`
  const sub = dotted(inProject || !app.tile.where ? '' : s.project, app.tile.where && (favorite || due) ? (app.machines.has(s.machine) ? whereLabel(machineName(app.machines.get(s.machine)), s.machine) : s.where) : '', s.messages ? s.messages + ' messages' : '', live ? 'live' : s.open ? 'open on the machine' : '')
  return h(
    'a',
    {
      class: 'row past' + (live ? ' live' : '') + (active ? ' active' : '') + (inProject ? ' in-project' : '') + (favorite ? ' favorite' : '') + (due ? ' due' : '') + (reachable ? '' : ' dim'),
      'data-key': key,
      ...(reachable ? { href: live ? '#/s/' + encodeURIComponent(s.id) : `#/m/${s.machine}/${encodeURIComponent(s.id)}` } : { title: 'The computer this session is on is not connected' }),
      ...(favorite ? { 'data-favorite': s.id, draggable: 'false' } : {}),
      ...(mark?.color ? { 'data-color': mark.color } : {}),
    },
    h('span', { class: 'dot ' + state[0], title: state[1] }),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-top' }, h('span', { class: 'row-title' }, name), labelChip(mark), app.tile.time && h('span', { class: 'row-time' }, now?.lastActivity || s.lastActivity ? ago(now?.lastActivity ?? s.lastActivity) : '')),
      h('div', { class: 'row-sub' }, sub, now?.agents?.length ? ' · ' : '', agentsMark(now), (sub.length || now?.agents?.length) && soon ? ' · ' : '', soon),
      due && remindLine(mark),
    ),
    due && doneButton(s),
    editButton(s, key, true),
    starButton(s),
    favorite && gripButton(s.id, name),
  )
}

// ---- Search: every session on every machine that's online

el('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 200)
})
el('search').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  el('search').value = ''
  runSearch()
})

// The words are searched on every machine; what comes back first is which machines have
// matches, and in which of their projects. The rest is read as it's opened.
async function runSearch() {
  const q = el('search').value.trim()
  const seq = ++app.search.seq
  if (!q) {
    app.search = { ...app.search, q: '', seq, data: null }
    return renderList()
  }
  app.search.q = q
  // One letter matches most of everything
  if (q.length < 2) {
    app.search.data = { machines: [], short: true }
    return renderList()
  }
  renderList()
  // The words go sealed, to every machine alike. (With nothing to seal them with they are not sent anywhere, and that is said.)
  const sealed = await sealFor({ q, subagents: true })
  if (!sealed) {
    app.search.data = { machines: [], locked: true }
    return renderList()
  }
  const r = await fetch('/api/search/machines?c=' + encodeURIComponent(sealed)).catch(() => null)
  if (seq !== app.search.seq) return // a newer search is on its way
  app.search.data = r?.ok ? await r.json() : { machines: [], failed: true }
  followSearch()
  renderList()
}

// The way down that was open stays open, read again for the new words; and a level
// with one thing in it opens by itself
function followSearch() {
  const { data, open } = app.search
  if (data.machines.length === 1) open.add('m:' + data.machines[0].machine.id)
  for (const g of data.machines) {
    if (!open.has('m:' + g.machine.id)) continue
    if (g.projects.length === 1) open.add('p:' + g.machine.id + '|' + g.projects[0].cwd)
    for (const p of g.projects) if (open.has('p:' + g.machine.id + '|' + p.cwd)) loadSearchSessions(g.machine.id, p.cwd)
  }
}

function toggleSearch(key, load) {
  const { open } = app.search
  if (open.has(key)) open.delete(key)
  else {
    open.add(key)
    // A machine opened onto its one project shows that project's sessions too
    if (key.startsWith('m:')) followSearch()
    load?.()
  }
  renderList()
}

// The sessions in a project that have matches, a page at a time
async function loadSearchSessions(mid, cwd, more = false) {
  const key = mid + '|' + cwd
  const q = app.search.q
  const have = app.search.sessions.get(key)
  const offset = more ? (have?.sessions.length ?? 0) : 0
  const r = await fetch(`/api/machines/${mid}/search?` + (await askOf({ q, cwd, limit: SEARCH_SESSIONS, offset, subagents: true }))).catch(() => null)
  if (app.search.q !== q) return
  if (!r?.ok) return void (app.search.sessions.set(key, { q, sessions: [], total: 0, failed: true }), renderList())
  const data = await r.json()
  const sessions = [...(more ? have.sessions : []), ...data.sessions]
  app.search.sessions.set(key, { q, sessions, total: data.total })
  if (sessions.length === 1) app.search.open.add('s:' + mid + '|' + sessions[0].id)
  for (const s of data.sessions) if (app.search.open.has('s:' + mid + '|' + s.id)) loadSearchHits(mid, s.id)
  renderList()
}

// The matches in a session, a page at a time
async function loadSearchHits(mid, sid, more = false) {
  const key = mid + '|' + sid
  const q = app.search.q
  const have = app.search.hits.get(key)
  const offset = more ? (have?.hits.length ?? 0) : 0
  // (which session is in what is sealed for the machine with the rest: it reads nothing beside that)
  const r = await fetch(`/api/machines/${mid}/sessions/${encodeURIComponent(sid)}/search?` + (await askOf({ q, sid, limit: SEARCH_HITS, offset, subagents: true }))).catch(() => null)
  if (app.search.q !== q) return
  if (!r?.ok) return void (app.search.hits.set(key, { q, hits: [], total: 0, failed: true }), renderList())
  const data = await r.json()
  app.search.hits.set(key, { q, hits: [...(more ? have.hits : []), ...data.hits], total: data.total })
  renderList()
}

const SEARCH_SESSIONS = 30
const SEARCH_HITS = 20
const count = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

// Machines with matches, then a machine's projects, a project's sessions, a session's matches
function searchNodes() {
  const { data, open, q } = app.search
  if (!data) return [h('div', { class: 'list-empty' }, 'Searching…')]
  if (data.short) return [h('div', { class: 'list-empty' }, 'Keep typing: a search takes two letters or more.')]
  if (data.locked) return [h('div', { class: 'list-empty' }, 'Your sessions are end-to-end encrypted, and so is what you search them for: type your passphrase under Account first.')]
  const nodes = []
  // A row that opens onto what's under it
  const branch = (depth, key, load, title, label, tally) => {
    const isOpen = open.has(key)
    return h(
      'button',
      { type: 'button', class: 'project branch', 'data-depth': depth, 'aria-expanded': String(isOpen), title, onclick: () => toggleSearch(key, load) },
      h('span', { class: 'project-mark', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
      ...label,
      h('span', { class: 'row-time' }, tally),
    )
  }
  const note = (depth, text) => h('div', { class: 'list-empty branch-note', 'data-depth': depth }, text)
  for (const g of data.machines) {
    const mid = g.machine.id
    nodes.push(branch(0, 'm:' + mid, null, null, [h('span', { class: 'project-name' }, whereLabel(g.machine.name, mid))], `${count(g.hits, 'result')} in ${count(g.sessions, 'session')}`))
    if (!open.has('m:' + mid)) continue
    // Two folders can share a name: then where each is tells them apart
    const names = new Map()
    for (const p of g.projects) names.set(p.name, (names.get(p.name) ?? 0) + 1)
    for (const p of g.projects) {
      const pk = mid + '|' + p.cwd
      const where = names.get(p.name) > 1 ? h('span', { class: 'project-where' }, ' ' + p.cwd.slice(0, -p.name.length - 1)) : null
      nodes.push(branch(1, 'p:' + pk, () => loadSearchSessions(mid, p.cwd), p.cwd, [h('span', { class: 'project-name' }, p.name || 'No folder', where)], `${p.hits} in ${count(p.sessions, 'session')}`))
      if (!open.has('p:' + pk)) continue
      const found = app.search.sessions.get(pk)
      if (!found) nodes.push(note(2, 'Reading the sessions…'))
      else if (found.failed) nodes.push(note(2, "The machine didn't answer."))
      for (const s of found?.sessions ?? []) {
        const sk = mid + '|' + s.id
        const label = [isReporting(s.id) ? h('span', { class: 'dot live', title: 'Live' }) : null, h('span', { class: 'project-name session-name' }, markOf(s.id)?.name || s.title)]
        nodes.push(branch(2, 's:' + sk, () => loadSearchHits(mid, s.id), s.gone ? "Only its subagents' transcripts are left" : s.topic || s.title, label, `${s.hits} · ${ago(s.lastHit)}`))
        if (!open.has('s:' + sk)) continue
        const hits = app.search.hits.get(sk)
        if (!hits) nodes.push(note(3, 'Reading the results…'))
        else if (hits.failed) nodes.push(note(3, "The machine didn't answer."))
        for (const hit of hits?.hits ?? []) {
          const to = `#/m/${mid}/${encodeURIComponent(s.id)}?at=${encodeURIComponent(hit.uuid)}` + (hit.subagent ? '&sub=' + hit.subagent : '')
          nodes.push(h('a', { class: 'hit', 'data-depth': 3, href: to }, h('span', { class: 'hit-role' }, HIT_ROLES[hit.role] ?? hit.role, hit.subagent ? ' (subagent)' : ''), ...marked(hit.snippet)))
        }
        if (hits && hits.total > hits.hits.length) nodes.push(h('button', { type: 'button', class: 'more-link', 'data-depth': 3, onclick: () => loadSearchHits(mid, s.id, true) }, `${hits.total - hits.hits.length} more…`))
      }
      if (found && found.total > found.sessions.length) nodes.push(h('button', { type: 'button', class: 'more-link', 'data-depth': 2, onclick: () => loadSearchSessions(mid, p.cwd, true) }, `${count(found.total - found.sessions.length, 'more session')}…`))
    }
  }
  if (!data.machines.length) nodes.push(h('div', { class: 'list-empty' }, data.failed ? 'The search could not be run.' : 'Nothing found.'))
  const notes = []
  if (data.unreachable?.length) notes.push('Not searched (offline): ' + data.unreachable.join(', '))
  if (data.indexing) notes.push(`Still indexing ${data.indexing} files; more may turn up.`)
  if (!app.machines.size) notes.push('Search covers machines running the ManyClaws agent; none is connected.')
  for (const n of notes) nodes.push(h('div', { class: 'list-empty' }, n))
  return nodes
}

const HIT_ROLES = { user: 'You', assistant: 'Claude', tool: 'Ran', result: 'Output' }

// A snippet from the index, its matches between \u0001 and \u0002
function marked(snippet) {
  const out = []
  for (const part of snippet.split(/(\u0001[^\u0002]*\u0002)/)) {
    if (part.startsWith('\u0001')) out.push(h('mark', null, part.slice(1, -1)))
    else if (part) out.push(part)
  }
  return out
}

// ---- A past session: read from its transcript on the machine, a page at a time.
// A reply resumes it there.

const PAST_ROWS = 200
const FOLLOW_ROWS = 60 // lines read again to see what a running session has written since

async function openPast(mid, sid, { at = '', sub = '' } = {}) {
  clearInterval(pastTimer)
  leaveView()
  app.current = null
  document.body.classList.add('chat-open')
  el('empty').hidden = true
  el('chat').hidden = false
  el('requests').hidden = true
  el('attention').hidden = true
  // Kept from the last look at it, it's put back, unless a search hit points at a place it doesn't have
  const key = `m:${mid}/${sid}/${sub}`
  const kept = app.views.get(key)
  if (kept && (!at || kept.nodes.some((n) => isAt(n, at)))) {
    app.past = kept.past
    app.past.at = at
    const left = enterView(key)
    renderChips()
    showDraft()
    renderList()
    renderPastHeader()
    if (!showFound(at)) el('messages').scrollTop = el('messages').scrollHeight - left
    pastTimer = setInterval(followPast, 5000)
    // What's been written since it was put away
    return followPast({ sure: true })
  }
  app.views.delete(key)
  const p = (app.past = { mid, sid, at, sub, from: 0, to: 0, session: null, loaded: false })
  el('messages').replaceChildren(h('div', { class: 'msg notice' }, 'Reading the transcript…'))
  renderChips()
  showDraft()
  renderList()
  renderPastHeader()
  const page = await pastPage({ around: at })
  if (!page) return
  el('messages').replaceChildren(...pastNodes(page))
  p.loaded = true
  watchEarlier()
  // The place a search hit pointed at, or the end
  if (!showFound(at)) scrollToEnd()
  refoldSoon()
  // One that's open in a Claude Code on the machine is still being written: follow it
  pastTimer = setInterval(followPast, 5000)
}

// A row a search hit points at: the line it's drawn from, or the call whose result the line carries
const isAt = (node, uuid) => !!node.dataset && (node.dataset.uuid === uuid || node.dataset.result === uuid)

function showFound(at) {
  const box = el('messages')
  for (const node of box.querySelectorAll('.msg.found')) node.classList.remove('found')
  const hit = at && [...box.querySelectorAll('.msg')].find((n) => isAt(n, at))
  if (!hit) return false
  hit.classList.add('found')
  hit.scrollIntoView({ block: 'center' })
  return true
}

async function pastPage({ around = '', before } = {}) {
  const p = app.past
  // (which session, and where in it, are in the one thing sealed for the machine: it reads nothing beside that.
  // Where this device has no key there is nothing to ask with, and that is said.)
  if (!app.key) {
    el('messages').replaceChildren(h('div', { class: 'msg notice' }, NO_KEY_MACHINE))
    return null
  }
  const r = await fetch(`/api/machines/${p.mid}/sessions/${encodeURIComponent(p.sid)}/messages?` + (await askOf({ sid: p.sid, limit: PAST_ROWS, around: around || undefined, before, subagent: p.sub ? Number(p.sub) : undefined }))).catch(() => null)
  if (r?.status === 401) return showLogin()
  if (app.past !== p) return null
  if (!r?.ok) {
    const { error } = (await r?.json().catch(() => ({}))) ?? {}
    el('messages').replaceChildren(h('div', { class: 'msg notice' }, 'This session could not be read: ' + (error ?? 'the server did not answer') + '.'))
    return null
  }
  const page = await r.json()
  if (before === undefined) p.to = page.to
  p.from = before === undefined ? page.from : Math.min(p.from, page.from)
  p.total = page.total
  p.session = page.session ?? p.session
  renderPastHeader()
  return page
}

// A page's rows as nodes, with a way to the page before it. A row that's drawn already
// is left as it is, so a page read again adds only what's new in it; a result fills
// its call, on this page or one drawn before.
function pastNodes(page, { follow = false } = {}) {
  const nodes = []
  if (page.from > 0 && !follow) nodes.push(h('button', { type: 'button', class: 'earlier', onclick: loadEarlier }, 'Earlier messages…'))
  // A line of the transcript can make several rows: they're told apart by their order in it
  const seen = new Map()
  for (const m of page.messages) {
    const nth = seen.get(m.uuid + m.role) ?? 0
    seen.set(m.uuid + m.role, nth + 1)
    const key = (m.role === 'tool' || m.role === 'result') && m.toolUseId ? m.role + ':' + m.toolUseId : `${m.uuid}:${m.role}:${nth}`
    if (app.rowKeys.has(key)) continue
    app.rowKeys.add(key)
    if (m.role === 'result') {
      attachResult(m)
      continue
    }
    const node = renderMessage(m)
    if (m.uuid) node.dataset.uuid = m.uuid
    nodes.push(node)
  }
  return nodes
}

async function loadEarlier() {
  const p = app.past
  if (!p || app.loadingEarlier) return
  app.loadingEarlier = true
  try {
    const page = await pastPage({ before: p.from })
    if (!page) return
    const box = el('messages')
    const fromEnd = box.scrollHeight - box.scrollTop
    box.querySelector('.earlier')?.remove()
    box.prepend(...pastNodes(page))
    watchEarlier()
    box.scrollTop = box.scrollHeight - fromEnd
    refoldSoon()
  } finally {
    app.loadingEarlier = false
  }
}

// What has been written since the page was read: the last lines are read again, and
// the rows not drawn yet are added. `sure`: look even if the session wasn't open when last seen.
async function followPast({ sure = false } = {}) {
  const p = app.past
  if (!p?.loaded || document.hidden || p.sub || (!sure && !p.session?.open)) return
  const r = await fetch(`/api/machines/${p.mid}/sessions/${encodeURIComponent(p.sid)}/messages?` + (await askOf({ sid: p.sid, limit: FOLLOW_ROWS }))).catch(() => null)
  if (!r?.ok || app.past !== p) return
  const page = await r.json()
  p.session = page.session ?? p.session
  if (page.to === p.to && page.total === p.total) return renderPastHeader()
  // Rewound or rewritten under this page, or more was written than this look back covers: it's read afresh
  if (page.to < p.to || page.from > p.to) {
    p.loaded = false
    return openPast(p.mid, p.sid, { sub: p.sub })
  }
  const box = el('messages')
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  box.append(...pastNodes(page, { follow: true }))
  p.to = page.to
  p.total = page.total
  renderPastHeader()
  if (nearEnd) scrollToEnd()
  refoldSoon()
}

function renderPastHeader() {
  const p = app.past
  if (!p) return
  const s = p.session
  const m = app.machines.get(p.mid)
  const live = isReporting(p.sid)
  const mark = p.sub ? null : markOf(p.sid)
  put(el('chat-name'), (mark?.name || (s?.title ?? 'Session ' + p.sid.slice(0, 8))) + (p.sub ? ' — a subagent' : ''), labelChip(mark))
  el('chat-name').title = mark?.name ? (s?.title ?? '') : ''
  put(el('chat-sub'), dotted(whereLabel(machineName(m), p.mid), s?.cwd, prettyModel(s?.model), s?.messages ? s.messages + ' messages' : '', s?.lastActivity ? 'last active ' + time(s.lastActivity) : ''))
  el('chat-sub').title = el('chat-sub').textContent
  renderStar()
  const badge = el('chat-state')
  // Open in a terminal or an editor there, where this page can't reach it
  const elsewhere = !!s?.open && !s.hosted && !live
  badge.className = 'badge ' + (live || s?.hosted ? 'working' : elsewhere ? 'idle' : '')
  badge.textContent = live || s?.hosted ? 'Running' : elsewhere ? 'Open on the machine' : 'Not running'
  if (phoneLayout()) el('chat-sub').prepend(badge.textContent + ' · ')
  for (const id of ['stop', 'release', 'remove', 'attention', 'requests', 'agents']) el(id).hidden = true
  setWorking(false)
  banner.remove()
  renderFootOptions(null)

  // A reply resumes it, where the machine allows that
  let note = ''
  if (p.sub) note = "This is a subagent's own conversation. Replies go to the session it worked for."
  else if (s?.gone) note = "This session's own transcript is no longer on the machine; only its subagents' are. It can be searched, not resumed."
  else if (live || s?.hosted) note = 'This session is running. A reply goes to it.'
  else if (!m?.online) note = `${machineName(m)} is offline. A session there can be read and resumed when it's back.`
  else if (!m.spawn) note = `Starting sessions is turned off on ${machineName(m)}, so this one can be read but not resumed from here.`
  else if (elsewhere) note = 'This session is open in Claude Code on the machine. Reply there, or continue it here in a copy.'
  else note = `A reply resumes this session on ${machineName(m)}.`
  const canReply = !p.sub && !s?.gone && (live || (!!m?.online && !!m.spawn))
  // A reply that starts Claude Code again says what it may do without asking
  renderResumeMode(canReply && !live && !s?.hosted ? m : null, s)
  el('composer-note').textContent = note
  el('composer-note').hidden = false
  el('composer').hidden = !canReply
  el('input').disabled = !canReply
  el('send').disabled = !canReply
  el('attach').hidden = true
  el('input').placeholder = live || s?.hosted ? 'Reply to Claude…' : elsewhere ? 'Continue in a copy…' : 'Reply to resume this session…'
}

// The permission mode a relaunched session starts in: the one picked here, else the one
// it was last in (as its transcript says, or as it last reported), else the one last
// picked on this device, as far as the machine allows them
function resumeMode(m, s) {
  const allowed = m?.spawn?.modes?.length ? m.spawn.modes : ['default']
  let last = null
  try {
    last = localStorage.getItem('mc.resumeMode')
  } catch {}
  const picked = app.resumePick?.sid === draftKey() ? app.resumePick.mode : null
  return [picked, s?.mode || modeOf(s), last, 'default'].find((mode) => allowed.includes(mode)) ?? allowed[0]
}

// The picker for it, where the session's own mode shows while it runs
function renderResumeMode(m, s) {
  const box = el('foot-mode')
  if (!m) {
    box.replaceChildren()
    box.removeAttribute('title')
    delete box.dataset.modes
    el('composer').dataset.permissionMode = 'default'
    return
  }
  const mode = resumeMode(m, s)
  el('composer').dataset.permissionMode = mode
  const pick = (to) => {
    app.resumePick = { sid: draftKey(), mode: to }
    try {
      localStorage.setItem('mc.resumeMode', to)
    } catch {}
    if (app.past) renderPastHeader()
    else renderHeader()
  }
  modePicker({ id: 'resume-mode', allowed: m.spawn?.modes?.length ? m.spawn.modes : ['default'], mode, title: 'What the session may do without asking, once it starts again', onPick: pick })
}

// A choice of permission mode beside the reply box
function modePicker({ id, allowed, mode, title, onPick }) {
  const box = el('foot-mode')
  app.modeMenu = { mode, allowed, onPick }
  // Drawn already: drawing it again would shut it under a finger
  const drawn = [id, allowed.join(','), mode].join('|')
  if (box.dataset.modes === drawn) return void drawFootMenu()
  box.dataset.modes = drawn
  box.removeAttribute('title')
  const select = h('select', { id, class: 'resume-mode for-terminal', title, 'aria-label': 'Permission mode', onchange: (ev) => onPick(ev.target.value) }, ...allowed.map((x) => h('option', { value: x }, PERMISSION_MODES[x]?.[0] ?? x)))
  select.value = mode
  box.replaceChildren(select, modeButton(mode, title))
  drawFootMenu()
}

// The mode of a session the machine's agent is running, changed as it runs. Refused
// (the machine doesn't allow it, the model doesn't have it), the reason is shown and
// the picker goes back to what the session is in.
async function setSessionMode(s, mode) {
  // (which mode is in an order for the machine, signed here: where this device cannot sign, nothing is sent)
  const order = await orderFor(s.machine, 'mode', { sid: s.id, mode })
  const r = order ? await fetch(`/api/machines/${s.machine}/sessions/${encodeURIComponent(s.id)}/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }) }).catch(() => null) : null
  if (r?.ok) return void (app.modeError = null)
  const { error } = order ? ((await r?.json().catch(() => ({}))) ?? {}) : { error: NO_KEY }
  app.modeError = { sid: s.id, text: 'The mode was not changed: ' + (error ?? 'the machine did not answer') + '.', until: Date.now() + 15_000 }
  delete el('foot-mode').dataset.modes
  if (app.current === s.id) renderHeader()
}

// A reply to a past session: the machine's agent starts Claude Code on it again. One
// that's open in a terminal there is continued in a copy instead.
async function resumePast(text) {
  const p = app.past
  const node = userNode([text], { note: 'resuming on ' + machineName(app.machines.get(p.mid)) + '…', pending: true })
  el('messages').append(node)
  scrollToEnd()
  el('input').value = ''
  autosize()
  keepDraft()
  // (which machine it is, and what it allows, is known once the stream has said)
  await snapshotSeen
  const m = app.machines.get(p.mid)
  const mode = resumeMode(m, p.session)
  const fork = !!p.session?.open && !p.session.hosted && !isReporting(p.sid)
  // The reply goes signed, and nothing beside it: for the machine, to open the session
  // with it; or, where the session is running after all, for the session (one order and
  // not both: either would be run by whoever was handed it)
  const signed = isReporting(p.sid) && !fork ? { reply: await promptOrder(p.sid, p.mid, !!app.sessions.get(p.sid)?.hosted, { text, mode }) } : { order: await orderFor(p.mid, 'open', { sid: p.sid, prompt: text, mode, fork }) }
  // (where this device cannot sign, nothing is sent)
  const unsigned = !signed.reply && !signed.order
  const r = unsigned ? null : await fetch(`/api/machines/${p.mid}/sessions/${encodeURIComponent(p.sid)}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) }).catch(() => null)
  const data = unsigned ? { error: NO_KEY } : ((await r?.json().catch(() => ({}))) ?? {})
  if (!r?.ok) {
    node.querySelector('.from').textContent = 'not sent: ' + (data.error ?? r?.status ?? 'the server did not answer')
    // What was typed goes back where it can be sent again
    if (app.past === p && !el('input').value) {
      el('input').value = text
      autosize()
      keepDraft()
    }
    return
  }
  // It goes on as a session that reports: the reply isn't part of the transcript's page
  node.remove()
  app.expect = { sid: data.sid, mid: p.mid, until: Date.now() + 40_000 }
  location.hash = '#/s/' + encodeURIComponent(data.sid)
}

// A session just started or resumed takes a moment to report. If it never does (the
// ManyClaws mod isn't loaded there), its transcript on the machine is the way to follow it.
function awaitSession(id) {
  const e = app.expect
  const box = el('messages')
  // (one the account has kept or put something on, which only its machine has now, is read from there: a reminder's notification opens it this way)
  const kept = e?.sid === id ? null : (app.favorites.find((f) => f.id === id) ?? markOf(id))
  if (kept?.machine && app.machines.has(kept.machine)) return void location.replace(`#/m/${kept.machine}/${encodeURIComponent(id)}`)
  if (e?.sid !== id) {
    box.replaceChildren(h('div', { class: 'msg notice' }, 'This session is not known here. It may have been removed.'))
    return
  }
  el('composer').hidden = true
  if (!box.querySelector('.starting')) box.replaceChildren(h('div', { class: 'msg notice starting' }, 'Starting on ' + machineName(app.machines.get(e.mid)) + '…'))
  if (Date.now() > e.until) {
    app.expect = null
    location.hash = `#/m/${e.mid}/${encodeURIComponent(id)}`
    return
  }
  setTimeout(() => app.current === id && app.expect?.sid === id && loadMessages(id), 1000)
}

// ---- A new session on a machine

// What a session can be started with. The names are Claude Code's own for its models
// and effort levels; a machine's default is whatever its settings say.
const MODELS = [['', "The machine's default"], ['fable', 'Fable'], ['fable[1m]', 'Fable, 1M context'], ['opus', 'Opus'], ['opus[1m]', 'Opus, 1M context'], ['sonnet', 'Sonnet'], ['sonnet[1m]', 'Sonnet, 1M context'], ['haiku', 'Haiku']]
const EFFORTS = [['', "The machine's default"], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]
const OTHER_FOLDER = '::other' // no folder's path

// What was picked last time, on this device: { mode, model, effort, cwd: { <machine>: folder } }
function lastNew() {
  try {
    return JSON.parse(localStorage.getItem('mc.new')) ?? {}
  } catch {
    return {}
  }
}

// Whether a folder is one of the roots or under it, however its machine writes paths
function isUnder(cwd, root) {
  const at = folderKey(cwd)
  const base = folderKey(root).replace(/[\\/]+$/, '')
  return at === base || at.startsWith(base + '/') || at.startsWith(base + '\\')
}

async function openNew(mid) {
  clearInterval(pastTimer)
  leaveView()
  app.current = null
  app.past = null
  // (what that machine allows is known once the stream has said)
  await snapshotSeen
  if (location.hash.split('?')[0] !== '#/new/' + mid) return
  const m = app.machines.get(mid)
  const last = lastNew()
  document.body.classList.add('chat-open')
  el('empty').hidden = true
  el('chat').hidden = true
  el('new').hidden = false
  el('new').dataset.machine = mid
  el('new-title').textContent = 'New session on ' + machineName(m)
  // (where the page is dressed as the site, it opens with which computer this is for: site/account.css)
  el('new-where').textContent = machineName(m)
  el('new-error').hidden = true
  const fill = (select, options, picked) => {
    select.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)))
    if (options.some(([value]) => value === picked)) select.value = picked
  }
  fill(el('new-mode'), (m?.spawn?.modes ?? ['default']).map((mode) => [mode, PERMISSION_MODES[mode]?.[0] ?? mode]), last.mode)
  fill(el('new-model'), MODELS, last.model)
  fill(el('new-effort'), EFFORTS, last.effort)
  el('new-listed').checked = wantsListed()
  el('new-listed-row').title = LISTED_HINT
  const project = el('new-project')
  project.replaceChildren(h('option', { value: '' }, 'Reading the projects…'))
  renderList()
  // The projects there: the folders sessions have run in, the other folders beside
  // them, and the folders the machine allows sessions in themselves
  const r = await readFolders(mid)
  if (el('new').dataset.machine !== mid) return
  const { folders = [], allowed = [], others = [], unread = [] } = r?.ok ? await r.json() : {}
  // A folder the machine couldn't list in time: on a Mac that's a prompt on its screen waiting for an answer
  if (unread.length) {
    el('new-error').textContent = `${machineName(m)} could not list ${unread.join(' or ')}. On a Mac, a prompt asking to let node read it may be waiting on its screen. Its projects with sessions are still here, and "Another folder…" takes any path.`
    el('new-error').hidden = false
  }
  const recent = folders.map((f) => f.cwd).filter((cwd) => allowed.some((root) => isUnder(cwd, root)))
  const listed = new Set(recent.map(folderKey))
  const rest = others.filter((cwd) => !listed.has(folderKey(cwd)))
  const roots = allowed.filter((cwd) => !listed.has(folderKey(cwd)))
  // A project by its name, and where it is
  const option = (cwd) => h('option', { value: cwd }, `${folderName(cwd)}  —  ${cwd.slice(0, -folderName(cwd).length - 1) || cwd}`)
  const group = (label, list, draw = option) => (list.length ? h('optgroup', { label }, ...list.map(draw)) : null)
  project.replaceChildren(
    group('Projects with sessions', recent),
    group('Other folders', rest),
    group('The folders themselves', roots, (cwd) => h('option', { value: cwd }, cwd)),
    h('option', { value: OTHER_FOLDER }, 'Another folder…'),
  )
  const all = [...recent, ...rest, ...roots]
  const before = last.cwd?.[mid]
  project.value = all.find((cwd) => cwd === before) ?? all[0] ?? OTHER_FOLDER
  // A path to add to: the first folder sessions may start in, as that machine writes it
  const root = allowed[0] ?? ''
  el('new-cwd').value = root ? root.replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' : '/') : ''
  el('new-create').checked = false
  showOtherFolder()
  if (!matchMedia('(pointer: coarse)').matches) (project.value === OTHER_FOLDER ? el('new-cwd') : el('new-prompt')).focus()
}

// "Another folder…" asks for its path
function showOtherFolder() {
  el('new-other').hidden = el('new-project').value !== OTHER_FOLDER
}
el('new-project').addEventListener('change', () => {
  showOtherFolder()
  if (!el('new-other').hidden) el('new-cwd').focus()
})

el('new-listed').addEventListener('change', () => keepListed(el('new-listed').checked))

el('new-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const mid = el('new').dataset.machine
  const other = el('new-project').value === OTHER_FOLDER
  const cwd = other ? el('new-cwd').value.trim() : el('new-project').value
  const picked = { mode: el('new-mode').value, model: el('new-model').value, effort: el('new-effort').value }
  el('new-error').hidden = true
  // What the computer is to start is signed, and its first prompt goes in the order alone, which the server can't
  // read. Where this device cannot sign, nothing is sent.
  const order = await orderFor(mid, 'start', { cwd, prompt: el('new-prompt').value, ...picked, create: other && el('new-create').checked, listed: el('new-listed').checked })
  const r = order ? await fetch(`/api/machines/${mid}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }) }).catch(() => null) : null
  const data = order ? ((await r?.json().catch(() => ({}))) ?? {}) : { error: NO_KEY_MACHINE }
  if (!r?.ok) {
    el('new-error').textContent = data.error ?? 'The session could not be started.'
    el('new-error').hidden = false
    return
  }
  try {
    const last = lastNew()
    localStorage.setItem('mc.new', JSON.stringify({ ...picked, cwd: { ...last.cwd, [mid]: cwd } }))
  } catch {}
  buzz()
  el('new-prompt').value = ''
  app.expect = { sid: data.sid, mid, until: Date.now() + 40_000 }
  location.hash = '#/s/' + encodeURIComponent(data.sid)
})

// ---- Chat header

function renderHeader() {
  const s = app.sessions.get(app.current)
  if (!s) return
  const mark = markOf(s.id)
  put(el('chat-name'), nameOf(s), labelChip(mark))
  const ctx = typeof s.contextPercent === 'number' ? `context ${s.contextPercent}%` : null
  // (one given a name here still says what it calls itself, to whoever points at the name)
  el('chat-name').title = mark?.name ? s.title : (s.topic ?? '')
  const mode = modeOf(s) && modeOf(s) !== 'default' ? modeOf(s) + ' mode' : null
  const effort = s.effort ? 'effort ' + s.effort : null
  put(el('chat-sub'), dotted(phoneLayout() ? STATE_LABEL[s.state] : null, '🔒 end-to-end encrypted', whereLabel(whereOf(s), s.machine), s.cwd, s.model, mode, effort, ctx, s.account?.email))
  el('chat-sub').title = el('chat-sub').textContent
  renderStar()
  const badge = el('chat-state')
  badge.className = 'badge ' + s.state
  badge.textContent = STATE_LABEL[s.state]
  badge.title = s.ended && s.endReason ? `Claude Code exited (${s.endReason})` : ''
  const stoppable = s.attended && (s.state === 'working' || s.state === 'attention')
  if (!stoppable && app.stopping?.sid === s.id) app.stopping = null
  const stopping = app.stopping?.sid === s.id
  el('stop').hidden = !stoppable
  el('stop').disabled = stopping
  el('stop').textContent = stopping ? 'Stopping…' : 'Stop'
  // The terminal's own words for it, where there's a key to press
  working.lastChild.hidden = !stoppable || matchMedia('(pointer: coarse)').matches
  el('remove').hidden = s.online
  // One the machine's agent is running can be handed back to the machine
  el('release').hidden = !(s.hosted && s.machine && s.online)
  // (a prompt the session is set to ask in its own app alone is not one to answer here: the page says where it is asked)
  const answerable = (s.pendingRequests ?? []).some((r) => r.route !== 'local')
  el('attention').hidden = s.state !== 'attention' || answerable
  el('attention').textContent = '⚠ ' + (s.detail || 'Claude is waiting for you') + ` — answer it in ${appName(s)}.`
  renderRequests(s)
  renderAgents(s)
  renderBanner(s)
  setWorking(s.state === 'working')

  // The session's permission mode. One the machine's agent is running can be switched
  // from here, to a mode the machine allows, as an editor switches the one it hosts.
  // One running in a terminal or an editor is switched there: a mod can't set it.
  const inMode = modeOf(s) ?? 'default'
  const m = app.machines.get(s.machine)
  const modes = m?.spawn?.modes ?? []
  // One that has exited is started again by a reply, where its machine's agent can do
  // that: in the mode picked here, as one opened from its transcript is
  const resumes = s.ended && !!m?.online && !!m.spawn
  el('composer').dataset.permissionMode = inMode
  if (resumes) {
    renderResumeMode(m, s)
  } else if (s.hosted && s.online && !s.ended && modes.length) {
    modePicker({ id: 'session-mode', allowed: modes.includes(inMode) ? modes : [inMode, ...modes], mode: inMode, title: 'What this session may do without asking. A change takes effect at once.', onPick: (to) => setSessionMode(s, to) })
  } else {
    // (drawn already: drawing it again would take the button from under a finger)
    const drawn = 'shown|' + inMode + '|' + s.ended
    app.modeMenu = { mode: inMode, allowed: [], onPick: null }
    if (el('foot-mode').dataset.modes !== drawn) {
      el('foot-mode').dataset.modes = drawn
      const inTerminal = (PERMISSION_MODES[inMode] ?? PERMISSION_MODES.default)[1]
      el('foot-mode').replaceChildren(h('span', { class: 'for-terminal' }, inTerminal), modeButton(inMode))
      el('foot-mode').title = s.ended ? '' : 'The mode this session is in. It is changed where the session runs (shift+tab in a terminal, the mode button in an editor).'
    }
  }
  // (one that has exited has no model or effort of its own until it runs again)
  renderFootOptions(resumes ? null : s)

  let note = ''
  if (resumes) note = `A reply resumes this session on ${machineName(m)}.`
  else if (s.ended && !m) note = 'This session is not running. Its computer has no ManyClaws agent, so it can be read but not resumed from here.'
  else if (s.ended && !m.online) note = `${machineName(m)} is offline. This session can be resumed when it's back.`
  else if (s.ended) note = `Starting sessions is turned off on ${machineName(m)}, so this one can be read but not resumed from here.`
  else if (!s.attended) note = 'This is a headless session (claude -p or an SDK script): you can follow it but not reply.'
  else if (!s.online) note = 'This session is offline. A reply waits until it reconnects.'
  else if (app.modeError?.sid === s.id && Date.now() < app.modeError.until) note = app.modeError.text
  el('composer-note').textContent = note
  el('composer-note').hidden = !note
  const canSend = s.ended ? resumes : s.attended
  el('input').disabled = !canSend
  el('send').disabled = !canSend
  el('composer').hidden = !canSend
  el('attach').hidden = false
  el('input').placeholder = resumes ? 'Reply to resume this session…' : 'Reply to Claude…'
}

// Stop interrupts the turn. The button says it was taken until the session shows the turn
// is over, or for a few seconds when it doesn't, and can then be pressed again.
async function stop() {
  const sid = app.current
  if (!sid || app.stopping?.sid === sid) return
  const mine = (app.stopping = { sid })
  const over = () => {
    if (app.stopping !== mine) return
    app.stopping = null
    if (app.current === sid) renderHeader()
  }
  renderHeader()
  setTimeout(over, 5000)
  const r = await post('/interrupt').catch(() => null)
  if (!r?.ok) over()
}
el('stop').addEventListener('click', stop)

// Escape is Stop's key, as in a terminal: wherever Stop is there to press. In a field
// other than the reply box the key is that field's, and what's open over the chat (the
// whole prompt, the ⋯ menu) is shut by it first.
// A box open over the whole page (a new session, a session's mark, a file) is shut by the key
// itself, by the browser, and the key goes no further: not to Stop behind the box,
// wherever in the box, or on nothing at all, the key was pressed.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || ev.defaultPrevented || ev.repeat || ev.isComposing || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return
  if (document.querySelector('dialog[open]')) return
  if (ev.target !== el('input') && ev.target.closest?.('input, textarea, select')) return
  if (app.footMenu) return void closeFootMenu()
  const opened = [el('pinned'), el('more')].find((x) => x.offsetParent && (x.classList.contains('open') || x.getAttribute('aria-expanded') === 'true'))
  if (opened) return void opened.click()
  const button = el('stop')
  if (!button.offsetParent || button.disabled) return
  ev.preventDefault()
  stop()
})
el('release').addEventListener('click', async () => {
  const s = app.sessions.get(app.current)
  if (!s?.machine) return
  await fetch(`/api/machines/${s.machine}/sessions/${encodeURIComponent(s.id)}/stop`, { method: 'POST' })
})

// The permission modes, as VS Code names them and as a terminal says them under its
// prompt, with what VS Code's menu says of each
const PERMISSION_MODES = {
  default: ['Manual', '⏸\uFE0E manual mode on', 'Claude will ask for approval before making each edit'],
  acceptEdits: ['Edit automatically', '⏵⏵ accept edits on', 'Claude will edit your selected text or the whole file'],
  plan: ['Plan', '⏸\uFE0E plan mode on', 'Claude will explore the code and present a plan before editing'],
  auto: ['Auto', '⏵⏵ auto mode on', 'Claude will approve actions that pass a safety check and pause for anything risky'],
  bypassPermissions: ['Bypass permissions', '⏵⏵ bypass permissions on', 'Claude will not ask for approval before running potentially dangerous commands'],
  dontAsk: ["Don't ask", "⏵⏵ don't ask on", 'Claude will not ask: what it has not been allowed already is refused'],
}

// Text that differs by look: both are drawn, and the stylesheet shows one
function both(inVscode, inTerminal) {
  if (inVscode === inTerminal) return [inVscode]
  return [h('span', { class: 'for-vscode' }, inVscode), h('span', { class: 'for-terminal' }, inTerminal)]
}

// ---- A session's model and effort, shown and set the way VS Code and a terminal do it
//
// VS Code has the model and its effort in a pill by the reply box, and the effort's
// slider in the menu of modes. A terminal says the effort under the prompt
// ("◉ xhigh · /effort") and opens a picker for /model and for /effort. Here the pill and
// those words open the same, and so does typing /model or /effort on its own.
// A pick is the session's own command, run in it. Claude Code keeps one made in a
// terminal's session as that computer's default for new sessions, as it does when the
// command is typed there; in a session an app or the agent hosts it is the session's alone.

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_MARKS = { low: '○', medium: '◐', high: '●', xhigh: '◉', max: '◈' }
// (what Claude Code says of each when it is set)
const EFFORT_SAYS = {
  low: 'Quick, straightforward implementation with minimal overhead',
  medium: 'Balanced approach with standard implementation and testing',
  high: 'Comprehensive implementation with extensive testing and documentation',
  xhigh: 'Deeper reasoning than high, just below maximum',
  max: 'Maximum capability with deepest reasoning. May use excessive tokens. This session only',
}
const effortName = (level) => EFFORTS.find(([value]) => value === level)?.[1] ?? level
// The models a session's settings list, by what a terminal's picker calls them
const MODEL_SAYS = {
  default: ['Default (recommended)', 'What Claude Code recommends for your account'],
  best: ['Best', 'The most capable model you have'],
  fable: ['Fable', 'For your toughest challenges'],
  opus: ['Opus', 'For complex work and everyday tasks'],
  sonnet: ['Sonnet', 'Most efficient for simpler tasks'],
  haiku: ['Haiku', 'Fastest for quick answers'],
  opusplan: ['Opus Plan', 'Opus while planning, Sonnet for the rest'],
}
function modelChoice(alias) {
  const wide = /^(.*)\[1m\]$/.exec(alias)
  const [title, says] = MODEL_SAYS[wide ? wide[1] : alias] ?? [alias, '']
  return wide ? [title + ', 1M context', 'The same, with a context window of a million tokens'] : [title, says]
}

// VS Code's icons for the modes and the effort, near enough
const ICONS = {
  default: 'M7.5 9.5v-5a1.25 1.25 0 0 1 2.5 0v4.25m0-5.25a1.25 1.25 0 0 1 2.5 0V8.75m0-3.75a1.25 1.25 0 0 1 2.5 0v5.5c0 4-2 6.5-5.25 6.5-2.3 0-3.7-1-4.9-3.1L3.4 11.3a1.2 1.2 0 0 1 2.05-1.25L7.5 12.5',
  acceptEdits: 'M7 6.5 3.5 10 7 13.5M13 6.5l3.5 3.5-3.5 3.5M11.25 4.5l-2.5 11',
  plan: 'M5.5 3.5h7a2 2 0 0 1 2 2v9a2 2 0 0 0 2 2h-9a2 2 0 0 1-2-2v-11Zm3 4h3m-3 3h3',
  auto: 'M11 2.5 4.5 11h4.75L8.5 17.5 15.5 9h-4.75L11 2.5Z',
  bypassPermissions: 'M3 6.5h7m5 0h2M12.5 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM3 13.5h2m5 0h7M7.5 11.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  effort: 'M2.5 10h2m11 0h2M4.5 6.5v7M7.5 5v10m5-10v10m3-8.5v7M7.5 10h5',
  // (the settings' own, under the list)
  gear: 'M8.61 4.42 8.86 2.38 11.14 2.38 11.39 4.42 12.96 5.07 14.58 3.81 16.19 5.42 14.93 7.04 15.58 8.61 17.62 8.86 17.62 11.14 15.58 11.39 14.93 12.96 16.19 14.58 14.58 16.19 12.96 14.93 11.39 15.58 11.14 17.62 8.86 17.62 8.61 15.58 7.04 14.93 5.42 16.19 3.81 14.58 5.07 12.96 4.42 11.39 2.38 11.14 2.38 8.86 4.42 8.61 5.07 7.04 3.81 5.42 5.42 3.81 7.04 5.07ZM12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  autoApprove: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3.25V10l2.25 1.5',
  // (on a session's row, the way to the box its mark is set in: the pencil the open session's head has, in index.html)
  pencil: 'M4 16l.9-3.6 8.4-8.4a1.5 1.5 0 0 1 2.1 0l.6.6a1.5 1.5 0 0 1 0 2.1l-8.4 8.4zM11.9 5.4l2.7 2.7',
  // (the eye in the passphrase's box: open where pressing it shows what is typed, struck through where it hides it)
  eye: 'M2.25 10S5 4.75 10 4.75 17.75 10 17.75 10 15 15.25 10 15.25 2.25 10 2.25 10Zm7.75-2.4a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z',
  eyeOff: 'M2.25 10S5 4.75 10 4.75 17.75 10 17.75 10 15 15.25 10 15.25 2.25 10 2.25 10Zm7.75-2.4a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8ZM4 3.5l12 13',
}
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  for (const [k, v] of Object.entries({ class: 'menu-icon', viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v)
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', ICONS[name] ?? ICONS.bypassPermissions)
  svg.append(path)
  return svg
}

// A node's children put in place of what it had (an h() for one that is there already: what is null is left out)
const put = (node, ...children) => node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false))

// Whether a session's model and effort can be set from here: it is running and reachable,
// and its computer lets the page run commands in it
const canSetOptions = (s) => !!s && !app.past && !!s.online && !s.ended && (s.attended || s.hosted) && (s.capabilities ?? []).includes('chat')
// The one asked for and not yet shown by the session, if it is of this kind
const asked = (s, kind) => (s && app.setting?.sid === s.id && app.setting.kind === kind ? app.setting.value : null)

// VS Code's button for the mode: the menu of modes opens from it, with the effort under them
function modeButton(mode, title) {
  return h('button', { type: 'button', id: 'foot-modes', class: 'mode-btn for-vscode', title, 'aria-label': 'Mode: ' + (PERMISSION_MODES[mode]?.[0] ?? mode), 'aria-haspopup': 'true', 'aria-expanded': String(app.footMenu?.kind === 'modes'), onclick: () => openFootMenu('modes') }, icon(mode), h('span', null, PERMISSION_MODES[mode]?.[0] ?? mode))
}

// By the reply box: the model and its effort in VS Code's pill, and as a terminal says
// them under its prompt. Nothing of them for a session that isn't running.
function renderFootOptions(s) {
  const pill = el('foot-model')
  const hint = el('foot-effort')
  const live = s && !s.ended && !app.past ? s : null
  if (app.setting && (!live || app.setting.sid !== live.id)) app.setting = null
  const can = canSetOptions(live)
  // (the model by its name alone, as VS Code's pill has it: "Opus 5.5", whatever its context window)
  const name = live ? (asked(live, 'model') ? modelChoice(asked(live, 'model'))[0] : (prettyModel(live.model)?.replace(/ \(1M context\)$/, '') ?? null)) : null
  const level = live ? (asked(live, 'effort') ?? live.effort) : null
  // (drawn already: drawing them again would take them from under a finger)
  const drawn = JSON.stringify([live?.id, name, level, can, !!app.setting])
  if (pill.dataset.drawn !== drawn) {
    pill.dataset.drawn = drawn
    pill.hidden = !name
    pill.disabled = !can
    pill.classList.toggle('pending', !!asked(live, 'model'))
    pill.title = !name ? '' : `${prettyModel(live.model) ?? name}. ` + (can ? 'Press to change the model, or how hard it thinks.' : 'The model this session runs on, and how hard it thinks.')
    put(pill, h('b', null, name ?? ''), level ? h('span', { class: 'for-vscode' + (asked(live, 'effort') ? ' pending' : '') }, effortName(level)) : null, h('span', { class: 'for-terminal foot-hint' }, ' · /model'))
    hint.hidden = !live || (!level && !can)
    hint.disabled = !can
    hint.classList.toggle('pending', !!asked(live, 'effort'))
    hint.title = can ? 'How hard the model thinks. Press to change it.' : 'How hard the model thinks'
    put(hint, level ? `${EFFORT_MARKS[level] ?? '●'} ${level}` : '/effort', level ? h('span', { class: 'foot-hint' }, ' · /effort') : null)
  }
  if (!live && app.footMenu && app.footMenu.kind !== 'modes') app.footMenu = null
  drawAuto(live)
  drawFootMenu()
}

function openFootMenu(kind) {
  app.footMenu = app.footMenu?.kind === kind ? null : { kind }
  drawFootMenu()
  const s = app.sessions.get(app.current)
  if (app.footMenu?.kind === 'model' && s) loadModelRow(s)
  // (a key is next: the first thing in it that can be picked takes it)
  if (app.footMenu && !matchMedia('(pointer: coarse)').matches) el('foot-menu').querySelector('.on:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true })
}

function closeFootMenu() {
  const had = app.footMenu
  app.footMenu = null
  drawFootMenu()
  if (had && !matchMedia('(pointer: coarse)').matches) el('input').focus({ preventScroll: true })
}

// The models of a session, as its own settings list them, and which one it is set to
async function loadModelRow(s) {
  // (a session is asked what only reads in what this device sealed: the server is not told what is asked)
  const c = await sealFor({ method: 'config.list', args: {} })
  if (!c) return
  const r = await sendJson(`/api/sessions/${encodeURIComponent(s.id)}/call`, { c, timeoutMs: 8000 })
  const row = r.ok && Array.isArray(r.data?.value) ? r.data.value.find((x) => x?.key === 'model') : null
  if (!row || !Array.isArray(row.options)) return
  app.modelRows.set(s.id, { value: String(row.value ?? ''), options: row.options.map(String).slice(0, 40) })
  drawFootMenu()
}

// One thing in a menu to pick: an icon (VS Code) or a number (a terminal), what it is
// called, what is said of it, and a tick when it is the one
function menuRow({ title, says, mark, on, pending, disabled, onclick, ...data }) {
  return h(
    'button',
    { type: 'button', class: 'menu-row' + (on ? ' on' : '') + (pending ? ' pending' : ''), role: 'menuitemradio', 'aria-checked': String(!!on), disabled: disabled || undefined, onclick, ...data },
    mark ?? h('span', { class: 'menu-icon' }),
    h('span', { class: 'menu-text' }, h('span', { class: 'menu-title' }, title, on ? h('span', { class: 'menu-tick for-terminal' }, ' ✔') : null), says ? h('span', { class: 'menu-say' }, says) : null),
    on ? h('span', { class: 'menu-tick for-vscode', 'aria-hidden': 'true' }, '✓') : null,
  )
}

// Under the modes, where none of them can be picked. A session that runs in an app (VS
// Code, a terminal) has its mode changed there: a mod can't set it. A clone of it is run
// by a machine's agent, which can, so the way to one is offered: the New session box, as
// the button in the header opens it, with Full context clone the one Enter presses
const MODE_CHANGED_WITH = { 'VS Code': ', with the mode button', 'the terminal': ', with shift+tab' }
function modeNote(s, clones) {
  if (!s || s.hosted) return h('p', { class: 'menu-note' }, 'A session in a terminal or an editor has its mode changed there: shift+tab in a terminal, this menu in an editor.')
  const where = appName(s)
  const clone = () => {
    closeFootMenu()
    openNewBox()
    el('ns-box').querySelector('[data-how="clone"]')?.focus()
  }
  return h(
    'p',
    { class: 'menu-note' },
    `This session runs in ${where}, so its mode is changed there${MODE_CHANGED_WITH[where] ?? ''}.`,
    ...(clones ? [' ', h('button', { type: 'button', class: 'menu-link', onclick: clone }, 'Clone it to a new session'), ` outside ${where === 'its own app' ? 'it' : where} to change the mode from here.`] : []),
  )
}

// What is open over the reply box, drawn in the look's own way
function drawFootMenu() {
  const box = el('foot-menu')
  const kind = app.footMenu?.kind
  for (const [id, of] of [['foot-model', 'model'], ['foot-effort', 'effort'], ['foot-modes', 'modes'], ['foot-auto', 'modes']]) document.getElementById(id)?.setAttribute('aria-expanded', String(kind === of))
  if (!kind) {
    box.hidden = true
    box.replaceChildren()
    delete box.dataset.drawn
    return
  }
  const s = app.past ? null : app.sessions.get(app.current)
  const live = s && !s.ended ? s : null
  const can = canSetOptions(live)
  const where = live?.label || live?.host || 'that computer'
  const level = live ? (asked(live, 'effort') ?? live.effort ?? null) : null
  const modes = app.modeMenu ?? { mode: 'default', allowed: [], onPick: null }
  const row = live ? app.modelRows.get(live.id) : null
  // (a clone needs a device that is online and starts sessions)
  const clones = [...app.machines.values()].some((m) => m.online && !cantTake(m))
  // (drawn already: drawing it again would take it from under a finger)
  // Auto approve, under the modes: whether it is on for this session, how long yet, and why it cannot be where it cannot
  const auto = live ? { on: !!autoUntil(live.id), left: autoUntil(live.id) ? autoLeft(live.id) : '', bars: autoBars(live) } : null
  const drawn = JSON.stringify([kind, app.view, live?.id, live?.model, level, can, app.setting, modes.mode, modes.allowed, row, live?.state === 'working', auto, clones])
  if (box.dataset.drawn === drawn) return
  box.dataset.drawn = drawn
  box.dataset.kind = kind
  box.hidden = false
  const waits = live?.state === 'working' ? ' It takes effect when Claude finishes this turn.' : ''
  // Claude Code keeps what is set in a terminal as that computer's default for new sessions
  // ("saved as your default for new sessions"). Set in a session an app hosts (VS Code,
  // Desktop) or the machine's agent runs, it is "for this session only". Each says so itself.
  const keeps = live?.entrypoint === 'cli' && !live.hosted
  const saved = (keeps ? `Saved as ${where}'s default for new sessions, as Claude Code does.` : 'For this session only.') + waits
  // The effort: VS Code's five dots, a terminal's line from Faster to Smarter. It is under
  // the modes, as VS Code has it, and under the models too, as a terminal's /model has it
  // (and as the pill, which says both, leads one to look for it)
  const pick = (to) => () => setOption(live, 'effort', to)
  const level5 = (l) => ({ type: 'button', role: 'radio', 'aria-checked': String(l === level), 'data-effort': l, disabled: !can || undefined, onclick: pick(l) })
  const marks = (l) => (l === level ? ' on' : '') + (l === asked(live, 'effort') ? ' pending' : '')
  const dots = () =>
    h(
      'div',
      { class: 'menu-row menu-effort' },
      icon('effort'),
      h('span', { class: 'menu-text' }, h('span', { class: 'menu-title' }, 'Effort', level ? h('span', { class: 'menu-dim' }, ` (${effortName(level)})`) : null)),
      h('span', { class: 'effort-dots', role: 'radiogroup', 'aria-label': 'Effort' }, ...EFFORT_LEVELS.map((l) => h('button', { ...level5(l), class: 'effort-dot' + marks(l), 'aria-label': effortName(l), title: `${effortName(l)}: ${EFFORT_SAYS[l]}` }))),
    )
  const line = () => {
    const at = EFFORT_LEVELS.indexOf(level)
    return h(
      'div',
      { class: 'effort-line', role: 'radiogroup', 'aria-label': 'Effort' },
      h('span', { class: 'effort-ends' }, h('span', null, 'Faster'), h('span', null, 'Smarter')),
      h('span', { class: 'effort-track' }, ...EFFORT_LEVELS.map((l, i) => h('span', { class: i === at ? 'at' : '' }, i === at ? '▲' : ''))),
      h('span', { class: 'effort-names' }, ...EFFORT_LEVELS.map((l) => h('button', { ...level5(l), class: marks(l).trim(), title: EFFORT_SAYS[l] }, l))),
    )
  }
  // What is listed scrolls when there is more of it than room; the effort under it stays in sight
  const list = (...children) => h('div', { class: 'menu-list' }, ...children)
  const foot = (...children) => (live ? h('div', { class: 'menu-foot' }, ...children) : null)
  if (kind === 'modes') {
    const shown = [...new Set([...Object.keys(PERMISSION_MODES).filter((m) => m !== 'dontAsk'), ...modes.allowed, modes.mode])]
    const pickable = (m) => !!modes.onPick && modes.allowed.includes(m)
    put(
      box,
      list(
        h('div', { class: 'menu-head' }, 'Modes'),
        ...shown.map((m) =>
          menuRow({
            title: PERMISSION_MODES[m]?.[0] ?? m,
            says: PERMISSION_MODES[m]?.[2],
            mark: icon(m),
            on: m === modes.mode,
            disabled: !pickable(m) && m !== modes.mode,
            'data-mode': m,
            onclick: () => {
              if (pickable(m) && m !== modes.mode) modes.onPick(m)
              closeFootMenu()
            },
          }),
        ),
        modes.onPick ? null : modeNote(live, clones),
        // Not one of the session's own modes: what this browser does about what the session asks, in whichever mode it is
        auto && h('div', { class: 'menu-sep', role: 'separator' }),
        auto &&
          menuRow({
            title: auto.on ? `Auto approve · ${auto.left} left` : 'Auto approve for 1 hour',
            says: auto.on ? 'This browser says yes to everything this session asks, while it is open. Press to stop it.' : auto.bars || 'This browser says yes to everything this session asks, for an hour, while it is open',
            mark: icon('autoApprove'),
            on: auto.on,
            disabled: !auto.on && !!auto.bars,
            role: 'menuitemcheckbox',
            'data-auto': auto.on ? 'on' : 'off',
            onclick: () => {
              setAuto(live, !auto.on)
              closeFootMenu()
            },
          }),
      ),
      foot(dots(), can ? h('p', { class: 'menu-note' }, saved) : null),
    )
  } else if (kind === 'effort') {
    put(box, list(h('div', { class: 'menu-head' }, 'Effort'), line(), h('p', { class: 'menu-note' }, can ? 'Pick a level · Esc to cancel. ' + saved : 'It can be changed while the session is running and reachable.')))
  } else {
    const options = row?.options ?? ['default', ...MODELS.map(([value]) => value).filter(Boolean)]
    // (which one it is set to is the session's to say; until it has, none is ticked)
    const now = asked(live, 'model') ?? row?.value ?? null
    put(
      box,
      list(
        h('div', { class: 'menu-head' }, ...both('Model', 'Select model')),
        // (what Claude Code asks about in its own dialog before a switch mid-conversation is said here instead)
        h('p', { class: 'menu-note' }, `Switch between Claude models. ${keeps ? `Your pick becomes ${where}'s default for new sessions.` : 'Your pick is for this session only.'} Mid-conversation, the next response is slower and uses more tokens: the new model reads the whole history again.` + waits),
        ...options.map((alias) => {
          const [title, says] = modelChoice(alias)
          return menuRow({ title, says, on: alias === now, pending: alias === asked(live, 'model'), disabled: !can, 'data-model': alias, onclick: () => (alias === now ? closeFootMenu() : setOption(live, 'model', alias)) })
        }),
      ),
      foot(app.view === 'terminal' ? [h('div', { class: 'menu-head' }, 'Effort'), line()] : dots(), h('p', { class: 'menu-note' }, ...both(can ? saved : '', 'Pick one · Esc to cancel'))),
    )
  }
}

// Sets a session's model or effort: its own /model or /effort, run in it. What was asked
// for shows at once, dimmed, until the session says it has it (or says why not).
async function setOption(s, kind, value) {
  if (!canSetOptions(s)) return
  const mine = (app.setting = { sid: s.id, kind, value })
  app.modeError = null
  if (kind === 'model') app.footMenu = null
  renderHeader()
  const done = () => {
    if (app.setting !== mine) return
    app.setting = null
    if (app.current === s.id) renderHeader()
  }
  const args = { command: kind, args: value }
  // (it goes as its order and nothing beside it: which command, and with what, are in what this device signed.
  // Where it cannot sign, nothing is sent.)
  const order = await orderFor(s.id, 'call', { method: 'command.run', args })
  const r = order ? await sendJson(`/api/sessions/${encodeURIComponent(s.id)}/call`, { order, timeoutMs: 20_000 }) : { ok: false, error: NO_KEY }
  const failed = !r.ok ? r.error : r.data?.status === 'done' && !r.data.ok ? r.data.error || 'Claude Code refused it.' : null
  if (failed) {
    app.modeError = { sid: s.id, text: `The ${kind} was not changed: ${failed}`, until: Date.now() + 10_000 }
    setTimeout(() => app.current === s.id && renderHeader(), 10_100)
    return done()
  }
  // Run: the session says what it has in a moment. Still waiting: Claude is mid-turn, and
  // it runs when the turn ends
  if (kind === 'model') loadModelRow(s)
  setTimeout(done, r.data?.status === 'done' ? 4000 : 120_000)
}

// A press anywhere else shuts what is open
document.addEventListener('pointerdown', (ev) => {
  if (app.footMenu && !ev.target.closest?.('#foot-menu, #foot-model, #foot-effort, #foot-modes, #foot-auto')) closeFootMenu()
})
el('foot-model').addEventListener('click', () => openFootMenu('model'))
el('foot-effort').addEventListener('click', () => openFootMenu('effort'))
el('foot-auto').addEventListener('click', () => openFootMenu('modes'))
// The arrow keys move through a menu, as they do in a terminal's picker
el('foot-menu').addEventListener('keydown', (ev) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key]
  if (!step) return
  const all = [...el('foot-menu').querySelectorAll('button:not(:disabled)')]
  const next = all[(all.indexOf(document.activeElement) + step + all.length) % all.length]
  if (!next) return
  ev.preventDefault()
  next.focus()
})

// The terminal look opens the transcript the way Claude Code does: its mark, the
// version, the model and plan, and the folder
const banner = h('div', { id: 'banner', class: 'banner for-terminal', 'aria-hidden': 'true' })

function renderBanner(s) {
  const model = prettyModel(s.model)
  const plan = s.account?.subscriptionType ? 'Claude ' + s.account.subscriptionType[0].toUpperCase() + s.account.subscriptionType.slice(1) : null
  // (as a terminal opens: "Opus 5.5 with xhigh effort · Claude Max")
  const thinks = model && s.effort ? `${model} with ${s.effort} effort` : model
  const key = [s.version, thinks, plan, s.cwd].join('|')
  if (banner.dataset.key === key) return
  banner.dataset.key = key
  const mark = (...parts) => h('span', { class: 'mark' }, ...parts)
  const inner = (text) => h('span', { class: 'mark-in' }, text)
  banner.replaceChildren(
    h('div', null, mark(' ▐', inner('▛███▛█')), '   ', h('b', null, 'Claude Code'), s.version ? h('span', { class: 'dim' }, ' v' + s.version) : null),
    h('div', null, mark('▝▜', inner('█████'), '█▀'), '  ', h('span', { class: 'dim' }, [thinks, plan].filter(Boolean).join(' · '))),
    h('div', null, mark(' ▝▝   ▝▝'), '   ', h('span', { class: 'dim' }, s.cwd ?? '')),
  )
}

// claude-opus-5-5 -> Opus 5.5; claude-haiku-4-5-20251001 -> Haiku 4.5
function prettyModel(id) {
  if (!id) return null
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?(\[1m\])?$/.exec(id)
  if (!m) return id
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '') + (m[4] ? ' (1M context)' : '')
}

// The line that says Claude is working, with Claude Code's spinner
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const working = h('div', { id: 'working', class: 'working-line', hidden: true }, h('span', { class: 'spin', 'aria-hidden': 'true' }, '✻'), ' Working…', h('span', { class: 'esc for-terminal', hidden: true }, '(esc to interrupt)'))
let spinnerFrame = 0

function setWorking(on) {
  if (working.hidden === !on) return
  const box = el('messages')
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  working.hidden = !on
  box.classList.toggle('is-working', on)
  if (on && nearEnd) scrollToEnd()
}

setInterval(() => {
  if (working.hidden || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  working.firstChild.textContent = SPINNER[++spinnerFrame % SPINNER.length]
}, 130)

// ---- Subagents: the ones the open session has running now, in a strip above the reply box

const AGENTS_SHOWN = 6

function renderAgents(s) {
  const box = el('agents')
  const agents = s?.agents ?? []
  box.hidden = !agents.length
  if (!agents.length) return box.replaceChildren()
  const shown = agents.slice(0, AGENTS_SHOWN)
  box.replaceChildren(
    h('span', { class: 'agents-count' }, count(agents.length, 'subagent') + ' running'),
    ...shown.map((a) => h('span', { class: 'agent', title: [a.type, a.background ? 'in the background' : '', 'started ' + time(a.startedAt)].filter(Boolean).join(' · ') }, a.description || a.type || 'subagent', h('span', { class: 'agent-for' }, ' ' + ago(a.startedAt)))),
    ...(agents.length > shown.length ? [h('span', { class: 'agent more' }, `and ${agents.length - shown.length} more`)] : []),
  )
}

// ---- Requests: permission prompts and questions waiting for an answer here

// What a session runs in, as the person at it would call it
function appName(s) {
  if (/vscode/.test(s?.entrypoint ?? '')) return 'VS Code'
  if (/desktop/.test(s?.entrypoint ?? '')) return 'the Desktop app'
  return s?.interactive === false && s?.entrypoint && s.entrypoint !== 'cli' ? 'its own app' : 'the terminal'
}

// One the session's own app is asking in its dialog as well: the first answer counts
const askedThereToo = (r) => (r.route === 'both' ? h('div', { class: 'card-sub there-too' }, `Asked in ${appName(app.sessions.get(r.sid))} too: the first answer counts.`) : null)

function renderRequests(s) {
  // (not what this browser says yes to by itself: that is answered as it comes)
  const list = (s.pendingRequests ?? []).filter((r) => (r.kind === 'approval' || r.kind === 'question') && r.route !== 'local' && !autoTakes(s.id, r))
  const box = el('requests')
  box.hidden = !list.length
  // Keep what's being typed in an open card: redraw only when the set changes
  const key = list.map((r) => r.rid).join(',')
  if (box.dataset.key === key) return
  box.dataset.key = key
  box.replaceChildren(...list.map((r) => (r.kind === 'approval' ? approvalCard(r) : questionCard(r))))
}

function approvalCard(r) {
  const input = r.input && typeof r.input === 'object' ? r.input : {}
  const detail = r.tool === 'Bash' ? input.command : input.file_path ? [input.file_path, input.old_string !== undefined ? '\n--- old\n' + input.old_string + '\n+++ new\n' + input.new_string : input.content].filter(Boolean).join('\n') : JSON.stringify(input, null, 2)
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title' }, 'Claude wants to use ', h('b', null, r.tool)),
    r.reason && h('div', { class: 'card-sub' }, r.reason),
    detail && h('pre', { class: 'card-detail' }, detail),
    h(
      'div',
      { class: 'card-actions' },
      h('button', { class: 'primary', onclick: () => answer(r, { decision: 'allow' }) }, 'Allow'),
      h('button', { class: 'ghost', onclick: async () => answer(r, { decision: 'deny', reason: (await ask('Why not?', { says: 'Optional. Claude reads what you type here.', text: '', yes: 'Deny', no: null })) || undefined }) }, 'Deny'),
      r.route === 'both' ? null : h('button', { class: 'link', onclick: () => answer(r, { decision: 'ask' }) }, 'Let the terminal decide'),
    ),
    askedThereToo(r),
  )
}

function questionCard(r) {
  const picks = new Map() // question -> Set of labels
  const others = new Map() // question -> typed answer
  const questions = r.questions ?? []
  const single = questions.length === 1 && !questions[0].multiSelect && (questions[0].kind ?? 'choice') === 'choice'
  const submit = () => {
    const answers = {}
    for (const q of questions) {
      const typed = others.get(q.question)?.trim()
      const chosen = [...(picks.get(q.question) ?? [])]
      if (typed) chosen.push(typed)
      if (chosen.length) answers[q.question] = chosen.join(', ')
    }
    answer(r, { decision: 'answer', answers })
  }
  return h(
    'div',
    { class: 'card' },
    ...questions.map((q) =>
      h(
        'div',
        { class: 'question' },
        h('div', { class: 'card-title' }, q.header ? h('span', { class: 'chip' }, q.header) : null, ' ', q.question),
        h(
          'div',
          { class: 'options' },
          ...(q.options ?? []).map((o) =>
            h(
              'button',
              {
                class: 'option',
                title: o.description ?? '',
                onclick: (ev) => {
                  if (single) return answer(r, { decision: 'answer', answers: { [q.question]: o.label } })
                  const set = picks.get(q.question) ?? new Set()
                  if (!q.multiSelect) set.clear()
                  set.has(o.label) ? set.delete(o.label) : set.add(o.label)
                  picks.set(q.question, set)
                  for (const b of ev.target.parentElement.children) b.classList.toggle('picked', set.has(b.textContent))
                },
              },
              o.label,
            ),
          ),
        ),
        h('input', { class: 'other', placeholder: q.kind === 'number' ? 'A number' : 'Or type an answer', oninput: (ev) => others.set(q.question, ev.target.value) }),
      ),
    ),
    h(
      'div',
      { class: 'card-actions' },
      h('button', { class: 'primary', onclick: submit }, single ? 'Send typed answer' : 'Send answers'),
      h('button', { class: 'ghost', onclick: () => answer(r, { decision: 'decline' }) }, 'Decline'),
      r.route === 'both' ? null : h('button', { class: 'link', onclick: () => answer(r, { decision: 'ask' }) }, 'Answer in the terminal'),
    ),
    askedThereToo(r),
  )
}

// True when the server took it. `quiet`: nothing is said here where it did not (an answer
// the page gives by itself: someone may have answered first, in the session's own app).
async function answer(r, body, { quiet = false } = {}) {
  // An answer is signed: an order for its session, which says which asking it answers
  // (the request, and what was asked in it, as this device read it) and holds the whole
  // answer. Nothing goes beside it: the session goes by the order. (Handing the asking
  // back to the session's own app says nothing, and needs no passphrase.)
  const order = await orderFor(r.sid, 'answer', { ...body, rid: r.rid, asked: sealing.askedOf(r) })
  if (!order && body.decision !== 'ask') return quiet ? false : void tell('Not sent', sentence(NO_KEY))
  const res = await fetch('/api/requests/' + encodeURIComponent(r.rid), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(order ? { order } : { decision: body.decision }),
  }).catch(() => null)
  if (!res?.ok && !quiet) {
    const { error } = (await res?.json().catch(() => ({}))) ?? {}
    tell('Not sent', sentence(error ?? (res ? 'The server answered ' + res.status : 'The server could not be reached')))
  }
  return !!res?.ok
}

// ---- Auto approve: for an hour, this browser says yes to everything one session asks.
// A yes is an order signed with the half of the account's key that only its browsers and
// phones have, so it is this page that says it, each time, and only while it is open:
// nothing of it is told the server or the session's computer, which could say no yes of
// their own. It is one session's, picked in its Modes menu, and it is kept on this
// device with when it ends: so a page that is read again goes on with it (the page
// reads itself again when there is a newer one), and so does another tab of this browser.
// What it says yes to is what Allow would: a permission prompt that can be answered
// here, and that this device could open. What Claude asks in words is left to be answered.
const AUTO_MS = 3600_000
const AUTO_KEPT = 'mc.autoApprove'
const AUTO_WAIT_MS = 10_000 // how long a prompt it said yes to may go on waiting before it is shown after all
const autoSaid = new Map() // the prompts this page has said yes to by itself, each with when: request id -> time
const autoRefused = new Set() // and of those, the ones whose yes was not taken: left to be answered by hand
function autoRead() {
  let kept = {}
  try {
    kept = JSON.parse(localStorage.getItem(AUTO_KEPT)) ?? {}
  } catch {}
  app.auto = new Map(Object.entries(kept).filter(([, until]) => Number.isFinite(until) && until > Date.now() && until <= Date.now() + AUTO_MS))
}
function autoKeep() {
  try {
    if (app.auto.size) localStorage.setItem(AUTO_KEPT, JSON.stringify(Object.fromEntries(app.auto)))
    else localStorage.removeItem(AUTO_KEPT)
  } catch {}
}
// When it ends for a session: 0 where it is not on
const autoUntil = (sid) => ((app.auto.get(sid) ?? 0) > Date.now() ? app.auto.get(sid) : 0)
// How long it has left, in words short enough for the foot of the reply box
const autoLeft = (sid) => Math.max(1, Math.ceil((autoUntil(sid) - Date.now()) / 60_000)) + ' min'
// Why it cannot be turned on for a session, where it cannot: '' where it can
function autoBars(s) {
  if (!s || s.ended) return 'The session is not running.'
  if (!app.key) return 'A yes is signed with your key: type your passphrase under Account first.'
  if (s.policy?.approvals === 'local') return 'This session’s prompts are answered in its own app alone (Edit, then Answer, changes that).'
  return ''
}
// A prompt it says yes to: one Allow could be pressed on here, of a session it is on for
const autoCan = (r) => r.kind === 'approval' && r.route !== 'local' && !isLocked(r.tool)
// (and not one whose yes was refused, or was taken and has left it waiting all the same: that one is shown, to be seen to)
const autoTakes = (sid, r) => !!app.key && !!autoUntil(sid) && autoCan(r) && !autoRefused.has(r.rid) && !(Date.now() - (autoSaid.get(r.rid) ?? Infinity) > AUTO_WAIT_MS)
function setAuto(s, on) {
  autoRead()
  if (on) app.auto.set(s.id, Date.now() + AUTO_MS)
  else app.auto.delete(s.id)
  autoKeep()
  autoChanged()
}
// Yes, once, to each prompt waiting in a session it is on for
function autoApprove() {
  if (!app.auto.size || !app.key) return
  for (const sid of app.auto.keys()) {
    for (const r of app.sessions.get(sid)?.pendingRequests ?? []) {
      if (!autoTakes(sid, r) || autoSaid.has(r.rid)) continue
      autoSaid.set(r.rid, Date.now())
      answer(r, { decision: 'allow' }, { quiet: true }).then((taken) => {
        if (taken) return
        // (not taken: it is shown, to be answered by hand, unless it has been answered meanwhile)
        autoRefused.add(r.rid)
        if (app.current === sid && app.sessions.has(sid)) renderRequests(app.sessions.get(sid))
      })
    }
  }
}
// It was turned on or off, here or in another tab, or its hour is over: what is waiting is
// answered or shown, and the reply box says how it stands
function autoChanged() {
  autoApprove()
  const s = app.past ? null : app.sessions.get(app.current)
  if (s) renderRequests(s)
  drawAuto(s)
  drawFootMenu()
}
// By the reply box: that it is on, and for how long yet. It opens the Modes menu, where it is turned on and off.
// (in a terminal's look, which has no button for the modes, it is the way to that menu whether it is on or not:
// off, it reads as the commands beside it do, "/auto-approve")
function drawAuto(s) {
  const button = el('foot-auto')
  const live = s && !s.ended && !app.past ? s : null
  const on = live ? autoUntil(live.id) : 0
  const drawn = JSON.stringify([live?.id, on ? autoLeft(live.id) : '', live ? autoBars(live) : ''])
  if (button.dataset.drawn === drawn) return
  button.dataset.drawn = drawn
  button.hidden = !live || (!on && !!autoBars(live))
  button.classList.toggle('on', !!on)
  button.title = on ? `This browser says yes to everything this session asks, while it is open: ${autoLeft(live.id)} left. Press to stop it.` : 'Have this browser say yes to everything this session asks, for an hour'
  // (on a phone there is room for less of it: "Auto · 52 min")
  put(button, ...(on ? [h('span', { class: 'for-vscode' }, 'Auto', h('span', { class: 'foot-auto-more' }, ' approve'), ` · ${autoLeft(live.id)}`), h('span', { class: 'for-terminal' }, `⏵⏵ auto approve on · ${autoLeft(live.id)}`)] : [h('span', { class: 'for-terminal' }, '/auto-approve')]))
}
// Looked at again four times a minute: an hour that is over is put away, and what is left of one is said
setInterval(() => {
  if (!app.auto.size) return
  const had = app.auto.size
  autoRead()
  if (app.auto.size !== had) autoKeep()
  autoChanged()
}, 15_000)
// Turned on or off in another tab of this browser
window.addEventListener('storage', (ev) => {
  if (ev.key !== AUTO_KEPT) return
  autoRead()
  autoChanged()
})

el('remove').addEventListener('click', async () => {
  const sid = app.current
  if (!(await ask('Remove this session and its messages from ManyClaws?', { yes: 'Remove', danger: true }))) return
  const r = await fetch('/api/sessions/' + encodeURIComponent(sid), { method: 'DELETE' })
  if (r.ok) location.hash = ''
})

async function post(action, body) {
  const r = await fetch('/api/sessions/' + encodeURIComponent(app.current) + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (r.status === 401) showLogin()
  return r
}

// ---- Messages

// A row as it arrives
function addMessage(m) {
  // Until the chat's rows have been read, one that comes by the stream waits for them.
  // (Drawn as it came, it passed for all there was: a session opened while it was talking
  // showed only what it said from then on, and nothing before.)
  if (!app.loaded) return void (app.early.length < WINDOW && app.early.push(m))
  if (m.seq <= app.lastSeq) return
  const box = el('messages')
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  addMessages([m])
  if (!nearEnd) return void (m.role === 'assistant' && el('latest').classList.add('fresh'))
  trimRows()
  scrollToEnd()
}

// Rows drawn together: built off the page and added to it in one go, with nothing
// measured in between
function addMessages(list) {
  const fresh = list.filter((m) => m.seq > app.lastSeq)
  if (!fresh.length) return
  app.lastSeq = fresh.at(-1).seq
  el('messages').append(...rowNodes(fresh))
  tail()
  if (app.current && !app.past && typedHere(app.current, fresh)) renderListSoon()
}

// The nodes for some rows in order. A result fills the call it belongs to, drawn here
// or before. `older` rows are from before the ones on the page: nothing in them is waiting.
function rowNodes(list, { older = false } = {}) {
  const nodes = []
  const open = app.openTools
  if (older) app.openTools = new Set()
  for (const m of list) {
    if (m.role === 'result') {
      attachResult(m)
      continue
    }
    if (m.role === 'user' && !older) clearPending(m.text)
    // A call that never reported back is over once the conversation has moved on
    if (m.role === 'user' || m.role === 'assistant') settleTools()
    const node = renderMessage(m)
    node.dataset.seq = m.seq
    if (m.role === 'user') node._prompt = m.text
    nodes.push(node)
  }
  if (older) {
    settleTools()
    app.openTools = open
  }
  return nodes
}

function settleTools() {
  for (const node of app.openTools) node.classList.replace('open', 'stale')
  app.openTools.clear()
}

// While the end of a long session is followed, its oldest rows are let go: they come
// back from the server when scrolled to
function trimRows() {
  const box = el('messages')
  const rows = box.querySelectorAll(':scope > [data-seq]')
  if (app.past || rows.length <= ROWS_KEPT) return
  const keepFrom = rows.length - WINDOW
  for (let i = 0; i < keepFrom; i++) {
    if (rows[i].dataset.tool) app.tools.delete(rows[i].dataset.tool)
    app.openTools.delete(rows[i])
    // The prompt of the turn the rows now start in goes with them: its words are kept
    if (rows[i]._prompt !== undefined) app.promptBefore = { seq: Number(rows[i].dataset.seq), text: rows[i]._prompt }
    rows[i].remove()
  }
  app.firstSeq = Number(rows[keepFrom].dataset.seq)
  app.earlier = true
  showEarlier()
}

// What follows the transcript: the reply as it streams, replies not yet delivered,
// and the working line
function tail() {
  const box = el('messages')
  const partial = el('partial')
  if (partial) box.append(partial)
  for (const p of app.pending) box.append(p.node)
  box.append(working)
}

function renderMessage(m) {
  if (m.role === 'user') {
    const from = m.origin === 'plugin' ? 'Prompt from ManyClaws' : m.origin === 'bridge' ? 'Prompt from Remote Control' : null
    // One sent while Claude was at work, which it took up inside the turn, sits where it took it
    return userNode(withThumbnails(m.text), { note: [from, m.mid && 'Sent while Claude was working'].filter(Boolean).join(' · ') || null, title: time(m.ts) })
  }
  if (m.role === 'tool') return toolNode(m)
  if (m.role === 'output') return h('pre', { class: 'msg output' }, m.text)
  if (m.role === 'notice') return h('div', { class: 'msg notice' }, m.text)
  const node = h('div', { class: 'msg assistant tl md', title: time(m.ts) })
  node.innerHTML = rendered(m.text)
  return node
}

function userNode(content, { note, title, pending = false } = {}) {
  return h('div', { class: 'msg user' + (pending ? ' pending' : ''), title }, note && h('div', { class: 'from' }, note), h('div', { class: 'bubble' }, ...content))
}

// ---- Tool calls: one line for the call, and under it what it ran and what came back

// The names Claude Code's terminal gives the tools
const TERMINAL_TOOL_NAMES = { Edit: 'Update', MultiEdit: 'Update', NotebookEdit: 'Update', Grep: 'Search', Glob: 'Search', WebFetch: 'Fetch', WebSearch: 'Web Search', TodoWrite: 'Update Todos' }
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function toolNode(m) {
  const name = m.tool ?? 'tool'
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  const names = mcp ? [mcp[1] + ': ' + mcp[2], `${mcp[1]} - ${mcp[2]} (MCP)`] : [name, TERMINAL_TOOL_NAMES[name] ?? name]
  // A file reads as its name in VS Code, and as its path from the session's folder in the terminal
  let args = [m.text, m.text]
  // (the file a tool was given opens from its row, as a link to it does)
  const file = FILE_TOOLS.has(name) && /^(\/|[A-Za-z]:\\)/.test(m.text) ? { 'data-file': m.text, role: 'link', tabindex: 0 } : null
  if (file) {
    const cwd = app.past ? app.past.session?.cwd : app.sessions.get(app.current)?.cwd
    const inside = cwd && m.text.startsWith(cwd) && /^[\\/]/.test(m.text.slice(cwd.length))
    args = [m.text.split(/[\\/]/).pop(), inside ? m.text.slice(cwd.length + 1) : m.text]
  } else if ((name === 'Grep' || name === 'Glob') && m.text) {
    args = [`"${m.text}"`, `pattern: "${m.text}"`]
  } else if (m.detail) {
    args = [m.text, terminalCommand(m.detail)]
  }
  const body = h('div', { class: 'tool-body', hidden: !m.detail })
  if (m.detail) body.append(foldable(h('div', { class: 'tool-row in' }, h('span', { class: 'tool-label' }, 'IN'), h('pre', { class: 'tool-io' }, m.detail))))
  if (m.detail) refoldSoon()
  const node = h(
    'div',
    { class: ['msg tool tl open', m.detail && 'cmd', m.desc && 'has-desc'].filter(Boolean).join(' '), 'data-tool': m.toolUseId, title: time(m.ts) },
    h('div', { class: 'tool-head' }, h('span', { class: 'tool-name' }, ...both(...names)), m.desc && h('span', { class: 'tool-desc' }, m.desc), m.text && h('span', { class: 'tool-arg', ...file }, ...both(...args))),
    body,
  )
  if (m.toolUseId) app.tools.set(m.toolUseId, node)
  app.openTools.add(node)
  const early = m.toolUseId && app.results.get(m.toolUseId)
  if (early) {
    app.results.delete(m.toolUseId)
    fillResult(node, early)
  }
  return node
}

// A command the way Claude Code prints it: its first two lines, 160 characters at most
function terminalCommand(command) {
  const lines = command.split('\n')
  let shown = lines.slice(0, 2).join('\n')
  if (shown.length > 160) shown = shown.slice(0, 160)
  return shown.length < command.length ? shown.trimEnd() + '…' : shown
}

function attachResult(m) {
  const node = m.toolUseId && app.tools.get(m.toolUseId)
  if (node) fillResult(node, m)
  else if (m.toolUseId) app.results.set(m.toolUseId, m)
}

// What a call came back with, one line to a row. Folded, the terminal look shows the
// first three rows on screen (twelve of an edit) and counts the lines below them, as
// Claude Code does; the VS Code look shows a short window onto all of it. A click
// opens either one.
function fillResult(node, m) {
  app.openTools.delete(node)
  node.classList.remove('open', 'stale')
  node.classList.add(m.error ? 'err' : 'ok')
  // Where the result is in a transcript, for a search hit in it to land here
  if (m.uuid) node.dataset.result = m.uuid
  if (!m.text) return
  if (m.diff) node.classList.add('has-diff')
  const mark = (text, i) => (m.diff && i > 0 ? (text.startsWith('+') ? ' add' : text.startsWith('-') ? ' del' : '') : '')
  const row = h(
    'div',
    { class: 'tool-row out' + (m.diff ? ' diff' : ''), 'data-lost': m.more ?? 0, 'data-approx': m.approx ? '~' : '' },
    h('span', { class: 'tool-label' }, 'OUT'),
    h('pre', { class: 'tool-io' }, ...m.text.split('\n').map((text, i) => h('span', { class: 'ln' + mark(text, i) }, text))),
    h('div', { class: 'tool-more' }),
  )
  const body = node.querySelector('.tool-body')
  body.append(foldable(row))
  body.hidden = false
  refoldSoon()
}

// A row that's cut short opens in full with a click, and closes with another
function foldable(row) {
  row.addEventListener('click', () => {
    const opens = row.classList.contains('folds') || row.classList.contains('expanded')
    if (!opens || String(getSelection()).trim()) return
    row.classList.toggle('expanded')
    refold(row)
  })
  return row
}

// Whether a result is cut short at this width and in this look, and how much of it is
// below the cut. Claude Code counts rows on screen there, so a long line that wraps
// counts for each row it takes; so does this.
function refold(row) {
  markFold(row, measureFold(row))
}

// What's cut of a row as it's drawn now: nothing is changed here, so many can be
// measured in a row without the page being laid out again for each
function measureFold(row) {
  const pre = row.querySelector('.tool-io')
  if (row.classList.contains('expanded')) return { expanded: true }
  if (!pre.clientHeight) return null // not drawn in this look
  // Cut at the bottom, or (in the VS Code look, where lines don't wrap) at the right edge
  const below = pre.scrollHeight > pre.clientHeight + 1 ? Math.round((pre.scrollHeight - pre.clientHeight) / parseFloat(getComputedStyle(pre).lineHeight)) : 0
  return { below, cut: below > 0 || pre.scrollWidth > pre.clientWidth + 1 }
}

function markFold(row, mark) {
  if (!mark) return
  const more = row.querySelector('.tool-more')
  const lost = Number(row.dataset.lost) || 0 // lines the server didn't keep
  const lines = (n) => `${row.dataset.approx ?? ''}${n} line${n === 1 ? '' : 's'}` // ~ before an estimate
  const say = (text) => more && more.textContent !== text && (more.textContent = text) // a command's own row has no count
  if (mark.expanded) return void say(lost ? `… +${lines(lost)} not kept` : '')
  row.classList.toggle('folds', mark.cut)
  say(mark.below ? `… +${lines(mark.below + lost)} (${matchMedia('(pointer: coarse)').matches ? 'tap' : 'click'} to expand)` : lost ? `… +${lines(lost)} not kept` : '')
}

// A result is measured when it comes into view (or near it), not when it's drawn: a
// long session has thousands, and measuring one lays the page out. The ones that came
// into view together are measured together, then marked together.
const foldWatch = new IntersectionObserver(
  (entries) => {
    const box = el('messages')
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
    const rows = entries.filter((e) => e.isIntersecting).map((e) => e.target)
    for (const row of rows) foldWatch.unobserve(row)
    const marks = rows.map(measureFold)
    rows.forEach((row, i) => markFold(row, marks[i]))
    if (rows.length && nearEnd) scrollToEnd()
  },
  { root: el('messages'), rootMargin: '800px 0px' },
)

// Every result on the page is watched again: after rows are added, or when the width
// or the look has changed what's cut
function refoldSoon() {
  clearTimeout(app.refoldTimer)
  app.refoldTimer = setTimeout(() => {
    for (const row of el('messages').querySelectorAll('.tool-row')) {
      foldWatch.unobserve(row)
      foldWatch.observe(row)
    }
  }, 50)
}

window.addEventListener('resize', refoldSoon)

// A prompt's "[Attachment <id>: …]" notes, drawn as the photos they stand for
const ATTACHMENT_NOTE = /\n*\[Attachment ([a-f0-9]{16}): ([^\]]*)\]/g

function withThumbnails(text) {
  const out = []
  let last = 0
  for (const m of text.matchAll(ATTACHMENT_NOTE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    // A photo is opened here, and shown from what was opened (it has no address of its own to open in a tab)
    out.push(sealedPhoto('/api/attachments/' + m[1], m[2].replace(/ \(image\/[^)]*\)\. Call the view_attachment tool .*$/, '')))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function sealedPhoto(src, name) {
  const img = thumb(name)
  fetch(src)
    .then((r) => r.arrayBuffer())
    .then(async (bytes) => {
      const plain = app.key && (await vault.openBytes(new Uint8Array(bytes), app.key))
      if (!plain) return void (img.alt = '🔒 photo (encrypted)')
      img.src = `data:${imageType(plain)};base64,` + b64(plain)
    })
    .catch(() => {})
  return img
}

// A photo in the chat, drawn small: a click on it (or Enter) shows it in the box a file opens in, as big as it was sent
const thumb = (name, src) => h('img', { class: 'thumb', alt: name || 'photo', src, role: 'button', tabindex: 0 })

// An image's type, from its first bytes
const imageType = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x47 && b[1] === 0x49 ? 'image/gif' : b[8] === 0x57 && b[9] === 0x45 ? 'image/webp' : 'image/png')

// Bytes as base64, the standard kind a data: address and the server take
function b64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// A prompt has arrived in the chat: the reply waiting to be seen there, which it is, waits
// no longer. Replies sent while Claude was at work can arrive together, as one prompt
// with a line or more for each: then each of them is in it, in the order they were sent.
function clearPending(text) {
  const bare = text.replace(ATTACHMENT_NOTE, '').trim()
  const typed = (p) => p.text.trim() || 'See the attached photo.'
  // (one too long for the session to report whole arrives cut short)
  const same = (p) => typed(p) === text.trim() || typed(p) === bare || (typed(p).length > 4000 && bare.startsWith(typed(p).slice(0, 4000)))
  let arrived = app.pending.filter(same).slice(0, 1)
  if (!arrived.length) {
    let from = 0
    for (const p of app.pending) {
      const at = wholeLines(bare, typed(p), from)
      if (at < 0) continue
      arrived.push(p)
      from = at + typed(p).length
    }
  }
  for (const p of arrived) p.node.remove()
  app.pending = app.pending.filter((p) => !arrived.includes(p))
}

// Where `part` is in `text` as whole lines of it, at or after `from`; -1 if nowhere
function wholeLines(text, part, from = 0) {
  for (let at = text.indexOf(part, from); at >= 0; at = text.indexOf(part, at + 1)) {
    const end = at + part.length
    if ((at === 0 || text[at - 1] === '\n') && (end === text.length || text[end] === '\n')) return at
  }
  return -1
}

function scrollToEnd() {
  const box = el('messages')
  box.scrollTop = box.scrollHeight
}

// Markdown for Claude's replies, as far as Claude Code draws it: headings, lists,
// tables, quotes, rules and code blocks, with inline code, bold, italics and links.
// Text is escaped before any tag is added, so only the tags written here appear.
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const QUOTE = /^ {0,3}> ?/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/

const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, '    ').length

function markdown(src) {
  return blocks(src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n'))
}

function blocks(lines) {
  let html = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
    } else if (FENCE.test(line)) {
      const [code, next] = fenced(lines, i)
      html += code
      i = next
    } else if (HEADING.test(line)) {
      const [, marks, text] = HEADING.exec(line)
      html += `<h${marks.length}>${inline(text)}</h${marks.length}>`
      i++
    } else if (RULE.test(line)) {
      html += '<hr>'
      i++
    } else if (QUOTE.test(line)) {
      const quoted = []
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ''))
      html += '<blockquote>' + blocks(quoted) + '</blockquote>'
    } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const [table, next] = tabled(lines, i)
      html += table
      i = next
    } else if (ITEM.test(line)) {
      const [list, next] = listed(lines, i, indentOf(line))
      html += list
      i = next
    } else {
      const para = [line]
      i++
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++])
      html += '<p>' + inline(para.join('\n')) + '</p>'
    }
  }
  return html
}

function startsBlock(lines, i) {
  const line = lines[i]
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? ''))
}

// A code block; one still being written has no closing fence yet
function fenced(lines, i) {
  const [, indent, marks] = FENCE.exec(lines[i])
  const close = new RegExp('^\\s*' + marks[0] + '{' + marks.length + ',}\\s*$')
  const body = []
  i++
  while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
  const cut = new RegExp('^\\s{0,' + indent.length + '}')
  return ['<pre><code>' + escape(body.map((l) => l.replace(cut, '')).join('\n')) + '</code></pre>', i + 1]
}

function tabled(lines, i) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'))
  const head = cells(lines[i])
  const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? ' class="center"' : /-:$/.test(c) ? ' class="right"' : ''))
  let html = '<table><thead><tr>' + head.map((c, n) => `<th${align[n] ?? ''}>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
  i += 2
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const row = cells(lines[i++])
    html += '<tr>' + head.map((_, n) => `<td${align[n] ?? ''}>${inline(row[n] ?? '')}</td>`).join('') + '</tr>'
  }
  return [html + '</tbody></table>', i]
}

// A list at one indent: its items, their continuation lines and code blocks, and
// the deeper lists inside them
function listed(lines, i, indent) {
  const ordered = /\d/.test(ITEM.exec(lines[i])[2])
  let html = ordered ? `<ol start="${parseInt(ITEM.exec(lines[i])[2], 10)}">` : '<ul>'
  let open = false
  let text = []
  const flush = () => {
    if (text.length) html += inline(text.join('\n'))
    text = []
  }
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      // A blank line ends the list unless more of it follows
      let j = i
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length && indentOf(lines[j]) >= indent && (ITEM.test(lines[j]) || indentOf(lines[j]) > indent)) {
        if (!ITEM.test(lines[j])) text.push('')
        i = j
        continue
      }
      break
    }
    const item = ITEM.exec(line)
    const depth = indentOf(line)
    if (item && depth < indent) break
    if (item && depth >= indent + 2 && open) {
      flush()
      const [inner, next] = listed(lines, i, depth)
      html += inner
      i = next
    } else if (item) {
      if (/\d/.test(item[2]) !== ordered) break
      flush()
      if (open) html += '</li>'
      open = true
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3])
      html += task ? `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : '<li>'
      text.push(task ? task[2] : item[3])
      i++
    } else if (FENCE.test(line) && open) {
      flush()
      const [code, next] = fenced(lines, i)
      html += code
      i = next
    } else if (open && !HEADING.test(line) && !RULE.test(line) && (depth > indent || !startsBlock(lines, i))) {
      text.push(line.trim())
      i++
    } else break
  }
  flush()
  return [html + (open ? '</li>' : '') + (ordered ? '</ol>' : '</ul>'), i]
}

function inline(text) {
  // Code spans and links are set aside as they're found, so nothing inside them is
  // formatted again
  const held = []
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`
  const link = (href, label) => hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
  return escape(text)
    .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, marks, code) => hold('<code>' + code.replace(/^ (.*) $/s, '$1') + '</code>'))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => link(href, label))
    // Claude's links to files, which open the file from the session's computer (see Files): one with spaces in it is written between < and >
    .replace(/\[([^\]\n]+)\]\(&lt;([^\n]+?)&gt;\)/g, (_, label, target) => hold(fileRef(target, label)))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, target) => hold(fileRef(target, label)))
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, before, url) => {
      // A bare address ends before the quote or punctuation that follows it
      const href = url.replace(/&(quot|#39|lt|gt);[\s\S]*$/, '').replace(/[.,;:!?)\]]+$/, '')
      return before + link(href, href) + url.slice(href.length)
    })
    .replace(/\*\*(?!\s)([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_(?![\s_])([^_\n]+?)_(?![\w_])/g, '$1<em>$2</em>')
    .replace(/~~(?!\s)([^\n]+?)~~/g, '<del>$1</del>')
    .replace(/\u0000(\d+)\u0000/g, (_, n) => held[n])
    .replace(/\u0000(\d+)\u0000/g, (_, n) => held[n]) // a code span held inside a link's label
}

function escape(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// A link that is no web address: to a file where the session runs, which a click opens
// here; or to something else (a heading, an address to write to), which is only shown.
// (`target` and `label` are escaped already)
const isFileLink = (target) => !/^#/.test(target) && !/^(mailto|tel|data|javascript|about|blob):/i.test(target) && (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(file|vscode|vscode-insiders|cursor|windsurf):\/\//i.test(target))
const fileRef = (target, label) => (isFileLink(target) ? `<a class="ref" role="link" tabindex="0" data-file="${target}" title="${target}">${label}</a>` : `<span class="ref" title="${target}">${label}</span>`)

// ---- Files: a link in the chat to a file where the session runs opens the file here.
// Claude writes such a link as it would for an editor beside it ([app.js](server/app.js#L42)),
// and a tool's row names the file it was given. The page asks the computer's agent for the
// file on an order: so it is one of this account's own devices that asks, and nobody
// between. The agent works out which file is meant (a link is often short of the whole
// path), and sends it sealed with the account's key, in pieces. It is opened here and
// shown: text with its lines numbered and the one the link points at marked, a picture
// as a picture, a folder as what is in it. The server passes it on and keeps none of it.

const FILE_LINES = 20_000 // the most lines of a file that are drawn
const FILE_RENDERED = 400_000 // the longest Markdown that is drawn as a document
const fileBox = { seq: 0, urls: [], shown: null } // which asking the box shows the answer to, the addresses made here for what it shows, and what that is

const lastPart = (p) => String(p).replace(/[#?].*$/, '').split(/[\\/]/).filter(Boolean).pop() || String(p)
const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const sentence = (text) => (text ? text[0].toUpperCase() + text.slice(1) + (/[.?!]$/.test(text) ? '' : '.') : '')

// Where the chat that is showing runs: its computer, and its folder there
function fileHome() {
  if (app.past) return { mid: app.past.mid, sid: app.past.sid, cwd: app.past.session?.cwd ?? '', host: '' }
  const s = app.sessions.get(app.current)
  return s ? { mid: s.machine, sid: s.id, cwd: s.cwd ?? '', host: s.label || s.host || '' } : null
}

// The files the chat's tools were given: a link that says less than a whole path more likely means one of these
const filesNear = () => [...new Set([...el('messages').querySelectorAll('.tool-arg[data-file]')].map((n) => n.dataset.file))].slice(-200)

document.addEventListener('click', (ev) => {
  if (ev.target.matches?.('.thumb[src]')) return void openPhoto(ev.target)
  const link = ev.target.closest?.('[data-file]')
  if (!link) return
  ev.preventDefault()
  // (a link in a document that is showing is from that document's folder)
  openFile(link.dataset.file, { from: link.closest('.file-md') ? fileBox.shown?.dir : undefined })
})
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || !ev.target.matches?.('[data-file], .thumb')) return
  ev.preventDefault()
  ev.target.click()
})

function clearFile() {
  for (const url of fileBox.urls) URL.revokeObjectURL(url)
  fileBox.urls = []
  fileBox.shown = null
  el('file-body').replaceChildren()
  el('file-where').textContent = ''
  for (const id of ['file-note', 'file-save', 'file-view', 'file-open']) el(id).hidden = true
}

function fileNote(text, { error = false, more = [] } = {}) {
  const note = el('file-note')
  note.hidden = !text
  note.classList.toggle('error', error)
  note.replaceChildren(text, ...more)
}

function closeFile() {
  fileBox.seq++
  if (el('file-box').open) el('file-box').close()
  clearFile()
}
el('file-close').addEventListener('click', closeFile)
// (a click beside the box closes it, as Escape does)
el('file-box').addEventListener('click', (ev) => ev.target === el('file-box') && closeFile())
// Escape shuts the box by itself. The browser says so at its next frame, by when the box
// may be open again on another file: what it shows then is left as it is.
el('file-box').addEventListener('close', () => !el('file-box').open && closeFile())
window.addEventListener('hashchange', closeFile)

const unb64 = (text) => {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function openFile(target, { from } = {}) {
  const seq = ++fileBox.seq
  const home = fileHome()
  clearFile()
  el('file-name').textContent = lastPart(target)
  if (!el('file-box').open) el('file-box').showModal()
  const no = (text, more) => fileNote(text, { error: true, more })
  if (!home) return no('The session this link is in is no longer open.')
  if (!app.key) return no('A file comes sealed with your key, which this device does not have: type your passphrase under Account first.')
  const m = app.machines.get(home.mid)
  if (!m) return no(`Files are opened through the ManyClaws agent, and ${home.host || "this session's computer"} has none connected. `, [h('a', { href: '#/setup' }, 'Set up a computer'), ' has how to install it.'])
  if (!m.online) return no(`${machineName(m)} is not connected, so its files can't be reached.`)
  fileNote(`Fetching from ${machineName(m)}…`)
  const r = await sendJson(`/api/machines/${m.id}/file`, { order: await orderFor(m.id, 'file', { path: target, cwd: from || home.cwd, sid: home.sid, near: filesNear() }) })
  if (seq !== fileBox.seq) return
  if (!r.ok) return no(sentence(r.error))
  const info = r.data.file
  if (!info || typeof info !== 'object') return no(`What ${machineName(m)} sent could not be opened with the key this device has: the two were given different passphrases.`)
  const pieces = [unb64(r.data.data ?? '')]
  for (let part = 1; part < r.data.parts; part++) {
    fileNote(`Fetching from ${machineName(m)}… ${fileSize(pieces.reduce((n, p) => n + p.length, 0))} of ${fileSize(r.data.size)}`)
    const p = await sendJson(`/api/machines/${m.id}/file/part`, { id: await sealFor(r.data.id), part })
    if (seq !== fileBox.seq) return
    if (!p.ok) return no(sentence(p.error))
    pieces.push(unb64(p.data.data ?? ''))
  }
  const packed = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0))
  pieces.reduce((at, p) => (packed.set(p, at), at + p.length), 0)
  // (opening megabytes takes a moment: what is said meanwhile is drawn first)
  if (packed.length > 1_000_000) {
    fileNote('Opening…')
    await new Promise((done) => setTimeout(done, 30))
    if (seq !== fileBox.seq) return
  }
  const bytes = r.data.parts ? await vault.openBytes(packed, app.key) : new Uint8Array(0)
  if (!bytes) return no(`What ${machineName(m)} sent could not be opened with the key this device has.`)
  showFile(info, bytes, { target, home, m })
}

// A photo in the chat, in the box: from the bytes the page drew it small from, so nothing is
// fetched and no computer is asked. It is shown as a file is, with its name and Save.
function openPhoto(img) {
  const [, data] = /^data:[^,]*;base64,(.*)$/.exec(img.src) ?? []
  if (!data) return
  fileBox.seq++
  clearFile()
  const bytes = unb64(data)
  showFile({ kind: 'file', name: img.alt, path: '', size: bytes.length, exact: true }, bytes, { home: { cwd: '' } })
  if (!el('file-box').open) el('file-box').showModal()
}

// An address in this page for bytes it holds: gone again when the box shows something else
function fileUrl(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  fileBox.urls.push(url)
  return url
}

// A file's words, where it is text: null where it is not
function textOf(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b)
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b)
  if (b.subarray(0, 8000).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return null
  }
}

// What a file is, from its first bytes (and for what only a name tells, its name): { kind, type, text }
function fileKind(b, name) {
  const is = (at, sig) => [...sig].every((c, i) => b[at + i] === (typeof c === 'string' ? c.charCodeAt(0) : c))
  if (is(0, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'image', type: 'image/png' }
  if (is(0, [0xff, 0xd8, 0xff])) return { kind: 'image', type: 'image/jpeg' }
  if (is(0, 'GIF8')) return { kind: 'image', type: 'image/gif' }
  if (is(0, 'RIFF') && is(8, 'WEBP')) return { kind: 'image', type: 'image/webp' }
  if (is(4, 'ftypavif')) return { kind: 'image', type: 'image/avif' }
  if (is(0, 'BM') && /\.bmp$/i.test(name)) return { kind: 'image', type: 'image/bmp' }
  if (is(0, [0, 0, 1, 0]) && /\.ico$/i.test(name)) return { kind: 'image', type: 'image/x-icon' }
  if (is(0, '%PDF-')) return { kind: 'pdf', type: 'application/pdf' }
  const text = textOf(b)
  if (text === null) return { kind: 'binary' }
  // (a drawing written as text: drawn as a picture, which runs nothing in it, with its words a click away)
  if (/\.svg$/i.test(name) && /<svg[\s>]/i.test(text.slice(0, 4000))) return { kind: 'image', type: 'image/svg+xml', text }
  return { kind: 'text', text, document: /\.(md|markdown|mdx)$/i.test(name) && text.length <= FILE_RENDERED }
}

function showFile(info, bytes, { target, home, m }) {
  const sep = info.sep === '\\' ? '\\' : '/'
  const dir = info.kind === 'dir' ? info.path : info.path.slice(0, Math.max(0, info.path.length - String(info.name).length - 1)) || sep
  fileBox.shown = { info, dir }
  const inside = home.cwd && info.path.startsWith(home.cwd) && /^[\\/]/.test(info.path.slice(home.cwd.length))
  el('file-name').textContent = info.name || info.path
  el('file-where').textContent = [inside ? info.path.slice(home.cwd.length + 1) : info.path, info.kind === 'dir' ? null : fileSize(info.size), m && machineName(m)].filter(Boolean).join(' · ')
  el('file-where').title = info.path
  // Found by its name, and not where the link said: said, with the other files it could have meant
  const others = (info.others ?? []).map((p) => h('a', { class: 'file-other', role: 'link', tabindex: 0, 'data-file': p }, home.cwd && p.startsWith(home.cwd + sep) ? p.slice(home.cwd.length + 1) : p))
  fileNote(info.exact ? '' : `Nothing is at "${target}". This is the nearest by name${others.length ? ', and it could also mean:' : '.'}`, { more: others })
  const body = el('file-body')
  if (info.kind === 'dir') return void body.replaceChildren(folderList(info, bytes, sep))
  el('file-save').href = fileUrl(bytes, 'application/octet-stream')
  el('file-save').download = info.name || 'file'
  el('file-save').hidden = false
  const is = fileKind(bytes, String(info.name ?? ''))
  const views = []
  if (is.kind === 'image') views.push(['Picture', () => pictureOf(fileUrl(bytes, is.type), info.name)])
  if (is.kind === 'text' && is.document && !info.line) views.push(['Document', () => documentOf(is.text)])
  if (is.text !== undefined) views.push(['Source', () => textLines(is.text, info)])
  if (is.kind === 'text' && is.document && info.line) views.push(['Document', () => documentOf(is.text)])
  if (is.kind === 'pdf') {
    el('file-open').href = fileUrl(bytes, is.type)
    el('file-open').hidden = false
  }
  if (!views.length) views.push(['', () => h('p', { class: 'file-plain' }, is.kind === 'pdf' ? 'A PDF. Open shows it in a tab of its own, and Save keeps a copy on this device.' : 'This is not a file that can be shown here. Save keeps a copy on this device.')])
  let at = 0
  const draw = () => {
    body.replaceChildren(views[at][1]())
    body.scrollTop = 0
    // (the other way of seeing it, where there are two)
    el('file-view').hidden = views.length < 2
    el('file-view').textContent = views[(at + 1) % views.length][0]
    body.querySelector('.pointed')?.scrollIntoView({ block: 'center' })
  }
  el('file-view').onclick = () => {
    at = (at + 1) % views.length
    draw()
  }
  draw()
}

// A picture, fitted to the box's width. One that is wider than that is drawn smaller than
// it is: a click on it shows it at its own size, with the place clicked kept where it was,
// and the box scrolls over the rest; another click fits it again.
function pictureOf(src, name) {
  const img = h('img', { src, alt: name })
  const box = h('div', { class: 'file-picture' }, img)
  const wider = () => img.naturalWidth > img.clientWidth
  // (the pointer over it says which, from how it is drawn then: the window may have been resized since it loaded)
  for (const when of ['load', 'pointerenter']) img.addEventListener(when, () => box.classList.toggle('grows', wider()))
  img.addEventListener('click', (ev) => {
    const was = img.getBoundingClientRect()
    if (!box.classList.toggle('full', !box.classList.contains('full') && wider())) return
    const now = img.getBoundingClientRect()
    const body = el('file-body')
    body.scrollLeft += now.left + ((ev.clientX - was.left) / was.width) * now.width - ev.clientX
    body.scrollTop += now.top + ((ev.clientY - was.top) / was.height) * now.height - ev.clientY
  })
  return box
}

function documentOf(text) {
  const node = h('div', { class: 'file-md md' })
  node.innerHTML = rendered(text)
  return node
}

// A file's text, a line to a row: numbered, and the lines the link points at marked
function textLines(text, info) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && !lines[lines.length - 1]) lines.pop()
  const from = info.line || 0
  const to = Math.max(from, info.to || 0)
  const pre = h('pre', { class: 'file-text' }, ...lines.slice(0, FILE_LINES).map((line, i) => h('span', { class: 'fl' + (i + 1 >= from && i + 1 <= to ? ' pointed' : ''), 'data-n': i + 1 }, line)))
  // (how wide the numbers are: set on the node, since the page's policy takes no style written as an attribute)
  pre.style.setProperty('--digits', String(Math.min(lines.length, FILE_LINES)).length)
  if (lines.length <= FILE_LINES) return pre
  return h('div', null, pre, h('p', { class: 'file-plain' }, `The first ${FILE_LINES.toLocaleString()} of its ${lines.length.toLocaleString()} lines are shown. Save keeps all of it on this device.`))
}

// A folder: what is in it, each a link to it
function folderList(info, bytes, sep) {
  let listing = {}
  try {
    listing = JSON.parse(new TextDecoder().decode(bytes))
  } catch {}
  const under = (name) => (info.path.endsWith(sep) ? info.path : info.path + sep) + name
  const up = info.path.replace(/[\\/]+$/, '').slice(0, Math.max(0, info.path.replace(/[\\/]+$/, '').lastIndexOf(sep)))
  const row = (to, name, size) => h('a', { class: 'file-entry', role: 'link', tabindex: 0, 'data-file': to }, h('span', null, name), size ? h('span', { class: 'file-entry-size' }, size) : null)
  const rows = (listing.entries ?? []).map((e) => row(under(e.name), e.kind === 'dir' ? e.name + sep : e.name, e.kind === 'dir' ? '' : fileSize(e.size)))
  return h(
    'div',
    { class: 'file-list' },
    up && row(up, '..' + sep, ''),
    ...rows,
    !rows.length && h('p', { class: 'file-plain' }, 'Nothing is in this folder.'),
    listing.more ? h('p', { class: 'file-plain' }, `And ${listing.more.toLocaleString()} more.`) : null,
  )
}

// ---- Composer

el('composer').addEventListener('submit', (ev) => {
  ev.preventDefault()
  send()
})

el('input').addEventListener('keydown', (ev) => {
  // Enter sends on a keyboard; on a phone Enter is a new line and the button sends
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !matchMedia('(pointer: coarse)').matches) {
    ev.preventDefault()
    send()
  }
})
el('input').addEventListener('input', () => {
  autosize()
  keepDraft()
})

// ---- Drafts: what's typed and not sent stays with its session on this device, so a
// look at another session, or a reload, doesn't lose it

// A session is one thing whether it's read as it reports or from its transcript
const draftKey = () => app.past?.sid ?? app.current
const DRAFTS_KEPT = 50

// What is typed and not sent is a session's as much as what is sent: it is kept on this
// device sealed with the account's key, or it is not kept. So only where this device has
// the key and is its owner's own; on any other a draft lasts as long as the page is open.
// (anything kept here in the open goes: nothing of a session is left on a device that way)
async function readDrafts() {
  let kept = null
  // (what is on its way to being kept is kept first: read before it, a draft just sent would be back)
  await draftsKept
  try {
    kept = localStorage.getItem('mc.drafts')
    if (kept && !sealing?.isSealed(kept)) localStorage.removeItem('mc.drafts')
  } catch {}
  const read = app.key && sealing?.isSealed(kept) ? await vault.open(kept, app.key, null) : null
  // (what was typed while they were being read stays)
  app.drafts = { ...(read && typeof read === 'object' ? read : {}), ...app.drafts }
}
let draftsKept = Promise.resolve()
function saveDrafts() {
  const held = app.key
  // (one after another, so that the last thing typed is the last thing kept)
  draftsKept = draftsKept.then(async () => {
    try {
      if (held?.own) localStorage.setItem('mc.drafts', await vault.seal(app.drafts, held))
      else localStorage.removeItem('mc.drafts')
    } catch {}
  })
}

function keepDraft() {
  const key = draftKey()
  if (!key) return
  const text = el('input').value
  if (text.trim()) app.drafts[key] = { text: text.slice(0, 20_000), at: Date.now() }
  else delete app.drafts[key]
  // The oldest make room
  const keys = Object.keys(app.drafts)
  for (const k of keys.sort((a, b) => app.drafts[a].at - app.drafts[b].at).slice(0, Math.max(0, keys.length - DRAFTS_KEPT))) delete app.drafts[k]
  saveDrafts()
}

function showDraft() {
  el('input').value = app.drafts[draftKey()]?.text ?? ''
  autosize()
}

function autosize() {
  const input = el('input')
  input.style.height = 'auto'
  // Hidden, it has no size to measure: the stylesheet's one line stands
  if (input.scrollHeight) input.style.height = input.scrollHeight + 'px'
}

async function send() {
  if (app.past) {
    const reply = el('input').value.trim()
    return reply ? resumePast(reply) : undefined
  }
  const sid = app.current
  const text = el('input').value.trim()
  if (!sid || (!text && !app.attachments.length && !app.uploading)) return
  buzz()
  const s = app.sessions.get(sid)
  // /model or /effort on its own opens the picker for it, as it does in a terminal
  const picker = /^\/(model|effort)$/.exec(text)
  if (picker && canSetOptions(s)) {
    el('input').value = ''
    autosize()
    keepDraft()
    return openFootMenu(picker[1] === 'model' ? 'model' : app.view === 'terminal' ? 'effort' : 'modes')
  }
  // One that has exited is started again on its machine by this reply, in the mode picked beside the box
  const m = s?.ended ? app.machines.get(s.machine) : null
  const mode = m ? resumeMode(m, s) : undefined
  const waiting = m ? `starting on ${machineName(m)}…` : s?.online ? 'sending…' : 'waiting for the session to reconnect…'
  const node = userNode([text], { note: app.uploading ? 'uploading the photo…' : waiting, pending: true })
  const entry = { text, node }
  app.pending.push(entry)
  tail()
  scrollToEnd()
  el('input').value = ''
  autosize()
  keepDraft()
  // Photos still on their way up go with this reply
  await app.uploads
  const photos = app.attachments.filter((p) => p.sid === sid && p.id)
  app.attachments = app.attachments.filter((p) => !photos.includes(p))
  renderChips()
  node.querySelector('.bubble').append(...photos.map((p) => thumb(p.name, p.url)))
  node.querySelector('.from').textContent = waiting
  if (!text && !photos.length) {
    // The only photo failed to upload: there's nothing left to send
    node.remove()
    app.pending = app.pending.filter((p) => p !== entry)
    return
  }
  // (the reply is signed here, with its photos' notes: what is typed here goes nowhere in the open, and where this
  // device cannot sign it, it is not sent)
  const plain = [text || 'See the attached photo.', ...photos.map(photoNote)].join('\n\n').trim()
  const to = app.sessions.get(sid) ?? s
  const order = await promptOrder(sid, to?.machine, !!(to?.ended || to?.hosted), { text: plain, mode })
  if (!order) {
    node.querySelector('.from').textContent = 'not sent: ' + NO_KEY
    return
  }
  const r = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // (its computer runs what the order says, and nothing goes beside it but which photos are its own; and, for a session
    // that has exited, which machine is to start it again: the server may not know where it ran. If the session's own
    // plugin could not take it, it says so in the chat; if its machine's agent could not, the answer here says why.)
    body: JSON.stringify({ attachments: photos.map((p) => p.id), order, ...(to?.ended && to.machine ? { machine: to.machine } : {}) }),
  })
  if (r.status === 401) return showLogin()
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    node.querySelector('.from').textContent = 'not sent: ' + (data.error ?? r.status)
    if (!m) return
    // Not started: it isn't on its way, and what was typed goes back where it can be sent again
    app.pending = app.pending.filter((p) => p !== entry)
    if (app.current === sid && !el('input').value) {
      el('input').value = text
      autosize()
      keepDraft()
    }
    return
  }
  // In the session's hands (or the server's, for one that's away), it waits there to be taken up
  if (!data.resumed && app.pending.includes(entry)) node.querySelector('.from').textContent = app.sessions.get(sid)?.online ? 'sent: waiting for Claude to take it up…' : waiting
  // Started again, it takes a moment to report. If it never does (the ManyClaws mod
  // isn't loaded there), its transcript on the machine is the way to follow it.
  if (data.resumed) {
    setTimeout(() => {
      if (app.current === sid && app.sessions.get(sid)?.ended && app.pending.includes(entry)) location.hash = `#/m/${m.id}/${encodeURIComponent(sid)}`
    }, 40_000)
  }
}

// ---- Photos: picked, pasted or dropped; shrunk, shown, uploaded, then sent with the reply

el('attach').addEventListener('click', () => el('file').click())
el('file').addEventListener('change', (ev) => {
  attachFiles(ev.target.files)
  ev.target.value = ''
})

// A screenshot or a copied image, pasted anywhere in the chat
document.addEventListener('paste', (ev) => {
  const target = ev.target
  const elsewhere = target instanceof HTMLElement && target !== el('input') && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  if (!canAttach() || elsewhere || !ev.clipboardData) return
  const images = imageFiles(ev.clipboardData)
  if (!images.length || isTextCopy(ev.clipboardData)) return
  ev.preventDefault()
  attachFiles(images)
  el('input').focus()
})

// Image files dragged onto the chat
el('chat').addEventListener('dragover', (ev) => {
  if (!canAttach() || !ev.dataTransfer?.types.includes('Files')) return
  ev.preventDefault()
  ev.dataTransfer.dropEffect = 'copy'
  el('composer').classList.add('dropping')
})
el('chat').addEventListener('dragleave', (ev) => {
  if (!el('chat').contains(ev.relatedTarget)) el('composer').classList.remove('dropping')
})
el('chat').addEventListener('drop', (ev) => {
  el('composer').classList.remove('dropping')
  if (!canAttach() || !ev.dataTransfer?.types.includes('Files')) return
  ev.preventDefault()
  attachFiles(imageFiles(ev.dataTransfer))
})

function canAttach() {
  return !!app.current && !el('chat').hidden && !el('composer').hidden
}

function imageFiles(data) {
  const files = [...(data.files ?? [])]
  // Some browsers list a pasted image only among the clipboard's items
  if (!files.length) {
    for (const item of data.items ?? []) {
      const file = item.kind === 'file' ? item.getAsFile() : null
      if (file) files.push(file)
    }
  }
  return files.filter((f) => f.type.startsWith('image/'))
}

// Text copied from a spreadsheet or a document comes with a picture of itself.
// That paste is the text; a copied image (no text, or web markup with an <img>) is the image.
function isTextCopy(data) {
  const html = data.getData('text/html')
  return !!data.getData('text/plain').trim() && (data.types.includes('text/rtf') || (!!html && !/<img\b/i.test(html)))
}

function attachFiles(files) {
  const sid = app.current
  for (const file of [...files].filter((f) => f.type.startsWith('image/'))) {
    app.uploading++
    // One at a time, so the photos keep the order they were added in
    app.uploads = app.uploads.then(() => upload(sid, file))
  }
}

// What a reply says of a photo, for Claude to fetch it by
const photoNote = (p) => `[Attachment ${p.id}: ${p.name} (${p.type}). Call the view_attachment tool with id "${p.id}" to see it.]`

async function upload(sid, file) {
  const entry = { sid, id: null, name: file.name || 'photo', url: '', type: '' }
  try {
    const { blob, type } = await shrink(file)
    entry.type = type
    const data = await toBase64(blob)
    // A photo goes sealed: only this page and the session's computer open it
    if (!app.key) throw new Error(NO_KEY)
    const sent = b64(await vault.sealBytes(new Uint8Array(await blob.arrayBuffer()), app.key))
    // Shown while it uploads. A data: address, which the page's security policy allows for images
    entry.url = `data:${type};base64,${data}`
    if (app.current === sid) {
      app.attachments.push(entry)
      renderChips()
    }
    const r = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // (its bytes and no more: what it is called and what kind of picture it is are in the note that goes with the reply, in the order)
      body: JSON.stringify({ data: sent }),
    })
    const meta = await r.json()
    if (!r.ok) throw new Error(meta.error ?? r.status)
    entry.id = meta.id
  } catch (err) {
    app.attachments = app.attachments.filter((p) => p !== entry)
    tell('Could not attach ' + entry.name, sentence(String(err.message ?? err)))
  } finally {
    app.uploading--
    renderChips()
  }
}

// Big photos are scaled to 1568 px on the long side, where Claude reads them at full
// detail, and sent as JPEG. A small PNG, GIF, WebP or JPEG file goes as it is, unless
// it's wider or taller than MAX_SIDE: a long conversation takes no image bigger than
// that (a screenshot of a wide window is a small file with a great many pixels across),
// so it's scaled to fit, and a PNG stays one, for the sharpness of its text.
const MAX_SIDE = 2000
async function shrink(file) {
  const small = file.size < 1_000_000 && ['image/png', 'image/gif', 'image/webp', 'image/jpeg'].includes(file.type)
  const bitmap = await createImageBitmap(file).catch((err) => (small ? null : Promise.reject(err)))
  if (small && (!bitmap || Math.max(bitmap.width, bitmap.height) <= MAX_SIDE)) return { blob: file, type: file.type }
  const scale = Math.min(1, (small ? MAX_SIDE : 1568) / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const as = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85))
  const png = small && file.type === 'image/png' ? await as('image/png') : null
  if (png && png.size < 4_000_000) return { blob: png, type: 'image/png' }
  return { blob: await as('image/jpeg'), type: 'image/jpeg' }
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function renderChips() {
  const box = el('chips')
  const mine = app.attachments.filter((p) => p.sid === app.current)
  box.hidden = !mine.length
  box.replaceChildren(
    ...mine.map((p) =>
      h(
        'div',
        { class: 'chip-photo' + (p.id ? '' : ' uploading'), title: p.id ? p.name : 'Uploading ' + p.name + '…' },
        h('img', { src: p.url, alt: p.name }),
        h(
          'button',
          {
            type: 'button',
            class: 'chip-remove',
            'aria-label': 'Remove',
            onclick: () => {
              app.attachments = app.attachments.filter((x) => x !== p)
              renderChips()
            },
          },
          '×',
        ),
      ),
    ),
  )
  autosize()
}

// ---- Time

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

function time(ts) {
  return new Date(ts).toLocaleString()
}

// ---- On a phone: the keyboard, gestures, and what an app on the home screen can do

// A short tap of the motor, where the device has one to tap with
function buzz(ms = 10) {
  try {
    navigator.vibrate?.(ms)
  } catch {}
}

// The keyboard covers the bottom of the page without making it any shorter (iOS). The
// app is made as tall as what's left to see, so the reply box sits on the keyboard.
if (window.visualViewport) {
  const fit = () => {
    const covered = visualViewport.scale === 1 && innerHeight - visualViewport.height > 80
    const box = el('messages')
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120
    if (covered) document.documentElement.style.setProperty('--app-height', visualViewport.height + 'px')
    else document.documentElement.style.removeProperty('--app-height')
    // The browser scrolls the page up to show what's being typed in; the app has already made room
    if (covered) scrollTo(0, 0)
    if (nearEnd) scrollToEnd()
  }
  visualViewport.addEventListener('resize', fit)
  visualViewport.addEventListener('scroll', fit)
}

// Turned on its side, or a window made narrow: the header is worded for the layout it's in
matchMedia('(max-width: 760px)').addEventListener('change', () => {
  if (app.current) renderHeader()
  if (app.past) renderPastHeader()
})

// What's kept out of the way on a phone: where prompts are answered, the look, Exit and Remove
el('more').addEventListener('click', () => {
  const open = el('more').closest('.chat-head').classList.toggle('more-open')
  el('more').setAttribute('aria-expanded', String(open))
})

// Back to the latest, offered once the chat has been scrolled well away from it
el('messages').addEventListener(
  'scroll',
  () => {
    const box = el('messages')
    const away = box.scrollHeight - box.scrollTop - box.clientHeight
    el('latest').hidden = away < 600
    if (away < 120) el('latest').classList.remove('fresh')
    pinSoon()
  },
  { passive: true },
)

// ---- The prompt in sight: the rows at the top of the chat answer some prompt, and while
// they're scrolled through it stays above them, as the extension keeps it. It's the last
// prompt that has gone off the top; or, when the rows drawn start partway through a long
// turn, the one the server said came before them. A prompt still showing at the top
// needs no second copy.
function pinNow() {
  const box = el('messages')
  const bar = el('pinned')
  const top = box.getBoundingClientRect().top
  const prompts = box.querySelectorAll(':scope > .msg.user:not(.pending)')
  let text = app.current || app.past ? (app.promptBefore?.text ?? null) : null
  for (let i = prompts.length - 1; i >= 0; i--) {
    const r = prompts[i].getBoundingClientRect()
    if (r.top >= top - 2) continue
    text = r.bottom > top + 12 ? null : (prompts[i]._prompt ?? prompts[i].querySelector('.bubble')?.textContent ?? null)
    break
  }
  // (nothing above the first row to belong to: a chat that isn't a window onto a longer one, at its top)
  if (text !== null) text = text.replace(ATTACHMENT_NOTE, ' [photo]').trim()
  bar.hidden = !text
  if (!text || bar.dataset.text === text) return
  bar.dataset.text = text
  bar.classList.remove('open')
  bar.firstElementChild.textContent = text
}
let pinFrame = 0
function pinSoon() {
  if (pinFrame) return
  pinFrame = requestAnimationFrame(() => {
    pinFrame = 0
    pinNow()
  })
}
el('pinned').addEventListener('click', () => el('pinned').classList.toggle('open'))
// Rows come and go (a session opened, one put back, earlier ones read, a reply arriving), and the room for them changes
new MutationObserver(pinSoon).observe(el('messages'), { childList: true })
window.addEventListener('resize', pinSoon)
// And rows move without any of that being said: lines wrap again in a new width, a long result folds, a photo arrives.
// So it's looked at again now and then while a chat is showing; it costs a few measurements.
setInterval(() => !document.hidden && (app.current || app.past) && pinSoon(), 600)
el('latest').addEventListener('click', () => {
  el('latest').classList.remove('fresh')
  el('messages').scrollTo({ top: el('messages').scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
})

// A tap on the chat's title goes to the top of what's loaded, as a tap on a phone's top bar does
document.querySelector('#chat .chat-title').addEventListener('click', () => {
  if (matchMedia('(pointer: coarse)').matches && !String(getSelection())) el('messages').scrollTo({ top: 0, behavior: 'smooth' })
})

// Dragged to the right, the chat goes back to the list: a phone's own gesture for
// "back", which an app on the home screen doesn't get from a browser
{
  const pane = el('chat-pane')
  const SLOP = 12
  let drag = null // { x, y, at, dx, on }: `on` once it's clearly a drag to the right
  // Something under the finger that scrolls sideways itself takes the drag
  const scrollsSideways = (node) => {
    for (let n = node; n && n !== pane; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true
    }
    return false
  }
  const finish = (back) => {
    const done = () => {
      pane.removeEventListener('transitionend', done)
      clearTimeout(timer)
      if (back) location.hash = ''
      document.body.classList.remove('swiping', 'settling')
      pane.style.transform = ''
    }
    document.body.classList.add('settling')
    pane.style.transform = back ? 'translateX(100%)' : 'translateX(0)'
    pane.addEventListener('transitionend', done)
    const timer = setTimeout(done, 260)
  }
  pane.addEventListener(
    'touchstart',
    (ev) => {
      drag = null
      const t = ev.touches[0]
      if (ev.touches.length !== 1 || !phoneLayout() || !document.body.classList.contains('chat-open')) return
      // In a browser the very edge is the browser's own way back
      if (!isStandalone() && t.clientX < 24) return
      if (ev.target.closest('textarea, input, select, .composer') || scrollsSideways(ev.target)) return
      drag = { x: t.clientX, y: t.clientY, at: Date.now(), dx: 0, on: false }
    },
    { passive: true },
  )
  pane.addEventListener(
    'touchmove',
    (ev) => {
      if (!drag) return
      const t = ev.touches[0]
      const dx = t.clientX - drag.x
      const dy = t.clientY - drag.y
      if (!drag.on) {
        // Up or down first is a scroll, and stays one
        if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) return void (drag = null)
        if (dx < SLOP || Math.abs(dx) < 1.6 * Math.abs(dy)) return
        // The browser has taken the touch for a scroll of its own: it's left to it
        if (!ev.cancelable) return void (drag = null)
        drag.on = true
        document.body.classList.remove('settling')
        document.body.classList.add('swiping')
      }
      if (ev.cancelable) ev.preventDefault()
      drag.dx = Math.max(0, dx)
      pane.style.transform = `translateX(${drag.dx}px)`
    },
    { passive: false },
  )
  const end = () => {
    if (!drag?.on) return void (drag = null)
    const fast = drag.dx / Math.max(1, Date.now() - drag.at) > 0.5 && drag.dx > 40
    const back = drag.dx > Math.min(140, innerWidth * 0.35) || fast
    drag = null
    if (back) buzz()
    finish(back)
  }
  pane.addEventListener('touchend', end)
  pane.addEventListener('touchcancel', end)
}

// Pulled down from its top, the list is read again from the server and its machines
{
  const list = el('session-list')
  const pull = el('pull')
  const READY = 56
  let from = null
  let height = 0
  const show = (h) => {
    height = h
    pull.style.height = h + 'px'
    const ready = h >= READY
    if (ready && !pull.classList.contains('ready')) buzz()
    pull.classList.toggle('ready', ready)
    if (!pull.classList.contains('busy')) pull.querySelector('.pull-text').textContent = ready ? 'Release to refresh' : 'Pull to refresh'
  }
  const refresh = async () => {
    pull.classList.add('busy')
    pull.querySelector('.pull-text').textContent = 'Refreshing…'
    show(40)
    // The stream is opened again: its first word is everything as it stands
    await new Promise((done) => {
      app.onSnapshot = done
      connect()
      setTimeout(done, 5000)
    })
    pull.classList.remove('busy', 'ready')
    show(0)
  }
  list.addEventListener(
    'touchstart',
    (ev) => {
      // (a finger on a favorite's grip is moving the favorite, not pulling the list)
      from = ev.touches.length === 1 && list.scrollTop <= 0 && !pull.classList.contains('busy') && !ev.target.closest('.grip') ? ev.touches[0].clientY : null
    },
    { passive: true },
  )
  list.addEventListener(
    'touchmove',
    (ev) => {
      if (from === null) return
      const pulled = ev.touches[0].clientY - from
      if (pulled <= 0 || list.scrollTop > 0) return void (height && show(0))
      if (ev.cancelable) ev.preventDefault()
      // Half as far as the finger, and no further than is needed to say so
      show(Math.min(84, pulled * 0.5))
    },
    { passive: false },
  )
  const end = () => {
    if (from === null) return
    from = null
    if (height >= READY) refresh()
    else show(0)
  }
  list.addEventListener('touchend', end)
  list.addEventListener('touchcancel', end)
}

// ---- An account's own pages: how to set a computer up, and the account itself

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Where the browser keeps the clipboard to itself (an address that isn't https): by selection
    const box = h('textarea', { class: 'offscreen', 'aria-hidden': 'true' })
    box.value = text
    document.body.append(box)
    box.select()
    document.execCommand('copy')
    box.remove()
  }
}

// What a page section holds, in place of what it held (parts that don't apply, written as false, left out)
const fill = (node, ...children) => node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false))

// Something to paste into a terminal or a file, with a button that copies it
function codeBox(text) {
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'ghost copy',
      onclick: async () => {
        await copyText(text)
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1500)
      },
    },
    'Copy',
  )
  return h('div', { class: 'code-box' }, h('pre', { class: 'code' }, text), copy)
}

// A page of its own takes the chat's place
function leaveChat() {
  clearInterval(pastTimer)
  leaveView()
  app.current = null
  app.past = null
  document.body.classList.add('chat-open')
  el('empty').hidden = true
  el('chat').hidden = true
  renderList()
}

async function openGuide(which) {
  leaveChat()
  if (!(await loadAccount())) return showLogin()
  if (which === 'setup') renderSetup()
  else if (which === 'account/password') renderPassword()
  else if (which === 'account/unopened') renderUnopened()
  else renderAccount()
}

// ---- A computer's own page (#/computer/<machine>), from the gear by its name in the list:
// first what it needs, where it needs something (its plugin or its agent is older than the
// one the server hands out, or its agent is not running), with a line to paste into Claude
// Code there that sees to it; the color its name is shown in wherever a session says which
// computer it is on; a new session on it, asked for as the box over a chat asks for one (a
// project, and New); which plugin and agent it has; and at the foot, where the computer
// has cswap (claude-swap), the Claude accounts Claude Code can be switched between there.
// It is laid out and dressed as the account's page is. A computer with no agent has no
// machine, and a page all the same (#/computer/~<its host's name>), where it needs
// something: what it needs, and which plugin it has.

// What a computer's page is for, said where its name is pointed at
const computerSays = (m) => `The color ${machineName(m)} is shown in, a new session on it${m?.capabilities?.includes('cswap') ? ', and the Claude accounts on it' : ''}`

function closeComputer() {
  clearInterval(swapTimer)
  app.swap = null
  app.computer = null
}

async function openComputer(mid) {
  closeComputer()
  const c = (app.computer = { mid, known: false, said: '', cwd: '', mode: '', read: false, reading: false, starting: false, error: '', colorError: '' })
  leaveChat()
  renderComputer()
  // (which computers the account has, and what each allows, is known once the stream has said)
  await snapshotSeen
  if (app.computer !== c) return
  c.known = true
  renderComputer()
}

// The color is the account's, kept with the computer on the server: shown here at once,
// and on every page of the account's when the server says so
async function colorComputer(color) {
  const c = app.computer
  const m = app.machines.get(c?.mid)
  if (!m || (m.color ?? '') === color) return
  const was = m.color ?? ''
  const show = (now) => {
    const at = app.machines.get(c.mid)
    if (at) at.color = now
    if (app.computer === c) renderComputer()
    renderList()
    if (app.past?.mid === c.mid) renderPastHeader()
    else if (app.sessions.get(app.current)?.machine === c.mid) renderHeader()
  }
  c.colorError = ''
  show(color)
  const r = await fetch('/api/machines/' + c.mid, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ color }) }).catch(() => null)
  if (r?.ok) return
  c.colorError = ((await r?.json().catch(() => null))?.error ?? 'The server could not be reached') + ': the color is as it was.'
  show(was)
}

// A new session there: empty, in the project chosen, as New in the box over a chat makes
// one (newSession), and on to it the same way. There is no session it is made from.
async function startOnComputer() {
  const c = app.computer
  const m = app.machines.get(c?.mid)
  if (!m || c.starting || !c.cwd) return
  const say = (error) => {
    c.starting = false
    c.error = error
    if (app.computer === c) renderComputer()
  }
  const cwd = c.cwd
  const mode = m.spawn?.modes?.includes(c.mode) ? c.mode : undefined
  // (signed for that computer: where this device cannot sign, nothing is sent)
  const order = await orderFor(c.mid, 'branch', { how: 'new', cwd, mode, listed: wantsListed() })
  if (!order) return say(NO_KEY_MACHINE)
  c.starting = true
  c.error = ''
  renderComputer()
  const r = await fetch(`/api/machines/${c.mid}/branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ how: 'new', order }) }).catch(() => null)
  const data = (await r?.json().catch(() => ({}))) ?? {}
  if (!r?.ok) return say((data.error ?? 'The session could not be started.') + whyOf(data))
  // (the project and the permissions are the ones offered next time, here and on the page a session is started from with a prompt)
  try {
    const last = lastNew()
    localStorage.setItem('mc.new', JSON.stringify({ ...last, ...(mode ? { mode } : {}), cwd: { ...last.cwd, [c.mid]: cwd } }))
  } catch {}
  c.starting = false
  // (someone who has gone elsewhere meanwhile is left there: the session is in the list)
  if (app.computer === c) openBranched(data.sid, c.mid)
}

// The Claude accounts on it, where it has cswap: read as its page opens and while it is looked at
function watchCswap(m) {
  if (app.swap || !m?.online || !m.capabilities?.includes('cswap')) return
  app.swap = { mid: m.id, data: null, error: '', said: '', busy: 0, reading: false }
  loadCswap()
  // (as its own dashboard does, it's read again while it's looked at)
  clearInterval(swapTimer)
  swapTimer = setInterval(() => document.visibilityState === 'visible' && !app.swap?.busy && loadCswap(), 60_000)
}

// What a computer's page has to say of what the computer needs, as one thing to tell a change by (renderList draws the page again on one)
function computerSaid(id) {
  const c = computerOf(id)
  return JSON.stringify([needsOf(c), c ? [pluginOn(c), c.live.length, c.m?.online, c.m?.agent, c.m?.refused, c.m?.stalled, c.m?.hosted?.length] : null, app.latest])
}

// What it needs, first on its page: each thing said, then the one line to paste into Claude Code on the computer, which
// does all of it from the guide, and the way to the guide for doing it by hand
function needsPart(c) {
  const needs = needsOf(c)
  if (!needs.length) return null
  const guide = (app.account?.server ?? location.origin) + '/setup'
  const name = c.name
  const hosted = c.m?.hosted?.length ?? 0
  const said = {
    'agent-down': () => [h('b', null, `The agent isn't running on ${name}.`), ' No new session can be started on it, and its past sessions cannot be opened or searched, until it is. The sessions heard from there now go on as they are.'],
    'agent-stalled': () => [
      h('b', null, `The agent on ${name} has stopped answering.`),
      ' It is running, and says so, but it no longer asks for what to do: so no session can be started on it, and its past sessions cannot be opened or searched, until it is started again. The sessions heard from there now go on as they are. By hand, on a Mac: ',
      h('code', null, 'launchctl kickstart -k gui/$(id -u)/com.manyclaws.agent'),
      '; on Linux: ',
      h('code', null, 'systemctl --user restart manyclaws-agent'),
      '.',
    ],
    'agent-old': (n) =>
      n.heard === false
        ? [h('b', null, `The agent on ${name} was ${n.has} when it was last heard from, and ${n.newest} is the newest.`), ` ${name} is not connected now: update it there when it is.`]
        : [
            h('b', null, `The agent on ${name} is ${n.has}, and ${n.newest} is the newest.`),
            hosted
              ? ` Updating it starts it again, which ends the ${hosted === 1 ? 'session it is running now, one started from this page' : hosted + ' sessions it is running now, the ones started from this page'}. Do it from a session started on ${name} itself, in a terminal or VS Code: one started from this page is run by the agent, and cannot update it.`
              : ` Updating it starts it again. Do it from a session started on ${name} itself, in a terminal or VS Code: one started from this page is run by the agent, and cannot update it.`,
          ],
    'agent-refused': (n) => [
      h('b', null, `The agent on ${name} is ${n.has ? n.has + ', ' : ''}too old for this server to hear.`),
      `${n.newest ? ` The newest is ${n.newest}.` : ''} Until it is updated, no session can be started on ${name} from here, and its past sessions cannot be opened or searched.`,
      c.live.length ? '' : ` No session on ${name} is heard from either, so its plugin may be as old: the line below updates both.`,
    ],
    'plugin-old': (n) => [h('b', null, `The plugin on ${name} is ${n.has}, and ${n.newest} is the newest.`), ' A session that is already open keeps the plugin it started with: once the plugin is updated, this is gone as soon as a new session starts there.'],
  }
  // (what the line asks for: what is old is updated, and an agent that is not running is got running)
  const has = (kind) => needs.some((n) => n.kind === kind)
  // (an agent too old to be heard, on a computer no session is heard from either: its plugin is taken to be as old)
  const old = [has('plugin-old') || (has('agent-refused') && !c.live.length) ? 'plugin' : '', has('agent-old') || has('agent-refused') ? 'agent' : ''].filter(Boolean)
  const down = has('agent-down')
  const stalled = has('agent-stalled')
  const tasks = [old.length ? `update the ManyClaws ${old.join(' and ')}` : '', down ? (old.length ? 'get its agent running' : 'get the ManyClaws agent running') : '', stalled ? (old.length ? 'start its agent again' : 'start the ManyClaws agent again') : ''].filter(Boolean)
  return accountPart(
    'Needs attention',
    { id: 'computer-needs', 'data-key': 'needs' },
    h('div', { class: 'needs' }, ...needs.map((n) => h('p', { 'data-need': n.kind }, ...said[n.kind](n)))),
    h('p', { 'data-part': 'needs-say' }, `On ${name}, start Claude Code and paste this:`),
    codeBox(`Read ${guide}.md and ${tasks.join(' and ')} on this computer.`),
    h('p', null, h('a', { href: guide + '#keeping-it-up-to-date-and-running', target: '_blank', rel: 'noopener', id: 'computer-guide' }, down || stalled ? 'How to get the agent running' : 'Or update it by hand')),
  )
}

// Which plugin and which agent it has, as they say themselves, and how each stands against the one the server hands out
function versionsPart(c) {
  const stands = (has, newest) => (!versionOf(has) || !versionOf(newest) ? '' : behind(has, newest) ? `: ${newest} is the newest` : ', the newest')
  const m = c.m
  const plugin = pluginOn(c)
  const agent = !m
    ? 'Agent: none is connected.'
    : m.refused
      ? `Agent${versionOf(m.agent) ? ' ' + m.agent : ''}: too old for this server to hear${versionOf(app.latest.agent) ? `. The newest is ${app.latest.agent}` : ''}.`
      : !m.agent
        ? `Agent: ${m.online ? 'it does not say which it is' : 'not heard from'}.`
        : m.online
          ? `Agent ${m.agent}${stands(m.agent, app.latest.agent)}.`
          : `Agent ${m.agent}, when it was last heard from${behind(m.agent, app.latest.agent) ? `: ${app.latest.agent} is the newest` : ''}.`
  return accountPart(
    'Plugin and agent',
    { id: 'computer-versions', 'data-key': 'versions' },
    h('p', { 'data-part': 'agent-version' }, agent),
    h('p', { 'data-part': 'plugin-version' }, plugin ? `Plugin ${plugin}${stands(plugin, app.latest.plugin)}, as the ${count(c.live.length, 'session')} heard from there now ${c.live.length === 1 ? 'says' : 'say'}.` : `Plugin: it is a session that says which, and none on ${c.name} is heard from now.`),
  )
}

function renderComputer() {
  const c = app.computer
  if (!c) return
  c.said = computerSaid(c.mid)
  const at = computerOf(c.mid)
  const m = at?.m ?? null
  // (one with no machine: known by its host's name, and by the sessions heard from on it)
  const loose = !m && String(c.mid).startsWith('~')
  // A computer that had no agent and has one now is that machine: its page is the machine's
  const since = loose && c.known ? [...app.machines.values()].find((x) => x.name === c.mid.slice(1)) : null
  if (since) return void location.replace('#/computer/' + since.id)
  const name = at?.name ?? (loose ? c.mid.slice(1) : machineName(m))
  const says = m ? computerSays(m) : loose ? `What ${name} needs` : ''
  // (dressed as the site, the page opens with its name, large, as the account's opens with its email: over that it says what this is)
  el('computer-name').textContent = (m || loose) && !document.documentElement.dataset.site ? name : 'Computer'
  el('computer-sub').textContent = says
  const body = el('computer-body')
  if (!m && !loose) return redraw(body, [h('p', { class: 'muted', 'data-key': 'none' }, c.known ? 'This is not one of your computers. It may have been removed.' : 'Reading…')])
  if (!m && !at) return redraw(body, [h('p', { class: 'muted', 'data-key': 'none' }, c.known ? `No session on ${name} is heard from now, and no agent of yours is connected there: there is nothing to say of it.` : 'Reading…')])
  if (!m) return redraw(body, [accountHead('Computer', name, says + '.'), needsPart(at), versionsPart(at)].filter(Boolean))
  watchCswap(m)
  const colors = accountPart(
    'Color',
    { id: 'computer-color', 'data-key': 'color' },
    h(
      'div',
      { class: 'mk-colors', role: 'group', 'aria-label': 'Color' },
      ['', ...MARK_COLORS].map((color) => h('button', { type: 'button', class: 'mk-color', 'data-color': color, 'aria-pressed': String((m.color ?? '') === color), 'aria-label': color || 'No color', title: color ? color[0].toUpperCase() + color.slice(1) : 'No color', onclick: () => colorComputer(color) })),
    ),
    h('p', { class: 'muted' }, 'Wherever a session says which computer it is on, ', m.color ? whereLabel(name, m.id) : name, m.color ? ' is a label in this color: in the list, over a chat, and in what a search finds.' : ' is said plainly. Give it a color and it is a label in that color: in the list, over a chat, and in what a search finds.'),
    c.colorError && h('p', { class: 'form-note error', role: 'alert' }, c.colorError),
  )
  redraw(body, [accountHead('Computer', name, computerSays(m) + '.'), needsPart(at), colors, newPart(c, m), versionsPart(at), cswapPart(m)].filter(Boolean))
  // (what is chosen is this page's to say: a drawing leaves what a hand has changed as it is)
  const set = (id, value) => el(id) && el(id).value !== value && (el(id).value = value)
  set('computer-project', c.cwd)
  set('computer-mode', c.mode)
  if (el('computer-listed')) el('computer-listed').checked = wantsListed()
}

// A new session on it: the project, what it may do without asking, and New
function newPart(c, m) {
  const name = machineName(m)
  const part = (...body) => accountPart('New session', { id: 'computer-new', 'data-key': 'new' }, ...body)
  if (!m.online) return part(h('p', { class: 'muted' }, `${name} is offline. A session can be started on it when it is connected again.`))
  if (!m.spawn) return part(h('p', { class: 'muted' }, `Starting sessions is turned off on ${name} (its agent.json, "spawn").`))
  if (!app.key) return part(h('p', { class: 'muted' }, NO_KEY_MACHINE))
  // Its projects, as the box over a chat lists a device's: read from it where there are none yet, and once more as
  // the page opens where they are a minute old (not again and again while it stays open)
  const known = newProjects.get(c.mid)
  if ((!known?.list || (!c.read && Date.now() - known.at > 60_000)) && !c.reading) {
    c.reading = c.read = true
    readProjects(c.mid).then(() => {
      c.reading = false
      if (app.computer === c) renderComputer()
    })
  }
  const all = (known?.list ?? []).flatMap(([, cwds]) => cwds)
  // (the one a session was last started in there, from this device; else the first)
  if (all.length && !all.includes(c.cwd)) c.cwd = all.find((cwd) => cwd === lastNew().cwd?.[c.mid]) ?? all[0]
  const modes = m.spawn?.modes ?? ['default']
  if (!modes.includes(c.mode)) c.mode = modes.includes(lastNew().mode) ? lastNew().mode : modes[0]
  const option = (cwd) => h('option', { value: cwd, title: cwd }, folderName(cwd) + (all.filter((x) => folderName(x) === folderName(cwd)).length > 1 ? '  —  ' + cwd : ''))
  const projects = !known?.list
    ? [h('option', { value: '' }, 'Reading the projects…')]
    : all.length
      ? known.list.filter(([, cwds]) => cwds.length).map(([label, cwds]) => h('optgroup', { label }, ...cwds.map(option)))
      : [h('option', { value: '' }, 'No folder to start one in')]
  return part(
    h(
      'form',
      {
        class: 'guide-form',
        id: 'computer-new-form',
        onsubmit: (ev) => {
          ev.preventDefault()
          startOnComputer()
        },
      },
      h('label', { class: 'guide-field' }, 'Project', h('select', { id: 'computer-project', disabled: c.starting, onchange: (ev) => (c.cwd = ev.target.value) }, ...projects)),
      h('label', { class: 'guide-field' }, 'Permissions', h('select', { id: 'computer-mode', disabled: c.starting, onchange: (ev) => (c.mode = ev.target.value) }, ...modes.map((mode) => h('option', { value: mode }, PERMISSION_MODES[mode]?.[0] ?? mode)))),
      h('label', { class: 'guide-check', title: LISTED_HINT }, h('input', { type: 'checkbox', id: 'computer-listed', disabled: c.starting, onchange: (ev) => keepListed(ev.target.checked) }), "Show in VS Code's resume list"),
      h('div', { class: 'guide-end' }, h('button', { type: 'submit', class: 'primary', id: 'computer-start', disabled: c.starting || !all.length }, c.starting ? `Starting on ${name}…` : 'New')),
      c.error && h('p', { class: 'form-note error', role: 'alert', id: 'computer-error' }, c.error),
    ),
    h('p', { class: 'muted' }, 'An empty session in that project: it opens here, and waits for its first prompt. ', h('a', { href: '#/new/' + m.id, id: 'computer-longer' }, 'Start one with a first prompt, a model, or in another folder')),
  )
}

const SWAP_NOTES = {
  token_expired: 'token expired — refresh deferred this pass; retries automatically',
  foreign_credential: 'live credential belongs to another account — a switch repairs it',
  api_key: 'API key (no quota)',
  keychain_unavailable: 'keychain unavailable — locked or in use; try again',
  relogin_required: 're-login needed — refresh token dead; log in with Claude Code, then run: cswap add',
  no_credentials: 'no credentials',
  unavailable: 'usage unavailable',
}
let swapTimer = 0

// Reads the accounts from the machine: what it says, or why it couldn't
async function loadCswap() {
  const swap = app.swap
  if (!swap) return
  // (asked as a machine is asked to read anything: sealed)
  const r = app.key ? await fetch(`/api/machines/${swap.mid}/cswap?` + (await askOf())).catch(() => null) : null
  const data = app.key ? await r?.json().catch(() => null) : { error: NO_KEY_MACHINE }
  if (app.swap !== swap) return
  if (r?.ok) Object.assign(swap, { data, error: '' })
  else swap.error = data?.error ?? 'The server could not be reached.'
  renderComputer()
}

async function switchCswap(a) {
  const swap = app.swap
  const m = app.machines.get(swap.mid)
  if (swap.busy || !(await ask(`Switch Claude Code on ${machineName(m)} to ${a.email}?`, { yes: 'Switch' })) || app.swap !== swap || swap.busy) return
  Object.assign(swap, { busy: a.number, said: '', error: '' })
  renderComputer()
  // (which account is in an order for the machine, signed here: where this device cannot sign, nothing is sent)
  const order = await orderFor(swap.mid, 'cswap', { to: a.number })
  const r = order ? await fetch(`/api/machines/${swap.mid}/cswap/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }) }).catch(() => null) : null
  const data = order ? await r?.json().catch(() => null) : { error: NO_KEY_MACHINE }
  if (app.swap !== swap) return
  swap.busy = 0
  if (r?.ok) {
    swap.data = data
    swap.said = data.switched ? `Switched to ${data.to?.email ?? a.email}.` : `Not switched${data.reason ? ': ' + data.reason : '.'}`
  } else swap.error = data?.error ?? 'The server could not be reached.'
  renderComputer()
}
async function refreshCswap() {
  const swap = app.swap
  if (!swap || swap.reading) return
  Object.assign(swap, { reading: true, said: '' })
  renderComputer()
  await loadCswap()
  swap.reading = false
  if (app.swap === swap) renderComputer()
}

// How long ago, as cswap says it: 5m, 3h 12m, 1d 6h
function span(seconds) {
  const m = Math.floor(seconds / 60)
  if (m < 60) return m + 'm'
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

// When a window of usage starts over: how long from now, and the time it does, by this device's clock
function resetText(w) {
  const at = Date.parse(w.resetsAt ?? '')
  if (!at) return w.countdown ? `resets ${w.countdown} · ${w.clock}` : ''
  const left = Math.max(0, (at - Date.now()) / 1000)
  const d = new Date(at)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const sameDay = d.toDateString() === new Date().toDateString()
  return `resets ${span(left)} · ${sameDay ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm}`
}

// The last part of a computer's page, where the computer has cswap
function cswapPart(m) {
  if (!m.capabilities?.includes('cswap')) return null
  const part = (...body) => accountPart('cswap', { id: 'computer-swap', 'data-key': 'swap' }, ...body)
  const swap = app.swap
  if (!swap) return part(h('p', { class: 'muted', id: 'cswap-sub' }, `${machineName(m)} is offline. The Claude accounts on it are read when it is connected again.`))
  // One window of an account's usage: its name, how much is used, and when it starts over
  const bar = (name, w) => {
    const fill = h('span', { class: 'swap-fill' })
    fill.style.width = Math.min(100, Math.max(0, w.pct)) + '%'
    return h('div', { class: 'swap-bar' + (w.pct >= 90 ? ' high' : w.pct >= 70 ? ' mid' : '') }, h('span', { class: 'swap-name' }, name), h('span', { class: 'swap-track' }, fill), h('span', { class: 'swap-pct' }, Math.round(w.pct) + '%'), h('span', { class: 'swap-reset' }, resetText(w) + (w.aheadOfPace ? ' (ahead of pace)' : '')))
  }
  const bars = (u) => [u.fiveHour && bar('5h', u.fiveHour), u.sevenDay && bar('7d', u.sevenDay), ...u.scoped.map((w) => bar(w.name || 'model', w))]
  const account = (a) => {
    const lastSeen = a.lastGoodUsage && Math.max(a.lastGoodUsage.fiveHour?.pct ?? 0, a.lastGoodUsage.sevenDay?.pct ?? 0)
    const age = a.usage ? a.usageAgeSeconds : null
    return h(
      'div',
      { class: 'swap-account' + (a.active ? ' active' : '') + (a.disabled ? ' off' : ''), 'data-number': String(a.number) },
      h(
        'div',
        { class: 'swap-head' },
        h('span', { class: 'swap-number' }, String(a.number)),
        h('span', { class: 'swap-email' }, a.email),
        a.alias && h('span', { class: 'swap-org' }, `(${a.alias})`),
        a.organizationName && h('span', { class: 'swap-org' }, `[${a.organizationName}]`),
        a.active && h('span', { class: 'swap-active' }, '● active'),
        a.disabled && h('span', { class: 'swap-org' }, 'held out of rotation'),
        age >= 120 && h('span', { class: 'swap-org' }, `· ${span(age)} ago`),
        !a.active && h('button', { type: 'button', class: 'ghost swap-switch', disabled: !!swap.busy, onclick: () => switchCswap(a) }, swap.busy === a.number ? 'Switching…' : 'Switch'),
      ),
      a.usage ? bars(a.usage) : h('div', { class: 'swap-note' + (a.usageStatus === 'api_key' ? '' : ' warn') }, (a.usageStatus === 'api_key' ? '' : '⚠ ') + (SWAP_NOTES[a.usageStatus] ?? a.usageStatus)),
      !a.usage && a.lastGoodUsage && h('div', { class: 'swap-note' }, `└ last seen ${Math.round(lastSeen)}% used · ${span(a.lastGoodAgeSeconds ?? 0)} ago`),
    )
  }
  return part(
    h('div', { class: 'swap-top' }, h('p', { class: 'muted', id: 'cswap-sub' }, `The Claude accounts on ${machineName(m)}`), h('button', { type: 'button', id: 'cswap-refresh', class: 'ghost', disabled: swap.reading, onclick: refreshCswap }, 'Refresh')),
    h(
      'div',
      { id: 'cswap-body', class: 'swap' },
      swap.error && h('p', { class: 'swap-said error' }, swap.error),
      swap.said && h('p', { class: 'swap-said' }, swap.said),
      !swap.data && !swap.error && h('p', { class: 'muted' }, 'Asking the machine…'),
      swap.data && !swap.data.accounts.length && h('p', { class: 'muted' }, 'cswap has no accounts on this machine yet. Add one there with: cswap add'),
      (swap.data?.accounts ?? []).map(account),
      swap.data?.accounts.length > 0 && h('p', { class: 'muted swap-foot' }, `Switch changes the account Claude Code uses on ${machineName(m)}. Sessions that are running there usually pick it up by themselves (on a Mac, after a little while); restarting one applies it at once.`),
    ),
  )
}

// Whether anything of this account's has reported yet: what a new account is waiting to see
function connectedLine() {
  const sessions = [...app.sessions.values()].filter((s) => !s.ended).length
  const machines = app.machines.size
  if (!app.sessions.size && !machines) return h('p', { class: 'guide-status waiting' }, h('span', { class: 'spin', 'aria-hidden': 'true' }, '✻'), ' Waiting for your first session. It shows up here by itself, a few seconds after you start Claude Code on a computer you have set up.')
  const count = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
  return h('p', { class: 'guide-status connected' }, '✓ Connected: ', [sessions ? count(sessions, 'session') + ' open' : '', machines ? count(machines, 'computer') + ' with the agent' : ''].filter(Boolean).join(', ') || 'your sessions have reported', '. ', h('a', { href: '#' }, 'See your sessions'))
}

// ---- What a computer is given: an API token to sign in with, and the passphrase that
// opens the account's key there. Both are the person's to type as that computer is set
// up (into its agent's installer, which gives the plugin the same; or into the plugin
// itself); neither is put in a command. Drawn on Account, and on Set up a computer.

const dayOf = (ts) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const TOKEN_LIVES = [['30', '30 days'], ['90', '90 days'], ['365', 'A year'], ['0', 'Never runs out']]

// The account's API tokens, each with how it ends and when it was last used, a way to
// take it back, and the form that makes another. A token is shown once, as it is made.
function tokensPart(redraw) {
  const a = app.account
  const note = h('span', { class: 'form-note error' })
  const nameBox = h('input', { 'data-part': 'token-name', placeholder: 'A name for it (optional)', maxlength: '60', autocomplete: 'off' })
  const life = h('select', { 'data-part': 'token-days' }, ...TOKEN_LIVES.map(([days, text]) => h('option', { value: days, ...(days === '90' ? { selected: '' } : {}) }, text)))
  const make = h(
    'button',
    {
      type: 'button',
      class: 'primary',
      'data-part': 'token-make',
      onclick: async () => {
        make.disabled = true
        const r = await sendJson('/api/account/tokens', { name: nameBox.value, days: Number(life.value) })
        make.disabled = false
        if (!r.ok) return (note.textContent = r.error)
        app.madeToken = r.data
        await loadAccount()
        redraw()
      },
    },
    'Make a token',
  )
  const rows = (a.tokens ?? []).map((t) =>
    h(
      'div',
      { class: 'token-row api-token' + (t.expired ? ' off' : ''), 'data-token': t.id },
      h('div', null, h('b', null, t.name), h('div', { class: 'muted' }, [`ends …${t.hint}`, `made ${dayOf(t.createdAt)}`, t.expiresAt ? (t.expired ? `ran out ${dayOf(t.expiresAt)}` : `good until ${dayOf(t.expiresAt)}`) : 'never runs out', t.lastUsedAt ? `last used ${dayOf(t.lastUsedAt)}` : 'not used yet'].join(' · '))),
      h(
        'div',
        { class: 'token-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'ghost token-revoke',
            onclick: async () => {
              if (!(await ask(`Take back "${t.name}"?`, { says: 'Whatever signs in with it is refused from now on.', yes: 'Take it back', danger: true }))) return
              const r = await fetch('/api/account/tokens/' + t.id, { method: 'DELETE' }).catch(() => null)
              if (!r?.ok) return (note.textContent = (await r?.json().catch(() => null))?.error ?? 'The server could not be reached.')
              if (app.madeToken?.id === t.id) app.madeToken = null
              await loadAccount()
              redraw()
            },
          },
          'Take back',
        ),
      ),
    ),
  )
  const made = app.madeToken && (a.tokens ?? []).some((t) => t.id === app.madeToken.id) ? app.madeToken : null
  return [
    made && h('div', { class: 'token-made' }, h('p', null, h('b', null, 'Your new API token.'), ' Copy it now, or leave this open until the device has it: it is not shown again.'), h('div', { 'data-part': 'token-made' }, codeBox(made.token))),
    ...rows,
    !rows.length && h('p', { class: 'muted', 'data-part': 'tokens-none' }, 'No tokens yet. A device signs in with one.'),
    h('div', { class: 'token-new' }, nameBox, life, make, ' ', note),
  ]
}

// How good a passphrase looks: nothing is known of it but what is typed. `ok`: it may be
// tried (it is long enough to be the passphrase the account already has, which is taken
// as it is). `strong`: it may become the account's passphrase, chosen here for the first
// time or in another's place. The passphrase is all that stands between whoever holds
// the server's data and what the account's sessions say, and all that makes a browser one
// of the account's devices, whose orders its computers do: so one that is being chosen is
// held to four or more unrelated words, or to something long and mixed, and to not being
// what anyone would try first. (`own`: what is the account's own to say, its email's
// name: no part of a passphrase.)
const COMMON_PHRASES = new Set(['correcthorsebatterystaple', 'thequickbrownfoxjumpsoverthelazydog', 'thequickbrownfox', 'tobeornottobethatisthequestion', 'maytheforcebewithyou', 'passwordpasswordpassword', 'letmeinletmeinletmein', 'iloveyouiloveyouiloveyou', 'onetwothreefourfivesix', 'onetwothreefour', 'loremipsumdolorsitamet'])
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz']
// How much of a text is keys or letters in a row, one after the next, either way: of 1
function inARow(letters) {
  let run = 0
  for (let i = 1; i < letters.length; i++) {
    const pair = letters[i - 1] + letters[i]
    if (letters[i] === letters[i - 1] || KEY_ROWS.some((row) => row.includes(pair) || row.includes(pair[1] + pair[0]))) run++
  }
  return letters.length > 1 ? run / (letters.length - 1) : 0
}
function passphraseHint(text, own = []) {
  const plain = text.normalize('NFKC')
  const lower = plain.toLowerCase()
  const letters = lower.replace(/[^\p{L}\p{N}]/gu, '')
  const words = [...new Set(lower.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))]
  if (plain.length < 12) return { ok: false, strong: false, says: 'At least 12 characters.' }
  if (letters === 'correcthorsebatterystaple') return { ok: false, strong: false, says: 'Nice try, but no, not that one' }
  const weak = (why) => ({ ok: true, strong: false, why, says: `If this is the passphrase your account already has, go on. To choose it as a new one it is not strong enough: ${why}` })
  if (COMMON_PHRASES.has(letters)) return weak('it is a phrase anyone would try.')
  if (new Set(letters).size < 8) return weak('it is the same few characters over and over.')
  if (inARow(letters) > 0.6) return weak('it is keys or letters in a row.')
  const named = ['manyclaws', ...own].map((n) => String(n ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).find((n) => n.length >= 4 && letters.includes(n))
  if (named) return weak(`it has “${named}” in it, which is the first thing anyone would try.`)
  if (words.length >= 4 && plain.length >= 20) return { ok: true, strong: true, says: `Good: ${words.length} words.` }
  const kinds = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter((k) => k.test(plain)).length
  if (plain.length >= 16 && kinds >= 3 && new Set(plain).size >= 10) return { ok: true, strong: true, says: 'It will do, and longer is stronger: four or more unrelated words make a good one.' }
  return weak('use four or more unrelated words (20 characters or more), or 16 or more characters that mix capitals, digits and symbols.')
}

// The page loaded again, to read everything with a key it has just been given
// Everything this page was sent so far it read with what it held then: it starts over
// with what it holds now. By loading again, on a device that keeps its key. One that
// holds it only while the page is open would lose it that way, and one that has just let
// go of it has something to say: there the page reads everything again as it stands.
async function startOver() {
  const held = app.account && vault ? await vault.heldKey(app.account.user.id).catch(() => null) : null
  if (held?.own) return location.reload()
  app.views.clear()
  app.catalog.clear()
  app.projects.clear()
  app.projectOpen.clear()
  app.search = { q: '', seq: 0, data: null, open: new Set(), sessions: new Map(), hits: new Map() }
  app.sawSealed = false
  app.firstSeenTo = null
  if (await loadAccount()) enter()
}

// ---- The account's own small session. Nothing of the passphrase is on the server, so
// until a computer has sent something sealed there is nothing here to try a typed one
// on, and a mistyped one would be taken for the account's. So the first time a browser
// is given a passphrase, with nothing sealed here yet, it seals a text everybody knows
// with the key it made and keeps that here as a session of its own: one row, ended as
// it is made. The next time a passphrase is typed, on this device or another, it is tried
// on that: it opens to the known text, or it is not the account's passphrase. To the
// server it is a session like any other, sealed like the rest, kept as long and cleared
// with the rest: it tells the server no more than any sealed session does. The page
// knows it by its id, which every device of the account's works out alike from the
// account's id, and keeps it out of the list: it is nobody's conversation.
const FIRST_SAYS = 'ManyClaws: the session every device of this account opens.'
function firstIdOf(account) {
  if (!sealing) return null
  const hex = [...sealing.sha256(new TextEncoder().encode('manyclaws first session|' + account))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
// It is here, this browser has a key, and the key does not open it: it is this browser,
// then, that has another passphrase than the account
// (one with nothing on it yet says nothing either way: it is as if it were not there)
const firstIsOther = () => !!app.key && !!app.first?.card && app.first.topic !== FIRST_SAYS

// ---- What does not open here, and whose it is. Nothing of the passphrase is on the
// server, so which device was given another one is told only by what this browser's key
// opens, of what this page holds:
//   here      the account's own small session: it opens ('same': this browser has the
//             account's passphrase), it does not ('other': it is this browser that has
//             another), or none is kept to say ('unknown')
//   devices   each of the account's computers: whether what its agent says of it opens
//             (`card`: said again each time it says hello, so it is how the computer
//             stands now), and which of the sessions on it do not: the ones heard from
//             now (`running`) and the ones kept from before (`left`)
//   unplaced  the sessions that do not open and that no computer here says are its own:
//             a session's computer is named on its card, which is what does not open
//   favorites, marks   what a browser or a phone sealed: the names of the favorites, and
//             what was put on a session
// A thing counts where the key failed to open it, and it stands as "🔒 (encrypted)" and
// nothing else: not where it opened and says those words.
function unopened() {
  if (!app.key || !sealing) return { any: false, here: 'same', devices: [], unplaced: [], favorites: 0, marks: 0 }
  const here = firstIsOther() ? 'other' : app.first?.card ? 'same' : 'unknown'
  const all = [...app.sessions.values()]
  const running = (s) => s.online && !s.ended
  const devices = [...app.machines.values()].map((m) => {
    const its = all.filter((s) => s.machine === m.id)
    const shut = its.filter((s) => isLocked(s.card))
    return { m, card: isLocked(m.card), running: shut.filter(running), left: shut.filter((s) => !running(s)), opens: its.length - shut.length }
  })
  const unplaced = all.filter((s) => isLocked(s.card) && !app.machines.has(s.machine))
  const favorites = app.favorites.filter((f) => [f.title, f.project, f.where].some(isLocked)).length
  const marks = [...app.marks.values()].filter((m) => m.shut).length
  const any = here === 'other' || unplaced.length > 0 || devices.some((d) => d.card || d.running.length || d.left.length) || favorites > 0 || marks > 0
  return { any, here, devices, unplaced, favorites, marks }
}
// How a computer stands, of what it sent: its agent seals with another key now
// ('other'), or did when it was last heard from ('was'); it has this browser's key, and
// sessions that started before it did are still running ('running') or only kept
// ('left'); or all of it opens ('fine')
const deviceStands = (d) => (d.card ? (d.m.online ? 'other' : 'was') : d.running.length ? 'running' : d.left.length ? 'left' : 'fine')

// What this page holds is looked at again as it changes: the line across the top says
// whether anything does not open, and the page that says whose it is is drawn again
// where it is the one showing. So a computer given the right passphrase is seen to open
// as it reports, with nothing pressed here.
function lookAgain() {
  const u = unopened()
  const ids = (list) => list.map((s) => s.id)
  const now = JSON.stringify([u.here, u.devices.map((d) => [d.m.id, machineName(d.m), d.m.online, d.card, ids(d.running), ids(d.left), d.opens]), ids(u.unplaced), u.favorites, u.marks])
  if (now === app.unopenedWas) return
  app.unopenedWas = now
  showNotices()
  if (location.hash.split('?')[0] === '#/account/unopened' && !el('account').hidden && app.account && el('account-body').querySelector('[data-part=unopened]')) renderUnopened()
}

// Kept here, sealed with this key, as a computer's plugin reports a session: it starts,
// says the one thing, and ends. `there`: one is here already, sealed with whatever key,
// and goes first. True when the server has taken it.
async function keepFirst(key, there = !!app.first) {
  const sid = app.firstId
  if (!sid) return false
  if (there) await fetch('/api/sessions/' + sid, { method: 'DELETE' }).catch(() => {})
  const at = Date.now()
  // (as a computer's plugin reports a session: a card that says what it is about, a row that says it, and that it has ended)
  const events = [
    { type: 'card', card: await vault.seal({ topic: FIRST_SAYS, preview: FIRST_SAYS, state: 'idle', interactive: false }, key) },
    { type: 'rows', rows: [{ id: await vault.nameOf('first', key), row: await vault.seal({ ts: at, role: 'user', text: FIRST_SAYS }, key) }] },
    { type: 'session.end' },
  ]
  return (await sendJson('/api/sessions', { protocol: 2, meta: { protocol: 2, sealed: 3, orders: true }, events: events.map((e) => ({ sid, ts: at, sealed: 3, ...e })) })).ok
}

// A browser that has the key sees to it, once each time the page is opened, that the
// session is here: made where there is none (it went with the rest: cleared, or unheard
// for longer than anything is kept), and made
// again once it is half that old, so that it does not go. Not where this browser's key
// opens nothing of what is kept: then it is this browser that has another passphrase
// than the account's computers, and it is not for it to say which is the account's.
async function seeToFirst() {
  const a = app.account
  if (!a || !app.key || !app.firstId || app.firstSeenTo === a.user.id) return
  app.firstSeenTo = a.user.id
  if (app.first?.card) {
    if (app.first.topic === FIRST_SAYS && Date.now() - app.first.lastActivity > ((a.retainDays ?? 14) * 86400_000) / 2) await keepFirst(app.key)
    return
  }
  if ((await opensWhatIsKept(app.key)).fits !== 'no') await keepFirst(app.key, false)
}

// A favorite is kept with what its session was called, sealed, and stays when the
// account's sessions are cleared. After a reset nobody can open what it was called: each
// is named again under the new key, by what it was called where this browser still has
// the key that opened it, and otherwise by the start of its id, until its session next
// reports and says what it is called itself. `all` false (this browser given the
// passphrase the account has already, in place of another): only what this browser can
// still read is sealed again; the rest is not its to name. `was`: what this browser held
// until now, which is what it can still read with.
async function renameFavorites(key, all = true, was = app.key) {
  const text = await fetch('/api/favorites').then((r) => (r.ok ? r.text() : '')).catch(() => '')
  let kept = []
  try {
    kept = JSON.parse(text).favorites ?? []
  } catch {}
  for (const f of kept) {
    const read = {}
    for (const k of ['title', 'project', 'where']) if (sealing.isSealed(f[k]) && (await vault.open(f[k], key, null)) === null) read[k] = await vault.open(f[k], was, null)
    const shut = Object.keys(read).filter((k) => all || typeof read[k] === 'string')
    if (!shut.length) continue
    // (each as it was, where this browser can still read it; what it cannot is the start of the id for a name, and nothing for the rest)
    const again = async (k) => {
      if (!shut.includes(k)) return f[k]
      const said = typeof read[k] === 'string' && read[k] ? read[k] : k === 'title' ? f.id.slice(0, 8) : ''
      return said ? vault.seal(said, key) : ''
    }
    await sendJson('/api/favorites', { id: f.id, machine: f.machine, title: await again('title'), project: await again('project'), where: await again('where') })
  }
}

// What the account has put on its sessions (marks) is sealed too, and stays when its
// sessions are cleared. After a reset each mark is sealed again under the new key, where
// this browser still has the key that opened it; one that nobody can open now is taken
// off. (A notification still to come is asked for again, its words under the new key.)
// `all` false: as for the favorites, one this browser cannot read is left as it is.
async function resealMarks(key, all = true, was = app.key) {
  const text = await fetch('/api/marks').then((r) => (r.ok ? r.text() : '')).catch(() => '')
  let kept = []
  try {
    kept = JSON.parse(text).marks ?? []
  } catch {}
  for (const raw of kept) {
    const sealed = ['title', 'project', 'where', 'name', 'label', 'color', 'remind'].filter((k) => sealing.isSealed(raw[k]))
    if (!sealed.length || (await Promise.all(sealed.map((k) => vault.open(raw[k], key, null)))).every((v) => v !== null)) continue
    const read = Object.fromEntries(await Promise.all(sealed.map(async (k) => [k, await vault.open(raw[k], was, null)])))
    const path = '/api/marks/' + encodeURIComponent(raw.id)
    if (sealed.some((k) => read[k] === null)) {
      if (all) await fetch(path, { method: 'DELETE' }).catch(() => {})
      continue
    }
    const m = markRead({ ...raw, ...read })
    await sendJson(path, await markBody(m, { name: m.name, label: m.label, color: m.color, remind: m.remind, notify: !!m.notice }, key), 'PUT')
  }
}

// Whether a key opens what the server keeps of the account's that is sealed (`fits`):
// 'yes', 'no', or 'nothing' where nothing sealed is there to try it on. Where the
// account's own small session is here (`first`), it is the word on it: that is what it is
// for. Where it is not, the key is tried on whatever else is sealed here. It is the only
// way there is to tell a passphrase typed here from another: the server has nothing of
// it to ask.
async function opensWhatIsKept(key) {
  const found = []
  let first = null
  const look = (v, depth = 0) => {
    if (found.length >= 8 || depth > 6) return
    if (typeof v === 'string') return void (sealing.isSealed(v) && found.push(v))
    if (v && typeof v === 'object') for (const x of Object.values(v)) look(x, depth + 1)
  }
  for (const path of ['/api/sessions', '/api/favorites', '/api/notifications']) {
    // (read as it came, not opened on the way)
    const text = await fetch(path).then((r) => (r.ok ? r.text() : '')).catch(() => '')
    try {
      const data = JSON.parse(text)
      if (path === '/api/sessions') first = data.sessions?.find((s) => s.id === app.firstId && sealing.isSealed(s.card)) ?? null
      look(data)
    } catch {}
  }
  if (first) return { fits: (await vault.open(first.card, key, null))?.topic === FIRST_SAYS ? 'yes' : 'no', first: true }
  if (!found.length) return { fits: 'nothing', first: false }
  for (const v of found) if ((await vault.open(v, key, null)) !== null) return { fits: 'yes', first: false }
  return { fits: 'no', first: false }
}

// The passphrase: typed here, on this browser, and made into the key here with the
// account's id. Nothing of it goes to the server: no salt, nothing that tells the key,
// not that there is one. So there is one box for it, whether it is the first time it is
// chosen or this browser being given the one the account's computers have: the server
// could not tell those apart, and neither can this page, except by trying the key on what
// is sealed here: the account's own small session (firstSession), which the first browser
// given a passphrase keeps here for that, or whatever else is sealed. One that does not
// open it is mistyped, or is to be the account's from now on: the page says so and asks
// which. Another passphrase is another key, for the whole account: what is kept on the
// server is cleared, the small session with it, and one is made with the new key.
// Its parts by name (the card that asks for it as a browser comes in lays them out its own
// way: showPassphrase), and as the account's pages have them, one under the other.
const passphrasePart = (redraw) => Object.values(passphraseParts(redraw))
function passphraseParts(redraw) {
  const a = app.account
  const u = a.user
  const has = !!app.key
  const about = h('p', null, 'What your sessions say is sealed with a key that is made from your ', h('b', null, 'passphrase'), ', on each of your own devices: you type it as a computer is set up, and into this page in a browser or on a phone, once each. Choose a passphrase, not a password: four or more unrelated words are stronger than something clever, and easier to type. Don’t reuse the password you sign in with. Nothing of the passphrase is ever sent to the server: not the passphrase, not the key, not anything made from either, not even that you have one. So nobody who runs the server can read your sessions, and nothing but your own devices can tell whether a passphrase is the right one: type the same one everywhere. So that they can tell, the first browser you give it to keeps one small sealed session of its own here, with your others, and a passphrase typed later is tried on that.')
  // Where to keep it: nobody can give a forgotten one back, so a password manager is said to be a fair place for it
  const vaultSays = h('p', { 'data-part': 'passphrase-vault' }, 'A passphrase you forget cannot be recovered, by us or by anyone. A password manager whose vault is end-to-end encrypted is a reasonable place to keep it: if your browser or your manager offers to save it, it is saved as “ManyClaws encryption passphrase”, apart from the password you sign in with.')
  const note = h('span', { class: 'form-note', 'data-part': 'passphrase-note' })
  // (what a password manager files it under: a name of its own, so that it is kept apart from the password the account
  // signs in with, and that one is not offered in its place)
  const filedAs = h('input', { type: 'text', autocomplete: 'username', value: 'ManyClaws encryption passphrase', readonly: '', hidden: '', tabindex: '-1', 'aria-hidden': 'true' })
  // (it has no name, and nothing else in the form has one: were the form ever sent as a form, nothing typed here would go with it)
  const box = h('input', { 'data-part': 'passphrase-new', type: 'password', placeholder: has ? 'A new passphrase: four or more unrelated words' : 'Your passphrase: four or more unrelated words', autocomplete: 'new-password', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' })
  // The eye in the box, as any password's box has one: pressed, what is typed is shown in the box itself, and pressed
  // again it is dots. Shown, the box is a plain one, which still asks a keyboard to correct, capitalise and check
  // nothing; it is a password's again as the form is sent. (Pressing the eye leaves the typing where it is: it takes
  // no focus from the box, so a phone's keyboard stays up.)
  const eye = h('button', { type: 'button', class: 'passphrase-eye', 'data-part': 'passphrase-show', onmousedown: (ev) => ev.preventDefault(), onclick: () => see(box.type === 'password') })
  function see(yes) {
    box.type = yes ? 'text' : 'password'
    const does = yes ? 'Hide the passphrase' : 'Show the passphrase'
    for (const k of ['aria-label', 'title']) eye.setAttribute(k, does)
    eye.setAttribute('aria-pressed', String(yes))
    eye.replaceChildren(icon(yes ? 'eyeOff' : 'eye'))
  }
  see(false)
  // Whose device this is, asked as the passphrase is given to it: the key stays on a device that is its owner's, and is
  // held on any other only while the page is open. One of the two is chosen before the passphrase is taken. (A browser
  // that has a key and is given another is asked again, with what it said before chosen.)
  const whose = (part, checked, ...says) => h('label', { class: 'guide-check' }, h('input', { type: 'radio', 'data-part': part, checked, onchange: () => chose(part) }), h('span', null, ...says))
  const mine = whose('device-own', has && app.key.own, h('b', null, 'Yes, it is mine.'), ' My key stays on it, and my sessions open here whenever I come back.')
  const notMine = whose('device-other', has && !app.key.own, h('b', null, 'No, it is shared or borrowed.'), ' My key is held only while this page is open: it is gone when the page is closed or I sign out, and what this device asks of my computers is taken for a day at most.')
  const isMine = () => mine.querySelector('input').checked
  const chosen = () => isMine() || notMine.querySelector('input').checked
  const save = h('button', { type: 'submit', class: 'primary', 'data-part': 'passphrase-save', disabled: '' }, has ? 'Change the passphrase' : 'Use this passphrase')
  // What is asked where a passphrase does not open what is kept here: under the box
  const asked = h('div', { class: 'token-made', 'data-part': 'passphrase-reset', hidden: '' })
  // (what is the account's own to say is no part of a passphrase: the name its email has)
  const hintOf = () => passphraseHint(box.value, [String(u.email ?? '').split('@')[0]])
  const ready = () => hintOf().ok && chosen()
  // (the two are one choice: they have no name to make them so, so it is done here)
  function chose(part) {
    for (const [name, label] of [['device-own', mine], ['device-other', notMine]]) label.querySelector('input').checked = name === part
    save.disabled = !ready()
  }
  box.addEventListener('input', () => {
    const hint = hintOf()
    note.textContent = box.value ? hint.says : ''
    note.className = 'form-note' + (hint.ok ? '' : ' error')
    save.disabled = !ready()
    asked.hidden = true
  })
  const f = h(
    'form',
    { class: 'guide-form', 'data-part': 'passphrase-form' },
    filedAs,
    h('div', { class: 'passphrase-box passphrase-eyed' }, box, eye),
    h('fieldset', { class: 'device-whose', 'data-part': 'device-whose' }, h('legend', null, 'Is this your own device?'), mine, notMine),
    h('div', null, save, ' ', note),
    asked,
  )
  const failed = (why) => {
    note.textContent = why
    note.className = 'form-note error'
    save.disabled = !ready()
  }
  // The key is this browser's from here on, and this browser one of the account's devices.
  // `reset`: the key is the whole account's from here on too, and what was sealed with
  // the one before can be opened by nobody now: all of it goes, the small session with
  // it, and what is running is sent again. `first`: the small session is here, and opens
  // with this key; where it is not, it is made with it. `was`: what this browser held
  // until now, which what it sealed itself is read with once more.
  const take = async (made, held, { reset = false, first = false, was = app.key } = {}) => {
    // This device goes on the list of the account's devices first, signed with the passphrase's own signer, which is
    // then let go of: without that nothing it asks of a computer is done, so without it nothing else is changed either.
    // (the key this browser signed with before, where it had one, comes off the list: nothing has it now)
    const stay = held.own ? {} : { until: Date.now() + sealing.DEVICE_STAY_MS }
    app.listing = true
    const why = await putDevices(held, made.signer, (devices) => [...devices.filter((d) => d.key !== app.key?.device.key), { key: held.device.key, name: deviceLabel(), at: Date.now(), ...(a.login ? { login: a.login } : {}), ...stay }])
    vault.forget(made)
    if (why) {
      app.listing = false
      return failed(`This device could not be put among your account’s devices: ${why}. Nothing was changed.`)
    }
    if (reset) await fetch('/api/sessions', { method: 'DELETE' }).catch(() => {})
    // (what this browser sealed itself with the key it had, a favorite's name and what was put on a session, goes under the
    // new one: the server keeps neither up with its session, having read none of it)
    if (reset || was) {
      await renameFavorites(held, reset, was)
      await resealMarks(held, reset, was)
    }
    if (reset || !first) await keepFirst(held, false)
    await vault.keepKey(u.id, held)
    await vault.dropBefore(u.id)
    app.passphraseChanging = false
    app.listing = false
    // (everything this page was sent so far it could not open: it starts over, with the key)
    setTimeout(startOver, 0)
  }
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    if (!ready()) return
    save.disabled = true
    see(false)
    // (the key takes the browser a second or so to make: that is what makes a guess at a passphrase dear)
    note.textContent = 'Making your key…'
    note.className = 'form-note'
    let made = null
    let held = null
    try {
      made = await vault.keysOf(box.value, u.id)
      held = await vault.hold(made, { own: isMine() })
    } catch {
      return failed('Your key could not be made in this browser: it may be too old to keep one safely. Try an up-to-date browser.')
    }
    // Given to this browser: does it open what is kept here for the account?
    const { fits, first } = await opensWhatIsKept(held)
    // (once, at the deploy of 2026-10-08: a browser that has the key of before, and is given the same passphrase, seals
    // again what the account kept under that key and clears what its computers send again themselves. See keys.js.)
    const before = fits === 'yes' ? null : await vault.keyBefore(u.id, box.value)
    if (before) return take(made, held, { reset: fits === 'no', was: before })
    // The passphrase the account has already is taken as it is. One that is to be the account's from here on (its
    // first, or another in the old one's place) is held to more: strong enough to be chosen (passphraseHint), and not
    // the password this browser signs in with, which the server keeps stretched far more cheaply (keys.js, isPassword).
    const isPassword = await vault.isPassword(box.value, a.kdf, await vault.markOf(u.id)).catch(() => false)
    const hint = hintOf()
    const unfit = isPassword
      ? 'it is the password you sign in with. Choose a different one: the server keeps what signs you in, stretched far more cheaply than a passphrase is, so whoever had the server’s data could guess a passphrase that is also your password.'
      : hint.strong
        ? ''
        : hint.why
    if (fits !== 'yes' && unfit) {
      vault.forget(made)
      return failed(fits === 'no' ? `That is not the passphrase your account has. Nor can it become it: ${unfit}` : `That cannot be your passphrase: ${unfit}`)
    }
    // (the account's own, and its password too: taken, since it is the account's, and said under Account until one of the two is changed)
    try {
      if (isPassword) sessionStorage.setItem('mc.samePassword', u.id)
      else sessionStorage.removeItem('mc.samePassword')
    } catch {}
    // (nothing sealed is here to say, and this browser has a key already: it is asked before it takes another)
    if (fits === 'nothing' && has && !(await ask('Change your passphrase?', { says: 'It makes a new encryption key: each of your computers and browsers has to be given the new passphrase before it shows here again.', yes: 'Change it' }))) {
      vault.forget(made)
      note.textContent = ''
      return void (save.disabled = !ready())
    }
    if (fits !== 'no') return take(made, held, { first })
    // One that does not is mistyped, or is to be the account's passphrase from now on:
    // the page says so, asks which, and says how the second goes
    note.textContent = 'That is not the passphrase your account has.'
    note.className = 'form-note error'
    const again = () => {
      vault.forget(made)
      asked.hidden = true
      note.textContent = ''
      box.value = ''
      box.focus()
    }
    const yes = h('button', { type: 'button', class: 'primary', 'data-part': 'passphrase-reset-yes' }, 'Reset my account’s passphrase to this one')
    yes.addEventListener('click', () => {
      yes.disabled = true
      take(made, held, { reset: true })
    })
    fill(
      asked,
      h('p', null, h('b', null, 'That passphrase does not open what is kept here for your account.'), ' If it was mistyped, type it again. If you have forgotten your passphrase, or want another, you can reset it for your whole account.'),
      h('p', null, 'How a reset goes: what you typed becomes the passphrase of your whole account. Everything the server keeps of your sessions is removed, since nobody can open it without the passphrase it was sealed with. Nothing on your computers is touched. Then give the new passphrase to each of your computers (in Claude Code, /plugin configure manyclaws@manyclaws; for its agent, run the installer again), and to each other browser or phone, which asks for it when it is next opened. Your sessions show here again as your computers connect with it.'),
      h('div', { class: 'passphrase-box' }, yes, h('button', { type: 'button', class: 'ghost', 'data-part': 'passphrase-reset-no', onclick: again }, 'Type it again')),
    )
    asked.hidden = false
  })
  const changing = has && app.passphraseChanging
  // What this browser holds stays or goes by what was said of the device when the passphrase was typed
  const here = !has
    ? h('p', { 'data-part': 'key-needed' }, app.offList ? 'This browser was taken off your account’s devices, or its day as one of them is over, so it has let go of your key. Type your passphrase to make it one of them again.' : a.sessions ? 'This browser has not been given your passphrase, so it cannot read your sessions or reply to them. Type it here, once.' : 'This browser has no passphrase yet. Type the one your other devices have, or, if this is the first, choose one.')
    : app.key.own
      ? h('p', { 'data-part': 'key-here', class: 'guide-status connected' }, '✓ This browser has your key, made here from your passphrase, and it stays here when you sign out: you said this device is yours. Give each computer the same passphrase as you set it up. ', h('a', { href: '#/account/unopened', 'data-part': 'key-check' }, 'See what each of your devices opens'))
      : h('p', { 'data-part': 'key-here', class: 'guide-status connected' }, '✓ This browser has your key while this page is open: you said this device is not yours, so it is gone when the page is closed or you sign out. ', h('a', { href: '#/account/unopened', 'data-part': 'key-check' }, 'See what each of your devices opens'))
  let same = false
  try {
    same = sessionStorage.getItem('mc.samePassword') === u.id
  } catch {}
  return {
    about,
    vaultSays,
    here,
    same: same && has && h('p', { 'data-part': 'key-is-password', class: 'guide-status' }, 'Your encryption passphrase is the password you sign in with. Change one of them: the server keeps what signs you in, stretched far more cheaply than a passphrase is, so whoever had the server’s data could guess a passphrase that is also your password. ', h('a', { href: '#/account/password' }, 'Change your password')),
    other: firstIsOther()
      ? h('p', { 'data-part': 'key-other', class: 'guide-status' }, 'The passphrase this browser was given is not the one your account has now: it was set again on another of your devices, or this browser was given a different one. Type your account’s passphrase here (Change passphrase, below), and your sessions open again.')
      : unopened().any && h('p', { 'data-part': 'key-other', class: 'guide-status' }, 'Some of what is kept here for your account was sealed with a different passphrase from the one this browser was given, so it cannot be opened here. ', h('a', { href: '#/account/unopened', 'data-part': 'key-other-link' }, 'See which device has the other one, and what to do there')),
    change: has && !changing && h('div', null, h('button', { type: 'button', class: 'link', 'data-part': 'passphrase-change', onclick: () => ((app.passphraseChanging = true), redraw()) }, 'Change passphrase')),
    form: (!has || changing) && f,
  }
}

// ---- The account's devices: its phones and browsers. Each signs what it asks of the
// account's computers with a key of its own (keys.js), and a computer goes by it because
// the list of the account's devices has it. The list is signed with the passphrase's own
// signer, which a device has only while the passphrase is being typed there, and sealed:
// the server keeps it as one more sealed thing, and the account's computers read it from
// there. So a device is put on the list as the passphrase is typed into it, and is taken
// off it from any other with the passphrase typed again: what it asks is refused from
// then on, by every computer, and nothing else of the account's has to change.

// The list as the server has it, sealed: '' where there is none, null where the server did not say
// (read as it came, not opened on the way: it is handed back as it was, to say which list a new one replaces)
async function devicesKept() {
  const text = await fetch('/api/devices').then((r) => (r.ok ? r.text() : null)).catch(() => null)
  try {
    return text === null ? null : (JSON.parse(text).devices ?? '')
  } catch {
    return null
  }
}

// The list changed by `change` and signed again with the passphrase's signer, in place of
// the one the server has: '' when it is kept, or why it is not. Another device may change
// it at the same moment: the server takes a list only in place of the one it was made
// from, so it is made again from the newer one.
async function putDevices(held, signer, change) {
  // (the list this browser is on, by the key it has had until now: one older than that is not built on, keys.js)
  const since = Math.max(held.since ?? 0, app.key?.checker?.every((b, i) => b === held.checker[i]) ? (app.key.since ?? 0) : 0)
  for (let tries = 0; tries < 4; tries++) {
    const was = await devicesKept()
    if (was === null) return 'the server could not be reached'
    let devices
    try {
      devices = await vault.devicesAgain(was, held, signer, change, Date.now(), since)
    } catch (err) {
      if (err instanceof vault.OlderList) return err.message
      throw err
    }
    const r = await fetch('/api/devices', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ devices, was }) }).catch(() => null)
    if (r?.ok) {
      // (which list this device is on from: one older than that says nothing of it, whoever hands it over)
      const list = await vault.readDevices(devices, held)
      if (sealing.deviceIn(list, held.device.key)) held.since = list.v
      return ''
    }
    if (r?.status !== 409) return (await r?.json().catch(() => null))?.error ?? 'the server could not be reached'
  }
  return 'the list of them kept changing as it was written'
}

// A device is one of the account's while the list has it. One the list no longer has
// (taken off it from another device, or on it for a day that is over) lets go of what it
// holds: every computer refuses what it asks anyway, and its key is not left where it is
// no longer wanted. (A list this browser cannot read says nothing of it: that one was
// signed with another passphrase, and what is said of that is said under Account. Nor
// does a list older than the one this browser put itself on: anyone signed in, or the
// server, could hand that one over again, and it was written before this device was one.)
async function seeToDevice() {
  const held = app.key
  const id = app.account?.user.id
  // (not while this page is itself writing the list: it is on its way onto it, or off it, and says so itself)
  if (!id || !held || app.listing) return
  const kept = await devicesKept()
  const list = kept ? await vault.readDevices(kept, held) : null
  if (!list || list.v < (held.since ?? 0) || sealing.deviceIn(list, held.device.key) || app.key !== held) return
  await vault.dropKey(id)
  app.offList = true
  startOver()
}

// The account's devices, on its page: each phone and browser its passphrase was typed
// into, since when, and the way to take one off. Taking one off is signing the list again
// without it, which takes the passphrase: so it is asked for, and what is typed is held
// against what this browser was given before anything is sent. The device taken off is
// signed out too, by the name its sign-in has on the server, which the list keeps sealed
// with it: so it reads no more of the account either.
function devicesPart(redraw) {
  const u = app.account.user
  const says = h('p', null, 'The phones and browsers that have been given your passphrase. Each asks things of your computers with a key of its own, which never leaves it, and your computers do what one of these asks and nobody else: not the server, and not a device you have removed. A lost phone is removed here, from any other device, and your passphrase stays as it is.')
  if (!app.key) return [says, h('p', { class: 'muted', 'data-part': 'devices-locked' }, 'They are listed here once this browser has your passphrase.')]
  const box = h('div', { 'data-part': 'devices' }, h('p', { class: 'muted' }, 'Reading…'))
  const day = (ts) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  const hour = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const remove = async (d, here) => {
    const name = d.name || 'this device'
    const typed = await ask(here ? 'Remove this device from your devices?' : `Remove ${name} from your devices?`, {
      says: [
        here ? 'This browser lets go of your key, and what it asks of your computers is refused from then on. To use it again, type your passphrase here.' : `What ${name} asks of your computers is refused from then on, and it is signed out. Your computers and your other devices are not touched.`,
        !here && 'Your encryption key stays as it is. If that device may be in someone else’s hands, change your passphrase afterwards as well (Account, Change passphrase): that makes a new key, which a device that kept the old one cannot read with.',
        'Type your passphrase: the list of your devices is signed with it, and no device keeps what signs.',
      ],
      text: '',
      type: 'password',
      yes: 'Remove',
      danger: true,
    })
    if (!typed) return
    let made = null
    try {
      made = await vault.keysOf(typed, u.id)
    } catch {
      return void tell('Not removed', 'Your key could not be made in this browser.')
    }
    // (what was typed makes the checker this browser was given, or it is not the passphrase)
    if (!made.checker.every((b, i) => b === app.key.checker[i])) {
      vault.forget(made)
      return void tell('Not removed', 'That is not the passphrase this browser was given.')
    }
    app.listing = here
    const why = await putDevices(app.key, made.signer, (devices) => devices.filter((x) => x.key !== d.key))
    vault.forget(made)
    if (why) return void ((app.listing = false), tell('Not removed', sentence(why)))
    if (here) {
      await vault.dropKey(u.id)
      app.listing = false
      return void startOver()
    }
    // (its sign-in is ended too, where the list says which it is)
    if (typeof d.login === 'string' && d.login) await fetch('/api/account/logins/' + encodeURIComponent(d.login), { method: 'DELETE' }).catch(() => {})
    draw()
  }
  const draw = async () => {
    const kept = await devicesKept()
    if (kept === null) return fill(box, h('p', { class: 'form-note error' }, 'The server could not be reached.'))
    const list = kept ? await vault.readDevices(kept, app.key) : null
    if (!list) return fill(box, h('p', { class: 'muted', 'data-part': 'devices-none' }, kept ? 'The list kept here was signed with another passphrase than the one this browser was given, so it cannot be read here.' : 'No phone or browser is on the list yet: type your passphrase into this one again (Change passphrase, below) to put it there.'))
    const now = Date.now()
    fill(
      box,
      ...list.devices
        .filter((d) => !(d.until && now > d.until))
        .map((d) => {
          const here = d.key === app.key.device.key
          return h(
            'div',
            { class: 'person', 'data-device': d.key, 'data-here': here ? 'yes' : 'no' },
            h('div', null, h('b', null, d.name || 'A device'), here ? ' (this one)' : '', h('div', { class: 'muted' }, [`since ${day(d.at)}`, d.until ? `not its owner’s own: one of them until ${hour(d.until)}` : ''].filter(Boolean).join(' · '))),
            h('button', { type: 'button', class: 'ghost', 'data-part': 'device-remove', onclick: () => remove(d, here) }, 'Remove'),
          )
        }),
    )
  }
  draw()
  return [says, box]
}

// ---- The code this page is running. It is published (github.com/redimaker/manyclaws,
// under web/), and each release of it is a list of every file with its SHA-256, signed
// with a key that is kept neither in that repository nor on this server: the server hands
// the list over beside the files (/release.json). Here each file is read back as this
// browser has it and held against the list.
//
// What that is worth is said with it. A page that had been changed to do harm would show
// whatever it liked here, so this is a convenience and no proof. What does not depend on
// the page's word: the browser's own check (each script and style sheet is named in the
// page's HTML with the hash of the file, and is not run if it is anything else, so the
// HTML is the one file to compare), and a check made from outside the page, which is
// said how.
const CODE_REPO = 'https://github.com/redimaker/manyclaws'
function codePart() {
  const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
  // (the page itself, by the address it was opened at, and what it loads)
  const files = [['web/index.html', location.pathname === '/app' ? '/app' : '/'], ...['app.js', 'keys.js', 'seal.js', 'qr.js', 'sw.js', 'app.css', 'site/fonts.css', 'site/join.css', 'site/account.css'].map((f) => ['web/' + f, '/' + f])]
  // A file as this browser has kept it, which is the one it ran; where it kept none, as the server hands it over now
  const kept = async (address) => {
    const r = (await fetch(address, { cache: 'only-if-cached', mode: 'same-origin' }).catch(() => null)) ?? null
    const got = r?.ok ? r : await fetch(address).catch(() => null)
    return got?.ok ? hex(await crypto.subtle.digest('SHA-256', await got.arrayBuffer())) : ''
  }
  const box = h('div', { 'data-part': 'code' }, h('p', { class: 'muted' }, 'Reading…'))
  const origin = location.origin
  const draw = async () => {
    const list = await fetch('/release.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    const read = await Promise.all(files.map(async ([name, address]) => ({ name, hash: await kept(address), listed: list?.files?.[name] ?? '' })))
    const same = !!list && read.every((f) => f.hash && f.hash === f.listed)
    // The page's HTML alone is not the listed file, and is when a script asks for it: it was changed on its way to this
    // browser as a page, which is what a proxy in front of the server does that adds a script of its own to pages
    const html = read[0]
    const others = !!list && read.slice(1).every((f) => f.hash && f.hash === f.listed)
    const onTheWay =
      others && html.hash && html.hash !== html.listed
        ? await fetch(files[0][1], { cache: 'no-store' })
            .then(async (r) => r.ok && hex(await crypto.subtle.digest('SHA-256', await r.arrayBuffer())) === html.listed)
            .catch(() => false)
        : false
    fill(
      box,
      !list
        ? h('p', { class: 'guide-status', 'data-part': 'code-says', 'data-same': 'unlisted' }, 'This server did not say which release its page is of, so there is nothing here to hold the files against. Their hashes as this browser has them:')
        : same
          ? h('p', { class: 'guide-status connected', 'data-part': 'code-says', 'data-same': 'yes' }, `✓ The ${read.length} files this page is made of are as release ${list.release} lists them (${list.made}).`)
          : onTheWay
            ? h('p', { class: 'guide-status', 'data-part': 'code-says', 'data-same': 'html-changed' }, `The page’s HTML reached this browser changed: it is not the file release ${list.release} lists, though the server hands that file to a plain request. Something between the server and this browser adds to pages on their way, as a proxy’s own analytics script is added. This page lets no script from elsewhere run, and every script and style sheet it did run is as listed. It should not be so all the same: whoever runs this server can turn it off there.`)
            : h('p', { class: 'guide-status', 'data-part': 'code-says', 'data-same': 'no' }, `Some of this page’s files are not as release ${list.release} lists them. That is so for a few moments while the server is being brought up to date: load the page again. If it stays so, do not type your passphrase here, and check from outside the page, as below.`),
      ...read.map((f) =>
        h(
          'div',
          { class: 'person', 'data-file': f.name, 'data-as': !f.hash ? 'unread' : !list ? 'unlisted' : f.hash === f.listed ? 'listed' : 'differs' },
          h('div', null, h('b', null, f.name), h('div', { class: 'muted code-hash' }, f.hash || 'could not be read')),
          h('span', { class: 'muted' }, !f.hash || !list ? '' : f.hash === f.listed ? '✓ as listed' : '✗ not as listed'),
        ),
      ),
    )
  }
  draw()
  return [
    h('p', null, 'The code this page runs is published, at ', h('a', { href: CODE_REPO, target: '_blank', rel: 'noopener' }, 'github.com/redimaker/manyclaws'), ' under web/, with the plugin and the agent that run on your computers. Each release is a list of every file with its SHA-256, signed with a key that is kept neither there nor on this server. Your browser checks part of it itself: every script and style sheet this page loads is named in the page’s HTML with the hash of the file, and is not run if it is anything else. So the one file left to check is the HTML.'),
    box,
    h('p', { 'data-part': 'code-outside' }, 'What is shown above is this page’s own word, and a page that had been changed could say anything. To check from outside it, on a computer that has the ManyClaws agent:'),
    codeBox('node ~/.manyclaws/agent/agent.mjs verify'),
    h('p', null, 'That holds what this server hands out against the signed list, with the key the agent was installed with, and the agent and the plugin on that computer too. Or by hand, anywhere: compare the output of'),
    codeBox(`curl -s -H 'Accept: text/html' ${origin}/app | shasum -a 256`),
    h('p', null, 'with web/index.html in ', h('a', { href: origin + '/release.json', target: '_blank', rel: 'noopener' }, 'release.json'), ', and that file with the one in the repository. (Asked for as a browser asks for a page, which is what the header says: what is added to pages on their way to a browser is added to what is asked for so.)'),
  ]
}

// What the server keeps of the account's sessions, why, and the way to clear all of it.
// A session that is running is asked for its chat again and has it back in a moment; one
// that is not is gone from here until it next runs. Nothing on a computer is touched.
function keptPart(redraw) {
  const a = app.account
  const days = a.retainDays ?? 14
  // (where only sealed sessions are taken, a computer sends nothing until it has the passphrase: with none chosen, none does)
  const again = 'as they connect'
  const note = h('span', { class: 'form-note', 'data-part': 'kept-note' }, app.keptCleared ?? '')
  const clear = h(
    'button',
    {
      type: 'button',
      class: 'ghost',
      'data-part': 'kept-clear',
      onclick: async () => {
        if (!(await ask('Clear everything the server keeps of your sessions?', { says: 'A session that is running sends its chat again in a moment. One that is not running is gone from this page until it next runs. Nothing on your computers is touched.', yes: 'Clear', danger: true }))) return
        clear.disabled = true
        // (the account's own small session goes with the rest, and is none of what is counted)
        const first = app.first
        const r = await fetch('/api/sessions', { method: 'DELETE' }).catch(() => null)
        const out = await r?.json().catch(() => null)
        clear.disabled = false
        if (!r?.ok) {
          note.textContent = out?.error ?? 'The server could not be reached.'
          note.className = 'form-note error'
          return
        }
        const gone = Math.max(0, out.sessions - (first ? 1 : 0))
        // (the passphrase is as it was: a browser that has its key keeps the small session here again)
        if (first?.topic === FIRST_SAYS && app.key) await keepFirst(app.key, false)
        app.keptCleared = gone ? `Cleared: ${gone} session${gone === 1 ? '' : 's'}. Your computers send them again ${again}.` : 'There was nothing to clear.'
        await loadAccount()
        redraw()
      },
    },
    'Clear stored sessions',
  )
  return [
    h(
      'p',
      { 'data-part': 'kept-says' },
      `What your sessions say is kept here for ${days} days after a session is last heard from, so you can read a session while its computer is asleep or restarting, and sooner than the computer could send it. `,
      'It is kept encrypted: only your own devices can open it, with your passphrase. ',
      `You can clear all of it whenever you like. Your computers send their sessions again ${again}.`,
    ),
    h('div', null, clear, ' ', note),
  ]
}

// What a device is set up with is two things of the account's, and how it is done is
// the same for everyone: so this is an API token, made here and shown once, the line to
// paste into Claude Code on the computer, which sets it up from the guide, and the way to
// the guide for doing it by hand (the server's /setup, which has nothing of anyone's in it).
function renderSetup() {
  const a = app.account
  if (!a) return
  const guide = a.server + '/setup'
  const note = h('span', { class: 'form-note error' })
  const make = h(
    'button',
    {
      type: 'button',
      class: 'primary',
      'data-part': 'token-create',
      onclick: async () => {
        make.disabled = true
        // (good until it is taken back, under Account, where one can be made that runs out)
        const r = await sendJson('/api/account/tokens', { days: 0 })
        make.disabled = false
        if (!r.ok) return (note.textContent = r.error)
        app.madeToken = r.data
        await loadAccount()
        renderSetup()
      },
    },
    app.madeToken ? 'Create another' : 'Create an API token',
  )
  const made = app.madeToken && (a.tokens ?? []).some((t) => t.id === app.madeToken.id) ? app.madeToken : null
  const body = el('setup-body')
  const at = body.scrollTop
  fill(
    body,
    accountHead('Set up a computer', 'Connect a computer', 'Each computer you run Claude Code on is given two things of yours: an API token, and your encryption passphrase.'),
    h('div', { id: 'setup-status' }, connectedLine()),
    accountPart(
      'Your API token',
      { id: 'setup-token' },
      h('p', null, 'A device signs in with an API token. It is shown once, as it is made.'),
      made && h('div', { class: 'token-made', 'data-part': 'token-made' }, h('p', null, h('b', null, 'Your API token.'), ' Copy it now, or leave this open until the device has it: it is not shown again.'), codeBox(made.token)),
      h('div', null, make, ' ', note),
      h('p', { class: 'muted' }, 'The tokens you have made are under ', h('a', { href: '#/account' }, 'Account'), ', where any of them can be taken back.'),
    ),
    // The passphrase: asked for here where this browser has not been given one, since the device is about to
    // ask for the same one; where it has, only said
    accountPart(
      'Encryption passphrase',
      { id: 'setup-passphrase' },
      ...(app.key ? [h('p', { 'data-part': 'setup-passphrase' }, 'The device also asks for your encryption passphrase: the same one this browser was given. It can be changed under ', h('a', { href: '#/account' }, 'Account'), '.')] : passphrasePart(renderSetup)),
    ),
    accountPart(
      'Set up a device',
      { id: 'setup-device' },
      // (the short way first: one line pasted into Claude Code there, which has neither of the two things in it)
      h('p', { 'data-part': 'setup-say' }, 'On the computer, start Claude Code and paste this:'),
      codeBox(`Read ${guide}.md and set this computer up.`),
      // (what the person does there themselves, said where the two things are got: the rest is Claude Code's, by the guide)
      h('p', { 'data-part': 'setup-where' }, 'Claude Code installs everything from the guide. The one step that is yours there: in Claude Code, type ', h('code', null, '/plugin'), ', press the gear beside manyclaws, and fill in ', h('b', null, 'API token'), ' and ', h('b', null, 'Encryption passphrase'), ' with these two. Then start a new Claude Code session.'),
      // (and the guide itself, for whoever would rather do each step)
      h('p', null, h('a', { href: guide, target: '_blank', rel: 'noopener', id: 'setup-guide' }, 'Or set it up by hand')),
    ),
  )
  body.scrollTop = at
}

// Something secret of the account's: its end shown, all of it at a click, and copied
function secretRow(label, value, what, ...more) {
  const hidden = '••••••••' + value.slice(-6)
  const shown = h('code', { class: 'token' }, hidden)
  return h(
    'div',
    { class: 'token-row' },
    h('div', null, h('b', null, label), h('div', { class: 'muted' }, what)),
    h(
      'div',
      { class: 'token-actions' },
      shown,
      h('button', { type: 'button', class: 'ghost', onclick: () => (shown.textContent = shown.textContent === value ? hidden : value) }, 'Show'),
      h('button', { type: 'button', class: 'ghost', onclick: () => copyText(value) }, 'Copy'),
      ...more.filter(Boolean),
    ),
  )
}

// Who an account is, said in a line: its email, which is all the name it has (the
// server's first account has none until it is given one)
const accountSays = (u) => [u.email, u.admin ? 'admin of this server' : ''].filter(Boolean).join(' · ')

// A form on the account's pages, which sends and says how it went: `send` gives why
// not, or nothing, and `saved` is what comes after
function accountForm(fields, button, send, saved) {
  const note = h('span', { class: 'form-note' })
  const f = h('form', { class: 'guide-form' }, ...fields, h('div', null, h('button', { type: 'submit', class: 'primary' }, button), ' ', note))
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    note.textContent = ''
    note.className = 'form-note'
    const why = await send(Object.fromEntries(new FormData(f))).catch((err) => err.message || 'That did not work.')
    if (why) {
      note.textContent = why
      note.classList.add('error')
    } else {
      note.textContent = 'Saved.'
      await loadAccount()
      saved()
    }
  })
  return f
}
const accountField = (label, attrs) => h('label', { class: 'guide-field' }, label, h('input', attrs))
// Sends a change to the account: why not, in the server's words, or nothing
async function accountPut(path, method, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
  return r?.ok ? '' : ((await r?.json().catch(() => null))?.error ?? 'The server could not be reached.')
}
// What an account's page opens with where it is dressed as the site (site/account.css):
// a word over it, what the page is, and a line under
const accountHead = (tag, title, lede) => h('header', { class: 'acct-head' }, h('p', { class: 'acct-tag' }, tag), h('h1', null, title), lede && h('p', { class: 'acct-lede' }, lede))
// A part of an account's page: what it is called, and what it has
const accountPart = (title, attrs, ...body) => h('section', { class: 'acct-part', ...attrs }, h('h2', null, title), h('div', { class: 'acct-body' }, ...body))

function renderAccount() {
  const a = app.account
  if (!a) return
  const u = a.user
  // (its sessions, as it thinks of them: the small one the page keeps for itself is not one)
  const sessions = Math.max(0, a.sessions - (app.first ? 1 : 0))
  el('account-sub').textContent = accountSays(u)
  const form = (fields, button, send) => accountForm(fields, button, send, renderAccount)
  // The password is set or changed on a page of its own (renderPassword): here is whether
  // there is one, and the way to it
  const passwordPart = () => [
    h(
      'p',
      { 'data-part': 'password' },
      u.hasPassword ? 'You sign in with this email and your password. ' : u.email ? 'This account has no password yet: it is signed in to by the server’s web token. Set one to sign in with your email. ' : 'This account has no password yet: it is signed in to by the server’s web token. Give it an email, then a password, to sign in with those.',
      (u.hasPassword || u.email) && h('a', { href: '#/account/password', 'data-part': 'password-link' }, u.hasPassword ? 'Change password' : 'Set a password'),
    ),
    app.passwordSaid && h('p', { class: 'guide-status connected', 'data-part': 'password-said' }, app.passwordSaid),
  ]
  // Signing out of this device: its key stays or goes by whose device it was said to be, as the passphrase was typed
  const signOutPart = () => [
    h('p', null, 'This signs out this device only: your computers go on reporting, and your other devices stay signed in. Alerts stop here until you sign in again.'),
    app.key && h('p', { class: 'muted', 'data-part': 'logout-key' }, app.key.own ? 'Your key stays on this device, as you said it is yours, and opens your sessions as soon as you sign in here again. To take it off, remove this device under Devices.' : 'Your key goes from this device as you sign out, as you said it is not yours: your passphrase is typed again the next time.'),
    h('div', { class: 'guide-end' }, h('button', { type: 'button', id: 'account-logout', class: 'ghost', onclick: () => signOut() }, 'Sign out')),
  ]
  fill(
    el('account-body'),
    accountHead('Your account', u.email || 'The server’s first account', u.admin && 'You are the admin of this server.'),
    accountPart(
      'Email and password',
      { id: 'sign-in' },
      form([accountField('Email', { name: 'email', type: 'email', value: u.email, required: true, autocapitalize: 'off' })], 'Save', (v) => accountPut('/api/account', 'PUT', v)),
      ...passwordPart(),
    ),
    subscriptionPart(a.billing),
    accountPart('Computers', { id: 'computers' }, h('p', null, sessions || a.machines ? `${sessions} session${sessions === 1 ? '' : 's'} and ${a.machines} computer${a.machines === 1 ? '' : 's'} with the agent are yours here. ` : 'Nothing is connected to this account yet. ', h('a', { href: '#/setup' }, 'Set up a computer'))),
    accountPart('Stored sessions', { id: 'kept' }, ...keptPart(renderAccount)),
    accountPart(
      'API tokens',
      { id: 'api-tokens' },
      h('p', { class: 'muted' }, 'What your devices sign in with: each is given one as it is set up. A token only reports sessions here; it cannot sign in to this page. Each can be taken back on its own.'),
      // (a token is made to set a device up with: the way to how that is done, the server's own guide, from where tokens are made)
      h('p', null, h('a', { href: a.server + '/setup', target: '_blank', rel: 'noopener', 'data-part': 'tokens-guide' }, 'How to set up a device')),
      ...tokensPart(renderAccount),
    ),
    accountPart('Encryption passphrase', { id: 'passphrase' }, ...passphrasePart(renderAccount)),
    accountPart('Devices', { id: 'devices' }, ...devicesPart(renderAccount)),
    accountPart('This page’s code', { id: 'page-code' }, ...codePart()),
    a.agentToken && accountPart('This server', { id: 'server-token' }, secretRow('Server token', a.agentToken, 'This server’s own agent token, from its environment file. It works in the plugin as an API token does, and is changed there.')),
    accountPart('Sign out', { id: 'sign-out' }, ...signOutPart()),
    u.admin && accountPart('People', { id: 'admin' }, h('p', { class: 'muted' }, 'Reading…')),
  )
  if (u.admin) renderAdmin()
  // (come here to type the passphrase, from the page that says this browser has another: its box, in sight and in hand)
  if (app.toPassphrase) {
    app.toPassphrase = false
    el('passphrase').scrollIntoView({ block: 'start' })
    el('passphrase').querySelector('[data-part=passphrase-new]')?.focus({ preventScroll: true })
  }
}

// The password, set or changed: on a page of its own, which the account's page leads to
// and this goes back to. It isn't sent: what it is stretched into is, here, with how;
// and so is the current one, to show it is known.
function renderPassword() {
  const a = app.account
  if (!a) return
  const u = a.user
  el('account-sub').textContent = accountSays(u)
  const send = async (v) => {
    const K = await keys()
    if (v.password.length < K.MIN_PASSWORD) return 'The password needs at least 8 characters.'
    // (not the passphrase: where this browser has the account's key, what was typed is made into a key as a passphrase
    // is, here, and that is held against the one it has. Nothing of it is sent.)
    if (app.key) {
      const as = await K.keysOf(v.password, u.id).catch(() => null)
      const same = !!as && as.checker.every((b, i) => b === app.key.checker[i])
      K.forget(as)
      if (same) return 'That is your encryption passphrase. Choose a different password: the server keeps what signs you in, stretched far more cheaply than your passphrase is, so whoever had the server’s data could guess a passphrase that is also your password'
    }
    const current = u.hasPassword && a.kdf ? await K.signInKey(v.currentPassword, a.kdf) : undefined
    const made = await K.newPassword(v.password)
    const why = await accountPut('/api/account', 'PUT', { password: made.auth, currentPassword: current, kdf: made.kdf })
    if (!why) await K.keepMark(u.id, await K.passwordMark(made.auth)).catch(() => {})
    return /current password is not right/.test(why) ? 'The current password is not right.' : why
  }
  // (that it is done is said on the account's page)
  const done = () => {
    app.passwordSaid = u.hasPassword ? '✓ Your password is changed.' : '✓ Your password is set: you sign in with your email and it from now on.'
    location.hash = '#/account'
  }
  fill(
    el('account-body'),
    accountHead('Your account', 'Your password', 'It is never sent to the server: what is sent is drawn from it on this device.'),
    accountPart(
      u.hasPassword ? 'Change your password' : 'Set a password',
      { id: 'password' },
      // (an email is what a password signs in with: the server's first account may have none yet)
      u.email
        ? accountForm(
            [
              u.hasPassword && accountField('Current password', { name: 'currentPassword', type: 'password', autocomplete: 'current-password', required: true }),
              accountField('New password', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: '8', required: true }),
            ].filter(Boolean),
            u.hasPassword ? 'Change password' : 'Set password',
            send,
            done,
          )
        : h('p', { 'data-part': 'password-needs-email' }, 'Give the account an email first: it is what you sign in with.'),
      h('p', null, h('a', { href: '#/account', 'data-part': 'password-back' }, 'Back to your account')),
    ),
  )
}

// ---- What does not open here: a page of its own, which the line across the top leads
// to. It says which device has another passphrase than the rest, as far as this browser
// can tell (unopened), and what to do on that device: here, where it is this browser; in
// the plugin's own options, where it is a computer. Nothing on it is typed or pressed to
// find out: it is drawn again as what it says changes (lookAgain), so a computer that
// has been seen to is seen to open.
function renderUnopened() {
  const a = app.account
  if (!a) return
  el('account-sub').textContent = accountSays(a.user)
  const u = unopened()
  const days = a.retainDays ?? 14
  const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`
  const body = el('account-body')
  const at = body.querySelector('[data-part=unopened]') ? body.scrollTop : 0
  // (with no small session to tell by, this browser's passphrase is taken for the account's where it opens anything a computer sent)
  const opensSome = u.devices.some((d) => d.opens || (d.m.card && !d.card)) || [...app.sessions.values()].some((s) => s.card && !isLocked(s.card))
  const mine = u.here === 'same' || (u.here === 'unknown' && opensSome)
  // To where the passphrase is typed on this browser: the account's page, its box open and in hand
  const typeIt = (says) =>
    h(
      'button',
      {
        type: 'button',
        class: 'primary',
        'data-part': 'unopened-type',
        onclick: () => {
          app.passphraseChanging = app.toPassphrase = true
          location.hash = '#/account'
        },
      },
      says,
    )
  // What is done on a computer that has another passphrase: in the plugin's own options there, and nowhere else
  const steps = (where) =>
    h(
      'ol',
      { class: 'shut-steps', 'data-part': 'unopened-steps' },
      h('li', null, 'On ', where, ', open the ManyClaws plugin’s options in Claude Code. In a terminal, type', codeBox('/plugin configure manyclaws@manyclaws'), 'In the VS Code extension, type /plugin and press the gear beside manyclaws.'),
      h('li', null, 'In ', h('b', null, 'Encryption passphrase'), ', type the passphrase this browser was given. Nothing can show it to you: this browser keeps the key it made from it and not the passphrase, and the server has nothing of either.'),
      h('li', null, 'Start a new Claude Code session there. It seals with the new key, and the computer’s agent takes the same key from the plugin within half a minute. A session that was already running goes on with the key it started with, until it is started again.'),
    )
  // Sessions kept from before, which nobody who has this passphrase can open: taken off the server, when asked
  const removal = (list) => {
    const note = h('span', { class: 'form-note error' })
    const button = h(
      'button',
      {
        type: 'button',
        class: 'ghost',
        'data-part': 'unopened-remove',
        onclick: async () => {
          if (!(await ask(`Remove ${count(list.length, 'session')} that cannot be opened?`, { says: ['What the server keeps of them is removed. Nobody who has this passphrase could read it.', 'Nothing on your computers is touched: a session that is still on its computer shows here again when it next runs.'], yes: 'Remove', danger: true }))) return
          button.disabled = true
          let kept = 0
          for (const s of list) if (!(await fetch('/api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' }).catch(() => null))?.ok) kept++
          button.disabled = false
          if (kept) note.textContent = `${count(kept, 'session')} could not be removed.`
        },
      },
      list.length === 1 ? 'Remove it from here' : 'Remove them from here',
    )
    return h('div', null, button, ' ', note)
  }
  const leftSays = (list, lead) => {
    const one = list.length === 1
    return [h('p', { 'data-part': 'unopened-left' }, lead, `${count(list.length, 'session')} ${one ? 'is' : 'are'} kept here from before, sealed with another passphrase: nobody who has this one can open ${one ? 'it' : 'them'}. ${one ? 'It goes by itself' : 'They go by themselves'} ${days} days after ${one ? 'it' : 'each'} was last heard from, or now:`), removal(list)]
  }
  // One of the account's computers: what it is called, whether it is connected, how it stands, and what to do on it
  const device = (d) => {
    const name = machineName(d.m)
    const stands = deviceStands(d)
    const shut = d.running.length + d.left.length
    const heard = d.m.online ? 'connected now' : d.m.lastSeen ? 'last heard from ' + fromNow(d.m.lastSeen) : 'not connected'
    const also = `${shut ? `, and neither ${shut === 1 ? 'does 1 session' : `do ${shut} sessions`} on it` : ''}${d.opens ? `; ${count(d.opens, 'session')} on it ${d.opens === 1 ? 'does' : 'do'}` : ''}.`
    const one = d.running.length === 1
    const says = {
      other: () => [
        h('p', { 'data-part': 'unopened-says' }, h('b', null, `${name} has a different passphrase from this browser.`), ` What its agent says of it does not open here${also}`),
        h('p', null, h('b', null, 'What to do there:')),
        steps(h('b', null, name)),
        h('p', { class: 'muted' }, 'Nothing more is done here: its sessions open by themselves as it reports with the new key, and this page says so.'),
        ...(d.left.length ? leftSays(d.left, 'Of its sessions, ') : []),
      ],
      was: () => [
        h('p', { 'data-part': 'unopened-says' }, h('b', null, `${name} had a different passphrase from this browser when it was last heard from.`), ` What its agent said of it does not open here${also}`),
        h('p', null, h('b', null, 'What to do there, '), 'when it is next on, if it has not been given this browser’s passphrase since:'),
        steps(h('b', null, name)),
        ...(d.left.length ? leftSays(d.left, 'Of its sessions, ') : []),
      ],
      running: () => [
        h('p', { 'data-part': 'unopened-says' }, h('b', null, `${name} has this browser’s passphrase now`), `: what its agent says of it opens. ${count(d.running.length, 'session')} still running on it ${one ? 'was' : 'were'} started before it was given it, and ${one ? 'goes' : 'go'} on sealing with the other one.`),
        h('p', null, h('b', null, 'What to do there: '), `start ${one ? 'that session' : 'each of those sessions'} again (close it, and resume it or start a new one). Nothing is typed: a session takes the key the plugin has as it starts.`),
        ...(d.left.length ? leftSays(d.left, 'And ') : []),
      ],
      left: () => [h('p', { 'data-part': 'unopened-says' }, h('b', null, `Nothing needs doing on ${name}`), ': what it sends now opens.'), ...leftSays(d.left, '')],
      fine: () => [h('p', { 'data-part': 'unopened-says' }, d.opens || d.m.card ? `✓ Everything it sent opens here${d.opens ? ` (${count(d.opens, 'session')})` : ''}.` : 'Nothing sealed from it is kept here yet to try.')],
    }[stands]()
    return h('div', { class: 'shut-device', 'data-device': d.m.id, 'data-stands': stands }, h('div', { class: 'shut-name' }, h('b', null, name), h('span', { class: 'muted' }, ' · ' + [d.m.platform, heard].filter(Boolean).join(' · '))), ...says)
  }
  const order = ['other', 'was', 'running', 'left', 'fine']
  const devices = [...u.devices].sort((x, y) => order.indexOf(deviceStands(x)) - order.indexOf(deviceStands(y)))
  const closed = u.unplaced.length + u.devices.reduce((n, d) => n + d.running.length + d.left.length, 0)

  // This browser: whether it is the one, by the account's own small session
  const here = !app.key
    ? [h('p', { 'data-part': 'unopened-here' }, 'This browser has not been given your passphrase, so nothing that is sealed opens here. ', h('a', { href: '#/account' }, 'Type it in'))]
    : u.here === 'other'
      ? [
          h('p', { 'data-part': 'unopened-here', class: 'guide-status' }, h('b', null, 'It is this browser.'), ' The passphrase it was given does not open the small session your account keeps here for telling, so it is not the one your account has now: your passphrase was set again on another of your devices, or this browser was given a different one.'),
          h('p', null, h('b', null, 'What to do here: '), 'type your account’s passphrase into this browser. Your sessions open again at once, and nothing is cleared.'),
          h('div', null, typeIt('Type your account’s passphrase')),
          h('p', { class: 'muted' }, 'If the passphrase this browser has is the one you want your account to have, type it there all the same: the page asks whether to reset your account to it, and says how that goes.'),
          closed + u.devices.filter((d) => d.card).length > 0 && h('p', { class: 'muted', 'data-part': 'unopened-rest' }, 'Nothing your computers sent opens here until then. Nothing is wrong on them.'),
        ]
      : !u.any
        ? [h('p', { 'data-part': 'unopened-here', class: 'guide-status connected' }, '✓ Everything kept here for your account opens with this browser’s key. Nothing needs doing.')]
        : mine
          ? [h('p', { 'data-part': 'unopened-here', class: 'guide-status connected' }, u.here === 'same' ? '✓ It is not this browser. It opens the small session your account keeps here for telling, so the passphrase it was given is your account’s.' : '✓ This browser opens what your computers sent, apart from what is listed here.')]
          : [
              h('p', { 'data-part': 'unopened-here', class: 'guide-status' }, 'Nothing here says which passphrase is your account’s: this browser’s key opens nothing your computers have sent, and no small session is kept here for telling. Either this browser was given another passphrase than your computers, or they another than it.'),
              h('p', null, h('b', null, 'If your computers have the right one: '), 'type it into this browser.'),
              h('div', null, typeIt('Type the passphrase here')),
              h('p', null, h('b', null, 'If this browser has the right one: '), 'give it to each computer, as below.'),
            ]

  // The sessions that do not open and that no computer here says are its own
  const lost = () => {
    const now = u.unplaced.filter((s) => s.online && !s.ended)
    const left = u.unplaced.filter((s) => !now.includes(s))
    const one = now.length === 1
    return [
      now.length > 0 && h('p', { 'data-part': 'unopened-unplaced' }, h('b', null, `${count(now.length, 'session')} reporting now cannot be opened`), `, and nothing here names the computer ${one ? 'it is' : 'they are'} on: a session’s computer is named on its card, which is what does not open, and no agent says ${one ? 'it is' : 'they are'} its own. It is a computer of yours that runs no agent, or whose agent is off: one that is not shown above as opening.`),
      ...now.slice(0, 5).map((s) => h('p', { class: 'muted' }, `First heard from ${time(s.createdAt)}, last ${fromNow(s.lastActivity)}.`)),
      now.length > 0 && h('p', null, h('b', null, 'What to do there:')),
      now.length > 0 && steps('that computer'),
      ...(left.length ? leftSays(left, '') : []),
    ]
  }
  // What a browser or a phone sealed, with another key than this one
  const kept = () => {
    const what = [u.favorites && `${u.favorites === 1 ? 'the name' : 'the names'} of ${count(u.favorites, 'favorite')}`, u.marks && `what you put on ${count(u.marks, 'session')} (a name, a label, a reminder)`].filter(Boolean).join(', and ')
    return [
      h('p', { 'data-part': 'unopened-kept' }, `Of what you keep here yourself, ${what} was sealed on a browser or a phone with another passphrase than this one, or on this one before it was given the one it has.`),
      h('p', null, h('b', null, 'What to do there: '), 'on that browser or phone, open Account, choose Change passphrase, and type the passphrase this browser was given. It seals again what it can read with the right key. A favorite is also named again here by itself when its session next reports.'),
    ]
  }
  const shown = app.key && u.here !== 'other'
  const parts = [
    accountPart('This browser', { id: 'unopened-here', 'data-part': 'unopened', 'data-here': u.here, 'data-any': u.any ? 'yes' : 'no' }, ...here),
    shown && devices.length > 0 && accountPart('Your computers', { id: 'unopened-computers' }, ...devices.map(device)),
    shown && u.unplaced.length > 0 && accountPart('Sessions no computer says are its own', { id: 'unopened-unplaced' }, ...lost()),
    shown && u.favorites + u.marks > 0 && accountPart('Kept by a browser or a phone', { id: 'unopened-kept' }, ...kept()),
  ].filter(Boolean)
  parts.at(-1).querySelector('.acct-body').append(h('p', null, h('a', { href: '#/account', 'data-part': 'unopened-back' }, 'Back to your account')))
  fill(body, accountHead('Your account', 'What does not open here', 'Nothing of your passphrase is on the server, so only your own devices can tell whether they were all given the same one: by what opens. This is what this browser finds, as it stands now.'), ...parts)
  body.scrollTop = at
}

// What the account pays, on a server that charges, with the way to Stripe's page to change it
function subscriptionPart(b) {
  if (!b?.on) return null
  const s = b.subscription
  const live = s && ['active', 'trialing', 'past_due'].includes(s.status)
  const plan = live && b.prices.find((p) => p.plan === s.plan)
  const note = h('span', { class: 'form-note error' })
  const says = !live
    ? 'This account is free: nothing is charged for it.'
    : [
        s.status === 'trialing' ? 'On a free trial' : plan ? planText(plan) : s.plan === 'yearly' ? 'Yearly' : 'Monthly',
        s.status === 'past_due' ? 'The last payment did not go through: check your card.' : '',
        s.until ? (s.ending ? `Cancelled: it ends on ${dayText(s.until)}.` : s.status === 'trialing' ? `The first payment is on ${dayText(s.until)}.` : `Renews on ${dayText(s.until)}.`) : '',
      ]
        .filter(Boolean)
        .join('. ')
        .replace(/\.\./g, '.')
  return accountPart(
    'Subscription',
    { id: 'subscription' },
    h('p', { id: 'subscription-says' }, says),
    live && h('div', null, h('button', { type: 'button', class: 'ghost', id: 'subscription-manage', onclick: async () => (note.textContent = await toStripe('/api/billing/portal')) }, 'Change card, plan or cancel'), ' ', note),
  )
}

// The admin's part: who has an account here, and invites to make one
async function renderAdmin() {
  const box = el('admin')
  const r = await fetch('/api/admin/users').catch(() => null)
  if (!r?.ok || !box.isConnected) return
  const { users, invites, signup, billing } = await r.json()
  // Invites are for a server that asks for one, and for one that charges, where an invite makes a free account
  const inviting = signup === 'invite' || (signup === 'open' && billing)
  const paying = (p) => (p.free ? 'free' : ['active', 'trialing', 'past_due'].includes(p.subscription?.status) ? (p.subscription.plan === 'yearly' ? 'pays by the year' : 'pays by the month') : 'no subscription')
  const day = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const send = async (path, method, body) => {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).catch(() => null)
    if (!res?.ok) tell('That was not done', sentence((await res?.json().catch(() => null))?.error ?? 'The server could not be reached.'))
    return res?.ok ? res.json() : null
  }
  const note = h('input', { placeholder: 'Who is it for? (optional)', maxlength: '120' })
  const made = h('div', { id: 'invite-made' })
  const open = invites.filter((i) => !i.usedBy)
  // (an account is known by its email: the server's first, which is the admin's own, may have none yet)
  const who = (p) => p.email || 'The server’s first account'
  const body = h('div', { class: 'acct-body' })
  fill(box, h('h2', null, 'People'), body)
  fill(
    body,
    h('p', { class: 'muted' }, signup === 'open' ? (billing ? 'Anyone can make an account here, and subscribes to use it. One made with an invite from you is free.' : 'Anyone who finds this server can make an account on it.') : signup === 'closed' ? 'This server takes no new accounts.' : 'An account here is made with an invite from you. Each has its own computers and sessions: nobody sees anyone else\'s.'),
    ...users.map((p) =>
      h(
        'div',
        { class: 'person' + (p.disabled ? ' off' : '') },
        h('div', null, h('b', null, who(p)), p.admin ? ' (you, the admin)' : '', h('div', { class: 'muted' }, [`${p.sessions} session${p.sessions === 1 ? '' : 's'}`, `${p.machines} computer${p.machines === 1 ? '' : 's'}`, billing && !p.admin ? paying(p) : '', p.disabled ? 'turned off' : ''].filter(Boolean).join(' · '))),
        // On a server that charges: this account is charged, or isn't
        billing &&
          !p.admin &&
          h(
            'button',
            {
              type: 'button',
              class: 'ghost',
              'data-free': p.id,
              onclick: async () => {
                if (p.free && !(await ask(`Charge for the account of ${p.email}?`, { says: 'They see the plans in place of their sessions, and their computers stop reporting, until they subscribe.', yes: 'Charge' }))) return
                if (await send('/api/admin/users/' + p.id, 'PUT', { free: !p.free })) renderAdmin()
              },
            },
            p.free ? 'Charge' : 'Make free',
          ),
        !p.admin &&
          h(
            'button',
            {
              type: 'button',
              class: 'ghost',
              onclick: async () => {
                if (!p.disabled && !(await ask(`Turn off the account of ${p.email}?`, { says: 'They are signed out, and their computers stop reporting, until you turn it on again. Nothing of theirs is deleted.', yes: 'Turn off' }))) return
                if (await send('/api/admin/users/' + p.id, 'PUT', { disabled: !p.disabled })) renderAdmin()
              },
            },
            p.disabled ? 'Turn on' : 'Turn off',
          ),
        // One that is off can be deleted, with everything it had here
        !p.admin &&
          p.disabled &&
          h(
            'button',
            {
              type: 'button',
              class: 'ghost danger',
              onclick: async () => {
                if (!(await ask(`Delete the account of ${p.email} for good?`, { says: `Their ${p.sessions} session${p.sessions === 1 ? '' : 's'} with their chat, their ${p.machines} computer${p.machines === 1 ? '' : 's'} and their sign-in are removed from this server. This can't be undone.`, yes: 'Delete', danger: true }))) return
                if (await send('/api/admin/users/' + p.id, 'DELETE')) renderAdmin()
              },
            },
            'Delete…',
          ),
      ),
    ),
    inviting && h('h3', null, 'Invite someone'),
    inviting &&
      h(
        'form',
        {
          class: 'guide-form invite-form',
          onsubmit: async (ev) => {
            ev.preventDefault()
            const invite = await send('/api/admin/invites', 'POST', { note: note.value })
            if (!invite) return
            await renderAdmin()
            fill(el('invite-made'), h('p', null, 'Send them this link. It makes one account, and is good until ' + day(invite.expiresAt) + '. It then shows them how to set up.'), codeBox(invite.link))
          },
        },
        note,
        h('button', { type: 'submit', class: 'primary' }, 'Make an invite link'),
      ),
    made,
    ...open.map((i) =>
      h(
        'div',
        { class: 'person' },
        h('div', null, i.note || 'An invite', h('div', { class: 'muted' }, `not used yet · good until ${day(i.expiresAt)}`)),
        h('button', { type: 'button', class: 'ghost', onclick: () => copyText(location.origin + '/#invite=' + i.code) }, 'Copy link'),
        h('button', { type: 'button', class: 'ghost', onclick: async () => (await send('/api/admin/invites/' + i.code, 'DELETE')) && renderAdmin() }, 'Take back'),
      ),
    ),
  )
}
