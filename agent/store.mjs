// The machine's index of its transcripts, in one SQLite file: which files have been
// read and how far, what each session is, and every message's text for full-text search.
// Uses Node's own SQLite (node:sqlite, with FTS5), so the agent needs nothing installed.

// node:sqlite still announces itself as experimental on every start
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => (String(warning?.message ?? warning).includes('SQLite') ? undefined : emitWarning.call(process, warning, ...rest))
const { DatabaseSync } = await import('node:sqlite')

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY, path TEXT UNIQUE, sid TEXT, side INTEGER, root TEXT, project TEXT,
        size INTEGER, mtime INTEGER, offset INTEGER, facts TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY, root TEXT, project TEXT, path TEXT, cwd TEXT, title TEXT, first_prompt TEXT,
        first_ts INTEGER, last_ts INTEGER, prompts INTEGER, messages INTEGER, version TEXT, branch TEXT,
        model TEXT, mode TEXT, entrypoint TEXT, size INTEGER);
      CREATE INDEX IF NOT EXISTS sessions_recent ON sessions (last_ts DESC);
      CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, file INTEGER, sid TEXT, uuid TEXT, ts INTEGER, role TEXT, side INTEGER);
      CREATE INDEX IF NOT EXISTS docs_file ON docs (file);
      CREATE INDEX IF NOT EXISTS docs_sid ON docs (sid, ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
    `)
    this.matched = new Map() // a search's sessions, for the searches that follow it down
    const q = (sql) => this.db.prepare(sql)
    this.sql = {
      file: q('SELECT * FROM files WHERE path = ?'),
      files: q('SELECT path, size, mtime, offset FROM files'),
      addFile: q('INSERT INTO files (path, sid, side, root, project, size, mtime, offset, facts) VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL)'),
      setFile: q('UPDATE files SET size = ?, mtime = ?, offset = ?, facts = ? WHERE id = ?'),
      delFile: q('DELETE FROM files WHERE id = ?'),
      docIds: q('SELECT id FROM docs WHERE file = ?'),
      delDocs: q('DELETE FROM docs WHERE file = ?'),
      delFts: q('DELETE FROM fts WHERE rowid = ?'),
      addDoc: q('INSERT INTO docs (file, sid, uuid, ts, role, side) VALUES (?, ?, ?, ?, ?, ?)'),
      addFts: q('INSERT INTO fts (rowid, text) VALUES (?, ?)'),
      setSession: q(`INSERT INTO sessions (sid, root, project, path, cwd, title, first_prompt, first_ts, last_ts, prompts, messages, version, branch, model, mode, entrypoint, size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (sid) DO UPDATE SET root = excluded.root, project = excluded.project, path = excluded.path, cwd = excluded.cwd, title = excluded.title,
          first_prompt = excluded.first_prompt, first_ts = excluded.first_ts, last_ts = excluded.last_ts, prompts = excluded.prompts, messages = excluded.messages,
          version = excluded.version, branch = excluded.branch, model = excluded.model, mode = excluded.mode, entrypoint = excluded.entrypoint, size = excluded.size`),
      delSession: q('DELETE FROM sessions WHERE path = ?'),
      session: q('SELECT * FROM sessions WHERE sid = ?'),
      count: q('SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM docs) AS docs'),
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ---- Files

  knownFiles() {
    return new Map(this.sql.files.all().map((f) => [f.path, f]))
  }

  file(path) {
    return this.sql.file.get(path)
  }

  addFile({ path, sid, side, root, project }) {
    this.sql.addFile.run(path, sid, side ? 1 : 0, root, project)
    return this.sql.file.get(path)
  }

  // Everything read from a file so far, forgotten: it was rewritten, or is gone
  clearFile(file) {
    for (const { id } of this.sql.docIds.all(file.id)) this.sql.delFts.run(id)
    this.sql.delDocs.run(file.id)
  }

  removeFile(file) {
    this.clearFile(file)
    this.sql.delFile.run(file.id)
    if (!file.side) this.sql.delSession.run(file.path)
  }

  addDocs(file, docs) {
    for (const d of docs) {
      const { lastInsertRowid } = this.sql.addDoc.run(file.id, file.sid, d.uuid, d.ts, d.role, file.side)
      this.sql.addFts.run(lastInsertRowid, d.text)
    }
  }

  saveFile(file, { size, mtime, offset, facts }) {
    this.sql.setFile.run(size, mtime, offset, JSON.stringify(facts), file.id)
    if (file.side) return
    const f = facts
    this.sql.setSession.run(file.sid, file.root, file.project, file.path, f.cwd, f.title, f.firstPrompt, f.firstTs, f.lastTs, f.prompts, f.messages, f.version, f.branch, f.model, f.mode, f.entrypoint, size)
  }

  // ---- Sessions

  session(sid) {
    return this.sql.session.get(sid)
  }

  // Newest first. `before` pages back by time; `q` narrows by title, first prompt or folder.
  sessions({ limit = 50, before = 0, q = '', cwd = '' } = {}) {
    const where = ['messages > 0']
    const args = []
    if (before) {
      where.push('last_ts < ?')
      args.push(before)
    }
    if (cwd) {
      where.push('cwd = ?')
      args.push(cwd)
    }
    for (const word of q.toLowerCase().split(/\s+/).filter(Boolean)) {
      where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(first_prompt) LIKE ? ESCAPE '\\' OR lower(cwd) LIKE ? ESCAPE '\\')")
      const like = '%' + word.replace(/[\\%_]/g, '\\$&') + '%'
      args.push(like, like, like)
    }
    return this.db.prepare(`SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY last_ts DESC LIMIT ?`).all(...args, Math.min(Math.max(1, limit), 500))
  }

  // The folders sessions have run in (a session's project), most recent first, with
  // how many sessions each has
  folders(limit = 500) {
    return this.db.prepare("SELECT cwd, MAX(last_ts) AS last_ts, COUNT(*) AS sessions FROM sessions WHERE cwd != '' AND messages > 0 GROUP BY cwd ORDER BY last_ts DESC LIMIT ?").all(limit)
  }

  // ---- Search

  // Words are all required, in any order; "a phrase" in quotes stays together; the
  // last word matches as a beginning, so a search works while it's being typed.
  search({ q, limit = 30, sid = '', since = 0, until = 0, roles = [], subagents = true, sort = 'recent' } = {}) {
    const match = ftsQuery(q)
    if (!match) return []
    const where = ['fts MATCH ?']
    const args = [match]
    if (sid) {
      where.push('d.sid = ?')
      args.push(sid)
    }
    if (since) {
      where.push('d.ts >= ?')
      args.push(since)
    }
    if (until) {
      where.push('d.ts <= ?')
      args.push(until)
    }
    if (roles.length) {
      where.push(`d.role IN (${roles.map(() => '?').join(', ')})`)
      args.push(...roles)
    }
    if (!subagents) where.push('d.side = 0')
    const order = sort === 'relevance' ? 'bm25(fts), d.ts DESC' : 'd.ts DESC'
    // \u0001 and \u0002 mark the match, for the page to draw
    const hits = this.db
      .prepare(`SELECT d.sid, d.file, d.uuid, d.ts, d.role, d.side, snippet(fts, 0, char(1), char(2), '…', 24) AS snippet
        FROM fts JOIN docs d ON d.id = fts.rowid WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...args, Math.min(Math.max(1, limit), 200) * 6)
    // Grouped by session, in the order their first hit came, a few hits each
    const groups = new Map()
    for (const h of hits) {
      let g = groups.get(h.sid)
      if (!g) {
        if (groups.size >= limit) continue
        groups.set(h.sid, (g = { sid: h.sid, hits: [], total: 0 }))
      }
      g.total++
      // A hit in a subagent's file names the file, so that conversation can be opened
      if (g.hits.length < 3) g.hits.push({ uuid: h.uuid, ts: h.ts, role: h.role, snippet: h.snippet, ...(h.side ? { subagent: h.file } : {}) })
    }
    return [...groups.values()].map((g) => ({ ...g, session: this.session(g.sid) ?? this.remnant(g.sid) }))
  }

  // ---- Search as a way down: the projects with matches, the sessions in one, the matches in one

  // Every session with a match: sid -> { hits, last, cwd }. Kept a short while, for the
  // searches that follow as someone opens their way down from it.
  matches(q, { subagents = true } = {}) {
    const match = ftsQuery(q)
    if (!match) return new Map()
    const key = match + (subagents ? '' : '|main')
    // What's been indexed since changes the answer
    const stamp = this.db.prepare('SELECT MAX(id) AS id FROM docs').get().id ?? 0
    const kept = this.matched.get(key)
    if (kept && kept.stamp === stamp && Date.now() - kept.at < 30_000) return kept.map
    const rows = this.db.prepare(`SELECT d.sid AS sid, COUNT(*) AS hits, MAX(d.ts) AS last FROM fts JOIN docs d ON d.id = fts.rowid WHERE fts MATCH ?${subagents ? '' : ' AND d.side = 0'} GROUP BY d.sid`).all(match)
    const map = new Map()
    for (const r of rows) map.set(r.sid, { hits: r.hits, last: r.last ?? 0, cwd: (this.sql.session.get(r.sid) ?? this.remnant(r.sid))?.cwd ?? '' })
    this.matched.delete(key)
    this.matched.set(key, { map, stamp, at: Date.now() })
    while (this.matched.size > 8) this.matched.delete(this.matched.keys().next().value)
    return map
  }

  // The folders whose sessions have matches, with how many sessions and matches each, the latest match first
  searchProjects({ q, subagents = true } = {}) {
    const projects = new Map()
    const matched = this.matches(q, { subagents })
    let hits = 0
    let last = 0
    for (const m of matched.values()) {
      let p = projects.get(m.cwd)
      if (!p) projects.set(m.cwd, (p = { cwd: m.cwd, sessions: 0, hits: 0, last: 0 }))
      p.sessions++
      p.hits += m.hits
      p.last = Math.max(p.last, m.last)
      hits += m.hits
      last = Math.max(last, m.last)
    }
    return { sessions: matched.size, hits, last, projects: [...projects.values()].sort((a, b) => b.last - a.last) }
  }

  // The sessions in one folder that have matches, the latest match first, a page at a time
  searchSessions({ q, cwd = '', limit = 30, offset = 0, subagents = true } = {}) {
    const all = [...this.matches(q, { subagents })].filter(([, m]) => m.cwd === cwd).sort((a, b) => b[1].last - a[1].last)
    const from = Math.max(0, Number(offset) || 0)
    const page = all.slice(from, from + Math.min(Math.max(1, Number(limit) || 30), 200))
    return { total: all.length, sessions: page.map(([sid, m]) => ({ sid, hits: m.hits, last: m.last, session: this.session(sid) ?? this.remnant(sid) })) }
  }

  // The matches in one session, the latest first, a page at a time
  searchHits({ q, sid, limit = 20, offset = 0, subagents = true } = {}) {
    const match = ftsQuery(q)
    if (!match || !sid) return { total: 0, hits: [] }
    const rows = this.db
      .prepare(`SELECT d.file, d.uuid, d.ts, d.role, d.side, snippet(fts, 0, char(1), char(2), '…', 24) AS snippet
        FROM fts JOIN docs d ON d.id = fts.rowid WHERE fts MATCH ? AND d.sid = ?${subagents ? '' : ' AND d.side = 0'} ORDER BY d.ts DESC, d.id DESC LIMIT ? OFFSET ?`)
      .all(match, sid, Math.min(Math.max(1, Number(limit) || 20), 200), Math.max(0, Number(offset) || 0))
    return {
      total: this.matches(q, { subagents }).get(sid)?.hits ?? rows.length,
      hits: rows.map((h) => ({ uuid: h.uuid, ts: h.ts, role: h.role, snippet: h.snippet, ...(h.side ? { subagent: h.file } : {}) })),
    }
  }

  // A session whose own file is gone, as far as its subagents' files tell
  remnant(sid) {
    const files = this.db.prepare('SELECT project, facts FROM files WHERE sid = ? AND side = 1').all(sid)
    if (!files.length) return null
    const facts = files.map((f) => JSON.parse(f.facts ?? '{}'))
    return {
      sid,
      gone: true,
      project: files[0].project,
      cwd: facts.find((f) => f.cwd)?.cwd ?? '',
      title: '',
      first_prompt: '',
      first_ts: Math.min(...facts.map((f) => f.firstTs || Infinity)),
      last_ts: Math.max(...facts.map((f) => f.lastTs || 0)),
      messages: 0,
    }
  }

  fileById(id) {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id)
  }

  stats() {
    return this.sql.count.get()
  }

  close() {
    this.db.close()
  }
}

// An FTS5 query from what someone typed: each word quoted (so punctuation in it is
// only text), all required
export function ftsQuery(text) {
  const terms = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  let last = null
  while ((m = re.exec(text ?? ''))) {
    const phrase = (m[1] ?? m[2]).replace(/"/g, ' ').trim()
    // Only what the tokenizer keeps can match: letters and digits
    if (!/[\p{L}\p{N}]/u.test(phrase)) continue
    last = { phrase, quoted: m[1] !== undefined, end: re.lastIndex }
    terms.push(last)
  }
  if (!terms.length) return ''
  return terms.map((t) => `"${t.phrase}"` + (t === last && !t.quoted && t.end === text.length ? '*' : '')).join(' AND ')
}
