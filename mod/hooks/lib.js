// Pure helpers for the ManyClaws mod: no mods API calls here, so the tests can
// load them directly. register.js holds everything that touches `$`.

export const PROTOCOL = 2
export const PLUGIN_VERSION = '6.2.131'

// Where the mod reports: on the branch beta, ManyClaws' beta server. ManyClaws has one server, so the plugin has no option for its
// address and its dialog asks for none: MANYCLAWS_URL names another (a test's, or one
// somebody runs themselves).
export const SERVER = 'https://beta.manyclaws.dev'

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
  // (this computer's plugin and agent kept up to date: on an order from a device that may start sessions)
  'manyclaws.update': 'upkeep',
  'manyclaws.agent': 'upkeep',
}

// Capabilities on unless the machine's config says otherwise. "approve" lets permission
// prompts and questions be asked on the page; the rest are listed above.
export const DEFAULT_CAPABILITIES = ['core', 'inspect', 'chat', 'notify', 'message', 'approve', 'upkeep']
export const ALL_CAPABILITIES = ['core', 'inspect', 'chat', 'notify', 'message', 'approve', 'upkeep', 'tools', 'files', 'write', 'exec', 'model', 'config', 'mcp']

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

// How long the prompt cache of a reply stays warm: an hour where the reply wrote its cache for an
// hour (a plan's), five minutes where it wrote it for five; one that wrote none says nothing new
export const HOUR_CACHE_MS = 3_600_000
export const SHORT_CACHE_MS = 300_000
export function cacheTtlOf(usage, before = HOUR_CACHE_MS) {
  const made = usage?.cache_creation ?? usage?.cacheCreation
  if (!made) return before
  if (Number(made.ephemeral_1h_input_tokens ?? made.ephemeral1hInputTokens) > 0) return HOUR_CACHE_MS
  if (Number(made.ephemeral_5m_input_tokens ?? made.ephemeral5mInputTokens) > 0) return SHORT_CACHE_MS
  return before
}

// Why /effort <level> from the page would leave a terminal's session waiting, or '' when it would not.
// Mid-conversation, while the prompt cache is warm, Claude Code in a terminal stops to ask "Change
// effort level?" in a dialog only the terminal can answer, and all that is sent after it waits behind
// it. It asks once this process has had a reply, until that reply's cache has gone cold, unless the
// level is the one it has, or a change was answered there since the reply (one answer covers the rest).
export function effortRefusal({ level, current, lastReplyAt, ttlMs, setSinceReply, now }) {
  if (!lastReplyAt || setSinceReply) return ''
  const left = lastReplyAt + ttlMs - now
  if (left <= 0) return ''
  const asked = String(level ?? '').trim().toLowerCase()
  if (asked === (current ?? 'auto') || (asked === 'unset' && !current)) return ''
  const minutes = Math.max(1, Math.ceil(left / 60_000))
  return `mid-conversation, Claude Code asks about it in the terminal first, where nothing sent from here can answer, and everything sent after it would wait. Change it there with /effort, or here in ${minutes} minute${minutes === 1 ? '' : 's'}, once the conversation's cache has gone.`
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
  // Ultracode is a switch beside the level, not one of them (dynamic workflows on every task, at whichever level):
  // "Ultracode on (this session only): dynamic workflows on every task. Effort stays high." and "Ultracode off.
  // Effort stays high." are what /effort ultracode answers, with the level it leaves as it was
  const ultra = /^Ultracode (on|off)\b/.exec(said)
  if (ultra) {
    const stays = new RegExp(`\\bEffort stays ${level}`).exec(said)
    return { ultracode: ultra[1] === 'on', ...(stays ? { effort: stays[1] } : {}) }
  }
  // (the last is a level over what the settings or the organization allow, brought down to one they do)
  const effort = new RegExp(`^(?:Set effort level to|Current effort level:) ${level}`).exec(said) ?? new RegExp(`^Effort level: auto \\(currently ${level}`).exec(said) ?? new RegExp(`^Effort '[a-z]+' exceeds [\\s\\S]*; set to '${level}`).exec(said)
  if (effort) return { effort: effort[1] }
  if (/^Effort level set to auto\b/.test(said)) return { effort: null }
  if (/^Set model to \S/.test(said)) return { model: true }
  return null
}

// What /effort answered in place of doing what was asked: it says no in the words it says yes in, with no error. To
// Ultracode where that cannot be turned on (dynamic workflows are off in that computer's /config, or the model has
// none), and to a word it does not take. The reason, as it gave it, or null where it did what was asked.
export function settingRefused(command, text) {
  if (command !== 'effort') return null
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(String(text ?? ''))
  // eslint-disable-next-line no-control-regex
  const said = (out ? out[1] : String(text ?? '')).replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (!/^(?:Invalid argument\b|Ultracode needs |Ultracode isn't available )/.test(said)) return null
  // (what it could have been asked instead is a list for a terminal: "… Valid options are: low, medium, …")
  return said.split(/\.? Valid options are:/)[0].trim()
}

// A local command's answer without the colors it was drawn in for a terminal: they are dropped before it is cut to
// what is sent, which they would otherwise fill (/context's colored grid is four times over the length of a field)
export function colorless(content) {
  // eslint-disable-next-line no-control-regex
  const plain = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  if (typeof content === 'string') return plain(content)
  return Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? { ...b, text: plain(b.text) } : b)) : content
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

// What a turn took, as the terminal says it beneath the turn: how long it ran, and the
// tokens it wrote where it made a request that counted (8m 5s · ↓ 8.0k tokens)
export function took(e) {
  const s = Math.round(Number(e.durationMs) / 1000)
  if (!Number.isFinite(s) || s < 0) return ''
  const time = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : s + 's'
  const n = e.usage?.output_tokens
  return typeof n === 'number' && n > 0 ? `${time} · ↓ ${n < 1000 ? n : (n / 1000).toFixed(1) + 'k'} tokens` : time
}

export function randomId() {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
