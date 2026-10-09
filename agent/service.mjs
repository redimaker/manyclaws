// The agent as a service: keeps the index current, answers what the account's own devices
// ask of this machine (through the server, which passes it on and reads none of it), runs
// the sessions it's asked to, and carries the machine's mods' traffic to the server. It
// runs with an API token and the account's key, and without both it only waits for them:
// everything it sends is sealed with that key, and there is no other way for it to send.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store.mjs'
import { Indexer } from './indexer.mjs'
import { Transcript } from './transcript.mjs'
import { Host, HostError, CARRY_MAX } from './host.mjs'
import { Cswap } from './cswap.mjs'
import { seal, open, openAll, isSealed, keysFromText, contentKey, sealBytes, openBytes, isSealedBytes, UNOPENED, readOrder, takeOrder, orderMemory, devicesMemory, OrderRefused } from './seal.mjs'
import { historyRows } from './rows.mjs'
import { find as findFile, read as readFile, FileError, fileRoots } from './files.mjs'
import { takeFromPlugin } from './agent.mjs'

export const VERSION = '5.1.3'

// Something that is waited for no longer than it is given. `start` is handed a signal, which says stop at `ms`; and
// whoever waits stops waiting `stuckMs` after that, whether or not it has ended. The second is what holds: a request
// has been seen never to end and never to be given up (two agents, 2026-10-08 and 09: each went on saying hello for
// hours after the answer to a poll that it never asked again), and waiting on such a one was for ever.
export function ended(start, ms, stuckMs = STUCK_MS) {
  const stop = new AbortController()
  let told = null
  let late = null
  const given = new Promise((_, no) => {
    told = setTimeout(() => stop.abort(Object.assign(new Error(`no answer in ${ms / 1000} s`), { name: 'TimeoutError' })), ms)
    late = setTimeout(() => no(Object.assign(new Error(`it did not end ${stuckMs / 1000} s after it was told to stop`), { name: 'StuckError' })), ms + stuckMs)
  })
  const whole = Promise.resolve().then(() => start(stop.signal))
  // (given up, it may still end one day, either way: nobody is waiting, and nothing is to be said of it)
  whole.catch(() => {})
  return Promise.race([whole, given]).finally(() => (clearTimeout(told), clearTimeout(late)))
}

// A chat as words, oldest first, for a session that is to take it as what was said
// before: who spoke, what they said, and what was run. The rows are the ones a chat
// window draws. The end of it is what matters most, so one too long for a prompt
// loses its beginning.
const CHAT_TEXT_MAX = 180_000
export function chatText(rows, max = CHAT_TEXT_MAX) {
  const parts = []
  for (const r of rows) {
    const text = typeof r?.text === 'string' ? r.text.trim() : ''
    if (!text) continue
    if (r.role === 'user') parts.push('User: ' + text)
    else if (r.role === 'assistant') parts.push('Assistant: ' + text)
    else if (r.role === 'tool') parts.push(`[Assistant used ${typeof r.tool === 'string' && r.tool ? r.tool : 'a tool'}: ${text.slice(0, 600)}]`)
    else if (r.role === 'result' || r.role === 'output') parts.push(`[Result: ${text.slice(0, 1200)}]`)
  }
  const all = parts.join('\n\n')
  return all.length > max ? '[The beginning of the conversation is left out.]\n\n' + all.slice(-max) : all
}

// What a session that starts from another's words is told first
const HANDOFF_LEAD = 'You are taking over work from another Claude Code session. The handoff document that session wrote for you follows. Start from there: read it, then carry on with the work where it left off.'
const CHAT_LEAD =
  'What follows is the conversation so far of another Claude Code session, which this session continues. Its transcript could not be brought over whole, so this is what its chat window showed. Take it as what you and the user have said and done until now. Do nothing with it yet: answer only with one short line saying that you have it, and wait for what the user asks next.'

// A transcript goes to another machine in pieces small enough for any proxy on the way
const CARRY_PART = 2 * 1024 * 1024
const CARRY_MS = 10 * 60_000
const FILES_HELD = 4 // files held at once for their later pieces (see file.read)

// Whether anything in what arrived is still sealed: this machine has no key for it, or not the right one
const unopened = (value, depth = 0) => (typeof value === 'string' ? isSealed(value) || value === UNOPENED : !!value && typeof value === 'object' && depth < 8 && Object.values(value).some((v) => unopened(v, depth + 1)))
const NO_KEY = 'what arrived is sealed, and this machine does not have the key that opens it: run the agent\'s installer again and give it your passphrase'

// What the agent sends of this machine's sessions is sealed with the account's key
// (seal.mjs), and sealed whole: nothing of a session's messages, or of how they are made
// up, or of where and how it runs, is the server's to read. So of what
// a call comes to (`r`), and of what the machine says of the sessions it runs and has
// open, the server is given one sealed thing. Beside it, in the open, is only what the
// server passes a thing on by: a session's id, a transcript's pieces on their way to
// another machine, and how many there are. The rows of a transcript are made here
// (rows.mjs), as a session's plugin makes its own. What comes in sealed from the page (a
// prompt, a search, which folder) is opened here, and what is read here is read as the
// page sealed it and no other way (see `asked`).
const OPEN_ANSWER = {
  'session.start': ['sid'],
  'session.resume': ['sid'],
  'session.seed': ['sid'],
  'session.import': ['sid'],
  'session.send': ['sid'],
  'session.stop': ['sid'],
  'session.mode': ['sid'],
  'session.export': ['id', 'parts', 'sealed'],
  'session.export.part': ['data'],
  'session.import.part': ['part'],
  // (a file is sealed where it is read: what it is, its name for its later pieces, and its bytes)
  'file.read': ['id', 'file', 'size', 'parts', 'data'],
  'file.part': ['data'],
}
// What a call came to, for the server: what it passes on by, and the rest sealed whole
function closed(method, value, key) {
  const open = Object.fromEntries((OPEN_ANSWER[method] ?? []).filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]))
  // (a transcript's piece, or a file's, is its own sealed bytes: there is nothing beside it to seal)
  if (method.endsWith('.part') || method === 'file.read') return open
  return { ...open, r: seal(value ?? null, key) }
}
// What this machine takes as it came, in the open, and of it these and nothing else: a
// piece of a transcript on its way from here or to here (which carrying it is of,
// and which piece: the carrying itself was signed for), and what only stops a session.
const PLAIN = {
  'session.export.part': ['id', 'part'],
  'session.import.part': ['id', 'part', 'data'],
  'session.stop': ['sid'],
}
const UNSEALED_ASK = 'this machine reads what it is asked only where the asking came sealed with your key, and this did not: open your key on the device you are asking from (Account)'
// What the relay answers anything that is not a ManyClaws plugin's, sealed (see the relay)
const UNSEALED_RELAY = 'this machine carries to the server only what the ManyClaws plugin sealed with your key, and this was not that: in Claude Code, /plugin update manyclaws@manyclaws'
const SCAN_MS = 10_000 // how often the disk is checked for new and changed transcripts
const FROM_PLUGIN_MS = 3000 // how often the agent looks for what the plugin left for it
const HELLO_MS = 60_000
const POLL_WAIT_S = 25
const POLL_MS = (POLL_WAIT_S + 15) * 1000 // how long a poll is given: what the server holds it for, and some
const STUCK_MS = 5_000 // how long after a request is told to stop it is waited for no longer
const DEVICES_MS = 2000 // the list of the account's devices is not asked for again sooner than this after it was
const DEVICES_EVERY_MS = 5 * 60_000 // and it is read this often with no order to go by: a device taken off it is seen to be, while the list without it is still what the server hands over
const OPEN_TRANSCRIPTS = 16 // sessions kept ready to read

export async function run(config, flags = {}) {
  // (launchd and systemd keep what the service prints)
  const log = (...a) => console.log([new Date().toISOString(), ...a].join(' '))
  const store = new Store(config.db)
  const indexer = new Indexer(store, config.roots, { only: config.only ?? [], skip: config.skip ?? [] })
  const machine = {
    id: config.id || (config.id = crypto.randomUUID()),
    name: os.hostname(),
    label: config.label || '',
    platform: `${os.type()} ${os.arch()}`,
  }
  let announce = () => {}
  let tokenRefused = false // the server would not take this machine's token (401): the plugin's is taken in its place
  const host = new Host(config, { store, log, onChange: () => announce() })
  const cswap = new Cswap(config, { fail: (text) => new HostError(text) })
  // What it signs in with and what it seals with. With all three it is this account's
  // machine; without one of them it says nothing to anybody, and waits (see the end).
  const server = String(config.server ?? '').replace(/\/+$/, '')
  const keys = config.key ? keysFromText(config.key) : null
  const ready = !!(server && config.token && keys)
  const sealKey = keys ? contentKey(keys.key) : null
  // Files are opened from here for the account's own devices, and only from inside the folders this machine's owner
  // lets sessions be started in, or the ones agent.json names for it (`"files": [...]`); `"files": false` opens none.
  // (as those folders really are on disk: a file is one of theirs by where it really is, links followed. files.mjs)
  const filesFrom = config.files === false ? null : fileRoots(Array.isArray(config.files) ? config.files : host.spawnConfig.enabled ? host.spawnConfig.folders : [])
  const servesFiles = !!filesFrom?.length
  const transcripts = new Map() // path -> Transcript, most recently used last
  // Transcripts on their way to or from another machine, held for the minutes that takes
  const outgoing = new Map() // id -> { bytes, at }
  const incoming = new Map() // id -> { parts, size, at }
  const held = (map) => {
    for (const [id, x] of map) if (Date.now() - x.at > CARRY_MS) map.delete(id)
    return map
  }

  // Every session open in a Claude Code process here, with what its transcript calls it:
  // the session's id is its transcript's file name, so the two are one thing
  const openSessions = () => {
    const open = host.open()
    for (const [sid, o] of Object.entries(open)) {
      const s = store.session(sid)
      o.title = s?.title ?? ''
      o.firstPrompt = s?.first_prompt ?? ''
    }
    return open
  }
  let announcedTitles = ''

  // ---- The index: scanned on a timer, read a slice at a time between other work

  let indexing = false
  const index = () => {
    if (indexing) return
    indexing = true
    let found = 0
    try {
      found = indexer.scan()
    } catch (err) {
      log('scan failed:', err.message)
    }
    const step = () => {
      let left = 0
      try {
        left = indexer.step()
      } catch (err) {
        log('index failed:', err.message)
        indexer.pending.shift()
        left = indexer.pending.length
      }
      if (left) return setImmediate(step)
      indexing = false
      if (found > 20) log(`indexed ${found} files; ${JSON.stringify(store.stats())}`)
      // A running session's title changes as it goes: the server is told when one does
      const titles = JSON.stringify(Object.entries(openSessions()).map(([sid, o]) => [sid, o.title, o.firstPrompt]))
      if (titles !== announcedTitles) {
        announcedTitles = titles
        announce()
      }
    }
    setImmediate(step)
  }
  index()
  setInterval(index, (Number(config.scanSeconds) || SCAN_MS / 1000) * 1000).unref()

  // ---- What the server can ask for

  const transcript = (file, side) => {
    let t = transcripts.get(file)
    transcripts.delete(file)
    if (!t) t = new Transcript(file, { side })
    transcripts.set(file, t)
    if (transcripts.size > OPEN_TRANSCRIPTS) transcripts.delete(transcripts.keys().next().value)
    return t.sync()
  }

  const methods = {
    status: () => describe(),
    'sessions.list': ({ limit, before, q, cwd } = {}) => ({ sessions: store.sessions({ limit, before, q, cwd }), open: host.open(), hosted: host.list() }),
    'session.get': ({ sid } = {}) => ({ session: store.session(String(sid ?? '')) ?? null, open: host.open()[sid] ?? null }),
    // The folders sessions have run in, the ones a session may be started in, and the folders right under those
    folders: async () => ({ folders: store.folders(), allowed: host.spawnConfig.enabled ? host.spawnConfig.folders : [], ...(host.spawnConfig.enabled ? await host.subfolders() : { others: [], unread: [] }) }),
    search: (args = {}) => ({ results: store.search(args), indexing: indexer.pending.length }),
    // The same search as a way down: the projects with matches, the sessions in one, the matches in one
    'search.projects': (args = {}) => ({ ...store.searchProjects(args), indexing: indexer.pending.length }),
    'search.sessions': (args = {}) => store.searchSessions(args),
    'search.hits': (args = {}) => store.searchHits(args),
    // A page of a conversation: the last `limit` lines before `before`, or around one line.
    // `subagent` (a file id from a search hit) reads a subagent's own conversation.
    'session.read': ({ sid, subagent, limit = 200, before, around, max = 8000 } = {}) => {
      const file = subagent ? store.fileById(subagent) : null
      // (which session is the asking's to say: one that does not is no session here)
      const session = file ? null : store.session(String(sid ?? ''))
      const where = file?.path ?? session?.path
      if (!where) throw new HostError('no such session on this machine')
      const t = transcript(where, !!file)
      const chain = t.chain()
      const size = Math.min(Math.max(1, Number(limit) || 200), 1000)
      let to = Number.isInteger(before) ? Math.min(before, chain.length) : chain.length
      if (around) {
        const at = chain.indexOf(around)
        if (at >= 0) to = Math.min(chain.length, at + Math.ceil(size / 2))
      }
      const from = Math.max(0, to - size)
      const rows = t.rows(from, to, max)
      // (its rows are made here, in an answer that is sealed whole: nobody between here and the page can make them of what they can't read)
      return { rows: historyRows(rows), from, to, total: chain.length, session: session ?? store.remnant(file.sid) ?? null, open: host.open()[sid] ?? null }
    },
    'session.start': (args) => host.start(args ?? {}),
    'session.resume': (args) => host.resume(args ?? {}),
    // A session carried whole to another machine: its transcript, packed, and sealed with
    // the account's key, handed over a piece at a time. The server passes each piece on as
    // it is, and the other machine puts them together. One is packed only for whoever
    // signed for it (see ORDERED).
    'session.export': ({ sid } = {}) => {
      const { packed } = host.exportSession({ sid })
      const bytes = Buffer.from(sealBytes(new Uint8Array(packed), sealKey))
      const id = crypto.randomUUID()
      held(outgoing).set(id, { bytes, at: Date.now() })
      // (where it ran is the order's to say to the machine it goes to, which the page signed: it is not said here in the open)
      return { id, sealed: true, size: bytes.length, parts: Math.ceil(bytes.length / CARRY_PART) }
    },
    'session.export.part': ({ id, part } = {}) => {
      const out = held(outgoing).get(id)
      if (!out || out.file) throw new HostError('that transcript is no longer held here: start again')
      const parts = Math.ceil(out.bytes.length / CARRY_PART)
      if (!Number.isInteger(part) || part < 0 || part >= parts) throw new HostError('the transcript has no such part')
      out.at = Date.now()
      if (part === parts - 1) outgoing.delete(id)
      return { data: out.bytes.subarray(part * CARRY_PART, (part + 1) * CARRY_PART).toString('base64') }
    },
    // A file on this machine that a link in a session's chat names (files.mjs): found from
    // what the link says and where its session runs, read, and sealed whole with the
    // account's key. It leaves here no other way, and only for a device that signed for it
    // (see ORDERED). What it is and where it was found go sealed too; its size shows. The
    // first piece goes with the answer, and a file of more pieces hands the rest over as
    // a transcript's are.
    'file.read': async ({ path: target, cwd, sid, near } = {}) => {
      if (!servesFiles) throw new HostError(config.files === false ? 'opening files is turned off on this machine (agent.json, "files")' : 'this machine opens files only from the folders its owner named, and none are named: the ones sessions may be started in (the installer\'s --spawn), or others for this (--files)')
      try {
        const found = await findFile(target, { cwd: typeof cwd === 'string' && cwd ? cwd : (store.session(String(sid ?? ''))?.cwd ?? ''), near, within: filesFrom })
        const { bytes, ...listing } = await readFile(found)
        const { real, ...where } = found
        const file = seal({ ...where, name: path.basename(found.path), sep: path.sep }, sealKey)
        // (an empty file is nothing to seal: that it is empty is said with the rest of what it is)
        if (bytes && !bytes.length) return { file, size: 0, parts: 0, data: '' }
        const packed = Buffer.from(sealBytes(new Uint8Array(bytes ?? Buffer.from(JSON.stringify(listing))), sealKey))
        const id = crypto.randomUUID()
        const parts = Math.ceil(packed.length / CARRY_PART)
        if (parts > 1) {
          // (a few at most are held for their later pieces: one nobody came back for makes way for the next)
          const waiting = [...held(outgoing)].filter(([, o]) => o.file)
          for (const [old] of waiting.slice(0, Math.max(0, waiting.length - FILES_HELD + 1))) outgoing.delete(old)
          outgoing.set(id, { bytes: packed, at: Date.now(), file: true })
        }
        return { id: seal(id, sealKey), file, size: packed.length, parts, data: packed.subarray(0, CARRY_PART).toString('base64') }
      } catch (err) {
        if (err instanceof FileError) throw new HostError(err.message)
        // (what else went wrong may name what is on this machine: that is for the log here, and is not sent)
        log('file.read failed:', err.stack ?? err)
        throw new HostError('that file could not be read')
      }
    },
    'file.part': ({ id, part } = {}) => {
      const out = held(outgoing).get(id)
      if (!out?.file) throw new HostError('that file is no longer held here: open it again')
      const parts = Math.ceil(out.bytes.length / CARRY_PART)
      if (!Number.isInteger(part) || part < 1 || part >= parts) throw new HostError('the file has no such part')
      out.at = Date.now()
      if (part === parts - 1) outgoing.delete(id)
      return { data: out.bytes.subarray(part * CARRY_PART, (part + 1) * CARRY_PART).toString('base64') }
    },
    'session.import.part': ({ id, part, data } = {}) => {
      if (typeof id !== 'string' || !id || id.length > 64) throw new HostError('whose part this is was not said')
      const got = held(incoming).get(id) ?? { parts: [], size: 0, at: Date.now() }
      if (part !== got.parts.length) throw new HostError('a part of the transcript arrived out of turn')
      const bytes = Buffer.from(String(data ?? ''), 'base64')
      got.size += bytes.length
      got.at = Date.now()
      incoming.delete(id)
      if (got.size > CARRY_MAX + 64) throw new HostError('the transcript is too large to carry over whole')
      got.parts.push(bytes)
      incoming.set(id, got)
      return { part }
    },
    'session.import': ({ id, like, mode, model, effort, listed } = {}) => {
      const got = held(incoming).get(id)
      incoming.delete(id)
      if (!got) throw new HostError('no transcript arrived to start from')
      const packed = Buffer.concat(got.parts)
      // (a transcript is taken sealed, by another of the account's machines, or not at all)
      if (!isSealedBytes(packed)) throw new HostError('the transcript did not come sealed, so it was not taken')
      const opened = openBytes(new Uint8Array(packed), sealKey)
      if (!opened) throw new HostError(NO_KEY)
      return host.importSession({ packed: Buffer.from(opened), like, mode, model, effort, listed })
    },
    // A new session that starts from words: a handoff another session wrote (`text`), or
    // what the server kept of a chat whose transcript can't be had (`rows`). They arrive
    // here opened, where they were sealed.
    'session.seed': ({ like, text, rows, mode, model, effort, listed } = {}) => {
      if (unopened(text) || unopened(rows)) throw new HostError(NO_KEY)
        // (a session's handoff comes as its turn ended, with how it ended: whether it is one is said here, where it can be read)
      if (text && typeof text === 'object') {
        if (text.aborted || text.reason === 'aborted') throw new HostError('the session was interrupted before it had written its handoff')
        if ((text.reason && text.reason !== 'answer') || !String(text.text ?? '').trim()) throw new HostError('the session wrote no handoff' + (text.reason && text.reason !== 'answer' ? ` (${text.reason})` : ''))
        text = String(text.text)
      }
      const said = (Array.isArray(rows) ? chatText(rows) : typeof text === 'string' ? text : '').trim()
      if (!said) throw new HostError('there is nothing to start the new session from')
      return host.start({ like, prompt: (Array.isArray(rows) ? CHAT_LEAD : HANDOFF_LEAD) + '\n\n---\n\n' + said, mode, model, effort, listed })
    },
    'session.send': (args) => host.send(args ?? {}),
    'session.stop': (args) => host.stop(args ?? {}),
    'session.mode': (args) => host.setMode(args ?? {}),
    // cswap, where the machine has it: the Claude accounts here, and a switch to one of them
    'cswap.list': () => cswap.list(),
    'cswap.switch': ({ to } = {}) => cswap.switchTo(to),
  }

  function describe() {
    const about = {
      roots: config.roots,
      spawn: host.spawnConfig.enabled ? { folders: host.spawnConfig.folders, modes: host.spawnConfig.modes } : null,
      // (the folders a file may be opened from)
      files: filesFrom ?? [],
      stats: { ...store.stats(), pending: indexer.pending.length, bytesLeft: Math.max(0, indexer.bytesLeft) },
    }
    // What the machine is called and what its agent can do are the account's to see as a
    // device of its own, and are in the open: among them that it seals all it says (2),
    // and does what it is asked on a signed order alone. Its folders, what it has indexed,
    // and everything of the sessions it runs or has open are sealed: of those the server
    // is told which sessions they are (it passes a reply on to the machine that runs
    // one), and nothing of them.
    return {
      ...machine,
      agent: VERSION,
      node: process.version,
      capabilities: ['sessions', 'search', ...(host.spawnConfig.enabled ? ['spawn', 'branch', 'listed'] : []), ...(config.relay?.port ? ['relay'] : []), ...(cswap.path ? ['cswap'] : []), ...(servesFiles ? ['files'] : []), 'sealed', 'orders'],
      sealed: 3,
      spawn: !!about.spawn,
      card: seal(about, sealKey),
      hosted: host.list().map(({ sid, ...rest }) => ({ sid, s: seal(rest, sealKey) })),
      open: Object.fromEntries(Object.entries(openSessions()).map(([sid, { title, firstPrompt, ...rest }]) => [sid, { named: seal(title || String(firstPrompt ?? '').slice(0, 80), sealKey), s: seal(rest, sealKey) }])),
    }
  }

  // ---- Orders. What acts here is done only on an order: what a person asked from a
  // phone or a browser that has the passphrase, signed there with that device's own key
  // (seal.mjs). Which devices those are is on the list the passphrase signed, which this
  // machine reads from the server before it goes by an order (freshDevices, below), and
  // keeps: it takes a list only where it is the account's and no older than the one it
  // has, so a device taken off the list is refused from then on, whatever the server
  // hands over later.
  // It is run with what the order says, not with what came beside it, which is the
  // server's to have written. What only reads needs none, and is run with what the page
  // sealed for it and nothing else; what only stops a session needs none either (`asked`).
  // The orders run are remembered in a file, so that none is run again after a restart.
  const ordersFile = path.join(process.env.MANYCLAWS_HOME || path.join(os.homedir(), '.manyclaws'), 'orders.json')
  let ordersKept = null
  try {
    ordersKept = JSON.parse(fs.readFileSync(ordersFile, 'utf8'))
  } catch {}
  const orders = orderMemory(ordersKept, (now) => {
    try {
      fs.writeFileSync(ordersFile, JSON.stringify(now), { mode: 0o600 })
    } catch {}
  })
  const devicesFile = path.join(process.env.MANYCLAWS_HOME || path.join(os.homedir(), '.manyclaws'), 'devices')
  let devicesKept = null
  try {
    devicesKept = fs.readFileSync(devicesFile, 'utf8')
  } catch {}
  // (and the devices it has seen taken off that list, which are none of the account's here again whatever list has them
  // later: kept by whose list it is, so that another passphrase's starts with none)
  const goneFile = devicesFile + '-gone.json'
  const whose = keys ? Buffer.from(keys.checker).toString('base64url') : ''
  let goneKept = []
  try {
    const was = JSON.parse(fs.readFileSync(goneFile, 'utf8'))
    if (was?.checker === whose && Array.isArray(was.gone)) goneKept = was.gone
  } catch {}
  const devices = devicesMemory(
    devicesKept,
    sealKey,
    keys?.checker,
    (now) => {
      try {
        fs.writeFileSync(devicesFile, now, { mode: 0o600 })
      } catch {}
    },
    {
      gone: goneKept,
      saveGone: (gone) => {
        log(`a device was taken off the list of your account's devices: what it asks is refused here from now on, whatever list has it later (${gone.length} taken off so far)`)
        try {
          fs.writeFileSync(goneFile, JSON.stringify({ checker: whose, gone }), { mode: 0o600 })
        } catch {}
      },
    },
  )
  let devicesRead = null // the last reading of that list from the server, or the one under way: { at, done }
  let taken = null // the order the call being answered was run on: forgotten again if it did not run after all
  const take = (order, to, does) => {
    try {
      const o = takeOrder(order, { key: sealKey, devices: devices.list, to, does, seen: orders })
      taken = o.n
      return o
    } catch (err) {
      if (!(err instanceof OrderRefused)) throw err
      throw new HostError(`this machine does what it is asked only when a device that has your passphrase signed it: ${err.message}`)
    }
  }
  const asks = (order) => readOrder(order, sealKey, devices.list)?.do
  // A new session from another, on the order for it: which says how it is to be made (new,
  // clone or handoff), so that one asked for empty is not made from words instead
  const branch = (a, ...hows) => {
    const o = readOrder(a.order, sealKey, devices.list)
    if (o && o.do === 'branch' && !hows.includes(o.with.how)) throw new HostError('this machine does what it is asked only when a device that has your passphrase signed it: it was signed for something else')
    return take(a.order, machine.id, ['branch']).with
  }
  // (what a new session is seeded with is what another of the account's computers sealed, or it is nothing: a handoff
  // sealed whole, or rows each sealed whole. A row with anything of it in the open is not one.)
  const cameSealed = (v) => (Array.isArray(v) ? v.length > 0 && v.every((row) => row && isSealed(row.row)) : isSealed(v))
  // For each call that acts: what it is run with, from its order (`a` is what came, opened; `raw`, as it came).
  // Every order this agent takes is signed for this machine, and says in itself which
  // session it is about: one signed for a session's own plugin, or for another machine's
  // agent, is not taken here, so an order has one runner and that runner's memory of it.
  const ORDERED = {
    // A reply, for a session this machine runs
    'session.send': (a) => {
      const w = take(a.order, machine.id, ['prompt']).with
      return { sid: String(w.sid ?? ''), text: String(w.text ?? '') }
    },
    'session.resume': (a) => {
      const what = asks(a.order)
      // A reply to a session that has exited, which starts it again
      if (what === 'prompt') {
        const w = take(a.order, machine.id, ['prompt']).with
        return { sid: String(w.sid ?? ''), prompt: String(w.text ?? ''), mode: w.mode }
      }
      // One opened from its transcript: signed for this machine
      if (what === 'open') {
        const w = take(a.order, machine.id, ['open']).with
        return { sid: w.sid, prompt: w.prompt, mode: w.mode, model: w.model, effort: w.effort, fork: w.fork === true }
      }
      // A copy of one that is here
      const w = branch(a, 'clone')
      return { sid: w.from, fork: true, idle: true, mode: w.mode, listed: w.listed }
    },
    'session.start': (a) => {
      if (asks(a.order) === 'branch') {
        const w = branch(a, 'new')
        return { ...(w.cwd ? { cwd: w.cwd } : { like: w.like }), idle: true, mode: w.mode, listed: w.listed }
      }
      const w = take(a.order, machine.id, ['start']).with
      return { cwd: w.cwd, prompt: w.prompt, mode: w.mode, model: w.model, effort: w.effort, name: w.name, create: w.create === true, listed: w.listed }
    },
    'session.seed': (a, raw) => {
      if (!cameSealed(raw.rows ?? raw.text)) throw new HostError('what the new session was to start from did not come sealed, so it was not started')
      if (Array.isArray(a.rows) && a.rows.some((row) => unopened(row?.row))) throw new HostError(NO_KEY)
      // (each row came sealed whole, `row`: who said it, what was said and a tool's name are what was sealed there, and
      // nothing that came beside it is read)
      const rows = Array.isArray(a.rows)
        ? a.rows
            .map((row) => (row?.row && typeof row.row === 'object' ? row.row : {}))
            .filter((row) => ['user', 'assistant', 'tool', 'result', 'output'].includes(row.role) && row.text)
            .map((row) => ({ role: row.role, text: row.text, ...(typeof row.tool === 'string' ? { tool: row.tool } : {}) }))
        : undefined
      const w = rows ? branch(a, 'clone') : branch(a, 'handoff')
      return { like: w.cwd || w.like, text: rows ? undefined : a.text, rows, mode: w.mode, listed: w.listed }
    },
    'session.import': (a) => {
      const w = branch(a, 'clone')
      return { id: a.id, like: w.cwd || w.like, mode: w.mode, listed: w.listed }
    },
    // A transcript is packed to leave here for whoever signed for it: which session's, the order says
    'session.export': (a) => ({ sid: String(take(a.order, machine.id, ['export']).with.sid ?? '') }),
    'session.mode': (a) => {
      const w = take(a.order, machine.id, ['mode']).with
      return { sid: String(w.sid ?? ''), mode: String(w.mode ?? '') }
    },
    'cswap.switch': (a) => ({ to: take(a.order, machine.id, ['cswap']).with.to }),
    // A file is read for whoever signed for it: which file, and where its session runs, are the order's to say
    'file.read': (a) => {
      const w = take(a.order, machine.id, ['file']).with
      return { path: w.path, cwd: w.cwd, sid: w.sid, near: w.near }
    },
    // (and the rest of one is handed to whoever was told, sealed, which it is)
    'file.part': (a, raw) => {
      if (!isSealed(raw.id)) throw new HostError('which file that is did not come sealed')
      return { id: a.id, part: a.part }
    },
  }

  // ---- The server

  const headers = { authorization: 'Bearer ' + config.token, 'content-type': 'application/json', 'x-manyclaws-machine': machine.id }
  // A request to the server, with the time it is given, and its answer's text read inside that time (a body that
  // stops half way is a request that has not ended)
  const request = (p, init = {}, ms = 30_000) => ended((signal) => fetch(server + p, { ...init, headers, signal }).then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() })), ms)
  const post = (p, body, ms = 30_000) => request(p, { method: 'POST', body: JSON.stringify(body) }, ms)
  // A call's answer, sent until the server has had it, three times at the most. Sent once, an answer whose request
  // failed on its way (a connection the server had let go of meanwhile, the network gone for a moment) was lost, and
  // whoever had asked waited for nothing: a transcript on its way to another machine never arrived for one piece of
  // it. The server takes an answer it has had already for nothing new. (One that ran out of time is not sent again:
  // it had all the time an answer is given.)
  const sendAnswer = async (body, ms) => {
    for (let tries = 1; ; tries++) {
      try {
        return await post('/api/machine/result', body, ms)
      } catch (err) {
        if (tries >= 3 || err?.name === 'TimeoutError') throw err
        await new Promise((done) => setTimeout(done, 300 * tries))
      }
    }
  }

  if (ready) {
    let helloTimer = null
    announce = () => {
      clearTimeout(helloTimer)
      helloTimer = setTimeout(async () => {
        try {
          const r = await post('/api/machine/hello', { machine: describe() })
          if (!r.ok) log('hello refused:', r.status, r.text.slice(0, 400))
          // (a token the server will not take is one to be replaced by the plugin's: see takeFromPlugin)
          tokenRefused = r.status === 401
        } catch (err) {
          log('server unreachable:', err.message, err.cause?.message ?? '')
        }
        helloTimer = setTimeout(announce, HELLO_MS)
      }, 50)
    }
    announce()

    // Calls come down a long poll; each answer goes back on its own
    let cursor = 0
    // (when a poll last ended, either way, and which loop is the one polling: see the timer under the loop)
    let polled = Date.now()
    let polling = 0
    const poll = async (mine = ++polling) => {
      for (;;) {
        // (a loop that was given up for stopped, and has woken after all, leaves the polling to the one started in its place)
        if (mine !== polling) return
        try {
          const r = await request(`/api/machine/poll?machine=${machine.id}&after=${cursor}&wait=${POLL_WAIT_S}`, {}, POLL_MS)
          polled = Date.now()
          if (!r.ok) throw new Error('poll ' + r.status)
          const { commands = [], unknown } = JSON.parse(r.text)
          // The server doesn't know the machine yet, or restarted and has forgotten what
          // it runs: say hello, and give that a moment before asking again
          if (unknown) {
            announce()
            await new Promise((r) => setTimeout(r, 1000))
          }
          for (const c of Array.isArray(commands) ? commands : []) {
            // (what is not a call is passed over, and no call ends the agent: not one with no name, nor one whose answer could not be made)
            if (!c || typeof c !== 'object') continue
            if (Number.isFinite(c.seq)) cursor = Math.max(cursor, c.seq)
            answer(c).catch((err) => log('a call was not answered:', err?.stack ?? err))
          }
        } catch (err) {
          polled = Date.now()
          // (a request that did not end is said whether or not the rest is: it is what stops a machine being heard)
          if (flags.verbose || err?.name === 'StuckError') log('poll:', err.message)
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    }
    // The loop above is all that asks for this machine's calls, and nothing here can end it. Should it stop all the
    // same, for longer than three polls take, another is started in its place: without one the machine goes on
    // saying hello, so it shows as there, and answers nothing it is asked.
    setInterval(() => {
      if (Date.now() - polled < 3 * POLL_MS) return
      log(`no poll has ended in ${Math.round((Date.now() - polled) / 1000)} s: polling is started again`)
      polled = Date.now()
      poll()
    }, POLL_MS).unref()
    // What a call is run with, of what came with it (`raw`).
    // What acts: what its order says (ORDERED), with what came sealed beside it opened.
    // A piece of a transcript on its way, and what only stops: as it came (PLAIN).
    // Everything else reads, and is run with the one thing the page sealed for it (`c`:
    // which session, which folder, what words, how many) and nothing that came beside
    // it. What comes beside it is the server's to have written: read by that, a machine
    // would search its sessions for words of the server's choosing, or read one a row
    // at a time, and how long each answer came to would say what is in them. With no
    // `c`, nothing is read.
    const asked = (method, raw) => {
      const came = raw && typeof raw === 'object' ? raw : {}
      if (Object.hasOwn(ORDERED, method)) return ORDERED[method](openAll(came, sealKey), came)
      if (Object.hasOwn(PLAIN, method)) return Object.fromEntries(PLAIN[method].map((k) => [k, came[k]]))
      if (!isSealed(came.c)) throw new HostError(UNSEALED_ASK)
      const what = open(came.c, sealKey, null)
      if (!what || typeof what !== 'object' || Array.isArray(what)) throw new HostError(NO_KEY)
      return what
    }
    // The list of the account's devices, read from the server and taken where it is the account's
    const readList = async () => {
      try {
        const r = await request('/api/agent/devices', {}, 10_000)
        if (r.ok) devices.take(JSON.parse(r.text).devices)
      } catch {}
    }
    // The account's devices, as the server has them now: asked for before an order is gone by (and not again within two seconds)
    const freshDevices = async () => {
      // (orders that come together are gone by one reading, which each of them waits for)
      if (!devicesRead || Date.now() - devicesRead.at >= DEVICES_MS) devicesRead = { at: Date.now(), done: readList() }
      await devicesRead.done
    }
    // And read as the agent starts, and every so often after, with no order to go by (DEVICES_EVERY_MS). Those readings
    // are apart from the one an order waits for: an order from a browser that was given the passphrase a moment ago is
    // gone by the list as it stands then, not by one read just before the browser was on it.
    readList()
    setInterval(readList, DEVICES_EVERY_MS).unref()
    const answer = async (c) => {
      // (a call with no name is one this machine does not know)
      const method = typeof c.method === 'string' ? c.method : ''
      let body
      try {
        const fn = Object.hasOwn(methods, method) ? methods[method] : null
        if (!fn) throw new HostError('unknown method ' + method)
        if (Object.hasOwn(ORDERED, method)) await freshDevices()
        // (what comes in from the page is opened, and what goes back closed)
        taken = null
        const args = asked(method, c.args)
        const order = taken
        // (what did not run after all may be asked again with the order it had: the server falls back from one way of making a session to another)
        const value = await Promise.resolve()
          .then(() => fn(args))
          .catch((err) => {
            if (order) orders.forget(order)
            throw err
          })
        body = { machine: machine.id, id: c.id, ok: true, value: closed(method, value, sealKey) }
      } catch (err) {
        if (!(err instanceof HostError)) log(method, 'failed:', err?.stack ?? err)
        // (why not, sealed: it may name a folder, a file or a session. That it does not know a call is said in the open: the
        // name is the server's own, and it is by this that the server says a machine's agent wants bringing up to date.)
        const why = String(err?.message ?? err)
        body = { machine: machine.id, id: c.id, ok: false, error: why.startsWith('unknown method ') ? why : seal(why, sealKey) }
      }
      // (a transcript on its way to another machine is megabytes, and so may a file be: each is given the time that takes)
      sendAnswer(body, method === 'session.export.part' || method.startsWith('file.') ? 180_000 : 30_000).catch((err) => log('result not sent:', err.message))
    }
    poll()
  } else if (config.locked) {
    // They are in the keychain, and it would not hand them over (it is locked, as it is until the account's user has
    // signed in on the machine's own screen): asked again by starting again, which whatever keeps the agent running does
    log(`this machine's API token and key are in the keychain, which did not hand them over (${config.locked}): starting again in a moment to ask again`)
    setTimeout(() => process.exit(1), 15_000)
  } else {
    const how = '(in Claude Code: /plugin, the gear beside manyclaws, then a new session). Indexing meanwhile'
    log(!server ? 'no server in agent.json: indexing only' : !config.token ? `no API token yet: waiting for the ManyClaws plugin to give this machine its token and key ${how}` : `no encryption key yet: waiting for the ManyClaws plugin to give this machine its key ${how}`)
  }

  // ---- The relay: the machine's mods talk to the agent, and the agent to the server,
  // so the machine has one connection out

  if (config.relay?.port && ready) {
    const relay = http.createServer(async (req, res) => {
      const done = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(typeof body === 'string' ? body : JSON.stringify(body))
      }
      if (!req.url.startsWith('/api/agent/')) return done(404, { error: 'not found' })
      if (config.relay.secret && req.headers.authorization !== 'Bearer ' + config.relay.secret) return done(401, { error: 'bad relay token' })
      const chunks = []
      for await (const c of req) chunks.push(c)
      // Only what a plugin sealed is carried: nothing that says in the open what a session is, or what is said in it,
      // leaves this machine by way of its agent. What a plugin sends with a body is a batch, which says of itself that it
      // is sealed whole and each thing in it likewise, or an answer given at its terminal, which is one sealed thing.
      // What it asks with no body names a session and no more, and asking for its calls it says that it seals.
      const [where, query = ''] = req.url.split('?')
      let body = null
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      } catch {}
      const carried =
        req.method === 'GET'
          ? !chunks.length && (where !== '/api/agent/poll' || new URLSearchParams(query).get('sealed') === '3')
          : req.method === 'POST' && where === '/api/agent/events'
            ? body?.meta?.sealed === 3 && Array.isArray(body.events) && body.events.every((e) => e?.sealed === 3)
            : req.method === 'POST' && where === '/api/agent/decision' && isSealed(body?.answer?.a) && Object.keys(body.answer).length === 1
      if (!carried) return done(403, { error: UNSEALED_RELAY, code: 'unsealed' })
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      try {
        const up = await fetch(server + req.url, {
          method: req.method,
          headers: { authorization: headers.authorization, 'x-manyclaws-machine': machine.id, ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}) },
          body: chunks.length ? Buffer.concat(chunks) : undefined,
          signal: abort.signal,
        })
        done(up.status, await up.text())
      } catch (err) {
        if (!abort.signal.aborted) done(502, { error: 'the ManyClaws server is unreachable: ' + err.message })
      }
    })
    relay.listen(config.relay.port, '127.0.0.1', () => log(`relaying this machine's mods on http://127.0.0.1:${config.relay.port}`))
  }

  const stop = () => {
    host.stopAll()
    store.close()
    process.exit(0)
  }
  // What the plugin beside this agent was given (the token, and the key written out), where
  // it leaves a note of them here: taken, and the agent stops, for what keeps it running
  // (launchd, systemd) to start it again with them. That is how a machine whose agent
  // Claude Code installed, with nothing asked, comes to sign in.
  setInterval(() => {
    let changed = []
    try {
      changed = takeFromPlugin({ tokenStands: ready && !tokenRefused })
    } catch (err) {
      log('what the plugin left could not be taken:', err.message)
    }
    if (!changed.length) return
    log(`given its ${changed.join(' and ')} by the ManyClaws plugin: starting again with ${changed.length > 1 ? 'them' : 'it'}`)
    stop()
  }, FROM_PLUGIN_MS)
  // (this timer is what keeps an agent with no token or no key running while it waits: every other one here lets the process end)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  log(`ManyClaws agent ${VERSION} on ${machine.name}: ${config.roots.join(', ')} -> ${server || '(no server)'}`)
  for (const line of flags.said ?? []) log(line)
  // The id is kept, so the machine is the same one after a restart
  if (!flags.ephemeral) saveId(config)
}

function saveId(config) {
  const file = path.join(process.env.MANYCLAWS_HOME || path.join(os.homedir(), '.manyclaws'), 'agent.json')
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  if (current.id === config.id) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...current, id: config.id }, null, 2) + '\n', { mode: 0o600 })
}
