#!/usr/bin/env node
// The ManyClaws machine agent. One per machine: it indexes the machine's Claude Code
// transcripts, reads sessions back, starts and resumes them, and is the machine's
// connection to the ManyClaws server, to which it says nothing that is not sealed.
//
//   node agent.mjs run                    the service
//   node agent.mjs index                  bring the index up to date, then exit
//   node agent.mjs search <words>         search it
//   node agent.mjs sessions [words]       list sessions, newest first
//   node agent.mjs read <session id>      print a session's conversation
//   node agent.mjs configure --server URL [--token T] [--label NAME] [--root DIR]… [--spawn DIR]…
//                            [--mode MODE]… [--files DIR]… [--relay] [--key KEY] [--wait] [--no-keychain]
//                                         write agent.json (the installer does); what's
//                                         there is kept (--mode: the only permission modes
//                                         sessions may be started in; with no list, every
//                                         mode but bypassPermissions. --files: the folders a
//                                         file may be opened from; with none, the --spawn
//                                         ones), the token can come in MANYCLAWS_TOKEN
//                                         and the key in MANYCLAWS_KEY. The key is the
//                                         account's encryption passphrase: the key is made
//                                         from it here, with the account's id (nothing of
//                                         it is on the server), and what is kept is the key
//                                         and the half that checks the list of the account's
//                                         devices (mcf_…), never the passphrase. With --wait
//                                         it may be written without them: the agent then waits for
//                                         the ManyClaws plugin to give it its token and key.
//                                         On a Mac the token and the key are kept in the
//                                         keychain (secrets.mjs), unless --no-keychain
//   node agent.mjs verify [--server URL]  hold what is here against the signed release it was
//                                         installed from: the agent's files, the plugin as Claude
//                                         Code has it, and what the server hands a browser for
//                                         its page (verify.mjs)
//   node agent.mjs plugin [--look]        give the ManyClaws plugin in Claude Code what this machine
//                                         was set up with (the installer does, where it was typed
//                                         into it), so that the token and the passphrase are
//                                         typed once; says what it did. With --look nothing is
//                                         given: it says whether the plugin has its token and
//                                         passphrase, and what is left for the person to do
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.mjs'
import { Indexer } from './indexer.mjs'
import { Transcript } from './transcript.mjs'
import { findClaude, expandHome } from './host.mjs'
import { keysFromText, keysFromPassphrase, keysText } from './seal.mjs'
import { secretsOf, settle, forgetKept, fingerprint } from './secrets.mjs'

const HOME = process.env.MANYCLAWS_HOME || path.join(os.homedir(), '.manyclaws')
const RELAY_PORT = 8798

export function loadConfig(overrides = {}) {
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'))
  } catch {}
  const config = { roots: [path.join(os.homedir(), '.claude')], db: path.join(HOME, 'index.db'), ...file, ...overrides }
  config.roots = config.roots.map((r) => path.resolve(expandHome(r)))
  // (the token and the key, wherever this machine keeps them: `locked` where its keychain would not hand them over here)
  return Object.assign(config, secretsOf(config))
}

// Writes agent.json for this machine. What's there is kept (the machine's id among it),
// and the options given replace their own. `opts` holds lists for root, spawn and mode.
export function configure(opts, { home = HOME, env = process.env } = {}) {
  const file = path.join(home, 'agent.json')
  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const folders = (list) => (list ?? []).filter(Boolean).map((p) => path.resolve(expandHome(p)))
  const server = String(opts.server ?? config.server ?? '').replace(/\/+$/, '')
  // (what it has already, wherever it keeps it: in agent.json, or in the keychain with its fingerprint here)
  const had = secretsOf(config, { env })
  const token = opts.token || env.MANYCLAWS_TOKEN || had.token
  // The account's key, as it was made from the passphrase: everything the agent sends of this machine's sessions is
  // sealed with it, and with none it sends nothing
  if (opts.key && !keysFromText(opts.key)) throw new Error('the key is not what a ManyClaws computer keeps (mcf_, 43 characters, a dot, 43 more)')
  const key = opts.key ? opts.key.trim() : had.key
  // (kept in a keychain that cannot be read from here, an installer run over SSH say, both stay as they are or both are given anew)
  const given = !!(opts.token || env.MANYCLAWS_TOKEN) + !!opts.key
  if (had.locked && given === 1) throw new Error(`this machine keeps its token and its key in the keychain, which would not hand them over here (${had.locked}): give both the token and the passphrase, or run this in a terminal on the machine itself`)
  const keptLocked = !!had.locked && given === 0
  // (without them it waits for both: the plugin beside it gives it what the person typed there)
  if (!server || ((!token || !key) && !keptLocked && !opts.wait)) throw new Error('a server, a token and your encryption key are required')
  config.server = server
  config.id ??= crypto.randomUUID()
  if (opts.label) config.label = opts.label
  if (folders(opts.root).length) config.roots = folders(opts.root)
  config.roots ??= [path.join(os.homedir(), '.claude')]
  const spawn = folders(opts.spawn)
  config.spawn = { ...(config.spawn ?? {}), enabled: spawn.length > 0, folders: spawn }
  if (opts.mode?.length) config.spawn.modes = opts.mode
  // The folders a file may be opened from, where they are not the ones sessions are started in (`"files": false`, written
  // there by hand, opens none)
  if (folders(opts.files).length) config.files = folders(opts.files)
  else if (config.files !== false) delete config.files
  if (opts.relay) config.relay = { port: RELAY_PORT, secret: config.relay?.secret ?? crypto.randomBytes(24).toString('hex') }
  else delete config.relay
  // Where the token and the key are kept: on a Mac in the keychain, unless that was said no to. Written here, in
  // agent.json, they are moved there by the agent as it starts (secrets.mjs); kept there already and not given anew,
  // they stay there.
  if (opts.keychain === false) config.secrets = 'file'
  else if (process.platform === 'darwin') config.secrets ??= 'keychain'
  if (!keptLocked && !(config.has && token && key && config.has === fingerprint(token, key) && !config.token && !config.key)) {
    delete config.has
    if (token) config.token = token
    if (key) config.key = key
  }
  // The claude a terminal would run, found now: a service has no PATH to find it with
  const claude = findClaude(env)
  if (claude) config.claude = claude
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  // (what it was written with: and, where the two are kept in the keychain and not here, the two as well)
  return { ...config, ...(token && !config.token ? { token } : {}), ...(key && !config.key ? { key } : {}) }
}

// What this machine keeps, written out (mcf_…), from the passphrase it was given: the
// account's key, and the half that checks the list of the account's devices (by which
// what is asked of this machine is checked). The server says whose
// machine this is (the account's id, to whoever holds one of its tokens) and nothing
// else, and both are made here: the passphrase goes no further than this, and neither it
// nor the half that signs is kept. Of the passphrase the server has nothing, so nothing
// here can tell whether this is the one the account's other devices were given: if it is
// not, they cannot open what this machine sends, and it is they that say so. (What
// another program on this machine kept and hands over written out is taken as it is.)
export async function keyOfPassphrase(server, token, given) {
  const written = keysFromText(given)
  if (written) return keysText(written)
  // (something written as a kept key that isn't a whole one is not typed in as a passphrase by mistake)
  if (/^mc[a-z]_[A-Za-z0-9_.-]{20,}$/.test(String(given).trim())) throw new Error('the key is not what a ManyClaws computer keeps (mcf_, 43 characters, a dot, 43 more): give the passphrase itself')
  const r = await fetch(server + '/api/agent/account', { headers: { authorization: 'Bearer ' + token } }).catch(() => null)
  if (!r) throw new Error('the server could not be reached to say whose machine this is, which your encryption key is made with')
  if (r.status === 401) throw new Error('the API token was refused (it may have run out, or been taken back)')
  if (!r.ok) throw new Error(`the server would not say whose machine this is (${r.status})`)
  const keys = await keysFromPassphrase(given, (await r.json().catch(() => null))?.id)
  if (!keys) throw new Error('your encryption key could not be made from the passphrase')
  return keysText(keys)
}

// What the ManyClaws plugin was given, taken by this machine's agent: the note the plugin
// leaves in the agent's own folder (from-plugin.json) once the server has taken its token.
// A person types their API token and passphrase into the plugin's own dialog, and nowhere
// else: the agent, which Claude Code installs, waits for them here. The token, and the
// key written out as a computer keeps it (mcf_…), go into agent.json, and the note is
// gone. Only what is whole is taken, and only from a plugin that reports to the server
// this machine does. Answers what changed ('token', 'key'), for the service to start
// again with; nothing where the note said nothing new, or there was none.
//
// `tokenStands`: the agent has a token and the server has not refused it, so another
// token is not put in its place. A token only signs the machine in, and any of the
// account's does; sessions on one computer can hold different ones (one started before
// the plugin was given a new token, and one after), and each would hand the agent its
// own every half minute, the agent starting again each time. A key that differs is
// another passphrase's and is always taken, and so is a token where the agent has none
// or the server has refused the one it has.
export function takeFromPlugin({ home = HOME, env = process.env, tokenStands = false } = {}) {
  const note = path.join(home, 'from-plugin.json')
  let given
  try {
    given = JSON.parse(fs.readFileSync(note, 'utf8'))
  } catch {
    return []
  } finally {
    fs.rmSync(note, { force: true })
  }
  const file = path.join(home, 'agent.json')
  let config
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const address = (v) => String(v ?? '').replace(/\/+$/, '').toLowerCase()
  if (!given || typeof given !== 'object' || (config.server && address(given.server) !== address(config.server))) return []
  // (what it has now, wherever it keeps it. Kept in a keychain that will not hand it over, it is taken to be other than
  // what the plugin has: the plugin leaves a note only where the fingerprint here is not of its own two)
  const has = secretsOf(config, { env })
  const changed = []
  if (typeof given.token === 'string' && /^\S{8,400}$/.test(given.token) && given.token !== has.token && !(tokenStands && has.token)) {
    has.token = given.token
    changed.push('token')
  }
  if (typeof given.key === 'string' && keysFromText(given.key) && given.key.trim() !== has.key) {
    has.key = given.key.trim()
    changed.push('key')
  }
  if (!config.server && /^https?:\/\/\S+$/.test(String(given.server ?? ''))) config.server = String(given.server).replace(/\/+$/, '')
  if (changed.length) {
    // (written here, whole: an agent that keeps them in the keychain moves them there as it starts again)
    delete config.has
    if (has.token) config.token = has.token
    if (has.key) config.key = has.key
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    // (a file that was there keeps the mode it had: this one holds the token and the key, and is its owner's alone)
    fs.chmodSync(file, 0o600)
  }
  return changed
}

// What this machine was set up with, handed to the ManyClaws plugin beside it in Claude
// Code, so that a person types their token and passphrase once, into the installer, and
// nothing into the plugin: what it signs in with, and the account's key as it is kept
// here (mcf_…), which the plugin takes as it is. Where it reports is not among them: the
// plugin has no option for an address. It reports to its own server, or through this
// agent's relay where what it is given to sign in with is the relay's word, which it
// tells by what this agent keeps. They go in on Claude Code's own standard input
// (`claude plugin configure --values-stdin`), never on a command line, and Claude Code
// keeps what is secret of them where it keeps secrets. Answers { given, relay }, or
// { given: false, why }. Nothing that was handed over is in the answer, or in what is
// said of it.
export function givePlugin(config, { run = spawnSync } = {}) {
  if (config?.locked) return { given: false, why: `this machine keeps its token and key in the keychain, which would not hand them over here (${config.locked})` }
  if (!config?.server || !config?.token || !config?.key) return { given: false, why: 'this machine has not been set up yet' }
  if (!config.claude) return { given: false, why: 'Claude Code was not found on this machine' }
  const relay = config.relay?.port && config.relay?.secret ? config.relay : null
  const values = { token: relay ? relay.secret : config.token, key: config.key }
  let r
  try {
    r = run(config.claude, ['plugin', 'configure', 'manyclaws@manyclaws', '--values-stdin'], { input: JSON.stringify(values), encoding: 'utf8', timeout: 60_000 })
  } catch (err) {
    r = { error: err }
  }
  if (r.error || r.status !== 0) return { given: false, why: 'the plugin is not installed in Claude Code on this machine, or Claude Code would not take them' }
  return { given: true, relay: relay ? relay.port : 0 }
}

// What is said of that, for whoever ran the installer to read (a person, or Claude Code
// for them): what the plugin now has, and above all when it has nothing and still needs
// to be given it by hand
export function pluginSays(r) {
  const next = 'Start a new Claude Code session for it to connect: sessions already running connect when they are next started.'
  if (!r.given)
    return [
      `The ManyClaws plugin was NOT given its API token and passphrase: ${r.why}.`,
      'It still needs to be configured: no session of this computer shows on the page until it has both.',
      'Install the plugin and run this installer again (it asks for nothing it has), or type the two into the plugin yourself:',
      '  in Claude Code in a terminal, /plugin configure manyclaws@manyclaws; in the VS Code extension, /plugin and then the gear beside manyclaws.',
    ]
  const how = r.relay ? `now goes through the agent (http://127.0.0.1:${r.relay})` : 'has been given the same API token'
  return [`The ManyClaws plugin in Claude Code ${how}, and this computer's encryption key: it is configured, and there is nothing to type into it.`, next]
}

// Whether the plugin has been given its token and passphrase. Claude Code says which of a
// plugin's options are set, and never what they are. { installed: true, token, key };
// installed false where the plugin is not there, null where there is no telling.
export function pluginHas(config, { run = spawnSync } = {}) {
  if (!config?.claude) return { installed: null }
  let r
  try {
    r = run(config.claude, ['plugin', 'configure', 'manyclaws@manyclaws', '--json'], { encoding: 'utf8', timeout: 60_000 })
  } catch {
    return { installed: null }
  }
  if (r.error) return { installed: null }
  if (r.status !== 0) return { installed: false }
  try {
    const set = JSON.parse(r.stdout).configured ?? []
    return { installed: true, token: set.includes('token'), key: set.includes('key') }
  } catch {
    return { installed: null }
  }
}

// What is left for the person to do, where the agent was installed with nothing typed
// into it (Claude Code ran its installer): the plugin's own dialog is where the token and
// the passphrase go, and the agent takes the same two from the plugin. Said in so many
// words, for whoever ran the installer to read, and for Claude Code to pass on.
export function leftSays(has, { server = '', waiting = true } = {}) {
  const takes = waiting ? 'gives this agent the same two within a few seconds' : 'this agent takes a newer token or key from it, where the plugin has one'
  if (has.installed && has.token && has.key) return [`The ManyClaws plugin has its API token and encryption passphrase. Start a new Claude Code session: the plugin connects, and ${takes}.`]
  const missing = !has.installed ? 'the API token and the encryption passphrase' : !has.token && !has.key ? 'the API token and the encryption passphrase (it has neither yet)' : has.token ? 'the encryption passphrase (it has its API token)' : 'the API token (it has its passphrase)'
  return [
    ...(has.installed === false ? [`The ManyClaws plugin is not installed in Claude Code on this computer. Install it first: claude plugin marketplace add ${server}/plugins/marketplace.json, then claude plugin install manyclaws@manyclaws`] : []),
    `ONE STEP IS LEFT, AND IT IS THE PERSON'S: give the ManyClaws plugin ${missing}.`,
    '  In the VS Code extension: type /plugin to open Manage Plugins, press the gear beside manyclaws, and fill in "API token" and "Encryption passphrase".',
    '  In Claude Code in a terminal: /plugin configure manyclaws@manyclaws',
    `  The token is made at ${server}/app#/setup, and the passphrase is chosen at ${server}/app#/account.`,
    `Then start a new Claude Code session: the plugin connects, and ${takes}.`,
  ]
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const flags = {}
  const lists = { root: [], spawn: [], mode: [], files: [] } // options that can be given more than once
  const args = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const name = rest[i].slice(2)
      flags[name] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]
      if (lists[name] && flags[name] !== true) lists[name].push(flags[name])
    } else args.push(rest[i])
  }
  if (command === 'configure') {
    const text = (v) => (v === true || v === undefined ? '' : String(v))
    // The key is made from the passphrase before anything is written
    let key = (text(flags.key) || process.env.MANYCLAWS_KEY || '').trim()
    if (key) {
      let had = {}
      try {
        had = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'))
      } catch {}
      const server = (text(flags.server) || had.server || '').replace(/\/+$/, '')
      const token = text(flags.token) || process.env.MANYCLAWS_TOKEN || had.token
      if (!server || !token) throw new Error('a server and a token are required')
      key = await keyOfPassphrase(server, token, key)
    }
    const config = configure({ ...lists, server: text(flags.server), token: text(flags.token), label: text(flags.label), relay: !!flags.relay, key, wait: !!flags.wait, keychain: flags['no-keychain'] ? false : undefined })
    // What was written, and nothing secret but the relay's own word
    console.log(JSON.stringify({ id: config.id, label: config.label ?? '', roots: config.roots, spawn: config.spawn, files: config.files ?? null, claude: config.claude ?? '', relay: config.relay ?? null, secrets: config.secrets ?? 'file', waiting: !config.has && (!config.token || !config.key) }))
    return
  }
  // An agent brought up to date keeps its token and key where a newly installed one does: on a Mac, in the keychain,
  // unless this machine said no to that. Nothing else of what it was set up with is touched. (The installer, with --update.)
  if (command === 'keychain') {
    const file = path.join(HOME, 'agent.json')
    const had = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (process.platform !== 'darwin' || had.secrets) return
    fs.writeFileSync(file, JSON.stringify({ ...had, secrets: 'keychain' }, null, 2) + '\n', { mode: 0o600 })
    return
  }
  // What the keychain has for this machine is taken out of it (the installer, with --uninstall)
  if (command === 'forget') {
    try {
      forgetKept(JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8')))
    } catch {}
    return
  }
  if (command === 'verify') {
    const config = loadConfig()
    const { verify } = await import('./verify.mjs')
    const { ok, lines } = await verify({ home: HOME, roots: config.roots, server: String((flags.server === true ? '' : flags.server) || config.server || '').replace(/\/+$/, '') })
    for (const line of lines) console.log(line)
    process.exitCode = ok ? 0 : 1
    return
  }
  if (command === 'plugin') {
    const config = loadConfig()
    for (const line of flags.look ? leftSays(pluginHas(config), { server: config.server ?? '', waiting: !config.locked && (!config.token || !config.key) }) : pluginSays(givePlugin(config))) console.log(line)
    return
  }
  const overrides = {}
  if (flags.db) overrides.db = flags.db
  if (flags.root) overrides.roots = String(flags.root).split(',')
  const config = loadConfig(overrides)
  fs.mkdirSync(path.dirname(config.db), { recursive: true })

  // (what the plugin left for this machine while the agent was not running is taken first, and what it signs in and
  // seals with is put where this machine keeps it)
  if (command === 'run') {
    // (a token it has stands until the server refuses it, which it has yet to be asked: see takeFromPlugin)
    takeFromPlugin({ tokenStands: true })
    const said = []
    try {
      said.push(settle(path.join(HOME, 'agent.json')))
    } catch (err) {
      said.push(`the API token and the key could not be moved to the keychain (${err.message}): they stay in agent.json, which only you can read`)
    }
    return (await import('./service.mjs')).run(loadConfig(overrides), { ...flags, said: said.filter(Boolean) })
  }

  const store = new Store(config.db)
  const when = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '')
  if (command === 'index') {
    const indexer = new Indexer(store, config.roots, { only: config.only ?? [], skip: config.skip ?? [] })
    const started = Date.now()
    let last = 0
    indexer.run((ix) => {
      if (Date.now() - last < 2000 && ix.pending.length) return
      last = Date.now()
      console.error(`${ix.pending.length} files left, ${(Math.max(0, ix.bytesLeft) / 1e6).toFixed(0)} MB`)
    })
    console.log(JSON.stringify({ ...store.stats(), seconds: (Date.now() - started) / 1000, dbMB: fs.statSync(config.db).size / 1e6 }))
  } else if (command === 'search') {
    const started = Date.now()
    const results = store.search({ q: args.join(' '), limit: Number(flags.limit) || 10, sort: flags.sort })
    for (const r of results) {
      console.log(`\n${when(r.session?.last_ts)}  ${r.session?.title || r.session?.first_prompt?.slice(0, 60) || r.sid}  [${r.session?.cwd ?? ''}]  ${r.sid}  (${r.total} hits)`)
      for (const h of r.hits) console.log(`    ${when(h.ts)} ${h.role}${h.subagent ? ' (subagent)' : ''}: ${h.snippet.replace(/\u0001/g, '\x1b[1m').replace(/\u0002/g, '\x1b[0m').replace(/\s+/g, ' ')}`)
    }
    console.error(`\n${results.length} sessions in ${Date.now() - started} ms`)
  } else if (command === 'sessions') {
    for (const s of store.sessions({ q: args.join(' '), limit: Number(flags.limit) || 30 })) console.log(`${when(s.last_ts)}  ${String(s.messages).padStart(5)}  ${s.sid}  ${(s.title || s.first_prompt).slice(0, 60)}  [${s.cwd}]`)
  } else if (command === 'read') {
    const s = store.session(args[0])
    if (!s) throw new Error('no such session in the index')
    const t = new Transcript(s.path).sync()
    const chain = t.chain()
    const rows = t.rows(Math.max(0, chain.length - (Number(flags.last) || 40)), chain.length, 600)
    for (const r of rows) console.log(`${when(r.ts)} ${r.role}: ${r.text.slice(0, 300)}${(r.toolUses ?? []).map((u) => `[${u.tool} ${JSON.stringify(u.input).slice(0, 100)} -> ${String(u.text ?? '').slice(0, 80).replace(/\s+/g, ' ')}]`).join(' ')}`)
    console.error(`${chain.length} lines in the conversation; ${t.nodes.size} in the file`)
  } else {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 38).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  }
  store.close()
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
  })
}
