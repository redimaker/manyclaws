// Pure helpers for the ManyClaws mod: no mods API calls here, so the tests can
// load them directly. register.js holds everything that touches `$`.

export const PROTOCOL = 2
export const PLUGIN_VERSION = '5.1.1'

// Where the mod reports. ManyClaws has one server, so the plugin has no option for its
// address and its dialog asks for none: MANYCLAWS_URL names another (a test's, or one
// somebody runs themselves).
export const SERVER = 'https://manyclaws.dev'

// What may be asked of a session, by capability. A method missing here is refused.
export const METHOD_CAPABILITY = {
  'ping': 'core',
  'session.info': 'inspect',
  'session.messages': 'inspect',
  'session.usage': 'inspect',
  'command.list': 'inspect',
  'tool.list': 'inspect',
  'agent.list': 'inspect',
  'config.list': 'inspect',
  'prompt.read': 'inspect',
  'prompt.compose': 'inspect',
  'tool.check': 'inspect',
  'prompt.submit': 'chat',
  'command.run': 'chat',
  'turn.abort': 'chat',
  'prompt.fill': 'chat',
  'prompt.suggest': 'chat',
  'session.compact': 'chat',
  'session.note': 'chat',
  'agent.spawn': 'chat',
  'ui.toast': 'notify',
  'ui.status': 'notify',
  'ui.log': 'notify',
  'ui.notice': 'notify',
  'ui.copy': 'notify',
  'audio.speak': 'notify',
  'audio.play': 'notify',
  'session.send': 'message',
  'tool.call': 'tools',
  'fs.read': 'files',
  'fs.list': 'files',
  'fs.stat': 'files',
  'fs.exists': 'files',
  'fs.ancestors': 'files',
  'fs.write': 'write',
  'process.run': 'exec',
  'model.complete': 'model',
  'model.classify': 'model',
  'model.fork': 'model',
  'config.set': 'config',
  'settings.read': 'config',
  'mcp.call': 'mcp',
  'mcp.connect': 'mcp',
}

// Capabilities on unless the machine's config says otherwise. "approve" lets permission
// prompts and questions be asked on the page; the rest are listed above.
export const DEFAULT_CAPABILITIES = ['core', 'inspect', 'chat', 'notify', 'message', 'approve']
export const ALL_CAPABILITIES = ['core', 'inspect', 'chat', 'notify', 'message', 'approve', 'tools', 'files', 'write', 'exec', 'model', 'config', 'mcp']

// "default", "all", or a list such as "default,+files,-message" or "inspect,chat"
export function parseCapabilities(spec) {
  const parts = String(spec ?? '').split(/[\s,]+/).filter(Boolean)
  // Only additions and removals ("+files,-message") start from the defaults
  const relative = parts.every((p) => p.startsWith('+') || p.startsWith('-'))
  const out = new Set(relative ? DEFAULT_CAPABILITIES : [])
  for (const part of parts) {
    if (part === 'default') DEFAULT_CAPABILITIES.forEach((c) => out.add(c))
    else if (part === 'all') ALL_CAPABILITIES.forEach((c) => out.add(c))
    else if (part.startsWith('-')) out.delete(part.slice(1))
    else out.add(part.replace(/^\+/, ''))
  }
  out.add('core')
  return out
}

// The account's policy, as the server hands it over: what the mod does until it has
export const DEFAULT_POLICY = {
  version: 0,
  approvals: 'local', // local | remote | auto: where permission prompts are answered
  questions: 'local', // local | remote | auto: where AskUserQuestion is answered
  remoteTimeoutMs: 0, // remote: 0 waits for ever; after it, onTimeout applies
  onTimeout: 'ask', // ask (the terminal's own dialog) | deny
  stream: false, // send the reply's text as it streams
  maxField: 8000, // longest string in what is sent
  toolResults: true, // send tool results (capped at maxField)
}

// The two tools the mod puts before Claude, and the only ones: the server has none to
// add. Neither is answered in words of the server's (a notification has gone; a photo is
// one the page sealed, opened here)
export const OWN_TOOLS = [
  {
    name: 'notify_user',
    description:
      "Sends a notification to the user's ManyClaws page (their phone or browser). Use it when the user asked to be told when something finishes, or when a long task ends and they may be away. Don't use it for routine progress.",
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to tell the user, in one or two sentences' },
        title: { type: 'string', description: 'A short title' },
      },
      required: ['message'],
    },
  },
  {
    name: 'view_attachment',
    description: 'Shows a photo the user sent from the ManyClaws page (their phone or browser). Call it with the id from an "[Attachment <id>: …]" note in their message, once for each id, before answering.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The attachment id from the note' } },
      required: ['id'],
    },
  },
]

export function mergePolicy(current, update) {
  const next = { ...current }
  for (const [k, v] of Object.entries(update ?? {})) if (k in DEFAULT_POLICY && v !== undefined && v !== null) next[k] = v
  if (!['local', 'remote', 'auto'].includes(next.approvals)) next.approvals = 'local'
  if (!['local', 'remote', 'auto'].includes(next.questions)) next.questions = 'local'
  if (!['ask', 'deny'].includes(next.onTimeout)) next.onTimeout = 'ask'
  next.maxField = clampNumber(next.maxField, 200, 200_000, DEFAULT_POLICY.maxField)
  next.remoteTimeoutMs = clampNumber(next.remoteTimeoutMs, 0, 86_400_000, 0)
  return next
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

// Built-in slash commands that answer in text, so they can run from the web page
export const TEXT_COMMANDS = new Set(['clear', 'compact', 'context', 'exit', 'focus', 'recap', 'reload-plugins'])
// Built-ins that open a picker on their own but take the value given after them
export const VALUE_COMMANDS = new Set(['advisor', 'color', 'effort', 'fast', 'model', 'output-style', 'rename'])

export function parseSlash(text) {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(String(text ?? ''))
  return m ? { command: m[1], args: m[2].trim() } : null
}

// Why a built-in command can't run remotely, or '' when it can. `found` is the
// command's $.command.list() row, or undefined when there is none.
export function commandRefusal(name, args, found) {
  if (TEXT_COMMANDS.has(name) || (args && VALUE_COMMANDS.has(name))) return ''
  if (!found) return `There is no /${name} command in this session.`
  if (found.source !== 'builtin') return ''
  if (VALUE_COMMANDS.has(name)) return `/${name} on its own opens a picker in the terminal. Send it with a value, such as /${name} <value>.`
  return `/${name} opens a panel in the terminal, so it can't run from here.`
}

// Strings capped, arrays and depth bounded, so any value can travel as JSON
export function cap(value, max = 8000, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + `… [${value.length - max} more]` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (depth >= 8) return '[…]'
  if (Array.isArray(value)) {
    const out = value.slice(0, 500).map((v) => cap(v, max, depth + 1))
    if (value.length > 500) out.push(`[${value.length - 500} more]`)
    return out
  }
  if (value instanceof Uint8Array) return `[${value.length} bytes]`
  const out = {}
  let n = 0
  for (const [k, v] of Object.entries(value)) {
    if (++n > 300) {
      out['…'] = 'more keys'
      break
    }
    const c = cap(v, max, depth + 1)
    if (c !== undefined) out[k] = c
  }
  return out
}

// A message's content blocks in a small, stable shape
export function normalizeBlocks(content, max = 8000) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  return blocks.map((b) => {
    switch (b?.type) {
      case 'text':
        return { type: 'text', text: cap(String(b.text ?? ''), max) }
      case 'tool_use':
      case 'server_tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: cap(b.input, max) }
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: !!b.is_error, text: cap(flattenText(b.content), max) }
      case 'thinking':
        return { type: 'thinking', text: cap(String(b.thinking ?? ''), Math.min(max, 4000)) }
      case 'redacted_thinking':
        return { type: 'thinking', redacted: true }
      case 'image':
        return { type: 'image', mediaType: b.source?.media_type }
      case 'document':
        return { type: 'document', title: b.title }
      default:
        return { type: String(b?.type ?? 'unknown') }
    }
  })
}

// What a local command said it set, read off its answer in the transcript. /effort and
// /model answer in a line of text whoever ran them: typed at the terminal, picked in its
// picker, or sent from the page. { effort } with the level (null for auto: the model's
// own, which the next request to it reports), or { model: true } when the model changed.
export function settingSaid(text) {
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(String(text ?? ''))
  if (!out) return null
  // eslint-disable-next-line no-control-regex
  const said = out[1].replace(/\x1b\[[0-9;]*m/g, '').trim()
  const level = '(low|medium|high|xhigh|max)\\b'
  // (the last is a level over what the settings or the organization allow, brought down to one they do)
  const effort = new RegExp(`^(?:Set effort level to|Current effort level:) ${level}`).exec(said) ?? new RegExp(`^Effort level: auto \\(currently ${level}`).exec(said) ?? new RegExp(`^Effort '[a-z]+' exceeds [\\s\\S]*; set to '${level}`).exec(said)
  if (effort) return { effort: effort[1] }
  if (/^Effort level set to auto\b/.test(said)) return { effort: null }
  if (/^Set model to \S/.test(said)) return { model: true }
  return null
}

export function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)
  return content.map((c) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : '')).join('\n')
}

// Whether a person can be at this session: an interactive terminal, or an app that
// hosts Claude Code through the SDK (VS Code, Desktop). Only the SDK's own entry
// points (claude -p is sdk-cli, scripts are sdk-ts and sdk-py) are unattended.
export function isAttended(isInteractive, entrypoint) {
  return !!isInteractive || !/^sdk-/.test(String(entrypoint ?? ''))
}

export function randomId() {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
