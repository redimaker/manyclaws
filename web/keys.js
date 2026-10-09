// What is drawn from a password and from a passphrase, on the person's own device, and
// what a device keeps of the passphrase's key. Neither is ever sent. Of the password the
// server gets what signs in, and the salt it was stretched with. Of the passphrase the
// server gets nothing: no salt, nothing that tells its key, not that there is one.
//
// The password signs in, and nothing else:
//   password ──PBKDF2-SHA256 (salt, 600,000 rounds)──▶ ──HKDF "manyclaws auth v2"──▶ auth   (sent as the "password")
//
// The passphrase makes the key everything is sealed with (seal.js, which says how):
//   salt   = the first 16 bytes of SHA-256("manyclaws salt v4|" + the account's id)   made here, kept nowhere
//   passphrase ──Argon2id (salt, 64 MiB, 3 passes)──▶ master                            (not kept, not sent)
//   key     = HKDF(master, "manyclaws content v4")   seals and opens
//   signer  = HKDF(master, "manyclaws sign v4")      signs the list of the account's devices, and is kept nowhere:
//                                                    it is here for the moment it takes to put this device on the list
//   checker = the public half of signer              checks that list
//
// So every device of an account's makes the same key from the same passphrase with
// nothing handed to it but the account's id, and whatever is typed makes some key:
// whether it is the right one is told only by whether what was sealed opens with it.
// Another passphrase is another key, and what was sealed with the one before can no
// longer be opened.
//
// What this device keeps (`held`) is kept where no script can read it back: the key and
// what names are made with as WebCrypto keys that cannot be exported, and with them a
// signing key of this device's own, made here by the browser and never out of it. A script
// on this page can seal, open and sign with them while the page is open; it cannot copy
// them, and neither can anything that reads what the browser stores for this site.
// What this device asks of the account's computers it signs with its own key (an order),
// and they go by it because the list of the account's devices, which the passphrase's
// signer signed, has it.
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

// ---- The password is not to be the passphrase. The password is stretched far more
// cheaply than the passphrase (it only signs in, and what comes of it is the server's to
// keep), so an account whose two are one would have its passphrase guessed at the
// password's price by whoever had the server's data. The server cannot be asked whether
// they are one: that would send it something made from the passphrase. So it is told here.
// A browser that is signed in with a password keeps a mark of it (a hash of what was sent
// to sign in, which is the password stretched: no more than the server keeps), and what is
// typed as a passphrase is stretched the same way and held against the mark. A browser signed in before it kept marks has none, and tells nothing.
export const passwordMark = async (auth) => toB64(new Uint8Array(await subtle.digest('SHA-256', enc.encode('manyclaws password mark v1|' + auth))))
// Whether what was typed is the password this browser was signed in with (`params`: how the account's password is stretched)
export async function isPassword(typed, params, mark) {
  if (!mark || !params?.salt) return false
  return (await passwordMark(await signInKey(typed, params))) === mark
}

// ---- The passphrase

// What a passphrase makes for an account, as it is for the moment it takes to put it away
// (hold): { key, signer, checker }, 32 bytes each. Whatever is typed makes one: nothing
// here says whether it is the passphrase the account's other devices were given.
// (seal.js runs the sum's inner step in WebAssembly; a browser that will not run that does the same sum in JavaScript,
// which takes it several seconds)
export async function keysOf(passphrase, account, { cost } = {}) {
  // The sum is a second or so of arithmetic with nothing else done: so it is left off for a moment every so often
  // (each eighth time seal.js asks), for the page to draw what it says meanwhile and for whatever else waits to be heard.
  // (Not by a timer: a browser slows those right down in a tab that is not in front, and the key would take a minute.)
  let asked = 0
  const moment = () =>
    new Promise((on) => {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = () => (port1.close(), on())
      port2.postMessage(0)
    })
  const pause = () => (++asked % 8 ? undefined : moment())
  return S.keysFromPassphrase(passphrase, account, { cost, pause })
}
// What was drawn is done with: nothing of it is left in the page's memory to read
export function forget(made) {
  for (const part of [made?.key, made?.signer]) part?.fill?.(0)
}

// ---- What a device keeps, and what it does with it

// What was drawn, put where no script reads it back, with a signing key of this device's
// own: { key, names, checker, device: { key, signer }, own }. `own`: this is the person's
// own device, and what is held stays on it (keepKey). (The page adds `since`: which list
// of the account's devices this one is on from.)
export async function hold({ key, checker }, { own = false } = {}) {
  const names = S.hkdf(key, 'manyclaws name v1')
  const pair = await subtle.generateKey('Ed25519', false, ['sign', 'verify'])
  const held = {
    key: await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']),
    names: await subtle.importKey('raw', names, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    checker: new Uint8Array(checker),
    // (the half of the pair that checks is no secret: it is what the list of the account's devices knows this one by)
    device: { key: toB64(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), signer: pair.privateKey },
    own: !!own,
  }
  names.fill(0)
  return held
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
// or null where it does not open here or the passphrase's signer did not sign it
export const readDevices = async (text, held) => S.signedDevices(await open(text, held, null), held?.checker)

// That list made again, changed by `change` (which is given the devices and gives back
// what they are to be), signed with the passphrase's signer and sealed: what the server
// is to keep in its place. A device whose stay is over is left out of it; so is everything
// of a list this device cannot go by, which is then begun again.
// `since`: the list this browser knows itself to be on. One older than that is not built
// on: it was written before this device was one of the account's, and may have on it a
// device taken off since, which signing it again would put back. (A browser that is new
// to the account knows no list, and builds on what it is handed: it is the account's
// computers that keep a device taken off from coming back. seal.js, devicesMemory.)
export class OlderList extends Error {}
export async function devicesAgain(text, held, signer, change, now = Date.now(), since = 0) {
  const was = await readDevices(text, held)
  if (was && was.v < since) throw new OlderList('the server handed over an older list of your devices than the one this browser is on')
  const devices = change((was?.devices ?? []).filter((d) => !(d.until && now > d.until)))
  // (when it was made, and never less than the one before: a computer takes none older than the one it has)
  return seal(S.signDevices({ v: Math.max(now, (was?.v ?? 0) + 1), devices }, signer), held)
}

// ---- What is held, kept on this device, so a page that's opened again has it without the
// passphrase: in the browser's own database for this site, which its service worker reads
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

const named = (user) => 'v4|' + user
const isHeld = (v) => !!v && v.key instanceof CryptoKey && v.names instanceof CryptoKey && v.device?.signer instanceof CryptoKey && typeof v.device.key === 'string' && v.checker instanceof Uint8Array
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

// The mark of the password this browser was signed in with (passwordMark): kept in what this browser stores for the
// site, apart from the keys (which are kept where no script reads them back, and this is a line of text), and gone at
// sign-out
const marked = (user) => 'mc.password.' + user
const kept = (work) => {
  try {
    return work(globalThis.localStorage) ?? null
  } catch {
    return null
  }
}
export const keepMark = async (user, mark) => void kept((at) => at.setItem(marked(user), mark))
export const markOf = async (user) => kept((at) => at.getItem(marked(user)))
export const dropMark = async (user) => void kept((at) => at.removeItem(marked(user)))

// ---- Once, at the deploy of 2026-10-08, and then out of the code. A browser that was
// given the passphrase before it has the key of before: made with PBKDF2, and kept as
// bytes. What the account put on its sessions (their names, labels and reminders, and its
// favorites) is sealed with that key and is on no computer to be sent again, so the page
// seals it again with the new key as the passphrase is typed (app.js, passphrasePart).
// This is the key of before, good for opening only, where what was typed makes that same
// key (so that what is typed is the account's passphrase, and not a slip): null otherwise.
const before = (user) => 'v3|' + user
export async function keyBefore(user, passphrase) {
  const kept = await store('readonly', (s) => s.get(before(user))).catch(() => null)
  if (!(kept instanceof Uint8Array) || kept.length !== 64) return null
  const salt = toB64(new Uint8Array(await subtle.digest('SHA-256', enc.encode('manyclaws salt v3|' + String(user)))).subarray(0, 16))
  const was = await drawn(await stretched(passphrase, { salt, iterations: 600_000 }), 'manyclaws content v3')
  if (!was.every((b, i) => b === kept[i])) return null
  return { key: await subtle.importKey('raw', was, 'AES-GCM', false, ['decrypt']) }
}
export const dropBefore = (user) => store('readwrite', (s) => (s.delete(before(user)), s.delete(user))).catch(() => {})
