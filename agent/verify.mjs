// What runs on this computer, and what its server hands a browser, held against the
// release that was signed: `node agent.mjs verify`.
//
// A release is a list of every file with its SHA-256 (release.json), signed with a key
// that is kept neither in the public repository nor on any server (release.json.sig).
// The installer installed nothing that was not on a signed list, and kept the list, its
// signature and the keys it went by beside the agent. This looks again, at three things:
//
//   the agent     the files installed here, against the list they were installed by
//   the plugin    the ManyClaws plugin as Claude Code has it installed, against that list
//                 where it is the same version. Claude Code fetches the plugin itself, and
//                 checks no signature: this is where a plugin that is not a release shows
//   the page      what the server hands a browser now, against the list the server says
//                 its page is of, which has to be signed by a key this computer knows
//
// It is a check from outside the page, by code that came signed: a page that had been
// changed could say anything of itself, and nothing here asks it. What it cannot see is
// a server that hands this computer one page and a browser another. So the page's HTML is
// asked for twice, plainly and as a browser asks for a page (a proxy in front of a server
// that adds a script of its own to pages adds it to what is asked for so, and to nothing
// else): what it can tell apart, it does. What a browser does itself: the page's HTML
// names each script and style sheet by its hash, and the browser runs none that is
// anything else, so the HTML is the one file to compare.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAMESPACE = 'manyclaws-release'
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// Whether a list is signed by one of the keys (`signers`: a file as ssh-keygen's allowed signers are written)
export function signedBy(listText, sigText, signers) {
  const sigs = String(sigText ?? '').match(/-----BEGIN SSH SIGNATURE-----[\s\S]*?-----END SSH SIGNATURE-----\n?/g) ?? []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-verify-'))
  try {
    return sigs.some((sig, i) => {
      const file = path.join(dir, 'sig.' + i)
      fs.writeFileSync(file, sig)
      return spawnSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', 'manyclaws', '-n', NAMESPACE, '-s', file], { input: listText, encoding: 'utf8' }).status === 0
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// The files under a folder, by their paths from it
function under(dir, skip = () => false, at = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(dir, at), { withFileTypes: true })) {
    const rel = at ? at + '/' + e.name : e.name
    if (skip(rel)) continue
    if (e.isDirectory()) out.push(...under(dir, skip, rel))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

// Where the server hands out a file of the page's: the page itself at /app, the rest by their names
const addressOf = (file) => (file === 'web/index.html' ? '/app' : '/' + file.slice(4))
// How a browser asks for a page: what is added to pages on their way to a browser is added to what is asked for so
const AS_A_BROWSER = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
const hostOf = (address) => {
  try {
    return new URL(address).host
  } catch {
    return address
  }
}
// What of the page is written per visitor as it is served (the front door, the small print, the guides): not compared
const WRITTEN_AS_SERVED = new Set(['web/home.html', 'web/legal.html', 'web/setup.html', 'web/setup.md', 'web/upgrade.md'])

// Answers { ok, lines }: `ok` false where anything is other than a signed release says
export async function verify({ home, roots = [], server = '', fetched = fetch } = {}) {
  const lines = []
  let ok = true
  const bad = (text) => ((ok = false), lines.push('✗ ' + text))
  const good = (text) => lines.push('✓ ' + text)
  const agentDir = path.join(home, 'agent')
  const signers = path.join(agentDir, 'release-signers')
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  // ---- The agent
  const listText = read(path.join(agentDir, 'release.json'))
  let list = null
  if (!listText || !fs.existsSync(signers)) bad('the agent here was not installed from a signed release (it has no release.json, or no keys to check one by): install it again, as the guide has it')
  else if (!signedBy(listText, read(path.join(agentDir, 'release.json.sig')), signers)) bad('the list the agent was installed by is not signed by a key this computer knows')
  else {
    list = JSON.parse(listText)
    const listed = Object.keys(list.files).filter((f) => f.startsWith('agent/'))
    const wrong = listed.filter((f) => {
      const bytes = fs.existsSync(path.join(home, f)) ? fs.readFileSync(path.join(home, f)) : null
      return !bytes || sha256(bytes) !== list.files[f]
    })
    const extra = fs.readdirSync(agentDir).filter((f) => f.endsWith('.mjs') && !listed.includes('agent/' + f))
    if (wrong.length || extra.length) bad(`the agent's files are not as release ${list.release} lists them: ${[...wrong.map((f) => f + ' is not the file it names'), ...extra.map((f) => 'agent/' + f + ' is not on it')].join('; ')}`)
    else good(`the agent: agent ${list.agent}, release ${list.release} (${list.made}), signed, and its ${listed.length} files are as the list has them`)
  }

  // ---- The plugin, as Claude Code has it
  for (const root of roots) {
    let installed = []
    try {
      installed = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.['manyclaws@manyclaws'] ?? []
    } catch {}
    for (const one of installed) {
      const dir = one.installPath
      if (!dir || !fs.existsSync(dir)) continue
      if (!list) {
        lines.push(`· the plugin in ${root}: plugin ${one.version}, with no signed list here to hold it against`)
        continue
      }
      if (one.version !== list.plugin) {
        lines.push(`· the plugin in ${root} is ${one.version} and this release has ${list.plugin}: bring both up to date, and run this again`)
        continue
      }
      const listed = Object.keys(list.files).filter((f) => f.startsWith('mod/'))
      const wrong = listed.filter((f) => {
        const file = path.join(dir, f.slice(4))
        return !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== list.files[f]
      })
      // (what Claude Code keeps there of its own is not the plugin's)
      const extra = under(dir, (rel) => rel === '.in_use' || rel.startsWith('.in_use/') || rel.endsWith('.DS_Store')).filter((f) => !listed.includes('mod/' + f))
      if (wrong.length || extra.length) bad(`the plugin in ${root} is not as release ${list.release} lists it: ${[...wrong.map((f) => f + ' is not the file it names'), ...extra.map((f) => f + ' is not on it')].join('; ')}`)
      else good(`the plugin in ${root}: plugin ${one.version}, and its ${listed.length} files are as release ${list.release} lists them`)
    }
  }

  // ---- The page, as the server hands it out
  if (server && fs.existsSync(signers)) {
    const get = async (p, headers = {}) => {
      // (a server that does not answer is one that handed nothing over: not waited for without end)
      const r = await fetched(server + p, { cache: 'no-store', headers, signal: AbortSignal.timeout(30_000) }).catch(() => null)
      return r?.ok ? Buffer.from(await r.arrayBuffer()) : null
    }
    const [theirs, sig] = [await get('/release.json'), await get('/release.json.sig')]
    if (!theirs || !sig) bad(`the page: ${server} did not say which release its page is of`)
    else if (!signedBy(theirs.toString('utf8'), sig.toString('utf8'), signers)) bad(`the page: the list ${server} hands out is not signed by a key this computer knows`)
    else {
      const of = JSON.parse(theirs.toString('utf8'))
      const files = Object.keys(of.files).filter((f) => f.startsWith('web/') && !WRITTEN_AS_SERVED.has(f))
      const wrong = []
      for (const f of files) {
        const bytes = await get(addressOf(f))
        if (!bytes || sha256(bytes) !== of.files[f]) wrong.push(addressOf(f))
      }
      if (wrong.length) bad(`the page: ${server} hands out what release ${of.release} does not list: ${wrong.join(', ')}`)
      else good(`the page: release ${of.release} (${of.made}), signed, and the ${files.length} files ${server} hands out are as the list has them`)
      // The page's HTML once more, asked for as a browser asks for a page
      const asked = await get('/app', AS_A_BROWSER)
      if (asked && of.files['web/index.html'] && sha256(asked) !== of.files['web/index.html']) {
        const plain = (await get('/app'))?.toString('utf8') ?? ''
        const from = [...new Set([...asked.toString('utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).filter((src) => !plain.includes(src)).map(hostOf))]
        bad(`the page: its HTML is not the listed file when it is asked for as a browser asks for a page: something between ${server} and a browser changes it on the way${from.length ? ` (it adds a script from ${from.join(', ')})` : ''}. The page's own rules keep a script from elsewhere from running, but what a browser is handed is not what was released`)
      }
    }
  }
  return { ok, lines }
}
