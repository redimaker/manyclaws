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
//
// A file is found, and read, only inside the folders this machine opens files from
// (`within`): the ones its owner lets sessions be started in, or the ones named for this
// in its agent.json. Where it really is decides, links followed: a link inside those
// folders to a file outside them opens nothing. So a phone or a browser of the account's
// reads the projects it works in and not the rest of the machine.
//
// A file is written under the same rule (`place`, `write`): one the account's own device
// sends is put in its session's folder, or among that folder's uploads, under a name no
// file there has; and one that was opened here and changed there is written back where
// it was read from, while it is still the file that was read. Nothing is written outside
// the folders this machine takes files into, nor among this agent's own files, whatever
// folders were named.
import crypto from 'node:crypto'
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

// The folders a machine opens files from, as they really are on disk: null where it opens none
export function fileRoots(folders) {
  if (!Array.isArray(folders)) return null
  const roots = []
  for (const f of folders) {
    try {
      roots.push(fs.realpathSync(path.resolve(String(f).replace(/^~(?=$|[\\/])/, os.homedir()))))
    } catch {}
  }
  return roots
}
// Where a path really is, if that is inside one of those folders: null otherwise
const sameCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
async function inside(p, within) {
  const real = await fs.promises.realpath(p).catch(() => null)
  return real && within.some((root) => sameCase(real) === sameCase(root) || sameCase(real).startsWith(sameCase(root.endsWith(path.sep) ? root : root + path.sep))) ? real : null
}
export const OUTSIDE = 'that file is outside the folders this machine opens files from: the ones sessions may be started in, or the ones its agent.json names ("files")'

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
// same name; `within`, the folders this machine opens files from, as they really are
// (fileRoots). Answers { path, real, kind, size, mtime, line, to, exact, others }: `exact`
// where the file is where the link says, `real` where it really is (which is what is
// read), and `others` the files it could also have meant.
export async function find(target, { cwd = '', near = [], within = [] } = {}) {
  const tries = spellings(target)
  if (!tries.length) throw new FileError('that is not a link to a file')
  const home = typeof cwd === 'string' && path.isAbsolute(cwd) && (await stat(cwd))?.isDirectory() ? cwd : ''
  const top = home ? await topOf(home) : ''
  let outside = false // there is such a file, and it is not one this machine opens
  const found = async (p, t, more = {}) => {
    const s = await stat(p)
    if (!s) return null
    const real = await inside(p, within)
    if (!real) return void (outside = true)
    return { path: p, real, kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size, mtime: Math.round(s.mtimeMs), line: t.line, to: t.to, exact: true, others: [], ...more }
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
  // (a project that is not inside those folders is not looked through: no file of it would be opened)
  const inProject = top && wants.length && (await inside(top, within)) ? await named(top, new Set(wants.map((w) => w.name)), Date.now() + LOOK_MS) : []
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
      // (and of the others it could have meant, the ones that would be opened)
      const others = []
      for (const o of ranked.filter((_, j) => j !== i)) if (others.length < OTHERS_MAX && (await inside(o.p, within))) others.push(o.p)
      hit.others = others
      return hit
    }
  }
  throw new FileError(outside ? OUTSIDE : 'no file by that name was found on this machine')
}

// What is in it: a file's bytes, or a folder's entries ({ name, kind, size }, folders first)
export async function read(found) {
  // (read where it really is, as it was found to be: not by a name that may lead elsewhere by now)
  const where = found.real ?? found.path
  if (found.kind === 'dir') {
    const entries = await fs.promises.readdir(where, { withFileTypes: true }).catch(() => {
      throw new FileError('that folder could not be read')
    })
    const list = []
    for (const e of entries.slice(0, LIST_MAX)) {
      const s = e.isDirectory() ? null : await stat(path.join(where, e.name))
      list.push({ name: e.name, kind: e.isDirectory() || s?.isDirectory() ? 'dir' : 'file', size: s?.isFile() ? s.size : 0 })
    }
    list.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
    return { entries: list, more: Math.max(0, entries.length - LIST_MAX) }
  }
  if (found.kind !== 'file') throw new FileError('that is not a file that can be read')
  const mb = (n) => (n / 1024 / 1024).toFixed(1)
  const large = (n) => new FileError(`that file is too large to send: ${mb(n)} MB, and the most is ${mb(FILE_MAX)}`)
  if (found.size > FILE_MAX) throw large(found.size)
  const bytes = await fs.promises.readFile(where).catch(() => {
    throw new FileError('that file could not be read')
  })
  // (one that grew meanwhile)
  if (bytes.length > FILE_MAX) throw large(bytes.length)
  return { bytes }
}

// ---- A file written here: one a device of the account's sends to a session's folder,
// or one that was opened from here and is written back changed.

// Where a file sent with a reply is kept, under its session's folder: a folder of its own,
// which says of itself that git is to keep none of it, so that what was sent for Claude
// to read is in no commit by being swept up with the rest
export const UPLOADS = '.manyclaws-uploads'
const NAME_MAX = 200 // the longest name a file is given, in bytes
const NAMES_TRIED = 500 // how many names are tried for a file whose own is taken

// The SHA-256 of some bytes, as an order says it (base64url)
export const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('base64url')

// The name a file is given here, from the one it was sent with: the last part of it, with
// nothing that leads to another folder
export function plainName(name) {
  const base = String(name ?? '').slice(0, 2000).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!base || base === '.' || base === '..') throw new FileError('that is not a name a file can have')
  // (one too long keeps its ending, which says what kind of file it is)
  const dot = base.lastIndexOf('.')
  let [stem, ending] = dot > 0 && base.length - dot <= 20 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
  while (Buffer.byteLength(stem + ending) > NAME_MAX) stem = [...stem].slice(0, -1).join('')
  return stem + ending
}
// The names tried for it where its own is taken: notes.txt, notes (2).txt, notes (3).txt
function* otherNames(name) {
  yield name
  const dot = name.lastIndexOf('.')
  const [stem, ending] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; n < NAMES_TRIED + 2; n++) yield `${stem} (${n})${ending}`
}

export const CHANGED = 'that file has changed on this machine since it was opened'
export const NOT_WRITTEN = 'that is outside the folders this machine takes files into: the ones sessions may be started in, and the ones it opens files from where its agent.json says so ("upload": true)'
const OWN = "that is among the ManyClaws agent's own files on this machine, which are not written from anywhere else"

// Where a file is to be written, and whether that is somewhere this machine writes.
// `to` is the order's: `{ path }` for a file that was opened from here, which is written
// back where it really is and only while it is still there; or `{ name, into }` for a
// new one, in its session's folder (`cwd`) or among that folder's uploads. `within`, the
// folders this machine opens files from (fileRoots); `own`, the agent's own folder,
// inside which nothing is written. Answers { path, real, existing } (`existing`: its
// stat, for one written back), or { dir, name } for a new one, whose name is settled as
// it is made.
export async function place(to, { cwd = '', within = [], own = '' } = {}) {
  const mine = own ? await fs.promises.realpath(own).catch(() => path.resolve(own)) : ''
  const notOwn = (real) => {
    if (mine && (sameCase(real) === sameCase(mine) || sameCase(real).startsWith(sameCase(mine + path.sep)))) throw new FileError(OWN)
    return real
  }
  if (typeof to?.path === 'string' && to.path) {
    if (!path.isAbsolute(to.path)) throw new FileError('which file that is was not said whole')
    const s = await stat(to.path)
    if (!s) throw new FileError('that file is no longer there: it was moved or deleted on this machine since it was opened')
    if (!s.isFile()) throw new FileError('that is not a file that can be written')
    const real = await inside(to.path, within)
    if (!real) throw new FileError(NOT_WRITTEN)
    // (one its owner has marked not to be written is not written from elsewhere either)
    if (!(s.mode & 0o200)) throw new FileError('that file is marked read-only on this machine')
    return { path: to.path, real: notOwn(real), existing: s }
  }
  const name = plainName(to?.name)
  if (!['folder', 'uploads'].includes(to?.into)) throw new FileError('where that file is to go was not said')
  const home = typeof cwd === 'string' && path.isAbsolute(cwd) && (await stat(cwd))?.isDirectory() ? await inside(cwd, within) : null
  if (!home) throw new FileError(typeof cwd === 'string' && cwd && (await stat(cwd)) ? NOT_WRITTEN : "the session's folder was not found on this machine")
  notOwn(home)
  if (to.into === 'folder') return { dir: home, name }
  const dir = path.join(home, UPLOADS)
  await fs.promises.mkdir(dir).catch((err) => {
    if (err.code !== 'EEXIST') throw new FileError('the folder for what is sent to this session could not be made')
  })
  // (a link by that name to somewhere else is not followed out of those folders)
  const real = await inside(dir, within)
  if (!real || !(await stat(real))?.isDirectory()) throw new FileError(NOT_WRITTEN)
  notOwn(real)
  await fs.promises.writeFile(path.join(real, '.gitignore'), '# What was sent to this session from the ManyClaws page. Git keeps none of it.\n*\n', { flag: 'wx' }).catch(() => {})
  return { dir: real, name }
}

// Writes it. A new file is made under a name nothing there has, and never in another's
// place; one that could not be written whole is not left there in part. One written back
// takes the place of the file it was read from, whole or not at all, and keeps who may
// read and run it. It is written only over the file that was read: `was` is the SHA-256
// of that, and where the file is no longer that, it has changed here meanwhile and is
// left as it is. Answers { path, name, size, mtime, made }.
export async function write(where, bytes, { was } = {}) {
  if (bytes.length > FILE_MAX) throw new FileError(`that file is too large to take: the most is ${(FILE_MAX / 1024 / 1024).toFixed(1)} MB`)
  const done = async (p, made) => ({ path: p, name: path.basename(p), size: bytes.length, mtime: Math.round((await stat(p))?.mtimeMs ?? Date.now()), made })
  if (where.dir) {
    for (const name of otherNames(where.name)) {
      const p = path.join(where.dir, name)
      let made = null
      try {
        made = await fs.promises.open(p, 'wx')
      } catch (err) {
        if (err.code === 'EEXIST') continue
        throw new FileError('that file could not be written')
      }
      try {
        await made.writeFile(bytes)
        await made.close()
      } catch {
        // (it is this call's own, made a moment ago: nobody else's file is taken away)
        await made.close().catch(() => {})
        await fs.promises.rm(p, { force: true }).catch(() => {})
        throw new FileError('that file could not be written')
      }
      return done(p, true)
    }
    throw new FileError('there are too many files by that name there already')
  }
  if (typeof was !== 'string' || !was) throw new FileError('which file that takes the place of was not said')
  // (one longer than any file that is read is not the one that was read)
  const now = where.existing.size > FILE_MAX ? null : await fs.promises.readFile(where.real).catch(() => null)
  if (!now || digest(now) !== was) throw new FileError(CHANGED)
  const beside = path.join(path.dirname(where.real), `.${path.basename(where.real)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.promises.writeFile(beside, bytes, { flag: 'wx', mode: where.existing.mode & 0o777 })
    // (as it was allowed to be read and run, whatever this agent's own default for a new file is)
    await fs.promises.chmod(beside, where.existing.mode & 0o777)
    await fs.promises.rename(beside, where.real)
  } catch {
    await fs.promises.rm(beside, { force: true }).catch(() => {})
    throw new FileError('that file could not be written')
  }
  return done(where.path, false)
}
