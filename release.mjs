#!/usr/bin/env node
// Makes a release of what this repository holds: the list of every file that ends up on a
// person's computer or in their browser, each with its SHA-256 (mod/release.json), and that
// list signed (mod/release.json.sig). The two are kept in the plugin's own folder, so every
// copy of the plugin carries the list it was released by. The agent's installer installs
// nothing that is not on a signed list, and anyone can hold what a server hands their
// browser, or what Claude Code installed, against the same one.
//
//   node release.mjs            bring the page's integrity values up to date (web/index.html):
//                               each script and style sheet it loads is named there with its
//                               SHA-384, and a browser runs none that is not that file. So the
//                               page's one HTML file stands for all of its code
//   node release.mjs --check    say whether those, and release.json, are as the files are now
//                               (exit 1 where they are not): before a deploy
//   node release.mjs --sign     a release: the integrity values, then release.json with the
//                               next number, then its signature, by the key (or keys) named in
//                               MANYCLAWS_RELEASE_KEY: a private key's path, or a public key's
//                               whose other half an ssh-agent holds; several with a colon between
//   node release.mjs --tag      once the release is committed: tags that commit release-N, so
//                               that a release can be checked out, read and compared by its name
//
// Signed with ssh-keygen, under the namespace manyclaws-release. Which keys count is in
// mod/agent/install.sh (SIGNERS): to replace one, a release signed by the old key carries an
// installer that names the new one.
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const ROOT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? import.meta.dirname)
const NAMESPACE = 'manyclaws-release'

// What a release is of: the plugin (with the agent in it), the page, and what lets Claude Code install the plugin from here
const PARTS = ['.claude-plugin', 'mod', 'web']
// The list and its signature, in the plugin's folder: what the rest is held against, and not on the list itself
const LIST = 'mod/release.json'
const NOT = (rel) => /(^|\/)(\.DS_Store|node_modules)(\/|$)/.test(rel) || rel.startsWith('mod/.claude-plugin/types/') || rel === 'mod/tsconfig.json' || rel === LIST || rel === LIST + '.sig'

function filesOf(root = ROOT) {
  // In a checkout, the files git has or is about to have: not what something wrote beside them and git leaves out
  // (Claude Code writes its types beside a plugin it loads from a folder), which no archive of the repository will have
  if (fs.existsSync(path.join(root, '.git'))) {
    const git = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '--', ...PARTS], { encoding: 'utf8' })
    if (git.status === 0) return git.stdout.split('\n').filter((f) => f && !NOT(f) && fs.existsSync(path.join(root, f))).sort()
  }
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name
      if (NOT(rel)) continue
      if (e.isDirectory()) walk(rel)
      else if (e.isFile()) out.push(rel)
    }
  }
  for (const part of PARTS) if (fs.existsSync(path.join(root, part))) walk(part)
  return out.sort()
}
const digest = (file, how = 'sha256', as = 'hex') => crypto.createHash(how).update(fs.readFileSync(path.join(ROOT, file))).digest(as)

// ---- The page's integrity values. Every script and style sheet web/index.html loads, and
// every module its script goes on to import, is named in it with the SHA-384 of the file:
// a browser that is handed anything else under that name does not run it.
const PAGE = 'web/index.html'
function stamped(html) {
  // (a file the page names from its own folder or from the top of the site: where it is in web/)
  const fileOf = (href) => 'web/' + href.replace(/^\//, '')
  return html.replace(/<(script|link)\b[^>]*>/g, (tag) => {
    const href = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1]
    const loads = /^<script\b/.test(tag) || /\brel="(stylesheet|modulepreload)"/.test(tag)
    if (!href || !loads || /^[a-z]+:/i.test(href) || !fs.existsSync(path.join(ROOT, fileOf(href)))) return tag
    const integrity = `integrity="sha384-${digest(fileOf(href), 'sha384', 'base64')}"`
    return /\bintegrity="[^"]*"/.test(tag) ? tag.replace(/\bintegrity="[^"]*"/, integrity) : tag.replace(/\s*>$/, ` ${integrity}>`)
  })
}

// ---- The list
const listed = () => Object.fromEntries(filesOf().map((f) => [f, digest(f)]))
const readList = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, LIST), 'utf8'))
  } catch {
    return null
  }
}
const versions = () => ({
  plugin: JSON.parse(fs.readFileSync(path.join(ROOT, 'mod/.claude-plugin/plugin.json'), 'utf8')).version,
  agent: /^export const VERSION = '(.*)'$/m.exec(fs.readFileSync(path.join(ROOT, 'mod/agent/service.mjs'), 'utf8'))?.[1] ?? '',
})

const hasPage = fs.existsSync(path.join(ROOT, PAGE))
const html = hasPage ? fs.readFileSync(path.join(ROOT, PAGE), 'utf8') : ''
const pageNow = hasPage ? stamped(html) : ''

if (flags.has('--check')) {
  const stale = []
  if (pageNow !== html) stale.push(`${PAGE} names its scripts and styles by hashes that are not theirs now: node release.mjs`)
  const list = readList()
  if (!list || JSON.stringify(list.files) !== JSON.stringify(listed())) stale.push(LIST + ' is not a list of the files as they are now: node release.mjs --sign')
  else if (!fs.existsSync(path.join(ROOT, LIST + '.sig'))) stale.push(LIST + ' is not signed: node release.mjs --sign')
  for (const line of stale) console.error(line)
  process.exit(stale.length ? 1 : 0)
}

if (pageNow !== html) {
  fs.writeFileSync(path.join(ROOT, PAGE), pageNow)
  console.log(`${PAGE}: the integrity values were brought up to date`)
}

if (flags.has('--sign')) {
  const keys = String(process.env.MANYCLAWS_RELEASE_KEY ?? '').split(':').filter(Boolean)
  if (!keys.length) {
    console.error('MANYCLAWS_RELEASE_KEY names no key to sign with')
    process.exit(2)
  }
  const was = readList()
  const files = listed()
  // (the same files as the list has are the same release: signed again, it keeps its number)
  const same = was && JSON.stringify(was.files) === JSON.stringify(files)
  const list = { release: same ? was.release : (was?.release ?? 0) + 1, made: same ? was.made : new Date().toISOString().slice(0, 10), ...versions(), files }
  const text = JSON.stringify(list, null, 2) + '\n'
  fs.writeFileSync(path.join(ROOT, LIST), text)
  const sigs = keys.map((key) => execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', NAMESPACE], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }))
  fs.writeFileSync(path.join(ROOT, LIST + '.sig'), sigs.join(''))
  console.log(`release ${list.release}: plugin ${list.plugin}, agent ${list.agent}, ${Object.keys(files).length} files, signed by ${keys.length} key${keys.length > 1 ? 's' : ''}`)
}

// The commit a release is in, named for it: release-N, on the commit that holds that list as signed. Only once the
// list and its signature are committed as they are here, so that the name stands for what was signed and nothing else.
if (flags.has('--tag')) {
  const git = (...args) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })
  const list = readList()
  const no = (why) => (console.error(why), process.exit(1))
  if (!list || !Number.isInteger(list.release)) no(`${LIST} does not read: nothing was tagged`)
  for (const file of [LIST, LIST + '.sig']) {
    const committed = git('show', 'HEAD:' + file)
    if (committed.status !== 0 || committed.stdout !== fs.readFileSync(path.join(ROOT, file), 'utf8')) no(`${file} is not committed as it is here: commit the release first. Nothing was tagged`)
  }
  const name = 'release-' + list.release
  const at = git('rev-parse', '--verify', '--quiet', name + '^{commit}').stdout.trim()
  const head = git('rev-parse', 'HEAD').stdout.trim()
  if (at && at !== head) no(`${name} is already the name of another commit (${at.slice(0, 12)}): nothing was tagged`)
  if (!at && git('tag', name, head).status !== 0) no(`git would not tag ${head.slice(0, 12)} ${name}`)
  console.log(`${name} is ${head.slice(0, 12)}: push it with the branch (git push origin main ${name})`)
}
