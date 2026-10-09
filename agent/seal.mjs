// Sealing: end-to-end encryption of what an account's sessions say. Each of the account's
// devices derives the same key from the passphrase its owner types there and the
// account's id, and encrypts ("seals") and decrypts ("opens") with it. The server stores
// and forwards what was sealed and cannot open it.
//
// The server is given nothing made from the passphrase: no hash or verifier of it or of
// its key, not its length, and no record that one has been set. The only way to tell that
// a passphrase is the right one is to open something that was sealed with it.
//
// The salt is not a secret and is not stored anywhere. It is computed from the account's
// id, which the server assigns and tells each device (GET /api/agent/account for a
// computer, GET /api/account for the page). So every device computes the same salt, and
// the server could compute it too. Its job is to make the key depend on the account as
// well as the passphrase. It does not slow guessing: whoever holds what was sealed can
// try passphrases at their own pace. What slows that is Argon2id: each guess fills 64 MiB
// of memory three times over, which a graphics card does little faster than a phone. An
// account is still only as safe as its passphrase is hard to guess.
//
// This file is kept as three identical copies (a test compares them): mod/hooks/seal.js
// (the plugin), server/public/seal.js (the page) and agent/seal.mjs (the machine agent).
// The plugin's runtime has no crypto library, so everything is implemented here in plain
// JavaScript: SHA-256, SHA-512, HMAC, HKDF, BLAKE2b, Argon2id, AES-256-GCM and Ed25519.
// The tests check each one against Node's own. (Where there is WebAssembly, which is in a
// browser and in the machine's agent, the inner step of Argon2id is run in that: the same
// step, several times as fast. And the page keeps what comes of a passphrase where a
// script cannot read it back: keys.js.)
//
// What a device derives:
//
//   salt    = the first 16 bytes of SHA-256("manyclaws salt v4|" + the account's id)
//   master  = Argon2id(passphrase as NFKC UTF-8, salt, 64 MiB, 3 passes, 1 lane)  never stored, never sent
//   key     = HKDF-SHA256(master, salt "", info "manyclaws content v4")       the AES-256 key: stored on every device
//   signer  = HKDF-SHA256(master, salt "", info "manyclaws sign v4")          an Ed25519 private key (its seed): stored
//                                                                             nowhere. A phone or a browser has it for
//                                                                             the moment it takes to enrol itself
//   checker = the Ed25519 public key of signer                                stored by every device: it verifies what
//                                                                             the signer signed, and cannot sign
//
// What is sealed (S is the single character U+E000, which marks a string as sealed):
//
//   a sealed value = S + "v1." + base64url(iv | ciphertext | tag)
//                    AES-256-GCM with key over the JSON of the value, padded: iv is 12 random bytes, tag is 16 bytes,
//                    additional data "manyclaws sealed v2". Padded: spaces follow the JSON (whoever opens it reads
//                    past them), up to a length that says little of how long the value was (see `madeUp`)
//   sealed bytes   = "MCS1" | iv | ciphertext | tag                           (a photo, a file, a transcript)
//                    the same over the bytes as they are, not padded, with additional data "manyclaws bytes v2"
//   the devices    = a sealed value of { list, sig }: the account's phones and browsers, each by a key of its own
//                    list: the JSON of { v, devices: [{ key, name, at, until }] }, as a string: exactly what was signed.
//                          v is when the list was made, and never less than the one it replaces; key is the device's
//                          own Ed25519 public key, made on it and kept there where no script can read its other half;
//                          until, where a device is not its owner's own, is when it stops being one of them
//                    sig:  Ed25519 by signer over SHA-256("manyclaws devices v1|" | list)
//   an order       = S + "o2." + base64url(iv | ciphertext | tag)
//                    AES-256-GCM with key over the JSON of { o, by, sig }, padded as a sealed value is, with additional
//                    data "manyclaws order v3"
//                    o:   the JSON of { at, n, to, do, with }, as a string: exactly what was signed.
//                         at: when it was made, n: a random number used once, to: the session or machine it is for,
//                         do: what it asks, with: the rest of what it asks
//                    by:  the public key of the device that asks
//                    sig: Ed25519 by that device's own key over SHA-256("manyclaws order v3|" | o)
//   a name         = the first 22 characters of base64url(HMAC-SHA256(names, text))
//                    names = HKDF-SHA256(key, salt "", info "manyclaws name v1"). The server tells one sealed row
//                    from another by its name where it has to (a row sent twice is kept once). A name says nothing
//                    of what it names, and only a device with the key can compute one
//
// A different passphrase derives a different key, signer and checker. Nothing in a sealed
// value says which key sealed it: a device with a different key fails to open it, and
// that failure is how it knows.
//
// An order is what a person asks of a computer from a phone or a browser: a prompt, an
// answer to what a session asked, a session to start. Each phone and browser signs with a
// key of its own, which it made itself and which never leaves it. It is one of the
// account's devices because the passphrase's signer said so, once, when the passphrase
// was typed there: the list of them is signed by it, sealed, and kept on the server for
// the account's computers to read. A computer acts only on an order that opens with its
// key, that a device in the newest list it has seen signed, that is for it, that asks for
// something allowed where it arrived, that was made within the last hour, and that it has
// not run before. So nothing the server stores or makes up can make a computer act: it
// has no device's key, and cannot write a list. A computer has neither: it can read what
// the account's sessions say, and cannot give an order to another computer. And a device
// that is lost is taken off the list by any other, with the passphrase: its orders are
// refused from then on, and nothing else has to change.

const enc = new TextEncoder()
const dec = new TextDecoder()

export const SEALED = ''
const PREFIX = SEALED + 'v1.'
const AAD = enc.encode('manyclaws sealed v2')
const BYTES_AAD = enc.encode('manyclaws bytes v2')
const MAGIC = [0x4d, 0x43, 0x53, 0x31] // "MCS1"
// What stands in for something sealed that couldn't be opened (no key here, or not this key)
export const UNOPENED = '🔒 (encrypted)'

export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX)

// ---- SHA-256, HMAC and HKDF

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256(data) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const bitLength = data.length * 8
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6))
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]
      const b = w[i - 2]
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i])
  return out
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function hmac(key, data) {
  const k = new Uint8Array(64)
  k.set(key.length > 64 ? sha256(key) : key)
  const inner = k.map((b) => b ^ 0x36)
  const outer = k.map((b) => b ^ 0x5c)
  return sha256(concat(outer, sha256(concat(inner, data))))
}

// HKDF-SHA256 for up to 32 bytes
export function hkdf(ikm, info, length = 32, salt = new Uint8Array(0)) {
  const prk = hmac(salt.length ? salt : new Uint8Array(32), ikm)
  return hmac(prk, concat(typeof info === 'string' ? enc.encode(info) : info, new Uint8Array([1]))).slice(0, length)
}

// ---- AES-256

const SBOX = new Uint8Array(256)
const T0 = new Uint32Array(256)
const T1 = new Uint32Array(256)
const T2 = new Uint32Array(256)
const T3 = new Uint32Array(256)
{
  // The S-box from the multiplicative inverse in GF(2^8) and the affine map
  const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff
  let p = 1
  let q = 1
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff
    q ^= q << 1
    q ^= q << 2
    q ^= q << 4
    q &= 0xff
    if (q & 0x80) q ^= 0x09
    SBOX[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63
  } while (p !== 1)
  SBOX[0] = 0x63
  const x2 = (b) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]
    const t = ((x2(s) << 24) | (s << 16) | (s << 8) | (x2(s) ^ s)) >>> 0
    T0[i] = t
    T1[i] = ((t >>> 8) | (t << 24)) >>> 0
    T2[i] = ((t >>> 16) | (t << 16)) >>> 0
    T3[i] = ((t >>> 24) | (t << 8)) >>> 0
  }
}

function expandKey(key) {
  if (key.length !== 32) throw new Error('an AES-256 key is 32 bytes')
  const rk = new Uint32Array(60)
  const kv = new DataView(key.buffer, key.byteOffset, 32)
  for (let i = 0; i < 8; i++) rk[i] = kv.getUint32(i * 4)
  let rcon = 1
  for (let i = 8; i < 60; i++) {
    let t = rk[i - 1]
    if (i % 8 === 0) {
      t = ((SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[t >>> 24]) ^ (rcon << 24)
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff
    } else if (i % 8 === 4) t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255]
    rk[i] = (rk[i - 8] ^ t) >>> 0
  }
  return rk
}

// One block, as four big-endian words in and out
function encryptBlock(rk, b0, b1, b2, b3, out) {
  let s0 = b0 ^ rk[0]
  let s1 = b1 ^ rk[1]
  let s2 = b2 ^ rk[2]
  let s3 = b3 ^ rk[3]
  let k = 4
  for (let round = 1; round < 14; round++) {
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ rk[k]
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ rk[k + 1]
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ rk[k + 2]
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ rk[k + 3]
    s0 = t0
    s1 = t1
    s2 = t2
    s3 = t3
    k += 4
  }
  out[0] = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ rk[k]
  out[1] = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ rk[k + 1]
  out[2] = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ rk[k + 2]
  out[3] = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ rk[k + 3]
  return out
}

// ---- GCM

// X·H in GCM's GF(2^128), each as four big-endian words
function gmul(x, h) {
  let z0 = 0
  let z1 = 0
  let z2 = 0
  let z3 = 0
  let v0 = h[0]
  let v1 = h[1]
  let v2 = h[2]
  let v3 = h[3]
  for (let i = 0; i < 128; i++) {
    if ((x[i >>> 5] >>> (31 - (i & 31))) & 1) {
      z0 ^= v0
      z1 ^= v1
      z2 ^= v2
      z3 ^= v3
    }
    const lsb = v3 & 1
    v3 = (v3 >>> 1) | (v2 << 31)
    v2 = (v2 >>> 1) | (v1 << 31)
    v1 = (v1 >>> 1) | (v0 << 31)
    v0 = v0 >>> 1
    if (lsb) v0 ^= 0xe1000000
  }
  x[0] = z0 >>> 0
  x[1] = z1 >>> 0
  x[2] = z2 >>> 0
  x[3] = z3 >>> 0
}

function ghash(h, aad, data) {
  const x = new Uint32Array(4)
  const absorb = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
    for (let off = 0; off < bytes.length; off += 16) {
      if (bytes.length - off >= 16) for (let i = 0; i < 4; i++) x[i] ^= view.getUint32(off + i * 4)
      else {
        const block = new Uint8Array(16)
        block.set(bytes.subarray(off))
        const bv = new DataView(block.buffer)
        for (let i = 0; i < 4; i++) x[i] ^= bv.getUint32(i * 4)
      }
      gmul(x, h)
    }
  }
  absorb(aad)
  absorb(data)
  const lengths = new Uint8Array(16)
  const lv = new DataView(lengths.buffer)
  lv.setUint32(0, Math.floor((aad.length * 8) / 0x100000000))
  lv.setUint32(4, (aad.length * 8) >>> 0)
  lv.setUint32(8, Math.floor((data.length * 8) / 0x100000000))
  lv.setUint32(12, (data.length * 8) >>> 0)
  absorb(lengths)
  return x
}

// The counter-mode half of GCM: encrypts and decrypts alike
function ctr(rk, iv, data) {
  const ivv = new DataView(iv.buffer, iv.byteOffset, 12)
  const c0 = ivv.getUint32(0)
  const c1 = ivv.getUint32(4)
  const c2 = ivv.getUint32(8)
  const out = new Uint8Array(data.length)
  const ks = new Uint32Array(4)
  const ksb = new Uint8Array(16)
  const ksv = new DataView(ksb.buffer)
  let counter = 2 // 1 is the tag's block
  for (let off = 0; off < data.length; off += 16) {
    encryptBlock(rk, c0, c1, c2, counter >>> 0, ks)
    counter++
    for (let i = 0; i < 4; i++) ksv.setUint32(i * 4, ks[i])
    const n = Math.min(16, data.length - off)
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ksb[i]
  }
  return out
}

function tagOf(rk, h, iv, aad, ciphertext) {
  const s = ghash(h, aad, ciphertext)
  const ivv = new DataView(iv.buffer, iv.byteOffset, 12)
  const j0 = encryptBlock(rk, ivv.getUint32(0), ivv.getUint32(4), ivv.getUint32(8), 1, new Uint32Array(4))
  const tag = new Uint8Array(16)
  const tv = new DataView(tag.buffer)
  for (let i = 0; i < 4; i++) tv.setUint32(i * 4, (s[i] ^ j0[i]) >>> 0)
  return tag
}

// A key ready to use: its round keys and its GHASH key
function prepare(key) {
  const rk = expandKey(key)
  return { rk, h: encryptBlock(rk, 0, 0, 0, 0, new Uint32Array(4)) }
}

// AES-256-GCM with a 12-byte IV: ciphertext and its 16-byte tag together, as WebCrypto gives them
export function gcmEncrypt(key, iv, plaintext, aad = new Uint8Array(0)) {
  const { rk, h } = key.rk ? key : prepare(key)
  const ciphertext = ctr(rk, iv, plaintext)
  return concat(ciphertext, tagOf(rk, h, iv, aad, ciphertext))
}

// The plaintext, or null when the tag isn't right
export function gcmDecrypt(key, iv, sealed, aad = new Uint8Array(0)) {
  if (sealed.length < 16) return null
  const { rk, h } = key.rk ? key : prepare(key)
  const ciphertext = sealed.subarray(0, sealed.length - 16)
  const tag = tagOf(rk, h, iv, aad, ciphertext)
  let diff = 0
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ sealed[sealed.length - 16 + i]
  return diff === 0 ? ctr(rk, iv, ciphertext) : null
}

// ---- SHA-512, and Ed25519 signatures (RFC 8032), in whole-number arithmetic. None of
// the constants is typed in from a table: each is worked out here as its standard
// defines it, and the tests check every result against Node's own.

const M64 = (1n << 64n) - 1n
// The whole part of the n-th root of a whole number
function root(v, n) {
  if (v < 2n) return v
  let x = 1n << BigInt(Math.ceil(v.toString(2).length / Number(n)))
  for (;;) {
    const y = ((n - 1n) * x + v / x ** (n - 1n)) / n
    if (y >= x) return x
    x = y
  }
}
const PRIMES = (() => {
  const out = []
  for (let c = 2; out.length < 80; c++) if (out.every((p) => c % p)) out.push(c)
  return out
})()
// (the first 64 bits after the point of the square roots of the first 8 primes, and of the cube roots of the first 80)
const H512 = PRIMES.slice(0, 8).map((p) => root(BigInt(p) << 128n, 2n) & M64)
const K512 = PRIMES.map((p) => root(BigInt(p) << 192n, 3n) & M64)
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64

export function sha512(data) {
  const padded = new Uint8Array((((data.length + 17 + 127) >> 7) << 7))
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setBigUint64(padded.length - 8, BigInt(data.length) * 8n)
  const h = [...H512]
  const w = new Array(80)
  for (let off = 0; off < padded.length; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(off + i * 8)
    for (let i = 16; i < 80; i++) {
      const a = w[i - 15]
      const b = w[i - 2]
      w[i] = (w[i - 16] + (rotr(a, 1n) ^ rotr(a, 8n) ^ (a >> 7n)) + w[i - 7] + (rotr(b, 19n) ^ rotr(b, 61n) ^ (b >> 6n))) & M64
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 80; i++) {
      const t1 = (hh + (rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)) + ((e & f) ^ (~e & M64 & g)) + K512[i] + w[i]) & M64
      const t2 = ((rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M64
      hh = g
      g = f
      f = e
      e = (d + t1) & M64
      d = c
      c = b
      b = a
      a = (t1 + t2) & M64
    }
    const now = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = (h[i] + now[i]) & M64
  }
  const out = new Uint8Array(64)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setBigUint64(i * 8, h[i])
  return out
}

// The curve: -x² + y² = 1 + d·x²·y² over the whole numbers below 2²⁵⁵ - 19
const P = (1n << 255n) - 19n
const L = (1n << 252n) + 27742317777372353535851937790883648493n // how many points the base point makes
const mod = (a, m = P) => ((a % m) + m) % m
function power(b, e, m = P) {
  let r = 1n
  b = mod(b, m)
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m
    b = (b * b) % m
  }
  return r
}
const inverse = (a) => power(a, P - 2n)
const D = mod(-121665n * inverse(121666n))
const ROOT_OF_MINUS_1 = power(2n, (P - 1n) / 4n)
// The x of a point from its y and whether x is odd: null where there is no such point
function xOf(y, odd) {
  if (y >= P) return null
  const x2 = mod((y * y - 1n) * inverse(D * y * y + 1n))
  if (x2 === 0n) return odd ? null : 0n
  let x = power(x2, (P + 3n) / 8n)
  if (mod(x * x - x2) !== 0n) x = mod(x * ROOT_OF_MINUS_1)
  if (mod(x * x - x2) !== 0n) return null
  return (x & 1n) === BigInt(odd) ? x : P - x
}
const BASE_Y = mod(4n * inverse(5n))
const BASE_X = xOf(BASE_Y, 0)
// A point as [X, Y, Z, T], where x = X/Z, y = Y/Z and x·y = T/Z
const BASE = [BASE_X, BASE_Y, 1n, mod(BASE_X * BASE_Y)]
function add(p, q) {
  const a = mod((p[1] - p[0]) * (q[1] - q[0]))
  const b = mod((p[1] + p[0]) * (q[1] + q[0]))
  const c = mod(2n * p[3] * q[3] * D)
  const d = mod(2n * p[2] * q[2])
  const [e, f, g, h] = [b - a, d - c, d + c, b + a]
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)]
}
function times(k, p) {
  let q = [0n, 1n, 1n, 0n]
  for (; k > 0n; k >>= 1n) {
    if (k & 1n) q = add(q, p)
    p = add(p, p)
  }
  return q
}
const same = (p, q) => mod(p[0] * q[2] - q[0] * p[2]) === 0n && mod(p[1] * q[2] - q[1] * p[2]) === 0n
const little = (bytes) => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n)
function bytesOf(n, length) {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++, n >>= 8n) out[i] = Number(n & 255n)
  return out
}
function packed(p) {
  const z = inverse(p[2])
  return bytesOf(mod(p[1] * z) | ((mod(p[0] * z) & 1n) << 255n), 32)
}
function unpacked(bytes) {
  if (bytes.length !== 32) return null
  const n = little(bytes)
  const y = n & ((1n << 255n) - 1n)
  const x = xOf(y, Number(n >> 255n))
  return x === null ? null : [x, y, 1n, mod(x * y)]
}
// What a 32-byte seed signs with: the number it multiplies by, and what it mixes in
function secretOf(seed) {
  const h = sha512(seed)
  const a = (little(h.subarray(0, 32)) & ((1n << 254n) - 8n)) | (1n << 254n)
  return { a, prefix: h.subarray(32) }
}
// The half that checks, from the half that signs: 32 bytes each
export function verifyKey(seed) {
  return packed(times(secretOf(seed).a, BASE))
}
export function sign(message, seed) {
  const { a, prefix } = secretOf(seed)
  const A = packed(times(a, BASE))
  const r = mod(little(sha512(concat(prefix, message))), L)
  const R = packed(times(r, BASE))
  const k = mod(little(sha512(concat(R, A, message))), L)
  return concat(R, bytesOf(mod(r + k * a, L), 32))
}
// Whether `signature` is what the holder of the other half made for `message`
export function verify(message, signature, key) {
  if (signature?.length !== 64 || key?.length !== 32) return false
  const A = unpacked(key)
  const R = unpacked(signature.subarray(0, 32))
  const s = little(signature.subarray(32))
  // (a point not on the curve, or a number past the end, is nobody's signature)
  if (!A || !R || s >= L) return false
  const k = mod(little(sha512(concat(signature.subarray(0, 32), key, message))), L)
  return same(times(s, BASE), add(R, times(k, A)))
}

// ---- Keys, and sealing values

const toB64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64 = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
export { toB64, fromB64 }

// What a computer keeps, written out, as its agent keeps it: the key it seals with and
// the half that checks the list of the account's devices (mcf_, 43 characters, a dot, 43
// more), or null. (Anything written another way is not this, and is not taken for it.)
export function keysFromText(text) {
  const m = /^mcf_([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(String(text ?? '').trim())
  if (!m) return null
  const [key, checker] = [fromB64(m[1]), fromB64(m[2])]
  return key.length === 32 && checker.length === 32 ? { key, checker } : null
}
export const keysText = ({ key, checker }) => 'mcf_' + toB64(key) + '.' + toB64(checker)

// ---- A passphrase: the key is drawn from it and the account's id, wherever it is typed

// BLAKE2b (RFC 7693), with no key: what Argon2id hashes with. Each of its 64-bit words is
// kept as two 32-bit halves, the low one first.
// (where it starts from is where SHA-512 starts from)
const B2_START = new Uint32Array(H512.flatMap((h) => [Number(h & 0xffffffffn), Number(h >> 32n)]))
// (which words of the message each round takes, in order: the standard's table, with each number doubled, since a word is two halves here)
const B2_ORDER = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
].map((row) => row.map((n) => n * 2))
const TWO32 = 4294967296

// One mixing of four words of `v` (a, b, c, d: where each one's low half is) with two of the message's
function b2Mix(v, m, a, b, c, d, x, y) {
  let s = v[a] + v[b] + m[x]
  v[a] = s
  v[a + 1] = v[a + 1] + v[b + 1] + m[x + 1] + ((s / TWO32) | 0)
  let lo = v[d] ^ v[a]
  let hi = v[d + 1] ^ v[a + 1]
  v[d] = hi
  v[d + 1] = lo
  s = v[c] + v[d]
  v[c] = s
  v[c + 1] = v[c + 1] + v[d + 1] + ((s / TWO32) | 0)
  lo = v[b] ^ v[c]
  hi = v[b + 1] ^ v[c + 1]
  v[b] = (lo >>> 24) | (hi << 8)
  v[b + 1] = (hi >>> 24) | (lo << 8)
  s = v[a] + v[b] + m[y]
  v[a] = s
  v[a + 1] = v[a + 1] + v[b + 1] + m[y + 1] + ((s / TWO32) | 0)
  lo = v[d] ^ v[a]
  hi = v[d + 1] ^ v[a + 1]
  v[d] = (lo >>> 16) | (hi << 16)
  v[d + 1] = (hi >>> 16) | (lo << 16)
  s = v[c] + v[d]
  v[c] = s
  v[c + 1] = v[c + 1] + v[d + 1] + ((s / TWO32) | 0)
  lo = v[b] ^ v[c]
  hi = v[b + 1] ^ v[c + 1]
  v[b] = (lo << 1) | (hi >>> 31)
  v[b + 1] = (hi << 1) | (lo >>> 31)
}

// BLAKE2b of `data`, `length` bytes of it (1 to 64)
export function blake2b(data, length = 64) {
  const h = B2_START.slice()
  h[0] ^= 0x01010000 ^ length
  const v = new Uint32Array(32)
  const m = new Uint32Array(32)
  const block = new Uint8Array(128)
  const view = new DataView(block.buffer)
  // One block of 128 bytes: `count` is how many bytes have been taken with it, `last` that there are no more
  const step = (count, last) => {
    for (let i = 0; i < 32; i++) m[i] = view.getUint32(i * 4, true)
    v.set(h)
    v.set(B2_START, 16)
    v[24] ^= count
    v[25] ^= count / TWO32
    if (last) {
      v[28] = ~v[28]
      v[29] = ~v[29]
    }
    for (let round = 0; round < 12; round++) {
      const s = B2_ORDER[round % 10]
      b2Mix(v, m, 0, 8, 16, 24, s[0], s[1])
      b2Mix(v, m, 2, 10, 18, 26, s[2], s[3])
      b2Mix(v, m, 4, 12, 20, 28, s[4], s[5])
      b2Mix(v, m, 6, 14, 22, 30, s[6], s[7])
      b2Mix(v, m, 0, 10, 20, 30, s[8], s[9])
      b2Mix(v, m, 2, 12, 22, 24, s[10], s[11])
      b2Mix(v, m, 4, 14, 16, 26, s[12], s[13])
      b2Mix(v, m, 6, 8, 18, 28, s[14], s[15])
    }
    for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16]
  }
  let at = 0
  for (; data.length - at > 128; at += 128) {
    block.set(data.subarray(at, at + 128))
    step(at + 128, false)
  }
  block.fill(0)
  block.set(data.subarray(at))
  step(data.length, true)
  const out = new Uint8Array(64)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 16; i++) ov.setUint32(i * 4, h[i], true)
  return out.slice(0, length)
}

// Argon2id (RFC 9106, version 0x13). Its memory is blocks of 1024 bytes, each 128 64-bit
// words: here a Uint32Array, a word's low half first, so a block is 256 of its numbers.
const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24])
// The high half of the product of two 32-bit numbers
function mulhi(a, b) {
  const a0 = a & 0xffff
  const a1 = a >>> 16
  const b0 = b & 0xffff
  const b1 = b >>> 16
  return a1 * b1 + Math.floor((a1 * b0 + a0 * b1 + ((a0 * b0) >>> 16)) / 65536)
}

// A hash of any length (the standard's H'): BLAKE2b, run on as often as it takes
function longHash(length, input) {
  const first = concat(le32(length), input)
  if (length <= 64) return blake2b(first, length)
  const out = new Uint8Array(length)
  let v = blake2b(first)
  let at = 32
  out.set(v.subarray(0, 32))
  for (; length - at > 64; at += 32) {
    v = blake2b(v)
    out.set(v.subarray(0, 32), at)
  }
  out.set(blake2b(v, length - at), at)
  return out
}

// x = x + y + 2 * (the low half of x) * (the low half of y), in 64 bits: Argon2's own
// step, where BLAKE2b has a plain sum
function blamka(v, x, y) {
  const xl = v[x]
  const yl = v[y]
  const x0 = xl & 0xffff
  const x1 = xl >>> 16
  const y0 = yl & 0xffff
  const y1 = yl >>> 16
  const low = x0 * y0
  const mid = x1 * y0 + x0 * y1 + (low >>> 16)
  // (the product's two halves, each doubled)
  const pl = ((mid & 0xffff) << 16) | (low & 0xffff)
  const ph = x1 * y1 + ((mid / 65536) | 0)
  const s = xl + yl + ((pl << 1) >>> 0)
  v[x] = s
  v[x + 1] = v[x + 1] + v[y + 1] + (((ph << 1) | (pl >>> 31)) >>> 0) + ((s / TWO32) | 0)
}
function a2Mix(v, a, b, c, d) {
  blamka(v, a, b)
  let lo = v[d] ^ v[a]
  let hi = v[d + 1] ^ v[a + 1]
  v[d] = hi
  v[d + 1] = lo
  blamka(v, c, d)
  lo = v[b] ^ v[c]
  hi = v[b + 1] ^ v[c + 1]
  v[b] = (lo >>> 24) | (hi << 8)
  v[b + 1] = (hi >>> 24) | (lo << 8)
  blamka(v, a, b)
  lo = v[d] ^ v[a]
  hi = v[d + 1] ^ v[a + 1]
  v[d] = (lo >>> 16) | (hi << 16)
  v[d + 1] = (hi >>> 16) | (lo << 16)
  blamka(v, c, d)
  lo = v[b] ^ v[c]
  hi = v[b + 1] ^ v[c + 1]
  v[b] = (lo << 1) | (hi >>> 31)
  v[b + 1] = (hi << 1) | (lo >>> 31)
}
// BLAKE2b's round over sixteen words of `v`: word k is at `at`, `pair` on for every two
// before it, and 2 on where it is the second of its two. (A row of a block is sixteen
// words side by side, a column sixteen that lie two by two down it.)
function a2Round(v, at, pair) {
  const w0 = at
  const w2 = at + pair
  const w4 = w2 + pair
  const w6 = w4 + pair
  const w8 = w6 + pair
  const w10 = w8 + pair
  const w12 = w10 + pair
  const w14 = w12 + pair
  a2Mix(v, w0, w4, w8, w12)
  a2Mix(v, w0 + 2, w4 + 2, w8 + 2, w12 + 2)
  a2Mix(v, w2, w6, w10, w14)
  a2Mix(v, w2 + 2, w6 + 2, w10 + 2, w14 + 2)
  a2Mix(v, w0, w4 + 2, w10, w14 + 2)
  a2Mix(v, w0 + 2, w6, w10 + 2, w12)
  a2Mix(v, w2, w6 + 2, w8, w12 + 2)
  a2Mix(v, w2 + 2, w4, w8 + 2, w14)
}

// The memory Argon2id fills, and the step that fills a block of it: `blocks` of them, as
// one Uint32Array (`mem`), and `fill(prev, ref, out, xor)`, which makes block `out` from
// blocks `prev` and `ref` (over what `out` held, with `xor`). In plain JavaScript here,
// which is what the plugin runs; the same step in WebAssembly is below.
export function plainEngine(blocks) {
  const mem = new Uint32Array(blocks * 256)
  const r = new Uint32Array(256)
  const fill = (prev, ref, out, xor) => {
    const p = prev * 256
    const q = ref * 256
    const o = out * 256
    for (let i = 0; i < 256; i++) r[i] = mem[p + i] ^ mem[q + i]
    if (xor) for (let i = 0; i < 256; i++) mem[o + i] ^= r[i]
    else for (let i = 0; i < 256; i++) mem[o + i] = r[i]
    for (let i = 0; i < 256; i += 32) a2Round(r, i, 4)
    for (let i = 0; i < 32; i += 4) a2Round(r, i, 32)
    for (let i = 0; i < 256; i++) mem[o + i] ^= r[i]
  }
  return { mem, fill, done: () => mem.fill(0) }
}

// The same step in WebAssembly, for wherever that runs (a browser, a machine's agent; not
// the plugin, whose runtime has none), where it is several times as fast. It is
// deploy/argon2.wat, built and written in here by deploy/make-argon2.mjs, and a test holds
// it to the step above. Rejects where there is no WebAssembly, or none may be compiled.
const A2_STEP = 'AGFzbQEAAAABFQNgBH9_f38AYAJ_fwBgBX9_f39_AAIPAQNlbnYGbWVtb3J5AgABAwQDAAECBwgBBGZpbGwAAgrUBAPcAQEEfiAAKQMAIQQgASkDACEFIAIpAwAhBiADKQMAIQcgBCAFfCAEQv____8PgyAFQv____8Pg35CAYZ8IQQgByAEhUIgiiEHIAYgB3wgBkL_____D4MgB0L_____D4N-QgGGfCEGIAUgBoVCGIohBSAEIAV8IARC_____w-DIAVC_____w-DfkIBhnwhBCAHIASFQhCKIQcgBiAHfCAGQv____8PgyAHQv____8Pg35CAYZ8IQYgBSAGhUI_iiEFIAAgBDcDACABIAU3AwAgAiAGNwMAIAMgBzcDAAu1AQEHfyAAIAFqIQIgAiABaiEDIAMgAWohBCAEIAFqIQUgBSABaiEGIAYgAWohByAHIAFqIQggACADIAUgBxAAIABBCGogA0EIaiAFQQhqIAdBCGoQACACIAQgBiAIEAAgAkEIaiAEQQhqIAZBCGogCEEIahAAIAAgA0EIaiAGIAhBCGoQACAAQQhqIAQgBkEIaiAHEAAgAiAEQQhqIAUgB0EIahAAIAJBCGogAyAFQQhqIAgQAAu8AQIBfwF-QQAhBQNAIAAgBWopAwAgASAFaikDAIUhBiAEIAVqIAY3AwAgAwRAIAYgAiAFaikDAIUhBgsgAiAFaiAGNwMAIAVBCGoiBUGACEkNAAtBACEFA0AgBCAFakEQEAEgBUGAAWoiBUGACEkNAAtBACEFA0AgBCAFakGAARABIAVBEGoiBUGAAUkNAAtBACEFA0AgAiAFaiACIAVqKQMAIAQgBWopAwCFNwMAIAVBCGoiBUGACEkNAAsL'
let a2Step = null
export async function wasmEngine() {
  a2Step ??= WebAssembly.compile(fromB64(A2_STEP))
  const step = await a2Step
  return async (blocks) => {
    // (one block past the last, for the step to work in)
    const memory = new WebAssembly.Memory({ initial: Math.ceil(((blocks + 1) * 1024) / 65536) })
    const { exports } = await WebAssembly.instantiate(step, { env: { memory } })
    return {
      mem: new Uint32Array(memory.buffer, 0, blocks * 256),
      fill: (prev, ref, out, xor) => exports.fill(prev * 1024, ref * 1024, out * 1024, xor ? 1 : 0, blocks * 1024),
      done: () => new Uint8Array(memory.buffer).fill(0),
    }
  }
}

const A2_PAUSE = 1024 // blocks between one `pause` and the next

// Argon2id: `length` bytes from a password and a salt, at a cost of `m` KiB of memory
// filled `t` times over in `p` lanes. `pause`, when given, is awaited every 1024 blocks,
// so whatever else the caller's thread has to do is done in between. `engine` is what
// holds the memory and fills it (plainEngine); `secret` and `ad` are the standard's, and
// only its own test uses them.
export async function argon2id(password, salt, { m, t, p = 1, length = 32, secret = new Uint8Array(0), ad = new Uint8Array(0), pause, engine = plainEngine } = {}) {
  const blocks = 4 * p * Math.floor(m / (4 * p))
  const lane = blocks / p // how many blocks a lane is
  const segment = lane / 4 // and a quarter of one
  const start = blake2b(concat(le32(p), le32(length), le32(m), le32(t), le32(0x13), le32(2), le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad))
  // Three blocks past the end of the memory: one of noughts, the one addresses are made from, and the addresses
  const { mem, fill, done } = await engine(blocks + 3)
  const [NOUGHT, FROM, ADDRESSES] = [blocks, blocks + 1, blocks + 2]
  const put = (block, bytes) => {
    for (let i = 0; i < 256; i++) mem[block * 256 + i] = bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)
  }
  for (let l = 0; l < p; l++) {
    put(l * lane, longHash(1024, concat(start, le32(0), le32(l))))
    put(l * lane + 1, longHash(1024, concat(start, le32(1), le32(l))))
  }
  let filled = 0
  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      // The first half of the first pass takes its blocks from where a count says (so that
      // what is read does not depend on the password); the rest, from where the block before says
      const counted = pass === 0 && slice < 2
      for (let l = 0; l < p; l++) {
        if (counted) {
          mem.fill(0, NOUGHT * 256, (ADDRESSES + 1) * 256)
          mem.set([pass, 0, l, 0, slice, 0, blocks, 0, t, 0, 2, 0], FROM * 256)
        }
        const addresses = () => {
          mem[FROM * 256 + 12]++
          fill(NOUGHT, FROM, ADDRESSES, false)
          fill(NOUGHT, ADDRESSES, ADDRESSES, false)
        }
        let index = pass === 0 && slice === 0 ? 2 : 0
        if (counted && index) addresses()
        for (; index < segment; index++) {
          const at = l * lane + slice * segment + index
          const prev = at % lane === 0 ? at + lane - 1 : at - 1
          if (counted && index % 128 === 0) addresses()
          const from = counted ? ADDRESSES * 256 + (index % 128) * 2 : prev * 256
          const j1 = mem[from]
          const other = pass === 0 && slice === 0 ? l : mem[from + 1] % p
          // How many blocks it may take one from: those of its own lane made so far but the last, or those of another lane made before this slice
          const behind = pass === 0 ? slice * segment : lane - segment
          const area = other === l ? behind + index - 1 : behind - (index === 0 ? 1 : 0)
          const back = area - 1 - mulhi(area, mulhi(j1, j1))
          const first = pass !== 0 && slice !== 3 ? (slice + 1) * segment : 0
          fill(prev, other * lane + ((first + back) % lane), at, pass !== 0)
          if (pause && ++filled % A2_PAUSE === 0) await pause()
        }
      }
    }
  }
  // The last block of every lane, together
  const last = new Uint8Array(1024)
  for (let i = 0; i < 256; i++) {
    let word = 0
    for (let l = 0; l < p; l++) word ^= mem[(l * lane + lane - 1) * 256 + i]
    last[i * 4] = word
    last[i * 4 + 1] = word >>> 8
    last[i * 4 + 2] = word >>> 16
    last[i * 4 + 3] = word >>> 24
  }
  done?.()
  return longHash(length, last)
}

const CONTENT = 'manyclaws content v4'
const SIGNER = 'manyclaws sign v4'
// What a guess at a passphrase costs: 64 MiB of memory, filled three times over, in one lane
export const COST = { m: 65536, t: 3, p: 1 }
// The salt a passphrase is stretched with: drawn from the account's id, so every device
// of the account's makes the same one and none is kept anywhere
export const saltOf = (account) => sha256(enc.encode('manyclaws salt v4|' + String(account))).slice(0, 16)

// Everything a passphrase makes for an account (by its id): the key that seals, the half
// that signs the list of the account's devices and the half that checks it. Whatever is
// typed makes some key: nothing here, and nothing the server has, says whether it is the
// one the account's other devices made. `pause` and `engine` are Argon2id's (the step in
// WebAssembly where there is any, in plain JavaScript where there is none); `cost` is for
// a test of something else, which has no minute to give to this.
export async function keysFromPassphrase(passphrase, account, { pause, engine, cost = COST } = {}) {
  if (typeof account !== 'string' || !account) return null
  engine ??= await wasmEngine().catch(() => plainEngine)
  const master = await argon2id(enc.encode(String(passphrase).normalize('NFKC')), saltOf(account), { ...cost, pause, engine })
  const key = hkdf(master, CONTENT)
  const signer = hkdf(master, SIGNER)
  master.fill(0)
  return { key, signer, checker: verifyKey(signer) }
}

// What a computer keeps between sessions (its key, and the half that checks the list of
// the account's devices): locked under the computer's own token, which the system's secure
// storage holds. So what is kept opens for whoever has the token, and for nobody who only
// has the file it is in.
const KEPT_AAD = enc.encode('manyclaws kept key v4')
const keptWrap = (secret) => hkdf(enc.encode(String(secret)), 'manyclaws kept key v4')
export function keepKeys({ key, checker }, secret) {
  const iv = random(12)
  return 'v5.' + toB64(concat(iv, gcmEncrypt(keptWrap(secret), iv, concat(key, checker), KEPT_AAD)))
}
// What was kept, or null: kept under another token or passphrase, or not this at all (and
// then the key is made again from the passphrase)
export function keptKeys(text, secret) {
  if (typeof text !== 'string' || !text.startsWith('v5.')) return null
  try {
    const raw = fromB64(text.slice(3))
    const both = gcmDecrypt(keptWrap(secret), raw.subarray(0, 12), raw.subarray(12), KEPT_AAD)
    return both && both.length === 64 ? { key: both.slice(0, 32), checker: both.slice(32) } : null
  } catch {
    return null
  }
}

// The key ready for use: what seal() and open() take. With it, what names are made with
// (nameOf): drawn from the key, so that a name tells nothing of the key and is the same
// on every device that has it.
export function contentKey(key) {
  return { ...prepare(key), names: hkdf(key, 'manyclaws name v1') }
}

// A name for something the server has to tell from another without knowing what it is (a
// row of a chat, which may be sent twice and is kept once): made from what the thing is
// called on the device, it reads the same each time and says nothing of it
export const nameOf = (text, key) => toB64(hmac(key.names, enc.encode(String(text)))).slice(0, 22)

const random = (n) => crypto.getRandomValues(new Uint8Array(n))

// How long a sealed thing is shows, whatever it is sealed with: so what is sealed is made
// up first to a length that says little of it. Its JSON, with spaces after it (which
// whoever opens it reads past, as JSON has them), to the next 64 bytes up to 1024, and
// above that to the next length whose lower bits are all nought: the top
// floor(log2(log2(length))) + 1 bits of the length are all that vary, which adds 6% at
// most there (Padmé).
// What that hides: one short thing from another. A yes from a no, working from idle, one
// permission mode from another, which call an answer of a few words is to, how long a
// title is. What it does not: about how long a long text is, to within its step (64 bytes
// in 2000, 16 KB in a million), and how many things were sent and when. Sealed bytes (a
// photo, a file, a transcript) are not made up: they are as long as they are.
const bitsOf = (n) => 32 - Math.clz32(n) // how many bits a number is written in
export function sealedLength(length) {
  if (length <= 1024) return Math.max(64, Math.ceil(length / 64) * 64)
  const top = bitsOf(length) - 1
  const step = 2 ** (top - bitsOf(top))
  return Math.ceil(length / step) * step
}
function madeUp(bytes) {
  const out = new Uint8Array(sealedLength(bytes.length)).fill(0x20)
  out.set(bytes)
  return out
}

export function seal(value, key) {
  const iv = random(12)
  return PREFIX + toB64(concat(iv, gcmEncrypt(key, iv, madeUp(enc.encode(JSON.stringify(value === undefined ? null : value))), AAD)))
}

// What was sealed, or `fallback` when it can't be opened with this key
export function open(sealed, key, fallback = UNOPENED) {
  if (!isSealed(sealed) || !key) return fallback
  try {
    const bytes = fromB64(sealed.slice(PREFIX.length))
    const plain = gcmDecrypt(key, bytes.subarray(0, 12), bytes.subarray(12), AAD)
    return plain ? JSON.parse(dec.decode(plain)) : fallback
  } catch {
    return fallback
  }
}

// Every sealed value inside something (an answer, an event, a page of rows) opened; the rest as it was
export function openAll(value, key, depth = 0) {
  if (typeof value === 'string') return isSealed(value) ? open(value, key) : value
  if (!value || typeof value !== 'object' || depth > 40) return value
  if (Array.isArray(value)) return value.map((v) => openAll(v, key, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = openAll(v, key, depth + 1)
  return out
}

// Whether anything inside is sealed
export function hasSealed(value, depth = 0) {
  if (typeof value === 'string') return isSealed(value)
  if (!value || typeof value !== 'object' || depth > 40) return false
  return Object.values(value).some((v) => hasSealed(v, depth + 1))
}

export function sealBytes(bytes, key) {
  const iv = random(12)
  return concat(new Uint8Array(MAGIC), iv, gcmEncrypt(key, iv, bytes, BYTES_AAD))
}
export const isSealedBytes = (bytes) => bytes.length > 32 && MAGIC.every((b, i) => bytes[i] === b)
export function openBytes(bytes, key) {
  if (!isSealedBytes(bytes) || !key) return null
  return gcmDecrypt(key, bytes.subarray(4, 16), bytes.subarray(16), BYTES_AAD)
}


// ---- The account's devices: its phones and browsers, each known by a key of its own
// that it made itself. The list of them is signed by the passphrase's signer, which a
// device has only for the moment the passphrase is typed there, and sealed like anything
// else: to the server it is one more sealed thing. A computer keeps the newest it has seen.

const DEVICES_TAG = enc.encode('manyclaws devices v1|')
export const DEVICE_STAY_MS = 24 * 3600_000 // how long a device that is not its owner's own stays one of the account's
const MAX_DEVICES = 100
const isDeviceKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)

// What a list is signed by
export const devicesDigest = (list) => sha256(concat(DEVICES_TAG, enc.encode(list)))
// A list ({ v, devices }) written out and signed: `signer` is the passphrase's own. Sealed, it is what the server keeps.
export function signDevices({ v, devices }, signer) {
  const list = JSON.stringify({ v, devices })
  return { list, sig: toB64(sign(devicesDigest(list), signer)) }
}
// A list as it was signed ({ v, devices }), where the passphrase's checker says its signer signed it: null otherwise
export function signedDevices(got, checker) {
  try {
    if (!got || typeof got.list !== 'string' || typeof got.sig !== 'string' || !checker) return null
    if (!verify(devicesDigest(got.list), fromB64(got.sig), checker)) return null
    const { v, devices } = JSON.parse(got.list)
    if (!Number.isFinite(v) || !Array.isArray(devices) || devices.length > MAX_DEVICES) return null
    if (!devices.every((d) => d && isDeviceKey(d.key) && typeof d.name === 'string' && Number.isFinite(d.at) && (d.until === undefined || Number.isFinite(d.until)))) return null
    return { v, devices }
  } catch {
    return null
  }
}
export const makeDevices = (list, key, signer) => seal(signDevices(list, signer), key)
export const readDevices = (text, key, checker) => signedDevices(open(text, key, null), checker)
// One of a list's devices, by its key, while it is one of them: null for one that is not there, or whose stay is over
export const deviceIn = (list, key, now = Date.now()) => {
  const d = list?.devices?.find((x) => x.key === key)
  return d && !(d.until && now > d.until) ? d : null
}

// What a computer knows of the account's devices: the newest list it has seen that the
// passphrase's signer signed. `kept` is the list as it was last kept here, sealed, and
// `save` keeps one. One older than the one held is not taken, so a device taken off the
// list stays off it, whatever the server hands over later.
export function devicesMemory(kept, key, checker, save = () => {}) {
  let held = readDevices(kept, key, checker)
  let as = held ? kept : null // the list held, as it came: one handed over again as it is has nothing new to say
  return {
    get list() {
      return held
    },
    // A list as the server has it: true where it is the account's, and is the one held from here on
    take(text) {
      if (held && text === as) return true
      const next = readDevices(text, key, checker)
      if (!next || (held && next.v < held.v)) return false
      if (!held || next.v > held.v) save(text)
      held = next
      as = text
      return true
    },
  }
}

// ---- Orders: what a person asks of a computer, signed by the phone or the browser it is
// asked from, with the key that is that device's alone

const ORDER = SEALED + 'o2.'
const ORDER_AAD = enc.encode('manyclaws order v3')
const ORDER_TAG = enc.encode('manyclaws order v3|')
export const ORDER_MS = 60 * 60_000 // how long after it was asked an order may still be run
const ORDER_AHEAD_MS = 5 * 60_000 // how far ahead of this computer's clock the clock it was asked by may be
export const isOrder = (v) => typeof v === 'string' && v.startsWith(ORDER)
// What an order is signed by
export const orderDigest = (o) => sha256(concat(ORDER_TAG, enc.encode(o)))
// What an order says, written out to be signed: `to` is the session or machine it is for,
// `do` what it asks, `with` the rest of it
export const orderText = ({ to, do: what, with: rest = {} }, now = Date.now()) => JSON.stringify({ at: now, n: toB64(random(12)), to, do: what, with: rest })

// An order. `key` is the key ready for use (contentKey), `device` the device that asks:
// its own public key (`key`, as the list of devices has it) and the half that signs (`signer`).
export function makeOrder(asked, key, device, now = Date.now()) {
  const o = orderText(asked, now)
  const iv = random(12)
  // (made up as a sealed value is: a yes is as long as a no, and a short prompt as another)
  return ORDER + toB64(concat(iv, gcmEncrypt(key, iv, madeUp(enc.encode(JSON.stringify({ o, by: device.key, sig: toB64(sign(orderDigest(o), device.signer)) }))), ORDER_AAD)))
}

// An order as it was made ({ at, n, to, do, with }, and `by`: the device that asked), or
// why it is not one to go by: `key` (this key does not open it), `device` (it is from a
// device the list does not have), `over` (from one whose stay is over), `signature`
function orderIn(text, key, devices, now) {
  if (!isOrder(text) || !key) return { why: 'unsigned' }
  let got = null
  try {
    const raw = fromB64(text.slice(ORDER.length))
    const plain = gcmDecrypt(key, raw.subarray(0, 12), raw.subarray(12), ORDER_AAD)
    got = plain ? JSON.parse(dec.decode(plain)) : null
  } catch {}
  if (!got || typeof got.o !== 'string' || !isDeviceKey(got.by) || typeof got.sig !== 'string') return { why: 'key' }
  const device = devices?.devices?.find((d) => d.key === got.by)
  if (!device) return { why: 'device' }
  if (device.until && now > device.until) return { why: 'over' }
  try {
    if (!verify(orderDigest(got.o), fromB64(got.sig), fromB64(got.by))) return { why: 'signature' }
    const order = JSON.parse(got.o)
    return order && typeof order === 'object' && typeof order.n === 'string' && Number.isFinite(order.at) && order.with && typeof order.with === 'object' ? { order: { ...order, by: got.by } } : { why: 'signature' }
  } catch {
    return { why: 'signature' }
  }
}
// The order, where this key opens it and a device of the account's (`devices`: the list, as readDevices gives it) signed it: null otherwise
export const readOrder = (text, key, devices, now = Date.now()) => orderIn(text, key, devices, now).order ?? null

// Why an order was not run: said to whoever asked
export class OrderRefused extends Error {}
const REFUSED = {
  unsigned: 'it did not come signed by one of your devices',
  key: 'it was not sealed with the key this computer was given: if your passphrase has been set again, give this computer the new one',
  device: "the device it was asked from is not one of your account's devices as this computer knows them: type your passphrase into that device again (Account), which makes it one",
  over: "the device it was asked from was made one of your account's devices for a day, as one that is not your own, and the day is over: type your passphrase into it again",
  signature: 'it was not signed by the device it says it is from',
}

// Takes an order to be run here and now, once: what it holds, or a throw that says why
// not. `devices` is the account's devices as this computer knows them, `to` who is being
// asked, `does` what it may be asking (one of), `seen` the memory of orders run (orderMemory).
export function takeOrder(text, { key, devices, to, does, seen, now = Date.now() }) {
  const { order, why } = orderIn(text, key, devices, now)
  if (!order) throw new OrderRefused(REFUSED[why])
  if (order.to !== to) throw new OrderRefused('it was signed for somewhere else')
  if (!does.includes(order.do)) throw new OrderRefused('it was signed for something else')
  if (now - order.at > ORDER_MS) throw new OrderRefused('it was asked more than an hour ago: ask again')
  if (order.at - now > ORDER_AHEAD_MS) throw new OrderRefused("it is dated ahead of this computer's clock: one of the two clocks is wrong")
  if (seen.has(order.n)) throw new OrderRefused('it has been run already')
  seen.add(order.n, order.at)
  return order
}

// What the page seals and opens with where its keys are kept so that no script reads them
// back (keys.js, in WebCrypto): how each thing sealed here begins, and what is said over it
export const WIRE = { value: PREFIX, valueAad: AAD, bytes: MAGIC, bytesAad: BYTES_AAD, order: ORDER, orderAad: ORDER_AAD }
export { madeUp }

// The memory of orders run, for as long as one could still be run again: `kept` is what
// was remembered before ({ n: at }), and `save` keeps what is remembered now
export function orderMemory(kept, save = () => {}) {
  const run = new Map(Object.entries(kept && typeof kept === 'object' ? kept : {}))
  const told = () => save(Object.fromEntries(run))
  return {
    has: (n) => run.has(n),
    add(n, at) {
      for (const [was, then] of run) if (Date.now() - then > ORDER_MS + ORDER_AHEAD_MS) run.delete(was)
      run.set(n, at)
      told()
    },
    // (one that was not run after all may be asked again)
    forget(n) {
      if (run.delete(n)) told()
    },
  }
}

// What a session asked (a permission, a question), as two devices work it out alike from
// what each has of it: an answer says which asking it answers by this, so that an answer
// to one thing is not an answer to another shown in its place
const alike = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(alike).join(',') + ']' : '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + alike(v[k])).join(',') + '}') : JSON.stringify(v ?? null))
export const askedOf = (r) => toB64(sha256(enc.encode(alike([r?.rid ?? '', r?.kind ?? '', r?.tool ?? r?.name ?? '', r?.input ?? null, r?.questions ?? null]))))
