// A session the agent opened on Windows, in a console window of its own (host.mjs): what
// it is to run is in a file the agent wrote, named on this one's command line, which is
// read and removed. Claude Code runs in this window, and this waits for it and goes with
// it. (A Mac and Linux run a shell script in its place, which becomes Claude Code.)
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const file = process.argv[2]
let run
try {
  const text = fs.readFileSync(file, 'utf8')
  fs.rmSync(file, { force: true })
  run = JSON.parse(text)
} catch (err) {
  console.error(`ManyClaws: what this session was to be started with could not be read (${err.message})`)
  process.exit(1)
}
// (Ctrl+C and Ctrl+Break are Claude Code's, and closing the window ends it: this goes when it does)
for (const signal of ['SIGINT', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => {})
const child = spawn(run.claude, run.argv, { cwd: run.cwd, env: run.env, stdio: 'inherit' })
child.on('error', (err) => {
  console.error(`ManyClaws: Claude Code could not be started (${err.message})`)
  process.exitCode = 1
})
child.on('exit', (code) => process.exit(code ?? 1))
