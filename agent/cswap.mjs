// cswap (claude-swap) on this machine: the Claude accounts Claude Code can be switched
// between here. The agent runs it for the page: `cswap list --json`, and
// `cswap switch <number> --json`. Nothing else of cswap's is run from here, and what the
// page is sent of an account is what it shows, named below: no more of cswap's answer
// leaves the machine than that.
//
// agent.json's `cswap` is false to have none of this, or the path of the cswap to run
// (that one and no other) where it isn't found by itself: a service has little PATH to
// find it with.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LIST_MS = 45_000
const SWITCH_MS = 90_000

// Where cswap is, if it's installed: where it was said to be, beside claude (both are
// usually in ~/.local/bin), on the PATH, or where uv, pipx and Homebrew put tools
export function findCswap(config = {}, env = process.env) {
  if (config.cswap === false) return null
  const names = process.platform === 'win32' ? ['cswap.exe', 'cswap.cmd', 'cswap.bat'] : ['cswap']
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const dirs = [
    config.claude ? path.dirname(config.claude) : '',
    ...String((key && env[key]) ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin']),
  ]
  const candidates = typeof config.cswap === 'string' ? [config.cswap] : dirs.filter(Boolean).flatMap((d) => names.map((n) => path.join(d, n)))
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {}
  }
  return null
}

// What the page shows of a usage window, and of an account
const window = (w) => (w && typeof w.pct === 'number' ? { pct: w.pct, resetsAt: w.resetsAt ?? null, countdown: w.countdown ?? '', clock: w.clock ?? '', ...(w.aheadOfPace ? { aheadOfPace: true } : {}), ...(typeof w.name === 'string' ? { name: w.name } : {}) } : null)
const usage = (u) => (u ? { fiveHour: window(u.fiveHour), sevenDay: window(u.sevenDay), scoped: (Array.isArray(u.scoped) ? u.scoped : []).map(window).filter(Boolean) } : null)
const account = (a) => ({
  number: a.number,
  email: String(a.email ?? ''),
  alias: typeof a.alias === 'string' ? a.alias : '',
  organizationName: String(a.organizationName ?? ''),
  isOrganization: !!a.isOrganization,
  active: !!a.active,
  disabled: !!a.disabled,
  usageStatus: String(a.usageStatus ?? 'unavailable'),
  usage: usage(a.usage),
  usageAgeSeconds: typeof a.usageAgeSeconds === 'number' ? a.usageAgeSeconds : null,
  lastGoodUsage: usage(a.lastGoodUsage),
  lastGoodAgeSeconds: typeof a.lastGoodAgeSeconds === 'number' ? a.lastGoodAgeSeconds : null,
})

export class Cswap {
  // `fail` makes the error the caller is told as it is (the agent's HostError)
  constructor(config, { fail = (text) => new Error(text) } = {}) {
    this.config = config
    this.fail = fail
  }

  // Looked for each time: it can be installed, or taken away, while the agent runs
  get path() {
    return findCswap(this.config)
  }

  // Runs cswap and reads the one JSON object it prints. Its own refusal ({ error }, with
  // a failing exit) is told in its own words.
  run(args, timeout) {
    const file = this.path
    if (!file) return Promise.reject(this.fail('cswap is not installed on this machine'))
    return new Promise((resolve, reject) => {
      // (a .cmd on Windows is run by the shell; the arguments are a word and a number, checked before this)
      execFile(file, [...args, '--json'], { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: /\.(cmd|bat)$/i.test(file) }, (err, stdout, stderr) => {
        let out = null
        try {
          out = JSON.parse(stdout)
        } catch {}
        if (out?.error) return reject(this.fail('cswap: ' + (out.error.message || out.error.type || 'it failed')))
        if (err || !out) return reject(this.fail('cswap ' + args[0] + ' failed' + (err?.killed ? ': it took too long' : ': ' + (String(stderr || err?.message || 'no answer').trim().split('\n').pop() ?? '').slice(0, 300))))
        resolve(out)
      })
    })
  }

  // The accounts, as `cswap list` has them: { active, accounts }
  async list() {
    const out = await this.run(['list'], LIST_MS)
    return { active: out.activeAccountNumber ?? null, accounts: (out.accounts ?? []).map(account) }
  }

  // Switches Claude Code on this machine to one of them, by its number, and says how that went and how things stand now
  async switchTo(to) {
    const number = Number(to)
    if (!Number.isInteger(number) || number < 1 || number > 999) throw this.fail('which account: give its number')
    const before = await this.list()
    if (!before.accounts.some((a) => a.number === number)) throw this.fail(`cswap has no account ${number} on this machine`)
    const out = await this.run(['switch', String(number)], SWITCH_MS)
    const ref = (a) => (a ? { number: a.number ?? null, email: String(a.email ?? '') } : null)
    return { switched: !!out.switched, from: ref(out.from), to: ref(out.to), reason: typeof out.reason === 'string' ? out.reason : '', ...(await this.list()) }
  }
}
