// Where this machine keeps what its agent signs in with and seals with: the account's API
// token and its key. On a Mac, in the login keychain, which is encrypted under the
// account's own password: so the two are not in a file that a backup of the home folder
// holds, or that anything able to read a file there can read. Elsewhere, and where the
// keychain cannot be used, in agent.json, which only its owner reads.
//
// What the keychain does not do: keep them from a program that runs as the account's own
// user and asks the keychain for them, as the agent itself does. Nothing on a computer
// keeps a secret from that.
//
// The wish is in agent.json (`"secrets": "keychain"`, or `"file"` to have none of it),
// which the installer writes on a Mac. The move is the agent's own, as it starts
// (`settle`): it is the agent, started by launchd in the account's own session, that has
// to be able to read them back, and an installer run over SSH has no keychain to write
// to. They are put in the keychain, read back, and only then taken out of agent.json,
// which keeps a fingerprint of the two in their place (`has`). By that the plugin beside
// the agent tells whether the agent has what it has, and the installer that there is
// nothing to ask for again. The fingerprint is of two things nobody can guess, and says
// nothing of either.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'

const SECURITY = '/usr/bin/security'
const SERVICE = 'ManyClaws agent'
// (a keychain file of the tests' own, where they name one: no test touches the keychain of whoever runs it)
const which = (env) => (env.MANYCLAWS_KEYCHAIN ? [env.MANYCLAWS_KEYCHAIN] : [])
const security = (args, { input, env = process.env } = {}) => spawnSync(SECURITY, args, { input, encoding: 'utf8', timeout: 15_000, env })

export const fingerprint = (token, key) => crypto.createHash('sha256').update(`manyclaws agent has v1|${token}|${key}`).digest('base64url').slice(0, 22)

// Whether this machine is to keep the two in its keychain, and has one
export const wantsKeychain = (config) => config?.secrets === 'keychain' && process.platform === 'darwin' && fs.existsSync(SECURITY)

// The two as the keychain has them for this machine (by its id), or null. `why` says why not, where it is not for want of them.
function fromKeychain(id, env) {
  const r = security(['find-generic-password', '-s', SERVICE, '-a', id, '-w', ...which(env)], { env })
  if (r.status !== 0) return { why: r.status === 44 ? '' : String(r.stderr || r.error?.message || 'the keychain did not answer').trim().split('\n').pop() }
  try {
    const { token, key } = JSON.parse(Buffer.from(r.stdout.trim(), 'hex').toString('utf8'))
    return typeof token === 'string' && typeof key === 'string' && token && key ? { token, key } : { why: 'what the keychain has for this machine is not a token and a key' }
  } catch {
    return { why: 'what the keychain has for this machine is not a token and a key' }
  }
}

// Put there, in place of what it had. The two go to the keychain's own tool on its
// standard input and never among its arguments, which every user of the machine can see;
// written in hex, so that nothing in them means anything to what reads the line.
function toKeychain(id, { token, key }, env) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return 'this machine has no id to keep them by'
  const hex = Buffer.from(JSON.stringify({ token, key })).toString('hex')
  const kept = which(env).map((k) => ` "${k.replace(/(["\\])/g, '\\$1')}"`).join('')
  const r = security(['-i'], { input: `add-generic-password -U -s "${SERVICE}" -a "${id}" -l "${SERVICE}" -w "${hex}"${kept}\n`, env })
  return r.status === 0 ? '' : String(r.stderr || r.error?.message || 'the keychain did not take them').trim().split('\n').pop()
}

export function forgetKept(config, { env = process.env } = {}) {
  if (process.platform !== 'darwin' || !fs.existsSync(SECURITY) || !config?.id) return
  security(['delete-generic-password', '-s', SERVICE, '-a', String(config.id), ...which(env)], { env })
}

// What this machine signs in with and seals with, wherever it keeps them: { token, key },
// either of them undefined where it has none. `locked` (with why): they are in the
// keychain, and the keychain would not hand them over here.
export function secretsOf(config, { env = process.env } = {}) {
  const here = { token: config?.token || undefined, key: config?.key || undefined }
  if ((here.token && here.key) || !config?.has || !wantsKeychain(config)) return here
  const kept = fromKeychain(String(config.id ?? ''), env)
  if (kept.token) return { token: here.token ?? kept.token, key: here.key ?? kept.key }
  return { ...here, locked: kept.why || 'the keychain has nothing for this machine' }
}

// The two moved from agent.json (by its path) into the keychain, where that is wished and
// both are there to move: says what was done, or nothing where there was nothing to do.
// Throws with why where the keychain would not keep them, and agent.json is left as it was.
export function settle(file, { env = process.env } = {}) {
  let config
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
  if (!wantsKeychain(config) || !config.token || !config.key) return ''
  const id = String(config.id ?? '')
  const why = toKeychain(id, config, env)
  if (why) throw new Error(why)
  const back = fromKeychain(id, env)
  if (back.token !== config.token || back.key !== config.key) throw new Error(back.why || 'the keychain did not give back what it was given')
  const { token, key, ...rest } = config
  fs.writeFileSync(file, JSON.stringify({ ...rest, has: fingerprint(token, key) }, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return 'the API token and the key are kept in the keychain now, and no longer in agent.json'
}
