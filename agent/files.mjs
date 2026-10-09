// A file on this machine that a link in a session's chat names: which file is meant, and
// what is in it.
//
// A link says where a file is the way whoever wrote it had it in mind. Whole
// (/Users/x/app/src/a.ts), from the session's folder (src/a.ts), from the top of its
// project while the session runs further in, from a folder further in while the session
// runs at the top (a.ts for src/a.ts), under another machine's folders, with a line after
// it (a.ts:42, a.ts#L42-L51), as a file:// address, or with its spaces written %20. `find`
// tries the link as it is written first, and where that is no file, looks through the
// project for the file whose path ends most like it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FILE_MAX = 16 * 1024 * 1024 // the largest file that is read
const LIST_MAX = 2000 // the most of a folder's entries that are listed
const LOOK_MAX = 60_000 // how many entries of a project are looked at for a file that is not where the link says
const LOOK_MS = 4000 // and for how long
const OTHERS_MAX = 12 // how many other files the link could have meant are named
// Folders a project's own files are not in: what was fetched or built into it, and what keeps its history
const NOT_LOOKED_IN = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', '.gradle', '.tox', '.mypy_cache', '.pytest_cache', 'Pods', 'DerivedData'])

// Why a file was not read: said to whoever asked, so it names nothing of what is on this machine
export class FileError extends Error {}

const stat = (p) => fs.promises.stat(p).catch(() => null)

// The ways a link's target may be read: the path in it, and the line it points at. Most
// likely first: a line written after the path is taken as one before the whole is tried
// as a file's name, and a # that is no line the other way about.
export function spellings(target) {
  let t = String(target ?? '').trim().replace(/^<(.*)>$/, '$1').replace(/^(["'`])(.*)\1$/, '$2').trim()
  // An address of a file, as a browser or an editor writes one
  t = t.replace(/^file:\/\/(localhost)?(?=\/)/i, '').replace(/^(vscode|vscode-insiders|cursor|windsurf):\/\/file(?=\/)/i, '')
  // (/C:/x is C:/x)
  t = t.replace(/^\/([A-Za-z]:[\\/])/, '$1')
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|tel|data|javascript|about|blob):/i.test(t)) return []
  const out = []
  const add = (p, line, to) => {
    // (%20 for a space, as a link has it; a name with a % of its own is tried as it is too)
    let plain = p
    try {
      plain = decodeURIComponent(p)
    } catch {}
    for (const one of plain === p ? [p] : [plain, p]) {
      const where = one === '~' || /^~[\\/]/.test(one) ? path.join(os.homedir(), one.slice(1)) : one
      if (where && !out.some((o) => o.path === where && o.line === line)) out.push({ path: where, line, to })
    }
  }
  const n = (v) => (v ? Number(v) : undefined)
  const hash = /^(.*?)#L?(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(t)
  const colon = /^(.+?):(\d+)(?:(?::\d+)|(?:-(\d+)))?$/.exec(t)
  if (hash && hash[1]) add(hash[1], n(hash[2]), n(hash[3]))
  else if (colon) add(colon[1], n(colon[2]), n(colon[3]))
  add(t)
  // (a # that says something else: a heading in a document, say)
  if (!hash && t.indexOf('#') > 0) add(t.slice(0, t.indexOf('#')))
  return out
}

// The top of the project a folder is in: the nearest folder above it that git keeps, or the folder itself
async function topOf(cwd) {
  let dir = cwd
  for (let i = 0; i < 40; i++) {
    if (await stat(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return cwd
}

// The folders from one up to another above it, nearest first
function upTo(from, top) {
  const out = [from]
  let dir = from
  while (dir !== top && out.length < 40) {
    const up = path.dirname(dir)
    if (up === dir) break
    out.push((dir = up))
  }
  return out
}

const parts = (p) => String(p).split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..' && !/^[A-Za-z]:$/.test(s))

// How many of a path's last parts are the wanted ones, and how many of those to the letter
function likeness(file, wanted) {
  const have = parts(file)
  let same = 0
  let exact = 0
  while (same < wanted.length && same < have.length) {
    const a = have[have.length - 1 - same]
    const b = wanted[wanted.length - 1 - same]
    if (a.toLowerCase() !== b.toLowerCase()) break
    if (a === b) exact++
    same++
  }
  return { same, exact }
}

// Everything under a folder that has one of these names (each in small letters), nearest the top first, for as long as the search is given
async function named(top, names, until) {
  const hits = []
  const queue = [top]
  let seen = 0
  while (queue.length && seen < LOOK_MAX && Date.now() < until) {
    const dir = queue.shift()
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      seen++
      if (names.has(e.name.toLowerCase())) hits.push(path.join(dir, e.name))
      if (e.isDirectory() && !NOT_LOOKED_IN.has(e.name)) queue.push(path.join(dir, e.name))
    }
  }
  return hits
}

// The file a link means. `cwd` is the folder its session runs in; `near`, files the
// session has had to do with, which a link is more likely to mean than others of the
// same name. Answers { path, kind, size, mtime, line, to, exact, others }: `exact` where the
// file is where the link says, and `others` the files it could also have meant.
export async function find(target, { cwd = '', near = [] } = {}) {
  const tries = spellings(target)
  if (!tries.length) throw new FileError('that is not a link to a file')
  const home = typeof cwd === 'string' && path.isAbsolute(cwd) && (await stat(cwd))?.isDirectory() ? cwd : ''
  const top = home ? await topOf(home) : ''
  const found = async (p, t, more = {}) => {
    const s = await stat(p)
    return s && { path: p, kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size, mtime: Math.round(s.mtimeMs), line: t.line, to: t.to, exact: true, others: [], ...more }
  }
  // Where the link says: as written, from the session's folder, or from a folder above it in its project
  for (const t of tries) {
    const places = path.isAbsolute(t.path) ? [t.path] : home ? upTo(home, top).map((dir) => path.resolve(dir, t.path)) : []
    for (const p of places) {
      const hit = await found(p, t)
      if (hit) return hit
    }
  }
  // Nowhere it says: the files of the project, and the ones the session has had to do with, that end most like it
  const wants = tries
    .map((t) => {
      const wanted = parts(t.path)
      // (a/ and b/ before a path are a diff's, not folders)
      if (wanted.length > 1 && /^[ab]$/.test(wanted[0])) wanted.shift()
      return { t, wanted, name: (wanted[wanted.length - 1] ?? '').toLowerCase() }
    })
    .filter((w) => w.name)
  const inProject = top && wants.length ? await named(top, new Set(wants.map((w) => w.name)), Date.now() + LOOK_MS) : []
  const hints = (Array.isArray(near) ? near : []).filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, 200)
  for (const { t, wanted, name } of wants) {
    const is = (p) => path.basename(p).toLowerCase() === name
    const hinted = hints.filter(is)
    const ranked = [...new Set([...hinted, ...inProject.filter(is)])]
      .map((p) => ({ p, ...likeness(p, wanted), hinted: hinted.includes(p), depth: parts(p).length }))
      .sort((a, b) => b.same - a.same || b.exact - a.exact || b.hinted - a.hinted || a.depth - b.depth || (a.p < b.p ? -1 : 1))
    for (const [i, r] of ranked.entries()) {
      const hit = await found(r.p, t, { exact: false })
      if (!hit) continue
      hit.others = ranked.filter((o, j) => j !== i).slice(0, OTHERS_MAX).map((o) => o.p)
      return hit
    }
  }
  throw new FileError('no file by that name was found on this machine')
}

// What is in it: a file's bytes, or a folder's entries ({ name, kind, size }, folders first)
export async function read(found) {
  if (found.kind === 'dir') {
    const entries = await fs.promises.readdir(found.path, { withFileTypes: true }).catch(() => {
      throw new FileError('that folder could not be read')
    })
    const list = []
    for (const e of entries.slice(0, LIST_MAX)) {
      const s = e.isDirectory() ? null : await stat(path.join(found.path, e.name))
      list.push({ name: e.name, kind: e.isDirectory() || s?.isDirectory() ? 'dir' : 'file', size: s?.isFile() ? s.size : 0 })
    }
    list.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
    return { entries: list, more: Math.max(0, entries.length - LIST_MAX) }
  }
  if (found.kind !== 'file') throw new FileError('that is not a file that can be read')
  const mb = (n) => (n / 1024 / 1024).toFixed(1)
  const large = (n) => new FileError(`that file is too large to send: ${mb(n)} MB, and the most is ${mb(FILE_MAX)}`)
  if (found.size > FILE_MAX) throw large(found.size)
  const bytes = await fs.promises.readFile(found.path).catch(() => {
    throw new FileError('that file could not be read')
  })
  // (one that grew meanwhile)
  if (bytes.length > FILE_MAX) throw large(bytes.length)
  return { bytes }
}
