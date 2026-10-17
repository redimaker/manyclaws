// Sealing: end-to-end encryption of what an account's sessions say. Every device of an
// account has the same key, and encrypts ("seals") and decrypts ("opens") with it. The
// server stores and forwards what was sealed and cannot open it.
//
// The key is drawn from the account's root: 32 random bytes, made by its first phone or
// browser. There is no passphrase. A device gets the key from one the account has
// already, approved there (with Face ID, Touch ID or another passkey), sealed with a key
// the two made from a code the new device showed and the person typed (Pairing, below): so
// the server hands it over and cannot open it. The root, written out, is the account's recovery key, for when every device is
// lost: shown to the person once, kept by them, and never sent anywhere. The server is
// given nothing of it, and has nothing to guess it from: it is not made from anything a
// person chose.
//
// This file is kept as three identical copies (a test compares them): mod/hooks/seal.js
// (the plugin), web/seal.js (the page) and mod/agent/seal.mjs (the machine agent).
// The plugin's runtime has no crypto library, so everything is implemented here in plain
// JavaScript: SHA-256, SHA-512, HMAC, HKDF, AES-256-GCM, Ed25519, SPAKE2, and the check of
// an SSH signature (a release's). The tests check each one against Node's own. (The page
// keeps the key where a script cannot read it back, and the root wrapped under a passkey:
// keys.js.)
//
// What the root makes:
//
//   root    = 32 random bytes                                                  kept by the account's phones and browsers,
//                                                                              each under a passkey of its own; and by the
//                                                                              person, written out (rootText)
//   key     = HKDF-SHA256(root, salt "", info "manyclaws content v5")         the AES-256 key: stored on every device
//   signer  = HKDF-SHA256(root, salt "", info "manyclaws sign v5")            an Ed25519 private key (its seed): stored
//                                                                              nowhere. A phone or a browser makes it from
//                                                                              the root for the moment it signs
//   checker = the Ed25519 public key of signer                                 stored by every device: it verifies what
//                                                                              the signer signed, and cannot sign
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
//                          own Ed25519 public key, kept on it where no script can read its other half;
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
//   handed over    = "p1." + base64url(iv | ciphertext | tag)                   (sealPaired: the key to a new device)
//                    AES-256-GCM with the key two devices made from the code one showed (Pairing, below)
//
// Another root makes another key, signer and checker. Nothing in a sealed value says which
// key sealed it: a device with a different key fails to open it, and that failure is how
// it knows.
//
// An order is what a person asks of a computer from a phone or a browser: a prompt, an
// answer to what a session asked, a session to start. Each phone and browser signs with a
// key of its own, which never leaves it. It is one of the account's devices because the
// root's signer said so, when another device approved it: the list of them is signed by
// it, sealed, and kept on the server for the account's computers to read. A computer acts
// only on an order that opens with its key, that a device in the newest list it has seen
// signed, that is for it, that asks for something allowed where it arrived, that was made
// within the last hour, and that it has not run before. So nothing the server stores or
// makes up can make a computer act: it has no device's key, and cannot write a list. A
// computer has neither: it can read what the account's sessions say, and cannot give an
// order to another computer. And a device that is lost is taken off the list by any other
// that has the root: its orders are refused from then on, by every computer that has seen
// the list without it, whatever list is handed over later (devicesMemory). It still has
// the key it was given, which opens what is sealed and gives no order: shutting it out of
// what is said from then on too takes another root, which makes another key.

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

// ---- Pairing: SPAKE2 (RFC 9382) over edwards25519, with a code a person carries from one
// device to another. What is new to the account (a computer, a browser) shows the code;
// a phone or browser that has the account's key is where it is typed. Each side makes a
// point from the code and a number of its own, the server passes the two between them,
// and each makes the same key from them only where both had the same code. The server,
// which passes everything, has one guess at the code a try, and none it can check by
// itself: what it sees of a try says nothing of any other code. So a code of six digits
// is enough, with a try or three before it is made again. Each side shows the other it
// has the key (confirm) before anything is sealed with it.
//
//   w      = SHA-512("manyclaws pairing v1" | context | code) mod L
//   asker  (shows the code):  pA = x·G + w·M        approver (types it):  pB = y·G + w·N
//   K      = 8·x·(pB - w·N)  =  8·y·(pA - w·M)
//   TT     = each of "manyclaws asker", "manyclaws approver", pA, pB, K, w, led by its
//            length (8 bytes, little-endian)
//   Ke|Ka  = SHA-256(TT);  KcA|KcB = HKDF(Ka, "ConfirmationKeys" | context, 32)
//   confirm: HMAC(KcA, TT) from the asker, HMAC(KcB, TT) from the approver
//   key    = HKDF(Ke, "manyclaws paired v1"), sealing what goes between them with AES-256-GCM
//
// M and N are the RFC's for edwards25519: the first points with no known logarithm that the
// hash of "edwards25519 point generation seed (M)" and "(N)" makes (a test makes them again).

const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16))
const SPAKE_M = unpacked(fromHex('d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf'))
const SPAKE_N = unpacked(fromHex('d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab'))
const NOTHING = [0n, 1n, 1n, 0n]
const negated = (p) => [mod(-p[0]), p[1], p[2], mod(-p[3])]
const ledByLength = (bytes) => concat(bytesOf(BigInt(bytes.length), 8), bytes)
function pairWord(code, context) {
  return mod(little(sha512(enc.encode('manyclaws pairing v1|' + context + '|' + code))), L)
}
// One side's start: `asker` is the side that shows the code. `mine` goes to the other side
export function pairStart(asker, code, context) {
  const w = pairWord(String(code), String(context))
  const x = mod(little(random(64)), L)
  return { asker: !!asker, context: String(context), w, x, mine: packed(add(times(x, BASE), times(w, asker ? SPAKE_M : SPAKE_N))) }
}
// From the other side's point: the key, the confirm to send and the one to expect; null
// where theirs is no point, or no key comes of it
export function pairFinish(start, theirs) {
  const point = theirs?.length === 32 ? unpacked(theirs) : null
  if (!point) return null
  const K = times(8n, times(start.x, add(point, negated(times(start.w, start.asker ? SPAKE_N : SPAKE_M)))))
  if (same(K, NOTHING)) return null
  const [pA, pB] = start.asker ? [start.mine, theirs] : [theirs, start.mine]
  const tt = concat(...[enc.encode('manyclaws asker'), enc.encode('manyclaws approver'), pA, pB, packed(K), bytesOf(start.w, 32)].map(ledByLength))
  const keys = sha256(tt)
  const kc = hkdf(keys.subarray(16), 'ConfirmationKeys' + start.context, 32)
  const [cA, cB] = [hmac(kc.subarray(0, 16), tt), hmac(kc.subarray(16), tt)]
  return { key: hkdf(keys.subarray(0, 16), 'manyclaws paired v1', 32), confirm: start.asker ? cA : cB, expect: start.asker ? cB : cA }
}
// Whether a confirm is the one expected (as long, and the same in every byte)
export function pairConfirmed(paired, confirm) {
  if (!paired || confirm?.length !== paired.expect.length) return false
  let differ = 0
  for (let i = 0; i < confirm.length; i++) differ |= confirm[i] ^ paired.expect[i]
  return differ === 0
}
const PAIRED_PREFIX = 'p1.'
const PAIRED_AAD = enc.encode('manyclaws paired v1')
// What one side sends the other once both have confirmed, sealed with the key they made
export function sealPaired(paired, value) {
  const iv = random(12)
  return PAIRED_PREFIX + toB64(concat(iv, gcmEncrypt(paired.key, iv, madeUp(enc.encode(JSON.stringify(value === undefined ? null : value))), PAIRED_AAD)))
}
export function openPaired(paired, text) {
  try {
    if (!paired || typeof text !== 'string' || !text.startsWith(PAIRED_PREFIX)) return null
    const bytes = fromB64(text.slice(PAIRED_PREFIX.length))
    const plain = gcmDecrypt(paired.key, bytes.subarray(0, 12), bytes.subarray(12), PAIRED_AAD)
    return plain ? JSON.parse(dec.decode(plain)) : null
  } catch {
    return null
  }
}
// A code of `digits` digits, each as likely as any other
export function pairCode(digits = 6) {
  let code = ''
  while (code.length < digits) {
    const b = random(1)[0]
    if (b < 250) code += String(b % 10)
  }
  return code
}

// ---- Releases. A release is a list of every file with its SHA-256 (release.json), signed
// with ssh-keygen (release.json.sig) by a key kept neither in the public repository nor on
// any server. The agent's installer checks the signature with ssh-keygen itself; this is
// the same check in plain JavaScript, for what has no ssh-keygen to run: the page, which
// holds what a computer says it runs against the release it names, and the plugin. Only
// ssh-ed25519 keys, the only kind a release is signed with.

const SSHSIG = enc.encode('SSHSIG')
const fromStd64 = (text) => fromB64(String(text).replace(/\s+/g, '').replace(/=+$/, ''))
const sshString = (bytes) => {
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length)
  out.set(bytes, 4)
  return out
}
// The strings an SSH blob is made of, in order (null where it is not made of them)
function sshStrings(bytes, at = 0) {
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return null
    const n = view.getUint32(at)
    if (at + 4 + n > bytes.length) return null
    out.push(bytes.subarray(at + 4, at + 4 + n))
    at += 4 + n
  }
  return out
}
const ED25519 = 'ssh-ed25519'
const ed25519Of = (blob) => {
  const parts = sshStrings(blob)
  return parts?.length === 2 && dec.decode(parts[0]) === ED25519 && parts[1].length === 32 ? parts[1] : null
}
// The keys an allowed-signers file names (as ssh-keygen reads one): { principal, namespaces, key }
export function signersOf(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\S+)\s+(?:namespaces="([^"]*)"\s+)?ssh-ed25519\s+([A-Za-z0-9+/]+=*)/.exec(line)
    if (!m || m[1].startsWith('#')) continue
    const key = ed25519Of(fromStd64(m[3]))
    if (key) out.push({ principal: m[1], namespaces: m[2] === undefined ? null : m[2].split(','), key })
  }
  return out
}
// Whether `message` (text or bytes) was signed, in one of the signatures in `sigText`, by
// a key `signersText` names for `principal` and `namespace`
export function sshSigned(message, sigText, signersText, { principal = 'manyclaws', namespace = 'manyclaws-release' } = {}) {
  const bytes = typeof message === 'string' ? enc.encode(message) : message
  const keys = signersOf(signersText).filter((s) => s.principal === principal && (!s.namespaces || s.namespaces.includes(namespace)))
  const armored = String(sigText ?? '').match(/-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/g) ?? []
  return armored.some((one) => {
    try {
      const blob = fromStd64(one.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, ''))
      if (blob.length < 10 || !SSHSIG.every((b, i) => blob[i] === b) || new DataView(blob.buffer, blob.byteOffset).getUint32(6) !== 1) return false
      const parts = sshStrings(blob, 10)
      if (parts?.length !== 5) return false
      const [publicKey, ns, reserved, hashName, signature] = parts
      if (dec.decode(ns) !== namespace) return false
      const key = ed25519Of(publicKey)
      const sig = sshStrings(signature)
      if (!key || sig?.length !== 2 || dec.decode(sig[0]) !== ED25519) return false
      if (!keys.some((s) => s.key.every((b, i) => b === key[i]))) return false
      const hash = dec.decode(hashName)
      const digest = hash === 'sha512' ? sha512(bytes) : hash === 'sha256' ? sha256(bytes) : null
      if (!digest) return false
      return verify(concat(SSHSIG, sshString(ns), sshString(reserved), sshString(hashName), sshString(digest)), sig[1], key)
    } catch {
      return false
    }
  })
}

// What a plugin is, as one digest: each of its files by its path in the plugin's folder and
// its SHA-256, in order, made one SHA-256. The same from a release's list (the files under
// mod/) as from a folder Claude Code installed, so that what a computer runs is said in one
// value that can be held against a signed list, or approved by itself where it is no
// release. What of a plugin's folder is not the plugin: the list it was released by, and
// what Claude Code writes there of its own.
export const notPlugin = (rel) =>
  rel === 'release.json' || rel === 'release.json.sig' || rel === 'tsconfig.json' || rel === '.orphaned_at' || /^\.in_use(\/|$)/.test(rel) || rel.startsWith('.claude-plugin/types/') || /(^|\/)(\.DS_Store|node_modules)(\/|$)/.test(rel)
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
export const hexSha256 = (bytes) => hexOf(sha256(typeof bytes === 'string' ? enc.encode(bytes) : bytes))
// `files`: { path: its SHA-256 } (or [path, SHA-256] pairs)
export function pluginDigest(files) {
  const entries = (Array.isArray(files) ? files : Object.entries(files ?? {})).filter(([rel]) => !notPlugin(rel))
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return hexSha256(entries.map(([rel, hash]) => hash + '  ' + rel + '\n').join(''))
}
// A release's list as the plugin's files: those under mod/, by their paths in the plugin's folder
export const pluginOfList = (list) => Object.fromEntries(Object.entries(list?.files ?? {}).filter(([f]) => f.startsWith('mod/')).map(([f, hash]) => [f.slice(4), hash]))

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

// ---- The account's root: 32 random bytes, made by its first phone or browser, from which its keys are drawn

const CONTENT = 'manyclaws content v5'
const SIGNER = 'manyclaws sign v5'
// A new root, for a new account, or for one started afresh
export const newRoot = () => random(32)
// Everything a root makes: the key that seals, the half that signs the list of the account's devices and the half that
// checks it. Null for anything that is not a root.
export function keysFromRoot(root) {
  if (!(root instanceof Uint8Array) || root.length !== 32) return null
  const signer = hkdf(root, SIGNER)
  return { key: hkdf(root, CONTENT), signer, checker: verifyKey(signer) }
}

// The root written out, for a person to keep: the recovery key. Crockford's base32 (no I, L, O or U), 52 characters in
// 13 groups of 4. Read back with O taken for 0 and I and L for 1, in either case, with any spaces and dashes; anything
// else, or a last character with bits beyond the root's, is no recovery key (null).
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function rootText(root) {
  let value = 0
  let bits = 0
  let out = ''
  for (const b of root) {
    value = ((value << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits) out += B32[(value << (5 - bits)) & 31]
  return out.match(/.{1,4}/g).join('-')
}
export function rootFromText(text) {
  const s = String(text ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!/^[0-9A-HJKMNP-TV-Z]{52}$/.test(s)) return null
  const root = new Uint8Array(32)
  let value = 0
  let bits = 0
  let n = 0
  for (const c of s) {
    value = ((value << 5) | B32.indexOf(c)) & 0xffff
    bits += 5
    if (bits >= 8) {
      root[n++] = (value >>> (bits - 8)) & 255
      bits -= 8
    }
  }
  return n === 32 && bits === 4 && (value & 15) === 0 ? root : null
}

// (A computer keeps its key written out, keysText above, where its system keeps secrets. It is given the key and the
// checker, never the root: it seals and opens, and cannot sign a list of devices.)

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
// that never leaves it. The list of them is signed by the root's signer, which a device
// makes from the root only for the moment it signs, and sealed like anything else: to
// the server it is one more sealed thing. A computer keeps the newest it has seen.

const DEVICES_TAG = enc.encode('manyclaws devices v1|')
export const DEVICE_STAY_MS = 24 * 3600_000 // how long a device that is not its owner's own stays one of the account's
const MAX_DEVICES = 100
const isDeviceKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)

// What a list is signed by
export const devicesDigest = (list) => sha256(concat(DEVICES_TAG, enc.encode(list)))
// A list ({ v, devices, allowed }) written out and signed: `signer` is the root's. Sealed, it is what the
// server keeps. Beside the devices, and signed with them, the plugins the account's owner allowed on a computer where
// they are no release (`allowed`: { machine, hash, at }, the hash as pluginDigest makes it): what only the root says,
// as only it says which devices are the account's. And on a device, `start: false` where it may not start
// sessions on the account's computers (one that is not its owner's own, with `until`, never may).
const MAX_ALLOWED = 200
export function signDevices({ v, devices, allowed = [] }, signer) {
  const list = JSON.stringify(allowed.length ? { v, devices, allowed } : { v, devices })
  return { list, sig: toB64(sign(devicesDigest(list), signer)) }
}
const isAllowed = (a) => a && typeof a.machine === 'string' && a.machine.length <= 100 && /^[0-9a-f]{64}$/.test(a.hash) && Number.isFinite(a.at)
// A list as it was signed ({ v, devices, allowed }), where the root's checker says its signer signed it: null otherwise
export function signedDevices(got, checker) {
  try {
    if (!got || typeof got.list !== 'string' || typeof got.sig !== 'string' || !checker) return null
    if (!verify(devicesDigest(got.list), fromB64(got.sig), checker)) return null
    const { v, devices, allowed = [] } = JSON.parse(got.list)
    if (!Number.isFinite(v) || !Array.isArray(devices) || devices.length > MAX_DEVICES) return null
    if (!devices.every((d) => d && isDeviceKey(d.key) && typeof d.name === 'string' && Number.isFinite(d.at) && (d.until === undefined || Number.isFinite(d.until)) && (d.start === undefined || typeof d.start === 'boolean'))) return null
    if (!Array.isArray(allowed) || allowed.length > MAX_ALLOWED || !allowed.every(isAllowed)) return null
    return { v, devices, allowed }
  } catch {
    return null
  }
}
// Whether a device may have a session started on one of the account's computers: one that is its owner's own (no
// `until`), unless its owner turned that off
export const mayStart = (d) => !!d && d.until === undefined && d.start !== false
// Whether a plugin (its pluginDigest) was allowed on a computer (its id) by the list
export const allowedOn = (list, machine, hash) => !!list?.allowed?.some((a) => a.machine === machine && a.hash === hash)
export const makeDevices = (list, key, signer) => seal(signDevices(list, signer), key)
export const readDevices = (text, key, checker) => signedDevices(open(text, key, null), checker)
// One of a list's devices, by its key, while it is one of them: null for one that is not there, or whose stay is over
export const deviceIn = (list, key, now = Date.now()) => {
  const d = list?.devices?.find((x) => x.key === key)
  return d && !(d.until && now > d.until) ? d : null
}

// What a computer knows of the account's devices: the newest list it has seen that the
// root's signer signed, and every device it has seen taken off one. `kept` is the
// list as it was last kept here, sealed, and `save` keeps one. One older than the one held
// is not taken, so a device taken off the list stays off it, whatever the server hands
// over later.
//
// Nor does one come back on a newer list. A browser that signs a list has no list of its
// own to go by: it builds the next one on the list the server hands it, and
// signs that. Handed an old one, it would sign a device back on that had been taken off
// since, under a newer number than any list here. So a device that was on the list held
// here and is not on the one that replaced it is remembered as gone (`gone`: the keys
// remembered so before; `saveGone` keeps them), and is none of the account's here again,
// whichever list has it. Nothing is lost by that: a device is given a new key of its own
// each time it is approved, so no device is ever put back under the key it was taken off
// by.
const MAX_GONE = 500
export function devicesMemory(kept, key, checker, save = () => {}, { gone = [], saveGone = () => {} } = {}) {
  let held = readDevices(kept, key, checker)
  let as = held ? kept : null // the list held, as it came: one handed over again as it is has nothing new to say
  const off = new Set((Array.isArray(gone) ? gone : []).filter(isDeviceKey))
  // (the list as this computer goes by it: without the devices it has seen taken off)
  const without = (list) => (list && list.devices.some((d) => off.has(d.key)) ? { ...list, devices: list.devices.filter((d) => !off.has(d.key)) } : list)
  let known = without(held)
  return {
    get list() {
      return known
    },
    // The devices seen taken off, by their keys
    get gone() {
      return [...off]
    },
    // A list as the server has it: true where it is the account's, and is the one held from here on
    take(text) {
      if (held && text === as) return true
      const next = readDevices(text, key, checker)
      if (!next || (held && next.v < held.v)) return false
      if (held && next.v > held.v) {
        const stay = new Set(next.devices.map((d) => d.key))
        const left = held.devices.filter((d) => !stay.has(d.key) && !off.has(d.key))
        for (const d of left) off.add(d.key)
        // (the oldest are let go of first, should there ever be so many)
        for (const k of off) if (off.size > MAX_GONE) off.delete(k)
        if (left.length) saveGone([...off])
      }
      if (!held || next.v > held.v) save(text)
      held = next
      as = text
      known = without(held)
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
  key: 'it was not sealed with the key this computer was given: if your account was started afresh with a new key, connect this computer again, with the code its plugin shows',
  device: "the device it was asked from is not one of your account's devices as this computer knows them: approve that device again from one that has your key",
  over: "the device it was asked from was made one of your account's devices for a day, as one that is not your own, and the day is over: approve it again from one of your own",
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
