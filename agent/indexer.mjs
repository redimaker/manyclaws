// Keeps the index in step with the transcripts on disk: finds the files, reads what's
// new in each, a slice at a time so the agent stays responsive while a first index of
// gigabytes runs.
import fs from 'node:fs'
import path from 'node:path'
import { eachLine, parse, searchable, newFacts, foldFacts } from './transcript.mjs'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SLICE = 8 * 1024 * 1024 // bytes of one file read per step

const entries = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// Every transcript under a Claude Code config dir. A session's own file is
// projects/<project>/<session id>.jsonl; its subagents' are anywhere under
// projects/<project>/<session id>/.
// `only` and `skip` are patterns on the project folder's name, for a machine whose
// owner wants part of it left out.
export function listTranscripts(root, { only = [], skip = [] } = {}) {
  const out = []
  const wanted = (name) => (!only.length || only.some((p) => new RegExp(p).test(name))) && !skip.some((p) => new RegExp(p).test(name))
  const add = (file, sid, side, project) => {
    try {
      const st = fs.statSync(file)
      out.push({ path: file, sid, side, root, project, size: st.size, mtime: Math.floor(st.mtimeMs) })
    } catch {}
  }
  const walk = (dir, sid, project) => {
    for (const e of entries(dir)) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, sid, project)
      else if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') add(full, sid, true, project)
    }
  }
  for (const project of entries(path.join(root, 'projects'))) {
    if (!project.isDirectory() || !wanted(project.name)) continue
    const dir = path.join(root, 'projects', project.name)
    for (const e of entries(dir)) {
      if (e.isFile() && e.name.endsWith('.jsonl') && SESSION_ID.test(e.name.slice(0, -6))) add(path.join(dir, e.name), e.name.slice(0, -6), false, project.name)
      else if (e.isDirectory() && SESSION_ID.test(e.name)) walk(path.join(dir, e.name), e.name, project.name)
    }
  }
  return out
}

export class Indexer {
  constructor(store, roots, filter = {}) {
    this.store = store
    this.roots = roots
    this.filter = filter
    this.pending = []
    this.bytesLeft = 0
  }

  // Compares the disk with the index, and queues what has changed, newest first
  scan() {
    const known = this.store.knownFiles()
    const pending = []
    for (const root of this.roots) {
      for (const f of listTranscripts(root, this.filter)) {
        const k = known.get(f.path)
        known.delete(f.path)
        if (!k || k.size !== f.size || k.mtime !== f.mtime) pending.push(f)
      }
    }
    // What the index has that the disk no longer does
    for (const gone of known.keys()) {
      const file = this.store.file(gone)
      if (file) this.store.transaction(() => this.store.removeFile(file))
    }
    pending.sort((a, b) => b.mtime - a.mtime)
    this.pending = pending
    this.bytesLeft = pending.reduce((n, f) => n + Math.max(0, f.size - (this.store.file(f.path)?.offset ?? 0)), 0)
    return pending.length
  }

  // Reads one slice of the next file. Returns how many files are still waiting.
  step() {
    const f = this.pending[0]
    if (!f) return 0
    let file = this.store.file(f.path) ?? this.store.addFile(f)
    let facts = file.facts ? JSON.parse(file.facts) : newFacts()
    let size
    try {
      size = fs.statSync(f.path).size
    } catch {
      this.pending.shift()
      return this.pending.length
    }
    this.store.transaction(() => {
      // Smaller than what was read: the file was rewritten, so it's read again from the top
      if (size < file.offset) {
        this.store.clearFile(file)
        file = { ...file, offset: 0 }
        facts = newFacts()
      }
      const docs = []
      const offset = eachLine(
        f.path,
        file.offset,
        (line) => {
          const row = parse(line)
          if (!row) return
          foldFacts(facts, row)
          for (const d of searchable(row, { results: !file.side })) docs.push(d)
        },
        SLICE,
      )
      this.store.addDocs(file, docs)
      this.bytesLeft -= offset - file.offset
      const caughtUp = offset >= size || offset === file.offset
      // Until the whole file is read its recorded size stays behind, so a restart picks it up again
      this.store.saveFile(file, { size: caughtUp ? f.size : -1, mtime: f.mtime, offset, facts })
      if (caughtUp) this.pending.shift()
    })
    return this.pending.length
  }

  // Everything waiting, in one go: for the command line and for tests
  run(onProgress) {
    this.scan()
    while (this.step()) onProgress?.(this)
    onProgress?.(this)
  }
}
