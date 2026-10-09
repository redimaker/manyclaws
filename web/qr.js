// A QR code for an address: what a phone's camera is pointed at to open this page there
// (the tour an account is given once it has paid: app.js, showTour). It says the address
// and nothing else: nothing of the account's is ever put in one.
//
// The code is the ordinary kind (ISO 18004): the address as bytes, error correction M (a
// fifth of it may be lost), and the smallest of versions 1 to 6 that holds it, which is an
// address of up to 106 bytes. A longer one gets no code: qrOf gives null, and the page
// says the address in words alone.
//
//   qrOf(text) -> { size, rows }   rows[y][x] is true where the module is dark; null where the text is too long

// For each version: how many blocks its data is in, the data bytes in each, and the check bytes each is given
const BLOCKS = [null, [1, 16, 10], [1, 28, 16], [1, 44, 26], [2, 32, 18], [2, 43, 24], [4, 27, 16]]

// Reed-Solomon over GF(256), as the standard has it (x^8 + x^4 + x^3 + x^2 + 1)
function times(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}
function divisorOf(degree) {
  const d = new Array(degree).fill(0)
  d[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      d[j] = times(d[j], root)
      if (j + 1 < degree) d[j] ^= d[j + 1]
    }
    root = times(root, 2)
  }
  return d
}
function checkBytes(data, divisor) {
  const rest = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ rest.shift()
    rest.push(0)
    divisor.forEach((c, i) => (rest[i] ^= times(c, factor)))
  }
  return rest
}

// The eight ways the data's modules may be flipped, so that the code has no large plain patches: one is chosen (penalty)
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

// How hard a code is on a camera, by the standard's four counts: long runs of one colour, blocks of one colour, what
// looks like a corner mark where there is none, and more dark than light or the other way about
function penalty(rows) {
  const size = rows.length
  let sum = 0
  const lines = []
  for (let i = 0; i < size; i++) {
    lines.push(rows[i].map((d) => (d ? '1' : '0')).join(''))
    lines.push(rows.map((row) => (row[i] ? '1' : '0')).join(''))
  }
  for (const line of lines) {
    for (const run of line.match(/0{5,}|1{5,}/g) ?? []) sum += run.length - 2
    for (let at = 0; at + 11 <= line.length; at++) if (line.startsWith('10111010000', at) || line.startsWith('00001011101', at)) sum += 40
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) if (rows[y][x] === rows[y][x + 1] && rows[y][x] === rows[y + 1][x] && rows[y][x] === rows[y + 1][x + 1]) sum += 3
  const dark = rows.flat().filter(Boolean).length
  return sum + 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5)
}

export function qrOf(text) {
  const bytes = new TextEncoder().encode(String(text))
  // (two bytes of every code are its own: what kind of data it has, how much, and where that ends)
  const version = BLOCKS.findIndex((b) => b && b[0] * b[1] - 2 >= bytes.length)
  if (version < 1) return null
  const [blocks, each, check] = BLOCKS[version]

  // The data: that it is bytes, how many, the bytes, an end, and filler to the size the version holds
  const bits = []
  const put = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(4, 4)
  put(bytes.length, 8)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, blocks * each * 8 - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let filler = 0xec; bits.length < blocks * each * 8; filler ^= 0xec ^ 0x11) put(filler, 8)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0))
  // In blocks, each with its check bytes; then a byte from each block in turn, the data first and the checks after
  const divisor = divisorOf(check)
  const parts = Array.from({ length: blocks }, (_, b) => data.slice(b * each, (b + 1) * each)).map((d) => [d, checkBytes(d, divisor)])
  const woven = []
  for (let i = 0; i < each; i++) for (const [d] of parts) woven.push(d[i])
  for (let i = 0; i < check; i++) for (const [, c] of parts) woven.push(c[i])

  // The square, and which of its modules are the code's own and not data's (`fixed`)
  const size = 17 + 4 * version
  const rows = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    rows[y][x] = !!dark
    fixed[y][x] = true
  }
  // (the two dotted lines every code is measured by)
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  // (the three corner marks, each with a light band about it)
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, d !== 2 && d !== 4)
      }
    }
  }
  // (and the small one towards the fourth corner, which every version after the first has: these have the one)
  if (version > 1) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(size - 7 + dx, size - 7 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  // What says how the code is checked (M) and which mask it has: fifteen bits, written twice beside the corner marks
  const format = (mask) => {
    let rest = mask
    for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537)
    const word = ((mask << 10) | rest) ^ 0x5412
    const bit = (i) => ((word >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  format(0)

  // The data goes in from the bottom right, two columns at a time, up and then down, round whatever is the code's own
  let at = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - step : step
        if (fixed[y][x] || at >= woven.length * 8) continue
        rows[y][x] = ((woven[at >>> 3] >>> (7 - (at & 7))) & 1) === 1
        at++
      }
    }
  }

  // Each mask tried, and the one that is easiest on a camera kept
  const flip = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) rows[y][x] = !rows[y][x]
  }
  let best = 0
  let least = Infinity
  for (let mask = 0; mask < MASKS.length; mask++) {
    format(mask)
    flip(mask)
    const p = penalty(rows)
    if (p < least) [best, least] = [mask, p]
    flip(mask)
  }
  format(best)
  flip(best)
  return { size, rows }
}
