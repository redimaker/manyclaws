#!/usr/bin/env node
// Makes a release of what this repository holds: the list of every file that ends up on a
// person's computer or in their browser, each with its SHA-256 (release.json), and that
// list signed (release.json.sig). The agent's installer installs nothing that is not on a
// signed list, and anyone can hold what a server hands their browser against the same one.
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
//
// Signed with ssh-keygen, under the namespace manyclaws-release. Which keys count is in
// agent/install.sh (SIGNERS): to replace one, a release signed by the old key carries an
// installer that names the new one.
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const ROOT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? import.meta.dirname)
const NAMESPACE = 'manyclaws-release'

// What a release is of: the agent, the plugin, the page, and what lets Claude Code install the plugin from here
const PARTS = ['.claude-plugin', 'agent', 'mod', 'web']
const NOT = (rel) => /(^|\/)(\.DS_Store|node_modules)(\/|$)/.test(rel) || rel.startsWith('mod/.claude-plugin/types/') || rel === 'mod/tsconfig.json'

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
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'release.json'), 'utf8'))
  } catch {
    return null
  }
}
const versions = () => ({
  plugin: JSON.parse(fs.readFileSync(path.join(ROOT, 'mod/.claude-plugin/plugin.json'), 'utf8')).version,
  agent: /^export const VERSION = '(.*)'$/m.exec(fs.readFileSync(path.join(ROOT, 'agent/service.mjs'), 'utf8'))?.[1] ?? '',
})

const hasPage = fs.existsSync(path.join(ROOT, PAGE))
const html = hasPage ? fs.readFileSync(path.join(ROOT, PAGE), 'utf8') : ''
const pageNow = hasPage ? stamped(html) : ''

if (flags.has('--check')) {
  const stale = []
  if (pageNow !== html) stale.push(`${PAGE} names its scripts and styles by hashes that are not theirs now: node release.mjs`)
  const list = readList()
  if (!list || JSON.stringify(list.files) !== JSON.stringify(listed())) stale.push('release.json is not a list of the files as they are now: node release.mjs --sign')
  else if (!fs.existsSync(path.join(ROOT, 'release.json.sig'))) stale.push('release.json is not signed: node release.mjs --sign')
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
  fs.writeFileSync(path.join(ROOT, 'release.json'), text)
  const sigs = keys.map((key) => execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', NAMESPACE], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }))
  fs.writeFileSync(path.join(ROOT, 'release.json.sig'), sigs.join(''))
  console.log(`release ${list.release}: plugin ${list.plugin}, agent ${list.agent}, ${Object.keys(files).length} files, signed by ${keys.length} key${keys.length > 1 ? 's' : ''}`)
}
