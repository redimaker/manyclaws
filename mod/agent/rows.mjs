// A session's chat as rows, made from what Claude Code reports: a prompt, a reply, a tool
// call and what it came back with, a command's output, a notice. They are made on the
// session's own computer, by its plugin as things happen and by the machine's agent of a
// transcript it reads back, and sealed there before they leave it (seal.js): the server
// never reads one. One file, in two places that must stay the same: mod/hooks/rows.js
// (the plugin) and agent/rows.mjs (the machine agent).
//
// A row: { role: 'user' | 'assistant' | 'tool' | 'result' | 'notice' | 'output', text,
// and as the role has them: uuid, origin, tool, toolUseId, detail, desc, more, approx,
// error, diff, mid, hist, ts }

// What the app wraps around a prompt before Claude reads it
export function cleanPrompt(text) {
  return text.replace(/<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder)>[\s\S]*?<\/\1>\s*/g, '').trim()
}

// Word from the app that something it ran in the background has ended. Claude reads it as
// a user turn, written as <task-notification> with the task's ids inside; a person reads
// one line of it: its summary. Gives { notices, rest }: a line for each, and whatever
// else the text had that a person wrote (not the app's own preface to its notes).
export function taskNotices(text) {
  const notices = []
  let rest = text.replace(/<task-notification>([\s\S]*?)<\/task-notification>\s*/g, (all, body) => {
    const part = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1].trim() ?? ''
    notices.push(part('summary') || ['Background task', part('task-id'), part('status')].filter(Boolean).join(' '))
    return ''
  })
  if (notices.length) rest = rest.replace(/^\s*\[SYSTEM NOTIFICATION[^\]]*\][\s\S]*$/, '')
  return { notices, rest: rest.trim() }
}

// A prompt sent while Claude is at work reaches it inside the turn, in a note the app
// writes around it ("The user sent a new message while you were working: …"), not as a
// turn of its own. Gives { prompts, rest }: what was typed, and whatever else the text had.
export function midTurnPrompts(text) {
  const prompts = []
  const rest = text.replace(/<system-reminder>\s*The user sent a new message while you were working:\n([\s\S]*?)<\/system-reminder>\s*/g, (all, body) => {
    // (after the prompt, the app's word to Claude on how to take it)
    const typed = body.replace(/\n\nThis is how Claude Code surfaces messages[\s\S]*$/, '').trim()
    if (typed) prompts.push(typed)
    return ''
  })
  return { prompts, rest: rest.trim() }
}

// What reached Claude inside a turn, as chat rows: a prompt sent meanwhile is the user's
// own, a background task's word is its line, and anything else is a notice as it came
export function deliveryRows(text) {
  const { prompts, rest } = midTurnPrompts(text)
  // (the app wraps its own notes too)
  const { notices, rest: other } = taskNotices(rest.replace(/^<system-reminder>\s*/, '').replace(/\s*<\/system-reminder>$/, ''))
  if (!prompts.length && !notices.length) return rest ? [{ role: 'notice', text: rest }] : []
  return [...prompts.map((p) => ({ role: 'user', text: p, mid: true })), ...notices.map((n) => ({ role: 'notice', text: n })), ...(other ? [{ role: 'notice', text: other }] : [])]
}

// A user row of a transcript, the way a chat shows it: a slash command by its name,
// a local command's output as output, a prompt without its wrapping
export function promptRows(text) {
  // eslint-disable-next-line no-control-regex
  const plain = (out) => out.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\n+|\s+$/g, '')
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
    return [{ role: 'user', text: (command[1] + ' ' + (args ? args[1] : '')).trim() }]
  }
  const shell = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)
  if (shell) return [{ role: 'user', text: '! ' + shell[1].trim() }]
  const out = [...text.matchAll(/<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>([\s\S]*?)<\/\1>/g)].map((m) => plain(m[2])).filter(Boolean)
  if (out.length) return [{ role: 'output', text: out.join('\n') }]
  if (/<(local-command-caveat|local-command-stdout|bash-stdout)>/.test(text)) return []
  const { notices, rest } = taskNotices(cleanPrompt(text))
  return [...notices.map((n) => ({ role: 'notice', text: n })), ...(rest ? [{ role: 'user', text: rest }] : [])]
}

// A history as chat rows. `list` is what the mod sends when a session starts
// (`toolUses` as { name, input }) or the fuller rows of its session.messages call,
// where each tool use has its id and, once answered, what came back.
export function historyRows(list) {
  const rows = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    // Where a row sits in its transcript, when the reader knows (the machine agent does)
    const at = { uuid: typeof m.uuid === 'string' ? m.uuid : undefined, ts: Number(m.ts) || undefined }
    if (m.role === 'notice') {
      if (m.text) rows.push({ role: 'notice', text: m.text, ...at })
      continue
    }
    if (m.role !== 'assistant') {
      rows.push(...promptRows(String(m.text ?? '')).map((r) => ({ ...r, ...at, origin: r.role === 'user' && m.origin !== 'human' ? m.origin : undefined })))
      continue
    }
    if (String(m.text ?? '').trim()) rows.push({ role: 'assistant', text: m.text, ...at })
    for (const t of Array.isArray(m.toolUses) ? m.toolUses : []) {
      const id = typeof t.tool_use_id === 'string' ? t.tool_use_id : ''
      rows.push({ role: 'tool', tool: t.tool ?? t.name, text: summarizeInput(t.input), toolUseId: id, ...toolDetail(t.input), ...at })
      if (!id || (t.result === undefined && typeof t.text !== 'string')) continue
      let outcome = summarizeResult({ result: t.result ?? t.text, isError: t.isError })
      // A transcript can store a tool's record without its bulk; the text Claude read has it
      if ((!outcome.text || outcome.text === '(No output)') && t.text) outcome = summarizeResult({ result: t.text, isError: t.isError })
      rows.push({ role: 'result', toolUseId: id, ...outcome, ts: at.ts, ...(typeof t.resultUuid === 'string' ? { uuid: t.resultUuid } : {}) })
    }
  }
  return rows.map((r) => ({ ...r, hist: true }))
}

// The one line of a tool call's input worth showing
export function summarizeInput(input) {
  const i = input ?? {}
  // (a question Claude asks reads as the question)
  const line = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.skill ?? i.plan ?? i.questions?.[0]?.question ?? ''
  return String(line).split('\n')[0].slice(0, 300)
}

// More of a tool call than its one line: what Claude said it's for, and the whole command
export function toolDetail(input) {
  const i = input ?? {}
  if (typeof i.command !== 'string') return {}
  return { detail: i.command.slice(0, 2000), desc: typeof i.description === 'string' ? i.description.slice(0, 200) : '' }
}

const MAX_RESULT_LINES = 40
const MAX_RESULT_CHARS = 2400

// What a tool call came back with, as the lines a chat shows under it. `more` counts
// the lines left out (`approx` when that's an estimate), and `diff` says the lines
// after the first are a patch.
export function summarizeResult(ev) {
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
  const lineCount = (text) => (text ? text.replace(/\n$/, '').split('\n').length : 0)
  const blocks = (list) => list.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type ? `[${b.type}]` : '')).filter(Boolean).join('\n')
  const r = ev.result
  let text = ''
  let diff = false
  if (typeof ev.deny === 'string') text = 'Denied: ' + ev.deny
  else if (typeof r === 'string') text = r
  else if (Array.isArray(r)) text = blocks(r)
  else if (r && typeof r === 'object') {
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      text = [r.stdout, r.stderr].filter(Boolean).join('\n') || (r.backgroundTaskId ? 'Running in the background' : r.interrupted ? 'Interrupted' : '(No output)')
    } else if (Array.isArray(r.structuredPatch) && r.filePath) {
      // Write and Edit
      const name = String(r.filePath).split(/[\\/]/).pop()
      const patch = r.structuredPatch.flatMap((hunk) => (Array.isArray(hunk?.lines) ? hunk.lines : []))
      const added = patch.filter((l) => l.startsWith('+')).length
      const removed = patch.filter((l) => l.startsWith('-')).length
      text = patch.length ? `Updated ${name} with ${plural(added, 'addition')} and ${plural(removed, 'removal')}` : `Wrote ${plural(lineCount(String(r.content ?? '')), 'line')} to ${name}`
      if (patch.length) {
        text += '\n' + patch.join('\n')
        diff = true
      }
    } else if (r.file && typeof r.file === 'object') {
      const n = typeof r.file.numLines === 'number' ? r.file.numLines : typeof r.file.content === 'string' ? lineCount(r.file.content) : null
      text = n === null ? 'Read ' + (r.type ?? 'file') : 'Read ' + plural(n, 'line')
    } else if (Array.isArray(r.filenames)) {
      // Grep and Glob
      text = r.mode === 'content' && typeof r.numLines === 'number' ? 'Found ' + plural(r.numLines, 'line') : 'Found ' + plural(r.numFiles ?? r.filenames.length, 'file')
      const listed = typeof r.content === 'string' && r.content ? r.content : r.filenames.join('\n')
      if (listed) text += '\n' + listed
    } else if (typeof r.bytes === 'number' && r.code !== undefined) {
      text = `Received ${r.bytes < 1024 ? r.bytes + ' bytes' : (r.bytes / 1024).toFixed(1) + 'KB'} (${[r.code, r.codeText].filter(Boolean).join(' ')})`
    } else if (typeof r.totalToolUseCount === 'number') {
      const parts = [plural(r.totalToolUseCount, 'tool use')]
      if (typeof r.totalTokens === 'number') parts.push((r.totalTokens / 1000).toFixed(1) + 'k tokens')
      if (typeof r.totalDurationMs === 'number') parts.push(Math.round(r.totalDurationMs / 1000) + 's')
      text = `Done (${parts.join(' · ')})`
    } else if (Array.isArray(r.content)) text = blocks(r.content)
    else if (typeof r.result === 'string') text = r.result
    else if (typeof r.content === 'string') text = r.content
    else if (typeof r.message === 'string') text = r.message
  }
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '')
  // The mod cuts a long field and says how many characters it left out
  const cut = /… \[(\d+) more\]$/.exec(text)
  if (cut) text = text.slice(0, cut.index)
  const lines = text.split('\n')
  // Whole lines, within both limits; the first line always, shortened if it must be
  let count = 1
  for (let size = lines[0].length; count < Math.min(lines.length, MAX_RESULT_LINES) && size + lines[count].length < MAX_RESULT_CHARS; count++) size += lines[count].length + 1
  const kept = lines.slice(0, count)
  if (kept[0].length > MAX_RESULT_CHARS) kept[0] = kept[0].slice(0, MAX_RESULT_CHARS) + '…'
  // Lines the mod cut can only be estimated, from how long the others were
  const unseen = cut ? Math.round(Number(cut[1]) / Math.max(1, text.length / lines.length)) : 0
  return { text: kept.join('\n'), more: lines.length - count + unseen, approx: unseen > 0, error: !!(ev.isError || ev.denied || typeof ev.deny === 'string'), diff }
}

// The rows a `message` event makes: a prompt (with a background task's word as its own
// line), a reply's text and tool calls, a command and its output, a notice. None for a
// subagent's or the app's own messages.
export function messageRows(ev) {
  if (ev.agentId || ev.isMeta || !Array.isArray(ev.blocks)) return []
  const origin = ev.origin?.kind
  const text = ev.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  const rows = []
  switch (ev.door) {
    case 'prompt': {
      const { notices, rest } = taskNotices(cleanPrompt(text))
      notices.forEach((n, i) => rows.push({ uuid: ev.uuid + ':n' + i, role: 'notice', text: n }))
      if (rest) rows.push({ uuid: ev.uuid, role: 'user', text: rest, origin })
      break
    }
    case 'response':
      ev.blocks.forEach((b, i) => {
        const uuid = ev.uuid + ':' + i
        if (b.type === 'text' && b.text?.trim()) rows.push({ uuid, role: 'assistant', text: b.text })
        else if (b.type === 'tool_use') rows.push({ uuid, role: 'tool', tool: b.name, text: summarizeInput(b.input), toolUseId: b.id, ...toolDetail(b.input) })
      })
      break
    case 'command': {
      if (!text) break
      const name = /<command-name>([^<]*)<\/command-name>/.exec(text)
      const out = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(text)
      if (name) {
        const args = /<command-args>([^<]*)<\/command-args>/.exec(text)
        rows.push({ uuid: ev.uuid, role: 'user', text: (name[1] + ' ' + (args ? args[1] : '')).trim(), origin })
      } else if (out) {
        // eslint-disable-next-line no-control-regex
        const clean = out[1].replace(/\x1b\[[0-9;]*m/g, '').replace(/^\n+|\s+$/g, '')
        if (clean) rows.push({ uuid: ev.uuid, role: 'output', text: clean })
      } else rows.push({ uuid: ev.uuid, role: 'notice', text })
      break
    }
    case 'delivery':
      deliveryRows(text).forEach((row, i) => rows.push({ ...row, uuid: i ? ev.uuid + ':' + i : ev.uuid, origin: row.role === 'user' ? origin : undefined }))
      break
    case 'notice':
    case 'compaction':
      if (text) rows.push({ uuid: ev.uuid, role: 'notice', text })
      break
  }
  return rows
}

// The row under a tool call for what it came back with: none for a subagent's call
export function resultRow(ev) {
  if (ev.agentId || !ev.toolUseId) return null
  return { uuid: ev.toolUseId + ':result', role: 'result', toolUseId: ev.toolUseId, ...summarizeResult(ev) }
}
