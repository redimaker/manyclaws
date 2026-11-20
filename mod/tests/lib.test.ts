// The mod's pure helpers
import { expect, test } from 'claude-code/testing'
import { parseCapabilities, mergePolicy, DEFAULT_POLICY, commandRefusal, effortRefusal, cacheTtlOf, HOUR_CACHE_MS, SHORT_CACHE_MS, parseSlash, cap, normalizeBlocks, isAttended, settingSaid, settingRefused, colorless, took } from '../hooks/lib.js'
import { summarizeInput, messageRows, historyRows, capText, TEXT_BYTES } from '../hooks/rows.js'

test('capabilities: default, all, additions and exact lists', async () => {
  expect([...parseCapabilities('')].sort()).toEqual(['approve', 'chat', 'core', 'inspect', 'message', 'notify', 'upkeep'])
  expect([...parseCapabilities('default')].sort()).toEqual(['approve', 'chat', 'core', 'inspect', 'message', 'notify', 'upkeep'])
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

test("a change of effort a terminal would stop to ask about: after a reply, while its cache is warm, to another level, and not answered there since", async () => {
  const at = 1_000_000
  const asks = (more: any) => effortRefusal({ level: 'max', current: 'high', lastReplyAt: at, ttlMs: HOUR_CACHE_MS, setSinceReply: false, now: at + 1000, ...more })
  expect(asks({})).toMatch(/^mid-conversation, Claude Code asks about it in the terminal first, .* or here in 60 minutes, /)
  // (no reply in this process yet; the cache gone cold, an hour on or five minutes on; the level it has; one answered there)
  expect(asks({ lastReplyAt: 0 })).toBe('')
  expect(asks({ now: at + HOUR_CACHE_MS })).toBe('')
  expect(asks({ now: at + HOUR_CACHE_MS - 30_000 })).toMatch(/here in 1 minute, /)
  expect(asks({ ttlMs: SHORT_CACHE_MS, now: at + SHORT_CACHE_MS })).toBe('')
  expect(asks({ ttlMs: SHORT_CACHE_MS })).toMatch(/here in 5 minutes, /)
  expect(asks({ level: 'HIGH' })).toBe('')
  expect(asks({ level: 'auto', current: null })).toBe('')
  expect(asks({ level: 'auto' })).not.toBe('')
  expect(asks({ setSinceReply: true })).toBe('')
  // How long a reply's cache stays warm is what it wrote its cache for; one that wrote none keeps what was known
  expect(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } }, SHORT_CACHE_MS)).toBe(HOUR_CACHE_MS)
  expect(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 5 } })).toBe(SHORT_CACHE_MS)
  expect(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }, SHORT_CACHE_MS)).toBe(SHORT_CACHE_MS)
  expect(cacheTtlOf(null)).toBe(HOUR_CACHE_MS)
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

// (deon, 2026-11-19: a reply of 8022 characters reached the page as its first 8000 and "… [22 more]")
test("the words of a prompt or a reply are not cut at the field limit, which is for what tools take and give", async () => {
  const long = 'Herons stand in the shallows. '.repeat(400) // 12,000 characters
  const blocks = normalizeBlocks([{ type: 'text', text: long }, { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: long }] }], 8000)
  expect(blocks[0].text).toBe(long)
  expect((blocks[1] as any).text).toBe(long.slice(0, 8000) + '… [4000 more]')
  const rows = messageRows({ uuid: 'a1', door: 'response', blocks })
  expect(rows.map((r: any) => [r.role, r.text.length])).toEqual([['assistant', 12_000]])
  expect(messageRows({ uuid: 'u1', door: 'prompt', blocks: normalizeBlocks(long, 8000) })[0].text).toBe(long.trim())
  expect(historyRows([{ role: 'user', text: 'Tell me of herons' }, { role: 'assistant', text: long, toolUses: [] }]).map((r: any) => r.text.length)).toEqual([17, 12_000])
})

test('a row\'s text is cut only where its row, sealed, would be more than the server keeps: by its size as JSON in UTF-8, saying how much was left out', async () => {
  const size = (t: string) => new TextEncoder().encode(JSON.stringify(t)).length
  const plain = 'a'.repeat(TEXT_BYTES + 1000)
  const cut = capText(plain)
  expect(size(cut)).toBeLessThanOrEqual(TEXT_BYTES)
  expect(cut).toMatch(/^a+… \[\d+ more\]$/)
  expect(cut.length - cut.indexOf('…')).toBeLessThan(20)
  expect(Number(/\[(\d+) more\]/.exec(cut)![1]) + cut.indexOf('…')).toBe(plain.length)
  // (three bytes a character in UTF-8, two for a quote's escape and six for a control character's: each is cut sooner, to the same size)
  for (const one of ['鷺', '"', '\u0001']) {
    const t = one.repeat(TEXT_BYTES / 2)
    const c = capText(t)
    expect(size(c)).toBeLessThanOrEqual(TEXT_BYTES)
    expect(size(c)).toBeGreaterThan(TEXT_BYTES - 40)
    expect(Number(/\[(\d+) more\]/.exec(c)![1]) + c.indexOf('…')).toBe(t.length)
  }
  expect(capText('short')).toBe('short')
  expect(capText(undefined)).toBe('')
  expect(messageRows({ uuid: 'a2', door: 'response', blocks: [{ type: 'text', text: plain }] })[0].text).toBe(cut)
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

test("Ultracode is a switch beside the effort, read off what /effort ultracode answers, with the level it leaves as it was; and what /effort refuses is said as a refusal", async () => {
  const out = (said: string) => `<local-command-stdout>${said}</local-command-stdout>`
  // (as Claude Code 2.1.303 says them)
  expect(settingSaid(out('Ultracode on (this session only): dynamic workflows on every task. Effort stays high.'))).toEqual({ ultracode: true, effort: 'high' })
  expect(settingSaid(out('Ultracode off. Effort stays xhigh.'))).toEqual({ ultracode: false, effort: 'xhigh' })
  expect(settingSaid(out('\x1b[1mUltracode on\x1b[0m (this session only): dynamic workflows on every task.'))).toEqual({ ultracode: true })
  // A level set leaves it as it was: nothing is said of it
  expect(settingSaid(out('Set effort level to high (saved as your default for new sessions): Comprehensive implementation'))).toEqual({ effort: 'high' })
  // Refused where it cannot be turned on, in /effort's own words, without the list a terminal is given
  expect(settingRefused('effort', out('Ultracode needs dynamic workflows enabled (see /config). Valid options are: low, medium, high'))).toBe('Ultracode needs dynamic workflows enabled (see /config)')
  expect(settingRefused('effort', out("Ultracode isn't available on Haiku 5.5"))).toBe("Ultracode isn't available on Haiku 5.5")
  expect(settingRefused('effort', 'Invalid argument: heroic. Valid options are: low, medium')).toBe('Invalid argument: heroic')
  // What it did is no refusal, and nor is another command's answer
  expect(settingRefused('effort', out('Ultracode off. Effort stays high.'))).toBe(null)
  expect(settingRefused('model', out("Ultracode isn't available on Haiku 5.5"))).toBe(null)
})

test("a local command's answer drawn in color for a terminal is its answer on the page, however much color: the colors go before it is cut to what is sent", async () => {
  // As /context answers in 2.1.30x: a grid of colored cells, four times what a field holds with its colors
  const cell = '\x1b[38;5;244m⛁\x1b[39m '
  const said = '<local-command-stdout> \x1b[1mContext Usage\x1b[22m\n' + cell.repeat(2000) + '\n\x1b[38;5;246m└\x1b[39m init: ~20 tokens</local-command-stdout>'
  expect(said.length > 8000 * 3).toBe(true)
  // (as the plugin makes its rows: the colors dropped, then cut to a field)
  const rows = messageRows({ uuid: 'c1', door: 'command', blocks: normalizeBlocks(colorless([{ type: 'text', text: said }]), 8000) })
  expect(rows.map((r: any) => r.role)).toEqual(['output'])
  expect(rows[0].text.trim().startsWith('Context Usage\n⛁ ⛁')).toBe(true)
  expect(rows[0].text.trim().endsWith('init: ~20 tokens')).toBe(true)
  expect(/\x1b\[/.test(rows[0].text)).toBe(false)
  // (one cut short all the same, past its closing tag, is still output: what there is of it)
  const cut = messageRows({ uuid: 'c2', door: 'command', blocks: [{ type: 'text', text: '<local-command-stdout>Context Usage\nlong' }] })
  expect(cut.map((r: any) => [r.role, r.text])).toEqual([['output', 'Context Usage\nlong']])
  expect(colorless('\x1b[1mbold\x1b[22m plain')).toBe('bold plain')
})

test('what a turn took reads as the terminal says it: its length, and the tokens it wrote where any counted', () => {
  expect(took({ durationMs: 485_000, usage: { output_tokens: 8012 } })).toBe('8m 5s · ↓ 8.0k tokens')
  expect(took({ durationMs: 27_167, usage: { output_tokens: 451 } })).toBe('27s · ↓ 451 tokens')
  expect(took({ durationMs: 3_725_000, usage: { output_tokens: 120_400 } })).toBe('1h 2m · ↓ 120.4k tokens')
  // (an interrupt or an API error counts nothing: its length alone)
  expect(took({ durationMs: 90_000 })).toBe('1m 30s')
  expect(took({ durationMs: 400, usage: { output_tokens: 0 } })).toBe('0s')
  expect(took({})).toBe('')
})
