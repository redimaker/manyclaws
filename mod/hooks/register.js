// ManyClaws: a bridge between this Claude Code session and a ManyClaws server.
//
// It sends the server what happens in the session, sealed with the account's key before
// it leaves this computer (seal.js), and runs what the account's own devices ask of it (a
// call protocol over a long poll). There is no other way for a session to be told of: a
// plugin with no key sends nothing and asks for nothing. The server passes on what it is
// given and reads none of it. What it does say is the account's policy: where permission
// prompts and questions are answered, and whether replies stream.
//
// Configuration comes from the plugin's options (userConfig) or the environment:
//                  MANYCLAWS_URL           the server, where it is not https://manyclaws.dev (SERVER, in
//                                            lib.js): the plugin has no option for it, so its dialog
//                                            asks for no address
//   token        / MANYCLAWS_TOKEN         an API token of the account's, made on its Account page
//   label        / MANYCLAWS_LABEL         optional name for this machine or account
//   capabilities / MANYCLAWS_CAPABILITIES  "default", "all", or a list such as "+files,+exec"
//   key                                    the account's encryption passphrase. Everything the
//                                            session says is sealed with the key made from it. The
//                                            key is made here, from the passphrase and the account's
//                                            id, which is all the server hands over for the token: it
//                                            has nothing of the passphrase, and cannot say whether
//                                            this is the one the account's other devices were given.
//                                            The key, written out (mcf_…), is then put in the
//                                            passphrase's place among the plugin's options, so the
//                                            passphrase is kept nowhere on this computer.
//                  MANYCLAWS_KEY           the key written out (mcf_…), as a computer keeps it,
//                                            where there are no options to put it in. Never the
//                                            passphrase: what is in a session's environment is in
//                                            that of everything the session starts.
// Without a token, the mod does nothing. With a token and no passphrase it sends nothing
// and asks for nothing, and says once that it needs the passphrase.
//
// Nothing of what is said in the session, or of how what is said is made up, is the
// server's to read (see "What leaves this computer" below): the chat's rows are made here
// (rows.js) and each goes sealed whole, what the session is and how it stands goes as one
// sealed card, and what comes back from the page (replies, answers, photos) is opened here.

import {
  PROTOCOL,
  PLUGIN_VERSION,
  SERVER,
  METHOD_CAPABILITY,
  DEFAULT_POLICY,
  OWN_TOOLS,
  mergePolicy,
  parseCapabilities,
  parseSlash,
  commandRefusal,
  TEXT_COMMANDS,
  VALUE_COMMANDS,
  cap,
  normalizeBlocks,
  flattenText,
  settingSaid,
  isAttended,
  randomId,
} from './lib.js'
import { seal, open, isSealed, openBytes, keysFromText, keysText, contentKey, nameOf, toB64, fromB64, sha256, keysFromPassphrase, isOrder, readOrder, takeOrder, orderMemory, devicesMemory, askedOf, OrderRefused } from './seal.js'
import { messageRows, resultRow, historyRows, summarizeInput } from './rows.js'

const FLUSH_MS = 250 // how often what is in the queue is sent
const PING_MS = 20_000 // a session with nothing to report still checks in this often
const POLL_WAIT_S = 2 // how long the server may hold a poll open: short, and the same for every session (see poll)
const ENDED_MS = 1000 // how often a process whose session has ended looks for the one that comes after it
const DECISION_WAIT_S = 20 // how long the server may hold a wait for an answer open
const RETRY_MS = 5000 // wait after a failed poll
const MAX_QUEUE = 5000 // things kept while the server is unreachable
const MAX_BATCH = 300 // things per request
const MAX_RESULT = 1_000_000 // longest string in a call's result
const HISTORY_WAIT_MS = 3000 // how long a session's history waits for the first poll to say whether the server asks for it
const CARD_MS = 1000 // a session's card goes at most this often, but for a change of state, which goes at once
const DONE_WORTH_MS = 30_000 // a turn this long is worth telling a phone it is done
const ANSWER_FIELD = 200_000 // how long an answer the server asked for (a handoff) may be
const AGENT_IDLE_MS = 6 * 3600_000 // a subagent not heard of for this long is taken to be gone
const DEVICES_MS = 2000 // the list of the account's devices is not asked for again sooner than this after it was
const DEVICES_EVERY_MS = 5 * 60_000 // and it is read this often with no order to go by: a device taken off it is seen to be, while the list without it is still what the server hands over
const TOOL_PREFIX = 'mcp__manyclaws__'

const instance = randomId() // this load of the module, said in what `ping` answers (sealed, as every answer is) and nowhere else: a reload is a new one

let config = null // { url, token, label, capabilities, key, checker }, or null when unconfigured
let sealKey = null // the account's key, ready for use: what everything this session says is sealed with
let orders = orderMemory() // the orders this session has run, so that none is run twice (kept in the plugin's store)
let devices = devicesMemory() // the account's phones and browsers, as this computer knows them: an order is done only where one of them signed it
let devicesRead = null // the last reading of that list from the server for an order, or the one under way: { at, done }
let devicesLookedAt = null // when it was last read with no order to go by: null until it has been
let caps = new Set()
let policy = { ...DEFAULT_POLICY }
let meta = {} // this process's description, which goes on the session's card
let queue = [] // what is not yet delivered, each thing sealed and tagged with its session id
let isFlushing = false
let lastSent = 0
let sessionId = null // the current conversation's id; null right after one ends
let attended = false // a person can be at this session (see isAttended)
let runningTurn = null // turnId of the main loop's running turn, for turn.abort
let turnBefore = null // the turn that started before the session was taken up (while its key was being made), if it is still running
let state = 'idle'
let stateDetail = '' // what was said with it
let stateSince = Date.now() // when it came to be in that state
// What a session says of itself on its card, which the server cannot work out from what
// it is sent: what it is about, how full its context is, the subagents it has running
let topic = '' // its first prompt
let lastPrompt = '' // the last thing its user typed to it
let lastReply = '' // the last thing Claude has said since then: nothing, until it has said something
let preview = '' // the last thing said in it
let usageNow = { contextPercent: null, costUsd: null }
const subagents = new Map() // agent id -> { id, type, description, background, startedAt, lastActivity }
let spawns = [] // what the next subagents to start are for
let cardDirty = false // the card has changed since it last went
let cardUrgent = false // and is not to wait
let cardSent = 0
const stepsDone = new Set() // this turn's finished steps: text streamed for one of them is late, and not sent
let answerAsked = '' // the name the server asked the next turn's answer by (a handoff)
let answerTurn = null // the turn whose answer that is, once it has started
let answerGiven = '' // the last name answered by
let lastTool = '' // the latest tool call, for a permission prompt's detail
let cursor = 0 // highest command seq this session has run
let historyOwed = false // the history a session starts with has not been sent yet
let historyAsk = '' // the server's ask for this session's chat that was last taken up, by its name
let appended = 0 // rows of the main conversation told of (session.append), in all
const landing = new Set() // those told of and not yet kept: a promise each, settled when it is
const endedIds = new Set() // sessions this process has ended: never reported again
let hasWarned = false
let permissionMode = null // the permission mode, as last reported
let effortNow // the effort the session thinks at, as last reported: null when it has none, undefined until something says
let modelAskedUntil = 0 // a /model the page asked for is on its way: until then, the switch is not asked about again
const pendingList = [] // requests the band above the prompt offers to answer: { rid, kind, ... }
const localAnswers = new Map() // rid -> the answer given at the terminal
const localApprovals = new Map() // tool_use_id -> rid, for prompts left to the terminal's dialog
const asking = [] // approvals the app is asking in its own dialog that the page may answer too: { rid, tool, input, request }
const answeredBy = new Map() // rid -> who answered one of those first, when it wasn't the app's dialog
const deltas = new Map() // streamed reply text not yet sent, by turn, step and block
const added = new Set() // the names of its own tools that are before Claude (OWN_TOOLS)

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    const given = await readGiven($, options)
    if (!given) return next(e)
    const here = await keysHere($, given)
    if (here) await begin($, e, given, here)
    // The key is still to be made from the passphrase: in the first session on this
    // computer, or the first since it was given another. That is more arithmetic than a
    // hook is given the time for, so it is done beside the session, in pieces, and the
    // session is taken up when the key is there: it is told of from its start then, as
    // one found already running is.
    else if (here === null) {
      $.ui.log('ManyClaws: making your encryption key from your passphrase. This computer does that once, and it takes it a while: this session is shown on the page when the key is made.')
      $.clock.after(1, async () => {
        const made = await keysMade($, given)
        if (!made) return
        await begin($, e, given, made)
        void keyInPlace($, made)
      })
    }
    return next(e)
  })

  // Every row a conversation of this session keeps, main and subagents alike. A row is
  // told of here before it is kept: which of the main conversation's are on their way in
  // is noted, for a history to be read while none is (settledMessages).
  on('session.append', async ($, e, next) => {
    if (!config) return next(e)
    if (e.agentId) {
      await recordRow($, e)
      return next(e)
    }
    appended++
    let kept
    const row = new Promise((done) => (kept = done))
    landing.add(row)
    try {
      await recordRow($, e)
      return await next(e)
    } finally {
      landing.delete(row)
      kept()
    }
  })

  on('turn.start', async ($, e, next) => {
    if (!config && !e.agentId) turnBefore = e.turnId
    if (config) {
      await currentSessionId($)
      runningTurn = e.turnId
      stepsDone.clear()
      // (the turn the server asked the answer of is the first to start after it asked)
      if (answerAsked && !answerTurn) answerTurn = e.turnId
      await setState($, 'working')
      meta.model = await $.session.model()
    }
    return next(e)
  })

  // Each request to the model; the reply's text is kept as it streams, while the policy asks for that
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (!config) return yield* stream
    await currentSessionId($)
    // How hard this request asks the model to think is the session's effort, as of now
    // (a subagent's is its own; a model that takes none is sent none)
    if (!e.agentId && (e.effort === undefined || typeof e.effort === 'string')) noteEffort(e.effort ?? null)
    let result
    let isDone = false
    try {
      for (;;) {
        const step = await stream.next()
        if (step.done === true) {
          result = step.value
          isDone = true
          break
        }
        const chunk = step.value
        if (policy.stream && !e.agentId && chunk.kind === 'text') addDelta(e, chunk)
        yield chunk
      }
    } finally {
      if (!isDone) await stream.return(undefined).catch(() => {})
    }
    // (a subagent's request says it is at work, and that there is one, where this process had not heard it start)
    if (e.agentId) agentHeard(e.agentId, { known: false })
    else stepDone(e)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!config && !e.agentId) turnBefore = null
    if (config) {
      await currentSessionId($)
      if (e.agentId) agentGone(e.agentId)
      else {
        sendDeltas()
        runningTurn = null
        await turnDone($, e)
        await setState($, 'idle', e.reason === 'answer' ? '' : e.reason)
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!config) return next(e)
    if (e.tool === 'AskUserQuestion') return askQuestion($, e, next)
    const { tool, tool_use_id: toolUseId, agentId, ...input } = e
    if (isOwnTool(tool)) return ownTool($, tool.slice(TOOL_PREFIX.length), input)
    await currentSessionId($)
    lastTool = tool + ' ' + summarizeInput(input)
    agentHeard(agentId)
    const result = await next(e)
    agentHeard(agentId)
    // What the call came back with, as its row in the chat is made of it (rows.js): none for a subagent's call
    const end = { toolUseId, agentId }
    if (typeof result?.deny === 'string') end.deny = cap(result.deny, 2000)
    else {
      end.isError = !!result?.isError
      if (policy.toolResults) end.result = cap(result?.result, policy.maxField)
      // A permission refusal reaches the model as an error result
      if (end.isError && /permission to use .* (was )?denied|doesn't want to proceed|user (rejected|denied)/i.test(String(result?.result ?? ''))) end.denied = true
      // (a subagent sent to the background says so as the call that started it returns)
      const began = result?.result
      if (!agentId && typeof began?.agentId === 'string' && subagents.has(began.agentId)) {
        if (began.isAsync) subagents.get(began.agentId).background = true
        cardChanged()
      }
    }
    const row = resultRow(end)
    if (row) await emitRows($, [row])
    // A prompt answered in the terminal's own dialog: report what was chosen
    const rid = localApprovals.get(toolUseId)
    if (rid) {
      localApprovals.delete(toolUseId)
      // What came of it is what the call did; who decided is the page, where its answer got there first
      await emit($, 'resolved', { rid, decision: end.deny || end.denied ? 'deny' : 'allow', by: answeredBy.get(rid) ?? 'terminal' })
      answeredBy.delete(rid)
      forget(rid)
    }
    if (state === 'attention') await setState($, 'working')
    return result
  })

  // Permission decisions; an "ask" can be routed to the page by policy
  on('tool.check', async ($, e, next) => {
    const decided = await next(e)
    if (!config || !e.tool_use_id) return decided
    if (decided?.decision !== 'ask' || e.tool === 'AskUserQuestion') return decided
    // Its own two tools are as trusted as the plugin that put them there
    if (isOwnTool(e.tool)) return { decision: 'allow', reason: 'A ManyClaws tool' }
    return approve($, e, decided, next)
  })

  // Its own tools go in the prompt's tool list, not behind ToolSearch, so every model sees them
  on('tool.describe', { tool: /^mcp__manyclaws__/ }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  // Every settings hook event: what the mods API has no hook or getter of its own for is read off these
  on('classic.*', async ($, e, next) => {
    if (config) {
      const event = e.hook_event_name
      if (event === 'Notification') await notified($, e)
      // The app is asking in its own dialog. The engine runs this hook beside the dialog
      // and takes whichever answers first, so the page's answer, if it comes, is given here
      if (event === 'PermissionRequest') {
        const decision = await pageDecision($, e, next)
        if (decision) return { decision }
      }
      // A conversation started or resumed in this process (after /clear, /resume or
      // /branch) is reported, even one it ended before
      if (event === 'SessionStart' && e.session_id && e.session_id !== sessionId) {
        endedIds.delete(e.session_id)
        sessionId = null
      }
      await currentSessionId($)
      // The mods API has no getter for the permission mode; every settings hook
      // event carries it, as of that moment. The ones inside a tool call carry the
      // effort too (one without it says nothing about the effort)
      if (e.permission_mode && e.permission_mode !== permissionMode) {
        permissionMode = e.permission_mode
        cardChanged(true)
      }
      if (e.effort?.level && !e.agent_id) noteEffort(e.effort.level)
      // The model changed: by /model here or from the page, the terminal's picker, or the app
      if (event === 'PostModelSwitch') await noteModel($)
      // A switch the page asked for. Mid-conversation the app would stop to ask "Switch
      // model?" in its own dialog, where nobody is: whoever picked it on the page was told
      // the same there, and has answered
      if (event === 'PreModelSwitch' && Date.now() < modelAskedUntil) {
        modelAskedUntil = 0
        return { permissionDecision: 'allow', permissionDecisionReason: 'Picked on the ManyClaws page' }
      }
      if (event === 'SubagentStart') agentStarted(e)
      if (event === 'SubagentStop' && typeof e.agent_id === 'string') agentGone(e.agent_id)
    }
    return next(e)
  })

  // What the next subagent to start is for: the SubagentStart that follows says which one it is (agentStarted)
  on('agent.spawn', ($, e, next) => {
    if (config) {
      const now = Date.now()
      spawns = [...spawns.filter((x) => now - x.ts < 60_000), { ts: now, type: String(e.subagentType ?? ''), description: String(e.description ?? e.name ?? '').slice(0, 200), background: !!e.background }].slice(-20)
    }
    return next(e)
  })

  // How full the context is and what the session has cost, for its card
  on('session.measure', async ($, e, next) => {
    if (config) {
      await currentSessionId($)
      usageNow = { contextPercent: typeof e.context?.percent === 'number' ? e.context.percent : usageNow.contextPercent, costUsd: typeof e.cost?.usd === 'number' ? e.cost.usd : usageNow.costUsd }
      cardChanged()
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (config) {
      sendDeltas()
      // (why it ended goes on its card, which goes before it does)
      put(e.sessionId, 'card', { ...cardNow(), state: 'idle', endReason: e.reason })
      put(e.sessionId, 'session.end')
      endedIds.add(e.sessionId)
      // After /clear or a resume the process goes on under a new session id
      sessionId = null
      runningTurn = null
      state = 'idle'
      cursor = 0
      forgetSession()
      // Sent now, whether or not a flush is under way: the process may be exiting. (As the server hears that a
      // session has ended it lets go of the poll it holds for it, and an ended session is not asked for again: see
      // poll. So a process on its way out has nothing left open.)
      const batch = queue.splice(0, queue.length)
      try {
        await $.http.fetch(config.url + '/api/agent/events', {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify(batchOf(batch)),
        })
      } catch {
        queue.unshift(...batch)
      }
      await $.store.delete('cursor:' + e.sessionId).catch(() => {})
    }
    return next(e)
  })

  // The band above the prompt: answer a routed request at the terminal too
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = pendingList[0]
    if (!config || !current) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const theirs = await next(e)
    const button = (key, hotkey, label, answer) =>
      Button({ key, hotkey, label, plain: true, onPress: () => answerLocally($, current.rid, answer) })
    const rows = []
    if (current.kind === 'approval') {
      rows.push(Text({ bold: true, color: 'yellow', children: ['ManyClaws: Claude wants to use ' + current.tool] }))
      if (current.summary) rows.push(Text({ wrap: 'truncate-end', children: [current.summary] }))
      rows.push(Text({ dimColor: true, children: ['Also sent to ManyClaws: answer here or there.'] }))
      rows.push(
        Box({
          flexDirection: 'row',
          columnGap: 3,
          children: [
            button('mc-allow', '1', 'Allow', { decision: 'allow' }),
            button('mc-deny', '2', 'Deny', { decision: 'deny' }),
            button('mc-dialog', '3', 'Use the terminal dialog', { decision: 'ask' }),
          ],
        }),
      )
    } else {
      const q = current.questions[0] ?? {}
      const simple = current.questions.length === 1 && (q.kind ?? 'choice') === 'choice' && !q.multiSelect && (q.options ?? []).length <= 8
      rows.push(Text({ bold: true, color: 'yellow', children: ['ManyClaws: ' + (q.question ?? 'Claude has a question')] }))
      if (!simple) rows.push(Text({ dimColor: true, children: [current.questions.length + ' question(s): answer from ManyClaws, or here:'] }))
      else rows.push(Text({ dimColor: true, children: ['Also sent to ManyClaws: answer here or there.'] }))
      const options = simple ? q.options.map((o, i) => button('mc-opt-' + i, String(i + 1), o.label, { decision: 'answer', answers: { [q.question]: o.label } })) : []
      options.push(button('mc-dialog', String(options.length + 1), 'Answer in the terminal dialog', { decision: 'ask' }))
      rows.push(Box({ flexDirection: 'row', columnGap: 3, children: options }))
    }
    if (pendingList.length > 1) rows.push(Text({ dimColor: true, children: [pendingList.length - 1 + ' more waiting'] }))
    return Box({ flexDirection: 'column', children: theirs ? [...rows, theirs] : rows })
  })
}

// ---- Setup

// A session taken up, with what the plugin was given and the account's key: from here on
// it is told of, sealed, and asked for its calls. `e` is what its start said of it. Where
// the key had to be made first, this is some while after the session started: what it
// has said by then goes as the history of a session found running does.
async function begin($, e, given, keys) {
  const sid = await $.session.id()
  const named = 'orders:' + sid
  const ordersKept = await Promise.resolve($.store.get(named)).catch(() => null)
  // (the list of the account's devices as it was last kept here: by whose it is, since the plugin's store is every
  // session's on this computer, whichever account and server each reports to. Kept under one name for all, a session
  // would take another account's list, or another server's, for its own, and hold its own to be the older one.)
  const key = contentKey(keys.key)
  const listed = 'devices:' + nameOf(given.url, key)
  const devicesKept = await Promise.resolve($.store.get(listed)).catch(() => null)
  // (and the devices seen taken off it, which are none of the account's here again: kept the same way)
  const offList = 'gone:' + nameOf(given.url, key)
  const goneKept = await Promise.resolve($.store.get(offList)).catch(() => null)
  const entrypoint = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) || undefined
  const at = Number(await $.store.get('cursor:' + sid)) || 0
  // (all of it at once, with nothing waited for between: a hook that runs meanwhile finds the session not taken up, or taken up whole)
  config = { url: given.url, token: given.token, label: given.label, capabilities: given.capabilities, key: keys.key, checker: keys.checker }
  caps = parseCapabilities(config.capabilities)
  sealKey = key
  sessionId = sid
  orders = orderMemory(ordersKept, (now) => void Promise.resolve($.store.set(named, now)).catch(() => {}))
  // (which every session of that account's on this computer goes by, and keeps up)
  devices = devicesMemory(devicesKept, sealKey, config.checker, (now) => void Promise.resolve($.store.set(listed, now)).catch(() => {}), {
    gone: goneKept,
    saveGone: (now) => void Promise.resolve($.store.set(offList, now)).catch(() => {}),
  })
  devicesRead = null
  devicesLookedAt = null
  attended = isAttended(e.isInteractive, entrypoint)
  meta = {
    entrypoint,
    attended,
    protocol: PROTOCOL,
    plugin: PLUGIN_VERSION,
    cwd: e.cwd,
    interactive: e.isInteractive,
    surface: e.surface,
    label: config.label || undefined,
    capabilities: [...caps],
  }
  cursor = at
  // (a turn that started while the key was being made is still running: the session's card says so)
  if (turnBefore) {
    runningTurn = turnBefore
    state = 'working'
    stateSince = Date.now()
  }
  // None of these hold up the first prompt
  void describe($)
  // The history goes once the first poll is back: under the server's ask if it has one
  // (see sendHistory), unasked if not. If no poll comes back, unasked all the same.
  historyOwed = true
  $.clock.after(HISTORY_WAIT_MS, () => owedHistory($))
  $.clock.every(FLUSH_MS, () => flush($))
  $.clock.after(1, () => poll($))
}

// What the plugin was given: where it reports, what it signs in with, and the passphrase
// its key is made from. null where it has no token or no passphrase: a session is told of
// sealed or not at all, so with null nothing is sent and nothing is asked for.
async function readGiven($, options) {
  const token = options?.token || (await $.env.get('MANYCLAWS_TOKEN'))
  if (!token) return null
  // (`typed`: it came from the plugin's own options, where a person types it and where the key can be put in its place)
  const typed = String(options?.key || '').trim()
  const passphrase = typed || String((await $.env.get('MANYCLAWS_KEY')) || '').trim()
  if (!passphrase) return notShown($, 'ManyClaws: this computer has not been given your encryption passphrase, and nothing a session says leaves it unsealed. This session is not shown on the page. Give the plugin the passphrase in /plugin (manyclaws, its options), then start Claude Code again.')
  const url = (await $.env.get('MANYCLAWS_URL')) || (await relayOf($, String(token))) || SERVER
  return {
    url: String(url).replace(/\/+$/, ''),
    token: String(token),
    passphrase,
    typed: !!typed,
    label: options?.label || (await $.env.get('MANYCLAWS_LABEL')) || '',
    capabilities: options?.capabilities || (await $.env.get('MANYCLAWS_CAPABILITIES')) || 'default',
  }
}

// Why this session is not shown on the page, said once where it is seen: in the
// transcript, and on a surface that has somewhere to say it
function notShown($, text) {
  $.ui.log(text)
  Promise.resolve()
    .then(() => $.ui.toast(text, { timeoutMs: 20_000 }))
    .catch(() => {})
  return null
}
const unsent = ($, why) => notShown($, `ManyClaws: ${why}. This session is not shown on the page: nothing a session says leaves this computer unsealed. Put it right in /plugin (manyclaws, its options).`)

// The account's key from the passphrase this computer was given. The server says whose
// computer this is (the account's id, to whoever holds one of its tokens) and nothing
// else: of the passphrase it has nothing, so nothing here can tell whether this is the
// one the account's other devices were given. If it is not, they cannot open what this
// computer sends, and it is they that say so. The key is made here, once, and then
// written out (mcf_…) into the plugin's own options in the passphrase's place: so the
// next session starts at once, a passphrase typed anew makes its key anew, and the
// passphrase itself is kept nowhere on this computer once its key is made. What is kept
// is the key, where Claude Code keeps what is secret of a plugin's options: it opens what
// the account's sessions say, and can neither sign the list of the account's devices nor
// be turned back into the passphrase.
//
// The key is not kept beside that, locked under the passphrase or anything made with it:
// whoever had such a copy and this computer's token could try a passphrase on it with
// one cheap sum each, where trying one on anything sealed costs what Argon2id costs.
const PLUGIN = 'manyclaws@manyclaws' // what Claude Code knows this plugin by, where it was installed from its marketplace
const kept = (keys) => ({ key: keys.key, checker: keys.checker })

// The key where this computer has it already: written out, in the passphrase's place or
// in the environment. null where it is still to be made from the passphrase; undefined
// where what it was given is no use, which is said.
async function keysHere($, { passphrase, typed }) {
  // (once, at the release of 2026-10-09, and then out of the code: the copy of the key the plugin used to keep in its
  // own store, locked under the token and the passphrase, is removed from every computer that has one)
  await Promise.resolve($.store.delete('kept-key')).catch(() => {})
  let written = null
  try {
    written = keysFromText(passphrase)
  } catch {}
  if (written) return written
  // (something written as a kept key that isn't a whole one is not taken for a passphrase)
  if (/^mc[a-z]_[A-Za-z0-9_.-]{20,}$/.test(passphrase)) return void unsent($, 'what this computer was given as its passphrase is a key written out, and not a whole one: give it the passphrase itself')
  // (a passphrase is typed into the plugin's options and nowhere else: one in the environment would be handed to every
  // command the session runs, and there is nowhere to put its key in its place)
  if (!typed) return void unsent($, 'MANYCLAWS_KEY takes your key written out (mcf_…), as a computer keeps it, and what it holds is not one. A passphrase is not taken from the environment, where every command this session runs could read it: type it into the plugin\'s own options')
  return null
}

// The key made from the passphrase, and put in its place: null where it could not be
// made, which is said. Making it is some seconds of arithmetic at the least (Argon2id, in
// plain JavaScript here: a quarter of a minute on a fast computer), with the clock waited
// on between pieces so that the rest of the plugin is heard meanwhile.
async function keysMade($, { url, token, passphrase }) {
  let r
  try {
    r = await $.http.fetch(url + '/api/agent/account', { headers: { authorization: 'Bearer ' + token } })
  } catch {
    return unsent($, 'the server could not be reached to say whose computer this is, which your encryption key is made with')
  }
  if (r.status === 401) return unsent($, 'the API token was refused (it may have run out, or been taken back)')
  if (!r.ok) return unsent($, `the server would not say whose computer this is (${r.status})`)
  let keys = null
  try {
    // (the half that signs the list of the account's devices is made on the way, and is not kept: a computer checks that list, and can write none)
    keys = await keysFromPassphrase(passphrase, JSON.parse(r.text).id, { pause: () => $.clock.sleep(1) })
  } catch {}
  if (!keys) return unsent($, 'your encryption key could not be made from the passphrase')
  return kept(keys)
}

// The key written out, put among the plugin's options where the passphrase was: by Claude
// Code itself, asked as its own command line is (a plugin cannot write what is secret of
// its options any other way), with the key on that command's standard input and never
// among its arguments. Not waited for by the session, which has its key already. Where it
// cannot be done the passphrase stays where it was typed, and the key is made again as
// each session starts: slow, and said, with what to do about it.
async function keyInPlace($, keys) {
  let why = ''
  try {
    const claude = (await $.env.get('CLAUDE_CODE_EXECPATH')) || 'claude'
    const r = await $.process.run([claude, 'plugin', 'configure', PLUGIN, '--values-stdin'], { stdin: JSON.stringify({ key: keysText(keys) }), timeoutMs: 60_000 })
    if (r.exitCode === 0) return true
    why = String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200)
  } catch (err) {
    why = String(err?.message ?? err).slice(0, 200)
  }
  $.ui.log(`ManyClaws: your encryption key was made, and this session is sealed with it. It could not be put in your passphrase's place among the plugin's options${why ? ` (${why})` : ''}, so the passphrase is still kept there, and the key is made again as each session starts, which takes a while each time. Run this once in a terminal to put it right: claude plugin configure ${PLUGIN}`)
  return false
}

// Which session this is. After /clear or a resume the process goes on under another: it
// is taken up, and said hello for, the first time anything happens in it. Every hook
// asks before it does anything else, so what it goes on to say is said of that session.
async function currentSessionId($) {
  if (!sessionId) {
    const id = await $.session.id()
    // The process on its way out still answers with the session that just ended
    if (endedIds.has(id)) return id
    sessionId = id
    cursor = Number(await $.store.get('cursor:' + sessionId)) || 0
    put(sessionId, 'hello')
  }
  return sessionId
}

// What was kept of the session that has ended is not the next one's
function forgetSession() {
  topic = ''
  lastPrompt = ''
  lastReply = ''
  preview = ''
  usageNow = { contextPercent: null, costUsd: null }
  subagents.clear()
  spawns = []
  stepsDone.clear()
  answerAsked = ''
  answerTurn = null
}

// Host, platform, account and repository, for the session's card
async function describe($) {
  meta.host = (await output($, ['hostname'])).trim() || (await $.env.get('COMPUTERNAME')) || undefined
  meta.platform = (await output($, ['uname', '-sm'])).trim() || undefined
  meta.pid = Number(await $.env.get('CLAUDE_PID')) || undefined
  // The running Claude Code, not whichever `claude` comes first on PATH
  const claude = (await $.env.get('CLAUDE_CODE_EXECPATH')) || 'claude'
  try {
    const { email, orgName, orgId, subscriptionType, authMethod, apiProvider } = JSON.parse(await output($, [claude, 'auth', 'status']))
    meta.account = { email, orgName, orgId, subscriptionType, authMethod, apiProvider }
  } catch {
    // Not signed in through claude.ai, or the CLI isn't on PATH
  }
  const repo = await $.session.repo()
  if (repo) meta.repo = { root: repo.root, remote: repo.remote, name: repo.name }
  meta.root = await $.session.root()
  meta.model = await $.session.model()
  meta.version = (await $.session.version()).version
  meta.surfaces = [...(await $.session.surfaces())]
  // (said hello for now that it can say what it is: the card goes with it)
  await emit($, 'hello')
}

async function output($, argv) {
  try {
    const r = await $.process.run(argv, { timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}

// The messages a conversation has so far, as the chat's rows, with what each tool call
// came back with (the server can't ask for that later). A resumed one already has some
// when it starts: sent then, the server keeps them only for a session it has none for.
// And the server asks for them, by a name, of a session it holds nothing of (it met it
// only now, or what it kept of it went: cleared by its owner, or older than anything is
// kept). Sent under that name (`asked`), they are the chat as it stands, which the server
// puts in place of what it has: so they are sent even when there are none.
async function sendHistory($, asked) {
  const messages = await settledMessages($)
  if (!messages.length && !asked) return
  await emitRows($, historyRows(cap(messages.slice(-300), policy.maxField)), { hist: true, asked })
}

// The history a session starts with, if it has not gone yet
function owedHistory($) {
  if (!historyOwed) return
  historyOwed = false
  void sendHistory($)
}

// The conversation's messages, read while no row is on its way in. One on its way has
// been reported as it happens and may or may not be among what is read: read between
// rows, what is read is every row reported so far and no other, so the server can put it
// in place of what it has without losing a row or having one twice.
async function settledMessages($) {
  for (let tries = 0; ; tries++) {
    // (not for ever: a row that never lands doesn't keep the history from going)
    await Promise.race([Promise.all([...landing]), new Promise((done) => $.clock.after(2000, done))])
    const before = appended
    const messages = await $.session.messages()
    if ((appended === before && !landing.size) || tries >= 5) return messages
  }
}

// ---- What leaves this computer of a session: all of it sealed with the account's key.
// Nothing of what is said in it, or of how what is said is made up, is the server's to
// read: not who said a row or when, not which rows are a tool's call and its answer, not
// a tool's name, a model, a count or a cost. What goes is this and no more, each thing
// with the session's id, when it was put in the queue (which is when the server has it,
// near enough), that it is sealed whole (2) and what kind of thing it is, in the open,
// and no number:
//   rows         the chat: each row sealed whole, under a name the server tells it from the
//                next by (seal.js, nameOf) and that says nothing of it; `hist` and `asked`
//                where they are the chat as it stood, sent again, whose rows have no names
//   card         what the session is and how it stands: where it runs, its model and mode,
//                its state, what it is about, the subagents it has running. Sealed whole.
//   part         the reply as it is written, in sealed pieces; and that those so far are done with
//   request      something it asks (a permission, a question), sealed whole, under the id
//                its answer comes back by, which is the same kind of id whichever it asks;
//                `resolved` likewise, when it has been answered
//   result       what a call it was asked to run came to, sealed, under the call's id, and
//                whether it ran
//   notify       something for the account's phones, sealed whole
//   answer       what a turn came to, where the server asked for it by a name (a handoff,
//                which it passes on unread), sealed
//   session.end, hello, ping: that it has gone, and that it is here
// Everything else the hooks hear of (each message as the engine has it, each tool call's
// start and end, each request to the model, each hook, the usage) stays on this computer:
// what the page shows of it is in the rows and the card.
const out = {
  hello: () => ({}),
  ping: () => ({}),
  // (when it was said goes in with it: the server keeps only when it came. A row of the chat as it stood has no name: the
  // server puts those in place of what it kept, and tells none from another, and several of them are one message's and
  // would share one. Every other row has one: a row this computer has no name for (a notice of its own) is given one
  // made of nothing, so that it is not told from the rest by having none)
  rows: ({ rows, hist, asked }, ts) => ({
    ...(hist ? { hist: true } : {}),
    ...(asked ? { asked } : {}),
    rows: rows.map((row) => ({ ...(hist ? {} : { id: nameOf(row.uuid || randomId(), sealKey) }), row: seal({ ts, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) }, sealKey) })),
  }),
  card: (card) => ({ card: seal(card, sealKey) }),
  part: ({ clear, ...piece }) => (clear ? { clear: true } : { text: seal(piece, sealKey) }),
  request: ({ rid, ...asked }) => ({ rid, q: seal(asked, sealKey) }),
  resolved: ({ rid, ...how }) => ({ rid, a: seal(how, sealKey) }),
  result: ({ id, ok, value, error }) => ({ id, ok: !!ok, r: seal(ok ? { value } : { error }, sealKey) }),
  notify: (said) => ({ n: seal(said, sealKey) }),
  answer: ({ asked, ...came }) => ({ asked, a: seal(came, sealKey) }),
  'session.end': () => ({}),
}

// One thing of a session's, sealed and put in the queue
function put(sid, type, data = {}) {
  const ts = Date.now()
  // (a session said hello for is one whose card is to go)
  if (type === 'hello') cardChanged(true)
  queue.push({ sid, ts, sealed: 3, type, ...out[type](data, ts) })
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
}

// The same, of the session this is now: nothing, of one that has ended
async function emit($, type, data) {
  const sid = await currentSessionId($)
  if (endedIds.has(sid)) return
  put(sid, type, data)
}

// What a batch goes with: that it is sealed whole (2), and that the session does what it
// is asked on a signed order alone. What the session is goes in its card.
const batchOf = (events) => ({ protocol: PROTOCOL, meta: { protocol: PROTOCOL, sealed: 3, orders: true }, events })

// The card: everything a session says of itself, as the page shows it
function cardNow() {
  const now = Date.now()
  return {
    ...meta,
    state,
    detail: cap(stateDetail, 2000),
    since: stateSince,
    topic,
    prompt: lastPrompt,
    reply: lastReply,
    preview,
    ...usageNow,
    permissionMode,
    effort: effortNow ?? null,
    agents: [...subagents.values()].filter((a) => now - a.lastActivity < AGENT_IDLE_MS).sort((a, b) => a.startedAt - b.startedAt),
  }
}
function cardChanged(urgent = false) {
  cardDirty = true
  if (urgent) cardUrgent = true
}
// The card as it stands, put in the queue where it has changed and may go
function sendCard() {
  if (!cardDirty || !sessionId || !(cardUrgent || Date.now() - cardSent >= CARD_MS)) return
  cardDirty = cardUrgent = false
  cardSent = Date.now()
  put(sessionId, 'card', cardNow())
}

// The chat's rows, made here (rows.js): sent, and what the session is about kept from
// them for its card (its first prompt, the last thing its user typed and what Claude has said
// since, and the last thing said by either)
async function emitRows($, rows, { hist = false, asked } = {}) {
  if (!rows.length && !asked) return
  const sid = await currentSessionId($)
  if (endedIds.has(sid)) return
  // (of a prompt, what was typed: Claude in Chrome's instructions, which the app puts in front of a prompt typed
  // in VS Code for Claude to read, are some thousands of characters of what nobody typed)
  const said = (r) => (r?.role === 'user' ? String(r.text ?? '').replace(/<browser_instruction>[\s\S]*?<\/browser_instruction>\s*/g, '').trim() : String(r?.text ?? ''))
  // (what its user typed to it: a prompt, from wherever it was typed. Not a slash command or a shell line, which
  // are typed too but say nothing of what is wanted, and not what the app wrote to Claude by itself.)
  const typed = (r) => r.role === 'user' && r.origin !== 'engine' && !!said(r) && !/^(\/[\w:.-]+(\s|$)|! )/.test(said(r))
  if (hist) {
    const first = rows.find((r) => r.role === 'user' && said(r))
    if (first) topic = said(first).slice(0, 120)
    const mine = rows.findLastIndex(typed)
    if (mine >= 0) lastPrompt = said(rows[mine]).slice(0, 200)
    lastReply = said(rows.slice(mine + 1).findLast((r) => r.role === 'assistant')).slice(0, 200)
    const last = rows.findLast((r) => r.role === 'user' || r.role === 'assistant')
    if (last) preview = said(last).slice(0, 200)
  } else {
    for (const r of rows) {
      if (r.role === 'user' && !topic) topic = said(r).slice(0, 120)
      if (typed(r)) [lastPrompt, lastReply] = [said(r).slice(0, 200), '']
      else if (r.role === 'assistant') lastReply = said(r).slice(0, 200)
      if (r.role === 'user' || r.role === 'assistant') preview = said(r).slice(0, 200)
    }
  }
  cardChanged()
  put(sid, 'rows', { rows, hist, asked })
}

// The subagents a session has running now, for its card. One starts with the classic
// SubagentStart hook, described by the agent.spawn just before it, and is over at its
// SubagentStop or as its turn ends. Claude Code also stops helpers of its own that never
// started as subagents (the ones that summarize a background agent's progress): those
// aren't counted.
function agentStarted(e) {
  const id = typeof e.agent_id === 'string' ? e.agent_id : ''
  if (!id) return
  const spawn = spawns.shift()
  const now = Date.now()
  subagents.set(id, { id, type: String(e.agent_type || spawn?.type || ''), description: spawn?.description ?? '', background: !!spawn?.background, startedAt: now, lastActivity: now })
  cardChanged()
}
function agentGone(id) {
  if (subagents.delete(id)) cardChanged()
}
// One was heard of (a row of its own, a call, a request to the model): it is still at work.
// `known: false`: one that was already running when this process first heard of it is taken up.
function agentHeard(id, { known = true } = {}) {
  if (typeof id !== 'string' || !id) return
  const now = Date.now()
  if (subagents.has(id)) subagents.get(id).lastActivity = now
  else if (!known) {
    subagents.set(id, { id, type: '', description: '', background: false, startedAt: now, lastActivity: now })
    cardChanged()
  }
}

// A step of the turn is done: what streamed of it and has not gone is late, and the
// pieces that went are done with
function stepDone(e) {
  stepsDone.add(e.turnId + '|' + e.index)
  for (const [key, d] of deltas) if (d.turnId === e.turnId && d.index === e.index) deltas.delete(key)
  partDone()
}
function partDone() {
  if (sessionId) put(sessionId, 'part', { clear: true })
}

// Something for the account's phones: the server passes it on to the devices that asked
// for notifications, and reads none of it
function tellPhones(kind, body, { title, prefix = '' } = {}) {
  if (!sessionId) return
  const folder = String(meta.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
  put(sessionId, 'notify', { kind, title: title || topic.slice(0, 80) || folder, body: String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 240), prefix, where: meta.label || meta.host || '' })
}

// A turn is over, and what there is to say of that is said here, where it can be read:
// the chat's line where it did not end in an answer, word to a phone where it took a
// while and nobody stopped it, and its answer where the server asked for it.
async function turnDone($, e) {
  partDone()
  if (e.reason === 'aborted') await emitRows($, [{ uuid: e.turnId + ':end', role: 'notice', text: 'Interrupted' }])
  else if (e.reason && e.reason !== 'answer') await emitRows($, [{ uuid: e.turnId + ':end', role: 'notice', text: 'Turn ended: ' + e.reason }])
  if (e.reason !== 'aborted' && !e.isAborted && Number(e.durationMs) >= DONE_WORTH_MS && attended) {
    if (e.reason && e.reason !== 'answer') tellPhones('done', 'Stopped: ' + e.reason)
    else if (typeof e.answer === 'string' && e.answer) tellPhones('done', e.answer, { prefix: 'Done: ' })
    else tellPhones('done', 'Claude has finished.')
  }
  if (answerAsked && answerTurn === e.turnId) {
    await emit($, 'answer', { asked: answerAsked, text: cap(e.answer, ANSWER_FIELD), reason: e.reason, aborted: !!e.isAborted })
    answerGiven = answerAsked
    answerAsked = ''
    answerTurn = null
  }
}

async function setState($, next, detail = '') {
  if (next === state && !detail) return
  await currentSessionId($)
  const was = state
  if (next !== was) stateSince = Date.now()
  state = next
  stateDetail = detail
  cardChanged(true)
  // (said to the account's phones here, as it starts to need someone: the server cannot tell that it does)
  if (next === 'attention' && was !== 'attention') tellPhones('needs', detail || 'Claude is waiting', { prefix: 'Needs you: ' })
}

// A row a conversation keeps, as the engine has it. Of the main conversation's, the
// chat's rows are made (rows.js). Of a subagent's, that it is still at work.
async function recordRow($, e) {
  const { door, uuid, message, agentId } = e
  await currentSessionId($)
  agentHeard(agentId)
  // (what the engine adds beside the conversation, reminders and memory files, is no row of the chat)
  if (door === 'attachment' || (door === 'tool-result' && !policy.toolResults)) return
  if (!agentId) {
    await noteSetting($, message.content)
    await emitRows($, messageRows({ uuid, door, isMeta: !!message.isMeta, origin: cap(e.origin, 300), blocks: normalizeBlocks(message.content, policy.maxField) }))
    // (the reply is in the chat now: what streamed of it is done with)
    if (door === 'response') partDone()
  }
  if (door === 'response' && state === 'attention' && !pendingList.length) await setState($, 'working')
}

// The effort and the model, on the card when they change. The mods API has a getter for
// the model and none for the effort, so the effort is taken from wherever it shows: each
// request to the model, the hooks inside a tool call, and what /effort answers.
function noteEffort(level) {
  if (level === effortNow) return
  effortNow = level
  cardChanged(true)
}

async function noteModel($) {
  const model = await $.session.model()
  if (model === meta.model) return
  meta.model = model
  cardChanged(true)
}

// A local command's answer in the transcript: /effort and /model say what they set
async function noteSetting($, content) {
  const text = typeof content === 'string' ? content : flattenText(content)
  if (!text.includes('<local-command-stdout>')) return
  const said = settingSaid(text)
  if (!said) return
  if ('effort' in said) noteEffort(said.effort)
  if (said.model) await noteModel($)
}

async function notified($, e) {
  if (e.notification_type === 'idle_prompt') return
  // A question is asked through the permission prompt too: what it asks says more than "needs your permission"
  if (e.notification_type === 'permission_prompt' && state === 'attention' && /^Question: /.test(stateDetail)) return
  const what = e.notification_type === 'permission_prompt' && lastTool ? ': ' + lastTool : ''
  await setState($, 'attention', e.message + what)
}

function addDelta(e, chunk) {
  if (stepsDone.has(e.turnId + '|' + e.index)) return
  const key = e.turnId + '|' + e.index + '|' + chunk.index
  const d = deltas.get(key) ?? { turnId: e.turnId, index: e.index, block: chunk.index, text: '' }
  d.text += chunk.text
  deltas.set(key, d)
}

function sendDeltas() {
  if (!sessionId || !deltas.size) return
  for (const d of deltas.values()) if (d.text) put(sessionId, 'part', d)
  deltas.clear()
}

function authHeaders(json) {
  const h = { authorization: 'Bearer ' + config.token }
  if (json) h['content-type'] = 'application/json'
  return h
}

async function flush($) {
  if (isFlushing || !config) return
  sendDeltas()
  sendCard()
  if (!queue.length) {
    if (Date.now() - lastSent < PING_MS || !sessionId) return
    put(sessionId, 'ping')
  }
  isFlushing = true
  const batch = queue.slice(0, MAX_BATCH)
  try {
    const r = await $.http.fetch(config.url + '/api/agent/events', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(batchOf(batch)),
    })
    // A refused batch is dropped, so one bad thing in it can't block the rest
    if (r.ok || r.status === 400 || r.status === 413) queue.splice(0, batch.length)
    if (r.ok) lastSent = Date.now()
    else warn($, 'server answered ' + r.status + ' to events')
    // (the server has taken this computer's token: the agent beside this plugin, if there is one, is given the same)
    if (r.ok) void tellAgent($)
  } catch (err) {
    // Server unreachable: what is in the queue is kept for the next flush
    warn($, 'server unreachable: ' + (err?.message ?? err))
  } finally {
    isFlushing = false
  }
}

// ---- The machine's agent, where there is one: given what this plugin was given.
// A person types their API token and passphrase once, into this plugin's own dialog
// (Manage Plugins). The agent beside it signs in with the same token and seals with the
// same key, and its installer, which Claude Code runs, asks for neither: the agent waits.
// So once the server has taken this plugin's token, what the agent keeps (agent.json, in
// ~/.manyclaws) is looked at, and where it has no token, or another, or another key, it
// is left a note of the two in its own folder, which only this user can read. The agent
// takes them from there and starts again. The key goes written out as a computer keeps
// it (mcf_…), never the passphrase. Only for an agent that reports to the server this
// plugin does: one set up for another server is left alone, and so is one this plugin
// reports through (its relay), where what this plugin signs in with is the relay's word.
// Looked at again every half minute a session is sending: an agent installed while a
// session runs is found by that session, and so is one whose key has gone by.
const AGENT_LOOK_MS = 30_000
let agentLookedAt = 0
const sameServer = (a, b) => String(a ?? '').replace(/\/+$/, '').toLowerCase() === String(b ?? '').replace(/\/+$/, '').toLowerCase()
// The agent's folder and what it keeps there (agent.json), or null where there is no agent
async function agentKeeps($) {
  const home = (await $.env.get('MANYCLAWS_HOME')) || ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '') + '/.manyclaws'
  if (home === '/.manyclaws' || !(await $.fs.exists(home + '/agent.json'))) return null
  return { home, kept: JSON.parse(await $.fs.read(home + '/agent.json')) }
}
// Where this plugin reports through the machine's agent (its relay): the agent's installer
// gave it the relay's own word for a token, and that word is how it knows. What the agent
// keeps says which port. Any other token goes to the server.
async function relayOf($, token) {
  try {
    const relay = (await agentKeeps($))?.kept.relay
    return relay?.port && relay.secret && relay.secret === token ? 'http://127.0.0.1:' + relay.port : null
  } catch {
    return null
  }
}
// Which machine's agent is beside this plugin, said on the session's card: the id its
// agent.json keeps, or that there is none (null). Whether that agent is running is not
// read off this computer: the page knows whether the server hears it, and says of a
// computer whose sessions report while its agent does not that the agent is not running,
// and of one with no agent that it has none. Looked at when the agent's folder is, once
// the server has taken this plugin's token and every half minute after: so an agent
// installed or taken away while a session runs is on its card, and a session the server
// does not hear looks for nothing.
async function findAgent($) {
  let agent
  try {
    agent = await agentKeeps($)
  } catch {
    // (what is there could not be read: nothing new is said of it)
    return null
  }
  const found = agent ? { id: typeof agent.kept?.id === 'string' && agent.kept.id ? agent.kept.id : null } : null
  if (JSON.stringify(found) !== JSON.stringify(meta.agent)) {
    meta.agent = found
    cardChanged(true)
  }
  return agent
}
async function tellAgent($) {
  if (!config || Date.now() - agentLookedAt < AGENT_LOOK_MS) return
  agentLookedAt = Date.now()
  try {
    const agent = await findAgent($)
    if (!agent) return
    const { home, kept } = agent
    if (kept.server && !sameServer(kept.server, config.url)) return
    const key = keysText({ key: config.key, checker: config.checker })
    // (it has both already: nothing is written. An agent that keeps the two in the system's keychain has a fingerprint
    // of them here in their place, made as agent/secrets.mjs makes it.)
    const has = toB64(sha256(new TextEncoder().encode(`manyclaws agent has v1|${config.token}|${key}`))).slice(0, 22)
    if ((kept.token === config.token && kept.key === key) || kept.has === has) return
    await $.fs.write(home + '/from-plugin.json', JSON.stringify({ server: config.url, token: config.token, key }))
  } catch {}
}

// One line in the transcript the first time something goes wrong, not on every retry
function warn($, text) {
  if (hasWarned) return
  hasWarned = true
  $.ui.log('ManyClaws: ' + text)
}

// ---- Calls in

// Long-polls the server for calls and policy
async function poll($) {
  if (!config) return
  let delay = 1
  try {
    const sid = await currentSessionId($)
    // A session that has ended is not asked for. Nothing here can call a poll off, and one held open for it would keep
    // a process on its way out from going (a -p run's, whose last poll it waits for). After /clear or a resume
    // there is another session soon, which is looked for again.
    if (endedIds.has(sid)) {
      $.clock.after(ENDED_MS, () => poll($))
      return
    }
    // How long the server may hold this asking: two seconds, whoever is at the session or nobody. A session a program
    // runs (claude -p, an editor's panel, the machine's agent) sends nothing while a poll of its is open, and a process
    // on its way out waits for the one it has: held for twenty seconds, a permission prompt reached the page that much
    // late and a -p run went that much late. A longer wait for sessions in a terminal alone, which are not held up so,
    // would say which those are, and that is on the card. The server answers at once when it has something to send, so
    // nothing waits on this: it is only how often an idle session asks again. (Nor is it said which load of the plugin asks.)
    const q = `session=${encodeURIComponent(sid)}&after=${cursor}&pv=${policy.version}&wait=${POLL_WAIT_S}&sealed=3`
    const r = await $.http.fetch(config.url + '/api/agent/poll?' + q, { headers: authHeaders() })
    if (r.ok) {
      const body = JSON.parse(r.text)
      // (the server has taken this computer's token: its own two tools are put before Claude)
      await addTools($)
      // Where the account has its prompts answered, and how much a session sends: which grant nothing, since an answer
      // still has to be signed
      if (body.policy) policy = mergePolicy(policy, body.policy)
      // The server wants this session's chat (it holds nothing of it): answered once for
      // each time it asks. Asked for nothing, the history a session starts with goes now.
      if (typeof body.history === 'string' && body.history && body.history !== historyAsk && sid === sessionId) {
        historyAsk = body.history
        historyOwed = false
        void sendHistory($, historyAsk)
      } else owedHistory($)
      // The server wants the answer of this session's next turn, by a name (a handoff it
      // passes on): the turn that is running, if one is, else the next to start
      if (typeof body.answer === 'string' && body.answer && body.answer !== answerAsked && body.answer !== answerGiven && sid === sessionId) {
        answerAsked = body.answer
        answerTurn = runningTurn
      }
      // The list of the account's devices is read before an order is gone by: here, before anything in this answer is
      // counted as taken. From the count on, an order goes to what runs it with nothing waited for between. Were the
      // list read after the count, a load of the plugin that went while it was being read (a reload) would have kept
      // that it took the order and never run it, and the load after it would tell the server so: the order would be gone.
      if ((body.commands ?? []).some((command) => command.seq > cursor && isOrder(command.order))) await freshDevices($)
      // (and read every so often with no order to go by, the first time as the session is taken up: DEVICES_EVERY_MS.
      // Those readings are apart from the one an order waits for: an order from a browser that was given the passphrase
      // a moment ago is gone by the list as it stands then, not by one read just before the browser was on it.)
      else if (devicesLookedAt === null || (await $.clock.now()) - devicesLookedAt >= DEVICES_EVERY_MS) {
        devicesLookedAt = await $.clock.now()
        await readDevices($)
      }
      let ran = false
      for (const command of body.commands ?? []) {
        if (!(command.seq > cursor)) continue
        cursor = command.seq
        ran = true
        // Calls run side by side, so a slow one doesn't hold up the poll
        void execute($, command)
      }
      if (ran) await $.store.set('cursor:' + sid, cursor)
    } else delay = r.status === 401 ? 60_000 : RETRY_MS
  } catch {
    delay = RETRY_MS
  }
  $.clock.after(delay, () => poll($))
}

// Its own two tools (OWN_TOOLS), put before Claude: these and no others, since a tool's
// name and what it is said to do are words the model reads, and the server has none to
// add. Once: one that could not be put there is said in the chat, in a row sealed as any
// other, and is not tried again.
let toolsTried = false
async function addTools($) {
  if (toolsTried) return
  toolsTried = true
  for (const t of OWN_TOOLS) {
    try {
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema })
      added.add(t.name)
      $.ui.invalidate('tool.describe')
    } catch (err) {
      await emitRows($, [{ role: 'notice', text: `ManyClaws could not add its tool ${t.name}: ${err?.message ?? err}` }])
    }
  }
}
const isOwnTool = (tool) => tool.startsWith(TOOL_PREFIX) && added.has(tool.slice(TOOL_PREFIX.length))

// The account's devices, as the server has them now: read before an order is gone by (as
// a poll brings one, and as an answer to something the session asked comes), so that one
// from a device taken off the list is refused from then on. The list is the
// account's own (the passphrase signed it, and it is sealed with the key), so the server
// can only hand one over or not: a list is taken where it is the account's and no older
// than the one held (seal.js, devicesMemory), and where the server hands over anything
// else, or cannot be reached, the one held stands.
async function readDevices($) {
  try {
    const r = await $.http.fetch(config.url + '/api/agent/devices', { headers: authHeaders() })
    if (r.ok) devices.take(JSON.parse(r.text).devices)
  } catch {}
}
async function freshDevices($) {
  const now = await $.clock.now()
  // (orders that come together are gone by one reading, which each of them waits for)
  if (!devicesRead || now - devicesRead.at >= DEVICES_MS) devicesRead = { at: now, done: readDevices($) }
  await devicesRead.done
}

// What a session is asked comes one of three ways, and never as a method's name and
// arguments in the open. Signed (`order`): a prompt, or a call that acts, with all of it in
// the order. Sealed (`c`): a call that only reads. Or in the open, from the server or from
// anyone signed in: what only stops. A throw says why not.
const unsigned_ = (why) => new Error(`this session is end-to-end encrypted, and does what it is asked only when a device that has your passphrase signed it: ${why}`)
function asked(command) {
  if (isOrder(command.order)) {
    // (a session a program runs is given its prompts by that program, which is its machine's agent: the agent takes the order,
    // and one order is not to be run by both. So it is read before it is taken.)
    const read = readOrder(command.order, sealKey, devices.list)
    if (read?.do === 'prompt' && !attended) throw unsigned_('this session takes its prompts from the program that runs it')
    let taken
    try {
      taken = takeOrder(command.order, { key: sealKey, devices: devices.list, to: sessionId, does: ['prompt', 'call'], seen: orders })
    } catch (err) {
      if (!(err instanceof OrderRefused)) throw err
      throw unsigned_(err.message)
    }
    if (taken.do === 'prompt') return { method: 'prompt.submit', args: { text: String(taken.with.text ?? ''), force: taken.with.force === true ? true : undefined } }
    return { method: String(taken.with.method ?? ''), args: taken.with.args && typeof taken.with.args === 'object' ? taken.with.args : {} }
  }
  if (isSealed(command.c)) {
    const what = open(command.c, sealKey, null)
    if (!what || typeof what !== 'object') throw unsigned_('it was not sealed with the key this computer was given')
    const method = String(what.method ?? '')
    if (!READS.has(METHOD_CAPABILITY[method]) && !STOPS.has(method)) throw unsigned_('it did not come signed by one of your devices')
    return { method, args: what.args && typeof what.args === 'object' ? what.args : {} }
  }
  if (STOPS.has(command.method)) return { method: command.method, args: {} }
  throw unsigned_('it did not come signed by one of your devices')
}

// What a session does for whoever asks: what only reads (its answers go back sealed, to
// be read by the account's own devices) and what only stops. Everything else acts, and is
// done on an order alone.
const READS = new Set(['core', 'inspect', 'files'])
const STOPS = new Set(['turn.abort'])

// Runs one call, and says what it came to: sealed, under the call's id, with whether it ran
async function execute($, command) {
  const { id } = command
  let method
  let args = {}
  try {
    ;({ method, args } = asked(command))
    const capability = METHOD_CAPABILITY[method]
    if (!capability) throw new Error('unknown method ' + method)
    if (!caps.has(capability)) throw new Error(`${method} needs the "${capability}" capability, which this machine's ManyClaws config doesn't grant`)
    const value = await call($, method, args)
    await emit($, 'result', { id, ok: true, value: cap(value, MAX_RESULT) })
  } catch (err) {
    const why = String(err?.message ?? err).slice(0, 4000)
    // A reply that did not go through says so in the chat, with why: the server cannot
    // write that line, so it is written here (the reply itself too, where it was read)
    if (isOrder(command.order) && (method === 'prompt.submit' || method === undefined)) {
      await emitRows($, [...(method === 'prompt.submit' && args.text ? [{ role: 'user', text: String(args.text), origin: 'plugin' }] : []), { role: 'notice', text: 'Not sent: ' + why }])
    }
    await emit($, 'result', { id, ok: false, error: why })
  }
}

async function call($, method, args) {
  switch (method) {
    case 'ping':
      return { pong: true, instance, protocol: PROTOCOL, plugin: PLUGIN_VERSION, at: Date.now() }
    case 'session.info':
      return sessionInfo($)
    case 'session.messages': {
      const all = await $.session.messages(args.agentId ? { agentId: String(args.agentId) } : undefined)
      if (!Array.isArray(all)) return all
      const limit = Number(args.limit) || all.length
      return cap(all.slice(-limit), Number(args.maxField) || policy.maxField)
    }
    case 'session.usage':
      return $.session.usage(args.breakdown ? { breakdown: args.breakdown, columns: args.columns } : undefined)
    case 'command.list':
      return $.command.list()
    case 'tool.list':
      return cap(await $.tool.list(), 2000)
    case 'agent.list':
      return cap(await $.agent.list())
    case 'config.list':
      return cap(await $.config.list())
    case 'prompt.read':
      return $.prompt.read()
    case 'prompt.compose':
      return cap(await $.prompt.compose(), Number(args.maxField) || 20_000)
    case 'tool.check':
      return $.tool.check({ tool: String(args.tool), input: args.input ?? {} })
    case 'prompt.submit':
      return submitPrompt($, args)
    case 'command.run':
      return runCommand($, args)
    case 'turn.abort':
      if (!runningTurn) return { aborted: false, reason: 'no turn is running' }
      await $.turn.abort({ turnId: runningTurn })
      return { aborted: true }
    case 'prompt.fill':
      return $.prompt.fill({ text: String(args.text ?? ''), mode: args.mode })
    case 'prompt.suggest':
      return $.prompt.suggest({ text: String(args.text ?? '') })
    case 'session.compact':
      return cap(await $.session.compact(args.instructions ? { instructions: String(args.instructions) } : undefined))
    case 'session.note':
      return cap(await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: String(args.text ?? '') }] } }), 2000)
    case 'agent.spawn':
      return cap(await $.agent.spawn(pick({ prompt: String(args.prompt ?? '') }, args, ['description', 'subagentType', 'model', 'name', 'cwd'])))
    case 'ui.toast':
      $.ui.toast(String(args.text ?? ''), args.timeoutMs ? { timeoutMs: Number(args.timeoutMs) } : undefined)
      return { shown: true }
    case 'ui.status':
      $.ui.status(args.text === null || args.text === undefined ? undefined : String(args.text))
      return { shown: true }
    case 'ui.log':
      $.ui.log(String(args.text ?? ''))
      return { shown: true }
    case 'ui.notice':
      $.ui.notice(String(args.toolUseId ?? ''), args.text === null || args.text === undefined ? undefined : String(args.text))
      return { shown: true }
    case 'ui.copy':
      return $.ui.copy({ text: String(args.text ?? '') })
    case 'audio.speak':
      return cap(await $.audio.speak(String(args.text ?? ''), args.options))
    case 'audio.play':
      await $.audio.play(args.clip, args.options)
      return { played: true }
    case 'session.send':
      return $.session.send({ to: args.to, text: String(args.text ?? '') })
    case 'tool.call':
      return cap(await $.tool.call({ ...(args.input ?? {}), tool: String(args.tool) }), Number(args.maxField) || policy.maxField)
    case 'fs.read':
      return $.fs.read(String(args.path))
    case 'fs.list':
      return $.fs.list(args.path === undefined ? undefined : String(args.path))
    case 'fs.stat':
      return $.fs.stat(String(args.path))
    case 'fs.exists':
      return $.fs.exists(String(args.path))
    case 'fs.ancestors':
      return $.fs.ancestors(pick({ names: (args.names ?? []).map(String) }, args, ['of', 'below']))
    case 'fs.write':
      await $.fs.write(String(args.path), String(args.text ?? ''))
      return { written: true }
    case 'process.run': {
      if (!Array.isArray(args.argv) || !args.argv.length) throw new Error('argv must be a non-empty array')
      return $.process.run(args.argv.map(String), pick({}, args, ['cwd', 'env', 'stdin', 'timeoutMs']))
    }
    case 'model.complete':
      return $.model.complete(pick({ model: String(args.model ?? 'haiku'), prompt: String(args.prompt ?? '') }, args, ['system', 'maxTokens', 'timeoutMs', 'effort']))
    case 'model.classify':
      return $.model.classify(String(args.text ?? ''), (args.labels ?? []).map(String), args.options)
    case 'model.fork':
      return $.model.fork(pick({ prompt: String(args.prompt ?? '') }, args, ['maxTokens', 'timeoutMs']))
    case 'config.set':
      return cap(await $.config.set({ key: String(args.key), value: args.value }))
    case 'settings.read':
      return cap(await $.settings.read(args.source ? { source: args.source } : undefined))
    case 'mcp.call':
      return cap(await $.mcp.call(String(args.server), String(args.tool), args.args ?? {}), Number(args.maxField) || policy.maxField)
    case 'mcp.connect':
      return cap(await $.mcp.connect(String(args.server)))
  }
  throw new Error('unknown method ' + method)
}

function pick(base, from, keys) {
  for (const k of keys) if (from[k] !== undefined && from[k] !== null) base[k] = from[k]
  return base
}

async function sessionInfo($) {
  return {
    id: await $.session.id(),
    cwd: await $.session.cwd(),
    root: await $.session.root(),
    model: await $.session.model(),
    turns: await $.session.turns(),
    repo: await $.session.repo(),
    surfaces: await $.session.surfaces(),
    version: await $.session.version(),
    usage: cap(await $.session.usage()),
    meta,
    policy,
    state,
    runningTurn,
    pending: pendingList.map((p) => ({ rid: p.rid, kind: p.kind })),
  }
}

// A reply such as "/compact" or "/model sonnet" is a slash command, which
// prompt.submit refuses
async function submitPrompt($, args) {
  const text = String(args.text ?? '')
  if (!text.trim()) throw new Error('empty prompt')
  const slash = parseSlash(text)
  if (slash) return runCommand($, { ...slash, force: args.force })
  // Resolves once the prompt's turn starts, which waits for the session to be idle
  await $.prompt.submit(args.framed ? { text } : { text, asUser: true })
  return { submitted: true }
}

// Most built-in commands open a panel in the terminal that waits for a key there,
// and everything sent after one would queue behind it, so those are refused
// unless the caller passes force
async function runCommand($, args) {
  const command = String(args.command ?? '').replace(/^\//, '')
  const commandArgs = String(args.args ?? '')
  if (!command) throw new Error('no command')
  if (!args.force && !TEXT_COMMANDS.has(command) && !(commandArgs && VALUE_COMMANDS.has(command))) {
    const found = (await $.command.list()).find((c) => c.name === command)
    const refusal = commandRefusal(command, commandArgs, found)
    if (refusal) throw new Error(refusal)
  }
  if (command === 'model' && commandArgs) modelAskedUntil = Date.now() + 15_000
  const result = await $.command.run({ command, args: commandArgs })
  return { text: cap(result?.text, policy.maxField), context: cap(result?.context, 4000) }
}

// ---- Requests the page answers: approvals and questions

// Where a request is asked: 'remote' (on the page, and in the band above the prompt where
// the app draws one), 'local' (in the app's own dialog only), or 'both' (the app's own
// dialog and the page, and the first answer counts).
async function routeOf($, kind) {
  if (!caps.has('approve')) return 'local'
  const mode = policy[kind]
  if (mode === 'remote') return 'remote'
  if (mode !== 'auto') return 'local'
  // Nobody to ask here (claude -p, an SDK script): the page
  if (!attended) return 'remote'
  // A terminal or Desktop draws the band above the prompt, so routed to the page
  // the request is asked in both places, and the first answer wins
  const surfaces = await $.session.surfaces()
  if (surfaces.some((s) => s === 'terminal' || s === 'desktop')) return 'remote'
  // An app that can't draw the band (VS Code's panel) asks in its own dialog. The page
  // asks as well: the engine takes an answer given through a hook while that dialog is
  // up, and tells the app to close it.
  return 'both'
}

// The id a request's answer comes back by, which is in the open. It is the same kind of
// id whatever is asked: one that began by its kind would say which the session asks, a
// permission or a question.
const requestId = () => 'r_' + randomId()

function forget(rid) {
  const i = asking.findIndex((a) => a.rid === rid)
  if (i >= 0) asking.splice(i, 1)
}

// The page's answer to a permission prompt the app is asking in its own dialog, as a
// classic PermissionRequest decision; null when the dialog was answered first (or the
// turn was interrupted, or this prompt isn't one the page was shown).
async function pageDecision($, e, hook) {
  const input = JSON.stringify(e.tool_input ?? null)
  const mine = asking.filter((a) => a.tool === e.tool_name)
  const found = mine.find((a) => JSON.stringify(a.input ?? null) === input) ?? (mine.length === 1 ? mine[0] : null)
  if (!found) return null
  forget(found.rid)
  await flush($)
  const answer = await awaitAnswer($, found.rid, hook, found.request, 0)
  if (answer.decision !== 'allow' && answer.decision !== 'deny') return null
  // (what came of it is reported when the call ends, as for one answered in the dialog)
  answeredBy.set(found.rid, answer.by ?? 'server')
  await setState($, 'working')
  if (answer.decision === 'allow') return { behavior: 'allow' }
  return { behavior: 'deny', message: 'The user denied this from ManyClaws' + (answer.reason ? ': ' + answer.reason : '') }
}

async function approve($, e, decided, hook) {
  const rid = requestId()
  const summary = summarizeInput(e.input)
  const route = await routeOf($, 'approvals')
  const remote = route === 'remote'
  const request = {
    rid,
    kind: 'approval',
    toolUseId: e.tool_use_id,
    tool: e.tool,
    summary,
    input: cap(e.input, Math.max(policy.maxField, 50_000)),
    reason: cap(decided?.reason, 2000),
    route,
  }
  lastTool = e.tool + ' ' + summary
  await emit($, 'request', request)
  await setState($, 'attention', 'Permission: ' + lastTool)
  if (!remote) {
    localApprovals.set(e.tool_use_id, rid)
    // The app's own dialog; in both places, the page's answer comes in by pageDecision
    if (route === 'both') asking.push({ rid, tool: e.tool, input: e.input, request })
    return decided
  }
  await flush($)
  showPending($, { rid, kind: 'approval', tool: e.tool, summary })
  const answer = await awaitAnswer($, rid, hook, request, policy.remoteTimeoutMs)
  hidePending($, rid)
  let decision = answer.decision
  if (decision === 'timeout') decision = policy.onTimeout === 'deny' ? 'deny' : 'ask'
  await emit($, 'resolved', { rid, decision, by: answer.by ?? 'server', reason: cap(answer.reason, 2000) })
  if (decision === 'allow') {
    await setState($, 'working')
    return { decision: 'allow', reason: 'Allowed from ManyClaws' + (answer.by === 'terminal' ? ' (at the terminal)' : '') }
  }
  if (decision === 'deny') {
    await setState($, 'working')
    const why = answer.reason ? ': ' + answer.reason : ''
    return { decision: 'deny', reason: (answer.by === 'timeout' ? 'Nobody answered in time' : 'The user denied this from ManyClaws') + why }
  }
  // "ask", the server unreachable, or the turn interrupted: the terminal's own dialog
  localApprovals.set(e.tool_use_id, rid)
  return decided
}

async function askQuestion($, e, next) {
  const { tool, tool_use_id: toolUseId, agentId, ...input } = e
  const questions = Array.isArray(input.questions) ? input.questions : []
  const rid = requestId()
  const route = await routeOf($, 'questions')
  const remote = route === 'remote'
  const request = { rid, kind: 'question', toolUseId, agentId, questions: cap(questions, policy.maxField), route }
  await emit($, 'request', request)
  agentHeard(agentId)
  await setState($, 'attention', 'Question: ' + (questions[0]?.question ?? ''))
  if (remote) {
    await flush($)
    showPending($, { rid, kind: 'question', questions })
    const answer = await awaitAnswer($, rid, next, request, policy.remoteTimeoutMs)
    hidePending($, rid)
    if (answer.decision === 'answer' && answer.answers && typeof answer.answers === 'object') {
      const answers = {}
      for (const [k, v] of Object.entries(answer.answers)) answers[k] = Array.isArray(v) ? v.join(', ') : String(v)
      await emit($, 'resolved', { rid, decision: 'answer', by: answer.by ?? 'server', answers })
      await setState($, 'working')
      return { result: { questions, answers } }
    }
    if (answer.decision === 'timeout' && policy.onTimeout === 'deny') {
      await emit($, 'resolved', { rid, decision: 'declined', by: 'timeout' })
      return { deny: 'Nobody answered the question in time.' }
    }
    if (answer.decision === 'decline') {
      await emit($, 'resolved', { rid, decision: 'declined', by: answer.by ?? 'server' })
      return { deny: 'The user declined to answer' + (answer.reason ? ': ' + answer.reason : '.') }
    }
    await emit($, 'resolved', { rid, decision: 'ask', by: answer.by ?? 'server' })
  }
  // The app's own dialog. In both places the page asks too, and an answer from it that
  // comes first is the answer: returning it here ends the dialog (the engine tells the
  // app to close it).
  const watch = { done: false }
  const asked = next(e).then((result) => ({ result }))
  const paged = route === 'both' ? flush($).then(() => awaitAnswer($, rid, next, request, 0, watch)).then((answer) => ({ answer })) : null
  let first = await (paged ? Promise.race([asked, paged]) : asked)
  watch.done = true
  if (first.answer?.decision === 'answer' && first.answer.answers && typeof first.answer.answers === 'object') {
    const answers = {}
    for (const [k, v] of Object.entries(first.answer.answers)) answers[k] = Array.isArray(v) ? v.join(', ') : String(v)
    await emit($, 'resolved', { rid, decision: 'answer', by: first.answer.by ?? 'server', answers })
    await setState($, 'working')
    return { result: { questions, answers } }
  }
  if (first.answer?.decision === 'decline') {
    await emit($, 'resolved', { rid, decision: 'declined', by: first.answer.by ?? 'server' })
    await setState($, 'working')
    return { deny: 'The user declined to answer' + (first.answer.reason ? ': ' + first.answer.reason : '.') }
  }
  // (anything else from the page's side, the turn interrupted or the server gone, leaves it to the dialog)
  if (!first.result) first = await asked
  const { result } = first
  await emit($, 'resolved', {
    rid,
    decision: typeof result?.deny === 'string' ? 'declined' : 'answer',
    by: 'terminal',
    answers: cap(result?.result?.answers),
  })
  if (state === 'attention') await setState($, 'working')
  return result
}

// Its own two tools, answered here: the server is asked for nothing but to pass a
// notification on and to hand a photo over, sealed as the page kept it
async function ownTool($, name, input) {
  if (name === 'notify_user') {
    await currentSessionId($)
    tellPhones('notify', String(input?.message ?? ''), { title: input?.title ? String(input.title).slice(0, 200) : undefined })
    await emitRows($, [{ role: 'notice', text: '🔔 ' + [input?.title, input?.message].filter(Boolean).join(': ') }])
    await flush($)
    return { result: 'The notification was sent.' }
  }
  // A photo the user sent from the page: kept on the server as the page sealed it, and opened here
  const id = String(input?.id ?? '').trim()
  if (!/^[a-f0-9]{16}$/.test(id)) return { deny: `There is no attachment ${id} for this session.` }
  let r
  try {
    r = await $.http.fetch(`${config.url}/api/agent/attachment?session=${encodeURIComponent(sessionId ?? '')}&id=${id}`, { headers: authHeaders() })
  } catch {
    return { deny: `Attachment ${id} could not be read: the server could not be reached.` }
  }
  if (!r.ok) return { deny: r.status === 404 ? `There is no attachment ${id} for this session.` : `Attachment ${id} could not be read.` }
  let plain = null
  try {
    plain = openBytes(fromB64(String(JSON.parse(r.text).data ?? '')), sealKey)
  } catch {}
  if (!plain) return { result: [{ type: 'text', text: "[A photo that could not be opened with this machine's key]" }] }
  // (in the standard base64 Claude expects; what kind of picture it is, the picture says itself)
  const b64 = toB64(plain).replace(/-/g, '+').replace(/_/g, '/')
  return { result: [{ type: 'image', source: { type: 'base64', media_type: pictureType(plain), data: b64 + '='.repeat((4 - (b64.length % 4)) % 4) } }] }
}

// What kind of picture some bytes are, by how they begin
function pictureType(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return 'image/jpeg'
}

// A session takes a yes, an answer, or any words at all, only from a device of its
// account's that has the passphrase: in an order, made for this request and for what was
// asked in it. From anyone else (the server, or someone signed in who has not the
// passphrase) it takes what only refuses or leaves the asking to the dialog here, and
// none of the words that came with it: a reason given for a refusal is read by Claude,
// which makes it a prompt.
const BARE = new Set(['deny', 'decline', 'ask', 'abort', 'timeout', 'error'])
function signedAnswer($, rid, request, answer) {
  if (isOrder(answer.order)) {
    try {
      const taken = takeOrder(answer.order, { key: sealKey, devices: devices.list, to: sessionId, does: ['answer'], seen: orders })
      if (taken.with.rid !== rid || taken.with.asked !== askedOf(request)) throw new OrderRefused('it answers something else than was asked here')
      const { rid: _, asked, ...said } = taken.with
      return { ...said, by: answer.by ?? 'web' }
    } catch (err) {
      if (!(err instanceof OrderRefused)) throw err
      unsigned($, `an answer came for this session that could not be used (${err.message}), so it is asked here instead`)
      return { decision: 'ask', by: 'mod' }
    }
  }
  if (BARE.has(answer.decision)) return { decision: answer.decision, by: answer.by ?? 'server' }
  unsigned($, 'an answer came for this session that was not signed by one of your devices, so it is asked here instead')
  return { decision: 'ask', by: 'mod' }
}
// (said once a session: it is the same cause each time)
let saidUnsigned = false
function unsigned($, text) {
  if (saidUnsigned) return
  saidUnsigned = true
  $.ui.log('ManyClaws: ' + text + '.')
}

// Waits for the answer to a request, inside mods API calls so the hook's own time
// budget isn't spent. An answer given at the terminal also ends the wait.
// `hook` is the waiting hook's next: its signal (the turn interrupted) and budget.
async function awaitAnswer($, rid, hook, request, timeoutMs, watch) {
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0
  let unknown = 0
  let quick = 0
  let failures = 0 // in a row; a server restart takes a second or two
  for (;;) {
    if (watch?.done) return { decision: 'ask', by: 'mod' }
    const local = takeLocal(rid)
    if (local) return local
    if (hook?.signal?.aborted) return { decision: 'abort', by: 'interrupt' }
    let wait = DECISION_WAIT_S
    if (deadline) {
      const left = deadline - Date.now()
      if (left <= 0) return { decision: 'timeout', by: 'timeout' }
      wait = Math.max(1, Math.min(wait, Math.ceil(left / 1000)))
    }
    const started = Date.now()
    let r
    try {
      const q = `session=${encodeURIComponent(sessionId ?? '')}&request=${rid}&wait=${wait}`
      r = await $.http.fetch(config.url + '/api/agent/decision?' + q, { headers: authHeaders() })
    } catch {
      // The server restarting: try again for a few seconds
      if (++failures <= 8 && (await pause($, hook))) continue
      return takeLocal(rid) ?? { decision: 'unreachable', by: 'mod' }
    }
    const after = takeLocal(rid)
    if (after) return after
    if (!r.ok) {
      if ((r.status >= 500 || r.status === 429) && ++failures <= 8 && (await pause($, hook))) continue
      return { decision: 'unreachable', by: 'mod', status: r.status }
    }
    failures = 0
    let body = {}
    try {
      body = JSON.parse(r.text)
    } catch {}
    if (body.answer && typeof body.answer === 'object') {
      if (isOrder(body.answer.order)) await freshDevices($)
      return signedAnswer($, rid, request, body.answer)
    }
    if (body.unknown) {
      // The server lost the request (a restart): send it again
      if (unknown++ % 3 === 0) {
        await emit($, 'request', request)
        await flush($)
      }
    }
    // A server that answers at once without an answer would spin this loop
    if (Date.now() - started < 200 && ++quick > 50) return { decision: 'unreachable', by: 'mod' }
  }
}

// A second's pause before trying an unreachable server again. Sleeping counts
// against the hook's own time budget, so it stops while there's still some left.
async function pause($, hook) {
  if (!((hook?.budget?.remainingMs ?? 0) > 2500)) return false
  await $.clock.sleep(1000)
  return true
}

function takeLocal(rid) {
  const local = localAnswers.get(rid)
  if (local) localAnswers.delete(rid)
  return local
}

function showPending($, item) {
  pendingList.push(item)
  $.ui.invalidate('ui.render')
}

function hidePending($, rid) {
  const i = pendingList.findIndex((p) => p.rid === rid)
  if (i >= 0) pendingList.splice(i, 1)
  $.ui.invalidate('ui.render')
}

async function answerLocally($, rid, answer) {
  const given = { ...answer, by: 'terminal' }
  localAnswers.set(rid, given)
  hidePending($, rid)
  // Tell the server, which also ends the request's wait at once. What was answered is closed to it, and it is not
  // told where: an answer that comes this way is one given at this computer, which the server can say for itself.
  try {
    await $.http.fetch(config.url + '/api/agent/decision', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ session: sessionId, request: rid, answer: { a: seal(given, sealKey) } }),
    })
  } catch {
    // The wait notices the local answer when its poll returns
  }
}
