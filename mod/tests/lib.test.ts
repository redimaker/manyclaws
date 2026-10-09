// The mod's pure helpers
import { expect, test } from 'claude-code/testing'
import { parseCapabilities, mergePolicy, DEFAULT_POLICY, commandRefusal, parseSlash, cap, normalizeBlocks, isAttended, settingSaid } from '../hooks/lib.js'
import { summarizeInput } from '../hooks/rows.js'

test('capabilities: default, all, additions and exact lists', async () => {
  expect([...parseCapabilities('')].sort()).toEqual(['approve', 'chat', 'core', 'inspect', 'message', 'notify'])
  expect([...parseCapabilities('default')].sort()).toEqual(['approve', 'chat', 'core', 'inspect', 'message', 'notify'])
  expect(parseCapabilities('all').has('exec')).toBe(true)
  const plus = parseCapabilities('+files,+exec,-message')
  expect(plus.has('files')).toBe(true)
  expect(plus.has('exec')).toBe(true)
  expect(plus.has('message')).toBe(false)
  expect(plus.has('chat')).toBe(true)
  expect([...parseCapabilities('inspect chat')].sort()).toEqual(['chat', 'core', 'inspect'])
})

test('policy: merged, unknown keys dropped, bad values reset', async () => {
  // (tools and commands are none of a server's to add: dropped like anything else the mod does not know)
  const p = mergePolicy(DEFAULT_POLICY, { approvals: 'remote', bogus: 1, tools: [{ name: 'run_this' }], commands: [{ name: 'now' }], maxField: 5, questions: 'sometimes', stream: true })
  expect(p.approvals).toBe('remote')
  expect(p.questions).toBe('local')
  expect(p.maxField).toBe(200)
  expect(p.stream).toBe(true)
  expect((p as Record<string, unknown>).bogus).toBeUndefined()
  expect((p as Record<string, unknown>).tools).toBeUndefined()
  expect((p as Record<string, unknown>).commands).toBeUndefined()
})

test('slash commands: parsed, and panel commands refused', async () => {
  expect(parseSlash('/model sonnet')).toEqual({ command: 'model', args: 'sonnet' })
  expect(parseSlash('hello')).toBe(null)
  expect(commandRefusal('context', '', undefined)).toBe('')
  expect(commandRefusal('model', 'sonnet', undefined)).toBe('')
  expect(commandRefusal('model', '', { name: 'model', source: 'builtin' })).toMatch(/opens a picker/)
  expect(commandRefusal('status', '', { name: 'status', source: 'builtin' })).toMatch(/opens a panel/)
  expect(commandRefusal('my-skill', '', { name: 'my-skill', source: 'plugin' })).toBe('')
  expect(commandRefusal('nope', '', undefined)).toMatch(/no \/nope command/)
})

test('cap bounds strings, arrays, depth and odd values', async () => {
  expect(cap('x'.repeat(20), 10)).toBe('xxxxxxxxxx… [10 more]')
  expect((cap(Array.from({ length: 600 }, (_, i) => i)) as unknown[]).length).toBe(501)
  let deep: Record<string, unknown> = {}
  const root = deep
  for (let i = 0; i < 12; i++) deep = deep.next = {}
  expect(JSON.stringify(cap(root))).toMatch(/\[…\]/)
  expect(cap({ f: () => 1, n: 1 })).toEqual({ n: 1 })
})

test('message blocks are normalized', async () => {
  const blocks = normalizeBlocks([
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }], is_error: false },
    { type: 'thinking', thinking: 'hmm' },
    { type: 'image', source: { media_type: 'image/png' } },
  ])
  expect(blocks).toEqual([
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', tool_use_id: 't1', is_error: false, text: 'out' },
    { type: 'thinking', text: 'hmm' },
    { type: 'image', mediaType: 'image/png' },
  ])
  expect(normalizeBlocks('plain')).toEqual([{ type: 'text', text: 'plain' }])
  expect(summarizeInput({ command: 'ls -la\nmore' })).toBe('ls -la')
})

test('attended: a terminal or an app hosting the session, not claude -p or an SDK script', async () => {
  expect(isAttended(true, 'cli')).toBe(true)
  expect(isAttended(false, 'claude-vscode')).toBe(true)
  expect(isAttended(false, 'claude-desktop')).toBe(true)
  expect(isAttended(false, 'sdk-cli')).toBe(false)
  expect(isAttended(false, 'sdk-ts')).toBe(false)
  expect(isAttended(false, undefined)).toBe(true)
})

test('what /effort and /model answer is read off the transcript', async () => {
  const out = (said: string) => `<local-command-stdout>${said}</local-command-stdout>`
  expect(settingSaid(out('Set effort level to medium (saved as your default for new sessions): Balanced approach with standard implementation and testing'))).toEqual({ effort: 'medium' })
  expect(settingSaid(out('Set effort level to max (this session only): Maximum capability with deepest reasoning.'))).toEqual({ effort: 'max' })
  expect(settingSaid(out('\x1b[2mCurrent effort level: xhigh (Deeper reasoning than high, just below maximum (on supported models))\x1b[0m'))).toEqual({ effort: 'xhigh' })
  expect(settingSaid(out('Effort level: auto (currently medium)'))).toEqual({ effort: 'medium' })
  expect(settingSaid(out("Effort 'max' exceeds the cap for Sonnet 5.5 set by your settings or organization; set to 'high'"))).toEqual({ effort: 'high' })
  expect(settingSaid(out('Effort level set to auto'))).toEqual({ effort: null })
  expect(settingSaid(out('Set model to Sonnet 5.5 and saved as your default for new sessions'))).toEqual({ model: true })
  // Nothing else is taken for one: what a prompt says, another command's answer, a level it doesn't have
  expect(settingSaid('Set effort level to low')).toBe(null)
  expect(settingSaid(out('Kept model as Sonnet 5.5'))).toBe(null)
  expect(settingSaid(out('Set effort level to heroic'))).toBe(null)
  expect(settingSaid(out('Cancelled'))).toBe(null)
})
