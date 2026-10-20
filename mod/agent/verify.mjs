// What runs on this computer, and what its server hands a browser, held against the
// release that was signed: `node agent.mjs verify`.
//
// A release is a list of every file with its SHA-256 (release.json), signed with a key
// that is kept neither in the public repository nor on any server (release.json.sig). The
// two are in the plugin's own folder, so each copy of the plugin carries the list it was
// released by. The installer installed nothing that was not on a signed list, and kept the
// list, its signature and the keys it went by beside the agent. This looks again, at three
// things:
//
//   the agent     the files installed here, against the list they were installed by
//   the plugin    the ManyClaws plugin as Claude Code has it installed, against the list in
//                 its own folder, which has to be signed by a key this computer knows. Claude
//                 Code fetches the plugin itself, and checks no signature: this is where a
//                 plugin that is not a release shows
//   the page      what the server hands a browser now, against the list the server says
//                 its page is of, which has to be signed by a key this computer knows. Not
//                 with --here, which looks at this computer alone
//
// It is a check from outside the page, by code that came signed: a page that had been
// changed could say anything of itself, and nothing here asks it. What it cannot see is
// a server that hands this computer one page and a browser another. So the page's HTML is
// asked for twice, plainly and as a browser asks for a page (a proxy in front of a server
// that adds a script of its own to pages adds it to what is asked for so, and to nothing
// else): what it can tell apart, it does. What a browser does itself: the page's HTML
// names each script and style sheet by its hash, and the browser runs none that is
// anything else, so the HTML is the one file to compare.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pluginDigest, pluginOfList, notPlugin, sshSigned } from './seal.mjs'

const NAMESPACE = 'manyclaws-release'
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// Whether a list is signed by one of the keys (`signers`: a file as ssh-keygen's allowed signers are written). Checked
// here, in JavaScript (seal.mjs, sshSigned: the check the plugin and the page make), not by running ssh-keygen: the
// agent checks the plugin's copies every minute, and a synchronous ssh-keygen that did not come back held its whole
// event loop, so that it said nothing to the server for three and a half hours (the MacBook Pro, 2026-10-19). Its
// namespace and principal are as `ssh-keygen -Y verify -I manyclaws -n manyclaws-release` would hold them.
export function signedBy(listText, sigText, signers) {
  let signersText
  try {
    signersText = fs.readFileSync(signers, 'utf8')
  } catch {
    return false
  }
  return sshSigned(String(listText ?? ''), String(sigText ?? ''), signersText, { principal: 'manyclaws', namespace: NAMESPACE })
}

// The files under a folder, by their paths from it
export function under(dir, skip = () => false, at = '') {
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

// A plugin's folder as it is: each of its files by its path there and its SHA-256 (what of the folder is not the
// plugin's is left out: notPlugin, in seal.mjs)
export function pluginFiles(dir) {
  return Object.fromEntries(under(dir, notPlugin).map((rel) => [rel, sha256(fs.readFileSync(path.join(dir, rel)))]))
}

// A plugin's folder held against the list it carries: { signed, release, plugin, agent, made, digest, as, wrong, extra }.
// `digest` is what the folder is (pluginDigest), whatever the list says; `as` that the folder is the release the list
// is, signed by one of `signers` (a file as ssh-keygen's allowed signers are written); `wrong` the files that are not
// the ones listed, or missing, and `extra` those the list does not have. `signed` false, and the rest empty, where
// the folder has no list or it is not signed by those keys.
export function pluginRelease(dir, signers) {
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {
      return null
    }
  }
  const files = pluginFiles(dir)
  const digest = pluginDigest(files)
  const listText = read('release.json')
  if (!listText || !signedBy(listText, read('release.json.sig'), signers)) return { signed: false, digest, as: false, wrong: [], extra: [], hasList: !!listText }
  let list
  try {
    list = JSON.parse(listText)
  } catch {
    return { signed: false, digest, as: false, wrong: [], extra: [], hasList: true }
  }
  const listed = pluginOfList(list)
  const wrong = Object.keys(listed).filter((rel) => files[rel] !== listed[rel])
  const extra = Object.keys(files).filter((rel) => !Object.hasOwn(listed, rel))
  return { signed: true, release: list.release, plugin: list.plugin, agent: list.agent, made: list.made, digest, as: !wrong.length && !extra.length && digest === pluginDigest(listed), wrong, extra, list }
}

// The copies of the ManyClaws plugin Claude Code has installed under a config folder: { version, dir }
export function installedPlugins(root) {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'installed_plugins.json'), 'utf8')).plugins?.['manyclaws@manyclaws'] ?? []).filter((one) => one.installPath && fs.existsSync(one.installPath)).map((one) => ({ version: one.version, dir: one.installPath }))
  } catch {
    return []
  }
}

// Answers { ok, lines }: `ok` false where anything is other than a signed release says. `here`: this computer alone,
// not the page its server hands out.
export async function verify({ home, roots = [], server = '', fetched = fetch, here = false } = {}) {
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
    // (the list names each file by its path in the repository: the agent's are mod/agent/, installed in agent/ here)
    const listed = Object.keys(list.files).filter((f) => f.startsWith('mod/agent/'))
    const installedAs = (f) => path.join(agentDir, f.slice('mod/agent/'.length))
    const wrong = listed.filter((f) => {
      const bytes = fs.existsSync(installedAs(f)) ? fs.readFileSync(installedAs(f)) : null
      return !bytes || sha256(bytes) !== list.files[f]
    })
    const extra = fs.readdirSync(agentDir).filter((f) => f.endsWith('.mjs') && !listed.includes('mod/agent/' + f))
    if (wrong.length || extra.length) bad(`the agent's files are not as release ${list.release} lists them: ${[...wrong.map((f) => f + ' is not the file it names'), ...extra.map((f) => 'mod/agent/' + f + ' is not on it')].join('; ')}`)
    else good(`the agent: agent ${list.agent}, release ${list.release} (${list.made}), signed, and its ${listed.length} files are as the list has them`)
  }

  // ---- The plugin, as Claude Code has it: each copy against the list it carries
  for (const root of roots) {
    for (const one of installedPlugins(root)) {
      if (!fs.existsSync(signers)) {
        lines.push(`· the plugin in ${root}: plugin ${one.version}, with no keys here to hold it against`)
        continue
      }
      const r = pluginRelease(one.dir, signers)
      if (!r.hasList && !r.signed) bad(`the plugin in ${root} is plugin ${one.version}, which carries no signed list: it is from before the plugin carried the release it is of. Update it (claude plugin update manyclaws@manyclaws), and run this again`)
      else if (!r.signed) bad(`the plugin in ${root}: the list it carries is not signed by a key this computer knows`)
      else if (!r.as) bad(`the plugin in ${root} is not as release ${r.release} lists it: ${[...r.wrong.map((f) => f + ' is not the file it names'), ...r.extra.map((f) => f + ' is not on it')].join('; ')}`)
      else good(`the plugin in ${root}: plugin ${r.plugin}, release ${r.release}, signed, and its ${Object.keys(pluginOfList(r.list)).length} files are as the list has them`)
    }
  }

  // ---- The page, as the server hands it out
  if (server && !here && fs.existsSync(signers)) {
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
