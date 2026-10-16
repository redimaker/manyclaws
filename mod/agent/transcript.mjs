// Claude Code's transcripts: one .jsonl file per session under
// <config dir>/projects/<project>/, with its subagents' files in a folder beside it.
// A session that's running writes the same file as it goes, so reading the files
// covers live sessions and finished ones alike.
//
// This module reads them: the facts of a session (folder, title, times), the text in
// it worth searching, and its conversation as rows.
import fs from 'node:fs'

const CHUNK = 4 * 1024 * 1024

// A long text, cut the way the mod cuts one: the server reads the marker to estimate
// what was left out
export const cap = (text, max) => (text.length > max ? text.slice(0, max) + `… [${text.length - max} more]` : text)

// Calls fn(line, offset, length) for each whole line of the file from `from` on, and
// returns the offset after the last whole line. A line still being written is left
// for the next read. With `maxBytes`, stops at the first line end past that many bytes.
export function eachLine(file, from, fn, maxBytes = Infinity) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let pending = [] // chunks of a line that spans reads
    let pendingBytes = 0
    let pos = from
    let done = from
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos)
      if (n <= 0) break
      let start = 0
      for (;;) {
        const nl = buf.indexOf(10, start)
        if (nl < 0 || nl >= n) break
        const piece = buf.subarray(start, nl)
        const line = pending.length ? Buffer.concat([...pending, piece]) : piece
        const length = pendingBytes + piece.length
        if (length) fn(line.toString('utf8'), done, length)
        done += length + 1
        pending = []
        pendingBytes = 0
        start = nl + 1
        if (done - from >= maxBytes) return done
      }
      if (start < n) {
        pending.push(Buffer.from(buf.subarray(start, n)))
        pendingBytes += n - start
      }
      pos += n
    }
    return done
  } finally {
    fs.closeSync(fd)
  }
}

export function parse(line) {
  try {
    const row = JSON.parse(line)
    return row && typeof row === 'object' ? row : null
  } catch {
    return null
  }
}

const blocksText = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : b?.type === 'document' ? '[document]' : ''))
          .filter(Boolean)
          .join('\n')
      : ''

const hasToolResult = (content) => Array.isArray(content) && content.some((b) => b?.type === 'tool_result')

// What the app adds around a prompt before Claude reads it
const unwrap = (text) => text.replace(/<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>[\s\S]*?<\/\1>\s*/g, '').trim()

// A user row's own words: '' for one that only carries tool results, or that the app wrote
export function promptOf(row) {
  if (row.type !== 'user' || row.isMeta || row.isCompactSummary || !row.message) return ''
  if (hasToolResult(row.message.content)) return ''
  return blocksText(row.message.content)
}

// One line for what a tool call was given
export function inputSummary(input) {
  const i = input ?? {}
  const parts = [i.command, i.file_path ?? i.notebook_path ?? i.path, i.pattern, i.url, i.query, i.description, i.prompt, i.skill, i.subject].filter((v) => typeof v === 'string' && v)
  return parts.join(' — ')
}

// ---- Facts: what a session is, folded from its lines in order

export function newFacts() {
  return { cwd: '', title: '', firstPrompt: '', firstTs: 0, lastTs: 0, prompts: 0, messages: 0, version: '', branch: '', model: '', mode: '', entrypoint: '' }
}

export function foldFacts(facts, row) {
  const ts = row.timestamp ? Date.parse(row.timestamp) : 0
  if (ts) {
    if (!facts.firstTs) facts.firstTs = ts
    if (ts > facts.lastTs) facts.lastTs = ts
  }
  // Windows gives one folder as c:\git and as C:\git, by where the session was started
  if (row.cwd && !facts.cwd) facts.cwd = row.cwd.replace(/^[a-z](?=:[\\/])/, (drive) => drive.toUpperCase())
  if (row.version) facts.version = row.version
  if (row.gitBranch) facts.branch = row.gitBranch
  if (row.entrypoint) facts.entrypoint = row.entrypoint
  switch (row.type) {
    case 'ai-title':
      if (row.aiTitle && !facts.customTitle) facts.title = String(row.aiTitle)
      break
    case 'custom-title':
      if (row.customTitle) {
        facts.title = String(row.customTitle)
        facts.customTitle = true
      }
      break
    case 'permission-mode':
      facts.mode = String(row.permissionMode ?? '')
      break
    case 'user': {
      const prompt = unwrap(promptOf(row))
      if (prompt && !/^<(command-name|local-command|bash-)/.test(prompt)) {
        facts.prompts++
        if (!facts.firstPrompt) facts.firstPrompt = prompt.slice(0, 200)
      }
      facts.messages++
      break
    }
    case 'assistant':
      if (row.message?.model && row.message.model !== '<synthetic>') facts.model = row.message.model
      facts.messages++
      break
  }
}

// ---- Search: the text of one line worth finding again, as { uuid, ts, role, text }

const MAX_TEXT = 20_000
const MAX_INPUT = 4_000
const MAX_RESULT = 2_000

// `results: false` leaves out what tools returned: in subagents' files that is most
// of the bytes and the least worth finding
export function searchable(row, { results = true } = {}) {
  if ((row.type !== 'user' && row.type !== 'assistant') || !row.message || row.isMeta || row.isCompactSummary) return []
  const ts = row.timestamp ? Date.parse(row.timestamp) : 0
  const docs = []
  const add = (role, text) => {
    const clean = text.trim()
    if (clean) docs.push({ uuid: row.uuid ?? '', ts, role, text: clean })
  }
  const content = row.message.content
  if (row.type === 'user') {
    if (!hasToolResult(content)) add('user', unwrap(blocksText(content)).slice(0, MAX_TEXT))
    else if (results) for (const b of content) if (b?.type === 'tool_result') add('result', blocksText(b.content).slice(0, MAX_RESULT))
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') add('assistant', String(b.text ?? '').slice(0, MAX_TEXT))
      else if (b?.type === 'tool_use') add('tool', (b.name + ' ' + inputSummary(b.input)).slice(0, MAX_INPUT))
    }
  }
  return docs
}

// ---- The conversation: a session's file kept in step with what's been written, and
// read back as rows

// Light enough to keep in memory for a 200 MB file: where each line is, and what it
// hangs from. Lines are read again when their rows are asked for.
export class Transcript {
  // `side`: a subagent's own file, whose lines are all marked as a side conversation
  constructor(file, { side = false } = {}) {
    this.file = file
    this.side = side
    this.offset = 0
    this.nodes = new Map() // uuid -> { parent, type, at, length }
    this.results = new Map() // tool_use_id -> { at, length } of the line carrying its result
    this.leaf = null
    this.chainFor = null
    this.chainList = []
  }

  // Reads what's been appended. A file that shrank was rewritten: start again.
  sync() {
    const size = fs.statSync(this.file).size
    if (size < this.offset) {
      this.offset = 0
      this.nodes.clear()
      this.results.clear()
      this.leaf = null
    }
    if (size === this.offset) return this
    this.offset = eachLine(this.file, this.offset, (line, at, length) => {
      const row = parse(line)
      if (!row?.uuid || (row.isSidechain && !this.side)) return
      this.nodes.set(row.uuid, { parent: row.parentUuid ?? row.logicalParentUuid ?? null, type: row.type, at, length })
      this.leaf = row.uuid
      const content = row.message?.content
      if (row.type === 'user' && Array.isArray(content)) for (const b of content) if (b?.type === 'tool_result' && b.tool_use_id) this.results.set(b.tool_use_id, { at, length })
    })
    return this
  }

  // The lines of the conversation as it stands: back from the last line written to the
  // first, so turns that were rewound past are left out, as they are on a resume
  chain() {
    if (this.chainFor === this.leaf) return this.chainList
    const list = []
    const seen = new Set()
    for (let id = this.leaf; id && !seen.has(id); id = this.nodes.get(id)?.parent) {
      const node = this.nodes.get(id)
      if (!node) break
      seen.add(id)
      if (node.type === 'user' || node.type === 'assistant' || node.type === 'system') list.push(id)
    }
    this.chainFor = this.leaf
    this.chainList = list.reverse()
    return this.chainList
  }

  readAt({ at, length }) {
    const fd = fs.openSync(this.file, 'r')
    try {
      const buf = Buffer.allocUnsafe(length)
      fs.readSync(fd, buf, 0, length, at)
      return parse(buf.toString('utf8'))
    } finally {
      fs.closeSync(fd)
    }
  }

  // Rows [from, to) of the conversation, in the shape of the mod's session.messages:
  // { uuid, ts, role, text, toolUses: [{ tool_use_id, tool, input, result, text, isError }] }
  // plus { role: 'notice' } for what isn't said by either side. `max` caps each field.
  rows(from, to, max = 8000) {
    const chain = this.chain()
    const out = []
    for (const id of chain.slice(Math.max(0, from), to)) {
      const row = this.readAt(this.nodes.get(id))
      if (!row) continue
      const ts = row.timestamp ? Date.parse(row.timestamp) : 0
      if (row.type === 'system') {
        if (row.subtype === 'compact_boundary') out.push({ uuid: id, ts, role: 'notice', text: 'Conversation compacted' })
        continue
      }
      if (row.isMeta || !row.message) continue
      if (row.isCompactSummary) continue
      const content = row.message.content
      if (row.type === 'user') {
        const text = hasToolResult(content) ? '' : blocksText(content)
        if (text.trim()) out.push({ uuid: id, ts, role: 'user', text: cap(text, max), origin: row.origin?.kind })
        continue
      }
      if (!Array.isArray(content)) continue
      for (const b of content) {
        if (b?.type === 'text' && String(b.text ?? '').trim()) out.push({ uuid: id, ts, role: 'assistant', text: cap(String(b.text), max), toolUses: [] })
        else if (b?.type === 'tool_use') out.push({ uuid: id, ts, role: 'assistant', text: '', toolUses: [this.toolUse(b, max)] })
      }
    }
    return out
  }

  toolUse(block, max) {
    const use = { tool_use_id: block.id, tool: block.name, input: capDeep(block.input, 2000) }
    const where = this.results.get(block.id)
    const row = where && this.readAt(where)
    const result = row?.message?.content?.find?.((b) => b?.type === 'tool_result' && b.tool_use_id === block.id)
    if (result) {
      use.text = cap(blocksText(result.content), max)
      use.isError = !!result.is_error
      // The line the result is on: a search hit in a tool's output names that line
      use.resultUuid = row.uuid
      // The tool's own record of the call, where the transcript kept one
      if (row.toolUseResult !== undefined && !use.isError) use.result = capDeep(row.toolUseResult, max)
    }
    return use
  }
}

function capDeep(value, max, depth = 0) {
  if (typeof value === 'string') return cap(value, max)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 6) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => capDeep(v, max, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value).slice(0, 100)) out[k] = capDeep(v, max, depth + 1)
  return out
}
