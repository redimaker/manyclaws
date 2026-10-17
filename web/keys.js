// What is drawn from a password on the person's own device, and what a device keeps of
// the account's key. The password signs in, and nothing else: the server gets what signs
// in, and the salt it was stretched with.
//
//   password ──PBKDF2-SHA256 (salt, 600,000 rounds)──▶ ──HKDF "manyclaws auth v2"──▶ auth   (sent as the "password")
//
// The account's key is drawn from its root (seal.js says how), which is 32 random bytes:
// nothing typed makes it, and nothing of it is sent to the server. A phone or a browser is
// given it by another of the account’s devices, sealed with a key the two made from a code (seal.js, Pairing), or by the
// person, from the recovery key they kept.
//
// What this device keeps (`held`) is kept where no script can read it back: the key and
// what names are made with as WebCrypto keys that cannot be exported, and with them a
// signing key of this device's own, which no script can read either. A script on this page
// can seal, open and sign with them while the page is open; it cannot copy them, and
// neither can anything that reads what the browser stores for this site. What this device
// asks of the account's computers it signs with its own key (an order), and they go by it
// because the list of the account's devices, which the root's signer signed, has it.
//
// And the root, on the person's own device: wrapped (AES-256-GCM) under a key drawn from a
// passkey's PRF secret, which the device's authenticator gives only after Face ID, Touch ID,
// a PIN or a security key's touch. So the root is opened for the moment something is signed
// with it or handed over (approving a device, taking one off, showing the recovery key),
// and the person is there each time. Nothing of the passkey goes to the server: the page
// asks the authenticator for the PRF secret and checks no signature. A device whose
// authenticator has no PRF keeps the key and its own signing key, and not the root: it
// reads, and gives orders, and approves nothing.
//
// A module for the page and for Node alike (crypto.subtle in both; the tests use what is drawn).

import * as S from './seal.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const NONE = new Uint8Array(0)
const subtle = crypto.subtle

export const KDF = { kdf: 'pbkdf2-sha256', iterations: 600_000 }
export const MIN_PASSWORD = 8
// What a stretched password is drawn into, to sign in with
const AUTH = 'manyclaws auth v2'

export const { toB64, fromB64 } = S

const hkdf = (secret) => subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
const drawn = async (from, info) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: NONE, info: enc.encode(info) }, from, 256))
// What a secret that was typed is stretched into, ready to draw from
async function stretched(typed, { salt, iterations }) {
  const base = await subtle.importKey('raw', enc.encode(String(typed).normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
  return hkdf(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations }, base, 256))
}
const newSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)))

// ---- The password

// What to send as the password, with the salt and rounds the server tells for the email
export const signInKey = async (password, params) => toB64(await drawn(await stretched(password, params), AUTH))

// A password being set: { auth, kdf }, what to send as it and what the server keeps to draw it again
export async function newPassword(password, { iterations = KDF.iterations } = {}) {
  const kdf = { v: 2, kdf: KDF.kdf, iterations, salt: newSalt() }
  return { auth: await signInKey(password, kdf), kdf }
}

// What was drawn is done with: nothing of it is left in the page's memory to read
export function forget(made) {
  for (const part of [made?.key, made?.signer, made?.root, made?.seed]) part?.fill?.(0)
}

// ---- What a device keeps, and what it does with it

// What a device is given, put where no script reads it back, with a signing key of this
// device's own: { key, names, checker, device: { key, signer }, own, root }. `seed`: the
// device's signing key as the device that approved it made it (it is on the list of the
// account's devices already); without one, a new one is made here. `own`: this is the
// person's own device, and what is held stays on it (keepKey). `root`: the root, wrapped
// under this device's passkey (lockRoot), where it has one. (The page adds `since`: which
// list of the account's devices this one is on from.)
export async function hold({ key, checker }, { own = false, seed = null, root = null } = {}) {
  const names = S.hkdf(key, 'manyclaws name v1')
  let device
  if (seed) {
    const pub = S.verifyKey(seed)
    const jwk = { kty: 'OKP', crv: 'Ed25519', d: toB64(seed), x: toB64(pub) }
    device = { key: toB64(pub), signer: await subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign']) }
  } else {
    const pair = await subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    // (the half of the pair that checks is no secret: it is what the list of the account's devices knows this one by)
    device = { key: toB64(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), signer: pair.privateKey }
  }
  const held = {
    key: await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']),
    names: await subtle.importKey('raw', names, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    checker: new Uint8Array(checker),
    device,
    own: !!own,
    root: root ?? null,
  }
  names.fill(0)
  return held
}

// ---- The root under a passkey

// What the passkey's PRF secret is asked for with: the same on every device, as it is no secret
const PRF_SALT = S.sha256(enc.encode('manyclaws root v1'))
const ROOT_AAD = enc.encode('manyclaws root wrap v1')
const rp = () => ({ name: 'ManyClaws', id: globalThis.location?.hostname })
const prfOfAnswer = (cred) => {
  const got = cred?.getClientExtensionResults?.()?.prf?.results?.first
  return got ? new Uint8Array(got) : null
}
// A passkey of this device's own, made for the root, and its PRF secret: { cred, prf }, `prf` null where the
// authenticator has none. Each device's passkey has a user handle of its own, so that one made on another device of
// the person's never takes its place in a keychain that is shared between them. `who`: what the person's keychain lists
// it as (their email), `where`: this device.
export async function makePasskey(who, where) {
  const made = await navigator.credentials.create({
    publicKey: {
      rp: rp(),
      user: { id: random(16), name: String(who || 'ManyClaws'), displayName: 'ManyClaws on ' + String(where || 'this device') },
      challenge: random(32),
      pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key', alg })),
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  })
  const cred = toB64(new Uint8Array(made.rawId))
  const prf = made.getClientExtensionResults?.()?.prf
  if (!prf?.enabled && !prf?.results?.first) return { cred, prf: null }
  // (some authenticators say the secret as the passkey is made; the rest are asked for it once more)
  return { cred, prf: prfOfAnswer(made) ?? (await prfOf(cred)) }
}
// The PRF secret of this device's passkey, asked of its authenticator: Face ID, Touch ID or whatever it asks for
export async function prfOf(cred) {
  const got = await navigator.credentials.get({
    publicKey: { rpId: rp().id, challenge: random(32), allowCredentials: [{ type: 'public-key', id: fromB64(cred) }], userVerification: 'required', extensions: { prf: { eval: { first: PRF_SALT } } } },
  })
  const prf = prfOfAnswer(got)
  if (!prf) throw new Error('this passkey gives no secret to keep your key under')
  return prf
}
const wrapKey = async (prf) => subtle.importKey('raw', S.hkdf(prf, 'manyclaws root wrap v1'), 'AES-GCM', false, ['encrypt', 'decrypt'])
// The root wrapped under a passkey's secret, as it is kept: { cred, wrapped }
export async function lockRoot(root, { cred, prf }) {
  const iv = random(12)
  return { cred, wrapped: joined(iv, new Uint8Array(await subtle.encrypt(gcm(iv, ROOT_AAD), await wrapKey(prf), root))) }
}
// The root, opened with the passkey it is wrapped under (the person is asked for it): null where this device has none
export async function rootOf(held) {
  if (!held?.root?.cred) return null
  const prf = await prfOf(held.root.cred)
  const w = held.root.wrapped
  const root = new Uint8Array(await subtle.decrypt(gcm(w.subarray(0, 12), ROOT_AAD), await wrapKey(prf), w.subarray(12)))
  prf.fill(0)
  return root
}

const random = (n) => crypto.getRandomValues(new Uint8Array(n))
const joined = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
  return out
}
const gcm = (iv, aad) => ({ name: 'AES-GCM', iv, additionalData: aad })
const sealedWith = async (held, bytes, aad) => {
  const iv = random(12)
  return joined(iv, new Uint8Array(await subtle.encrypt(gcm(iv, aad), held.key, bytes)))
}
// (as seal.js makes it up: what is sealed says little of how long it was)
const madeUp = (value) => S.madeUp(enc.encode(JSON.stringify(value === undefined ? null : value)))

// A value sealed with what this device holds, as seal.js seals one: every device of the account's opens it
export const seal = async (value, held) => S.WIRE.value + toB64(await sealedWith(held, madeUp(value), S.WIRE.valueAad))

// What was sealed, or `fallback` when it can't be opened with what is held here
export async function open(sealed, held, fallback = S.UNOPENED) {
  if (!S.isSealed(sealed) || !held) return fallback
  try {
    const bytes = fromB64(sealed.slice(S.WIRE.value.length))
    return JSON.parse(dec.decode(await subtle.decrypt(gcm(bytes.subarray(0, 12), S.WIRE.valueAad), held.key, bytes.subarray(12))))
  } catch {
    return fallback
  }
}

// Every sealed value inside something (an answer, an event, a page of rows) opened; the rest as it was
export async function openAll(value, held, depth = 0) {
  if (typeof value === 'string') return S.isSealed(value) ? open(value, held) : value
  if (!value || typeof value !== 'object' || depth > 40) return value
  if (Array.isArray(value)) return Promise.all(value.map((v) => openAll(v, held, depth + 1)))
  const names = Object.keys(value)
  const opened = await Promise.all(names.map((k) => openAll(value[k], held, depth + 1)))
  return Object.fromEntries(names.map((k, i) => [k, opened[i]]))
}

export const sealBytes = async (bytes, held) => joined(new Uint8Array(S.WIRE.bytes), await sealedWith(held, bytes, S.WIRE.bytesAad))
export async function openBytes(bytes, held) {
  if (!S.isSealedBytes(bytes) || !held) return null
  try {
    return new Uint8Array(await subtle.decrypt(gcm(bytes.subarray(4, 16), S.WIRE.bytesAad), held.key, bytes.subarray(16)))
  } catch {
    return null
  }
}

// A name for something the server has to tell from another without knowing what it is (seal.js, nameOf)
export const nameOf = async (text, held) => toB64(new Uint8Array(await subtle.sign('HMAC', held.names, enc.encode(String(text))))).slice(0, 22)

// An order (seal.js): what is asked of a session or a machine, signed with this device's own key
export async function makeOrder(asked, held) {
  const o = S.orderText(asked)
  const sig = toB64(new Uint8Array(await subtle.sign('Ed25519', held.device.signer, S.orderDigest(o))))
  return S.WIRE.order + toB64(await sealedWith(held, madeUp({ o, by: held.device.key, sig }), S.WIRE.orderAad))
}

// The list of the account's devices as the server has it, opened and checked: { v, devices },
// or null where it does not open here or the root's signer did not sign it
export const readDevices = async (text, held) => S.signedDevices(await open(text, held, null), held?.checker)

// That list made again, changed by `change` (which is given the devices and gives back
// what they are to be), signed with the root's signer and sealed: what the server
// is to keep in its place. A device whose stay is over is left out of it; so is everything
// of a list this device cannot go by, which is then begun again.
// `since`: the list this browser knows itself to be on. One older than that is not built
// on: it was written before this device was one of the account's, and may have on it a
// device taken off since, which signing it again would put back. (A browser that is new
// to the account knows no list, and builds on what it is handed: it is the account's
// computers that keep a device taken off from coming back. seal.js, devicesMemory.)
export class OlderList extends Error {}
// `allowed`: what the plugins its owner allowed on a computer are to be, from what they were (kept as they were, where
// it says nothing)
export async function devicesAgain(text, held, signer, change, now = Date.now(), since = 0, { allowed = (a) => a } = {}) {
  const was = await readDevices(text, held)
  if (was && was.v < since) throw new OlderList('the server handed over an older list of your devices than the one this browser is on')
  const devices = change((was?.devices ?? []).filter((d) => !(d.until && now > d.until)))
  // (when it was made, and never less than the one before: a computer takes none older than the one it has)
  return seal(S.signDevices({ v: Math.max(now, (was?.v ?? 0) + 1), devices, allowed: allowed(was?.allowed ?? []) }, signer), held)
}

// ---- What is held, kept on this device, so a page that's opened again has it without being
// approved again: in the browser's own database for this site, which its service worker reads
// too. Only on a device its owner says is their own: on any other it is held for as long
// as the page is open, and is gone with it.

const memory = new Map()

function store(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('manyclaws', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('keys', mode)
      const asked = work(tx.objectStore('keys'))
      tx.oncomplete = () => (db.close(), resolve(asked?.result))
      tx.onabort = tx.onerror = () => (db.close(), reject(tx.error))
    }
  })
}

const named = (user) => 'v5|' + user
const isRoot = (r) => r === null || (!!r && typeof r.cred === 'string' && r.wrapped instanceof Uint8Array)
const isHeld = (v) => !!v && v.key instanceof CryptoKey && v.names instanceof CryptoKey && v.device?.signer instanceof CryptoKey && typeof v.device.key === 'string' && v.checker instanceof Uint8Array && isRoot(v.root ?? null)
export async function keepKey(user, held) {
  memory.set(user, held)
  await store('readwrite', (s) => (held.own ? s.put(held, named(user)) : s.delete(named(user)))).catch(() => {})
}
// What is held here for an account: null where nothing is
export async function heldKey(user) {
  if (!memory.has(user)) {
    const kept = await store('readonly', (s) => s.get(named(user))).catch(() => null)
    if (isHeld(kept)) memory.set(user, kept)
  }
  return memory.get(user) ?? null
}
export async function dropKey(user) {
  memory.delete(user)
  await store('readwrite', (s) => s.delete(named(user))).catch(() => {})
}

// What a browser kept for an account before there was a root (the key made from a passphrase, as it was kept from
// 2026-10-08, and before that): not taken, and gone (an account of before starts afresh: app.js). That there was one
// is kept in its place (`before|<account>`, which holds no key), until this browser holds the account's key: so the
// page can say why it has none, and what to do, for as long as that is so.
export const dropBefore = (user) =>
  store('readwrite', (s) => {
    for (const name of ['v4|' + user, 'v3|' + user, user]) {
      const had = s.get(name)
      had.onsuccess = () => {
        if (had.result === undefined) return
        s.delete(name)
        s.put({ at: Date.now() }, 'before|' + user)
      }
    }
  }).catch(() => {})
// Whether this browser held a key of before for the account, and has not been given its key since
export const wasBefore = (user) => store('readonly', (s) => s.get('before|' + user)).then((v) => !!v, () => false)
export const forgetBefore = (user) => store('readwrite', (s) => s.delete('before|' + user)).catch(() => {})
