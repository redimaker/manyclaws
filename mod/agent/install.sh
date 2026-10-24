#!/usr/bin/env bash
# Installs the ManyClaws agent on this machine and starts it as a service of your
# own user (launchd on macOS, systemd --user on Linux, and on Windows a task of Task
# Scheduler's that starts it as you sign in, run by Git Bash, which Claude Code has there).
#
#   curl -fsSL https://raw.githubusercontent.com/redimaker/manyclaws/beta/mod/agent/install.sh | bash -s -- [options]
#
# or, from the ManyClaws plugin as Claude Code installed it (the agent is in the plugin's folder, with
# the signed list the plugin was released by), what the plugin runs when the page asks it to:
#
#   bash <the plugin's folder>/agent/install.sh --from <the plugin's folder> [options]
#
# and, once it is installed, to bring it up to date, the copy of this that it keeps:
#
#   bash ~/.manyclaws/agent/install.sh --update
#
# The agent's files are fetched from the public repository they are kept in
# (github.com/redimaker/manyclaws): what runs here is what anyone can read there, and no
# server hands it out. What is fetched is a release: a list of every file with its SHA-256
# (mod/release.json), signed (mod/release.json.sig) with a key that is kept neither in that
# repository nor on any server. Nothing is installed unless the signature is by a key this
# installer knows (SIGNERS, below) and every file is as the list says; and none older than
# the release installed is taken. So an agent that is installed updates itself by a key it
# already has: whoever came to control the repository could not put code on this machine.
# The first install has nothing but this script to go by, which is why the script is worth
# reading before it is run.
#
# The agent signs in with an API token of your account's and seals with your account's
# key: the same two the ManyClaws plugin in Claude Code is given. It needs both: nothing
# of this machine's sessions is sent unsealed. Nobody types either: the plugin is given
# both as the computer is connected with the code it shows in a new session (typed
# where you are signed in to ManyClaws, and approved there), and the agent takes them from
# the plugin. So this asks for nothing: the agent is installed, and waits for them. For a
# set-up with nobody there, both can be given (--token and --key, or MANYCLAWS_TOKEN and
# MANYCLAWS_KEY), and the plugin is given the same.
#
#   --server URL        the ManyClaws server this machine reports to (default: what it was set
#                       up with, else https://beta.manyclaws.dev)
#   --from WHERE        take the release from here, where it is not to come from the repository:
#                       a .tar.gz by its address or its path, or a folder: a checkout of the
#                       repository, or the plugin's own folder (or MANYCLAWS_AGENT_FROM). It
#                       is checked all the same
#   --signers FILE      the keys a release may be signed by, in place of the ones this installer
#                       knows: a file as ssh-keygen's "allowed signers" are written (or
#                       MANYCLAWS_SIGNERS). For a release of your own making
#   --label NAME        what the page calls this machine (default: its host name)
#   --root DIR          a Claude Code config dir to index; repeat for several (default: ~/.claude)
#   --spawn DIR         let the page start and resume sessions in DIR; repeat for several.
#                       Without it (or --auto-folders) the machine's sessions can be read and
#                       searched, not started.
#   --auto-folders      let the page start and resume sessions in the folders you have used Claude
#                       Code in on this machine too: never your home folder or one above it, a
#                       temporary one, or one inside a folder whose name starts with a dot, and only
#                       one used in the last 90 days. No new folder is made in them (--spawn names
#                       where that may be), and the page lists them and may turn any of them off
#   --mode MODE         a permission mode the page may start sessions in; repeat for several.
#                       Given, only the ones named are allowed. With none, every one: default,
#                       acceptEdits, plan, auto, dontAsk and bypassPermissions, which lets a session
#                       do anything it is prompted to with nobody asked: leave it out of a list
#                       here to have none. The list is "spawn": { "modes": [...] } in agent.json.
#   --files DIR         a folder the page may open files from; repeat for several. With none,
#                       the --spawn folders. The temporary folders are always among them. A file
#                       anywhere else on the machine is not opened.
#                       (Files are put only into the --spawn folders: "upload": true in
#                       agent.json has them put into these too, and "upload": false nowhere.)
#   --relay             send this machine's ManyClaws mod through the agent, so the
#                       machine has one connection to the server
#   --token TOKEN       an API token of the account's, for a set-up with nobody there (or
#                       MANYCLAWS_TOKEN)
#   --key KEY           the account's key written out, as a computer keeps it (mcf_…), for a
#                       set-up with nobody there (or MANYCLAWS_KEY). There is no passphrase.
#                       Everything the agent sends of the machine's sessions is sealed with it
#   --no-keychain       on a Mac, keep the token and the key in agent.json (which only you can
#                       read) and not in your login keychain, where they are kept otherwise
#   --update            fetch the newest release and start the agent again: for an agent that
#                       is older than that, or one that is not running. Everything the machine
#                       was set up with is kept, and nothing is asked. Where the
#                       agent reports is what it was set up with, unless --server names another.
#                       Starting the agent again ends the sessions it is running (the ones
#                       started from the page), so while there are any nothing is done
#   --end-sessions      with --update or --reinstall: do it all the same, and end those sessions
#   --wait-start SECS   with --update: once the new agent is started, wait this long for it to say so
#                       (agent.started); where it does not, put the agent that was there back and
#                       start that again. What the agent's own upgrade from the page runs
#   --reinstall         remove the agent that is here, with everything it kept, and install the
#                       newest release in its place, set up as the old one was (who the machine
#                       is, its name, its folders and the rest of agent.json) but for its API
#                       token and its key, which go with the old one: the new one waits for the
#                       ManyClaws plugin to give it both again. The one-time upgrade of a machine
#                       whose agent is from before releases were signed (before 5.1.0), which
#                       cannot check what it installs. Like --update it does nothing while the
#                       agent is running sessions, or from one of them
#   --uninstall         stop the service and remove ~/.manyclaws
#
# Run again with new options to change them. The machine keeps its identity. Run again
# without --update, the options given are the ones it has from then on: without --spawn,
# starting sessions is off. To bring an agent up to date as it is, --update.
set -euo pipefail

HOME_DIR="${MANYCLAWS_HOME:-$HOME/.manyclaws}"
LABEL="com.manyclaws.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="$HOME/.config/systemd/user/manyclaws-agent.service"
TASK="ManyClaws agent"
case "$(uname -s)" in
  Darwin) os=mac ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) os=linux ;;
esac
# (Git Bash started by its own path, as Claude Code starts it, keeps Windows' PATH as it is, with Windows' own find, sort
# and the rest ahead of its own: its own first)
[ "$os" != windows ] || export PATH="/usr/bin:/bin:/mingw64/bin:$PATH"
# On Windows this runs in Git Bash, which writes /c/Users/…; node and Task Scheduler are Windows' own, and are given a
# path as Windows writes it (C:\Users\…). Elsewhere a path is as it is.
native() { if [ "$os" = windows ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
# (and a Windows program is given its own options, /end and the like, as they are, not taken by Git Bash for paths)
win() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "$@"; }
# (a folder named the way Windows writes it, as the agent's own update names its folder, is taken in Git Bash's way)
[ "$os" != windows ] || HOME_DIR="$(cygpath -u "$HOME_DIR")"
NHOME="$(native "$HOME_DIR")"
AGENT_JS="$(native "$HOME_DIR/agent/agent.mjs")"

REPO="redimaker/manyclaws"
from="${MANYCLAWS_AGENT_FROM:-https://codeload.github.com/$REPO/tar.gz/refs/heads/beta}"
# The keys a release may be signed by, as ssh-keygen's "allowed signers" are written. A
# release signed by one of these may bring an installer with others: that is how a key is
# replaced, and it is why an installed agent is updated by its own copy of this script.
SIGNERS='manyclaws namespaces="manyclaws-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMPeEfWVnYHahu/dRpMq7J+2eRNg67sQS+IJh/bH8PDD'
server="" token="" label="" relay=0 uninstall=0 typed=0 update=0 end_sessions=0 keychain=1 signers="${MANYCLAWS_SIGNERS:-}" reinstall=0 auto_folders=0 wait_start=0
roots=() spawn=() modes=() files=() key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server="${2%/}"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --root) roots+=("$2"); shift 2 ;;
    --spawn) spawn+=("$2"); shift 2 ;;
    --auto-folders) auto_folders=1; shift ;;
    --mode) modes+=("$2"); shift 2 ;;
    --files) files+=("$2"); shift 2 ;;
    --signers) signers="$2"; shift 2 ;;
    --no-keychain) keychain=0; shift ;;
    --relay) relay=1; shift ;;
    --key) key="$2"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    --update) update=1; shift ;;
    # (an update that first takes away what is here: nothing is asked, and nothing of the options is written)
    --reinstall) reinstall=1; update=1; shift ;;
    --end-sessions) end_sessions=1; shift ;;
    --wait-start) wait_start="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

stop_service() {
  if [ "$os" = windows ]; then
    win schtasks.exe /end /tn "$TASK" >/dev/null 2>&1 || true
    # (the task ended, what it ran may outlive it for a moment: agent-run.cmd, which would start the agent again, first,
    # then the agent, by their pids; and an agent started by hand all the same)
    for _ in $(seq 1 40); do
      all="$(procs)"
      pids="$({ printf '%s\n' "$all" | grep -F -- "$(native "$HOME_DIR/agent-run.cmd")" | grep -v -e grep -e Get-CimInstance; printf '%s\n' "$all" | agent_lines; } | awk '{ print $1 }' || true)"
      [ -n "$pids" ] || break
      for pid in $pids; do win taskkill.exe /pid "$pid" /f >/dev/null 2>&1 || true; done
      sleep 0.25
    done
  elif [ "$os" = mac ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    # bootout returns before the job is gone, and starting it again in that moment fails
    for _ in $(seq 1 40); do
      launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
      sleep 0.25
    done
  else
    systemctl --user disable --now manyclaws-agent.service 2>/dev/null || true
  fi
}

# Every process of this machine's, one to a line: its pid, its parent's, and its command line. On Windows, from
# PowerShell: Git Bash's own ps sees only what Git Bash started, and not Windows' processes or their command lines.
procs() {
  if [ "$os" = windows ]; then
    powershell.exe -NoProfile -NonInteractive -Command 'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1} {2}" -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }' 2>/dev/null | tr -d '\r'
  else
    ps -axww -o pid=,ppid=,command= 2>/dev/null
  fi
}
# The lines of procs that are this machine's agent running (the one in $HOME_DIR), however its command line quotes it
# (Windows: "…\agent\agent.mjs" run)
agent_lines() {
  grep -F -- "$AGENT_JS" | grep -E -- 'agent\.mjs"? run( |$)' | grep -v -e grep -e Get-CimInstance
}
# Its pid, or nothing
agent_pid() {
  procs | agent_lines | awk '{ print $1 }' | head -1
}
running="$(agent_pid || true)"
# A session the agent itself started (one started from the page) runs under the agent:
# stopping the agent ends that session, and this run with it, before the agent is started
# again. So from one of those nothing here is done, and it says so.
if [ -n "$running" ]; then
  # (on Windows this shell's pid as Windows knows it, which is not Git Bash's own)
  p=$$
  [ "$os" != windows ] || p="$(cat "/proc/$$/winpid" 2>/dev/null || echo $$)"
  all="$(procs)"
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    if [ "$p" = "$running" ]; then
      echo "This was run from a session the ManyClaws agent itself started (one started from your page). Stopping the agent ends that session, and this run with it, before the agent is started again: nothing was changed. Run it in a terminal on this machine, or from a Claude Code session started there in a terminal or VS Code." >&2
      exit 3
    fi
    # (awk reads to the end: one that stopped at the first line it wanted would cut printf off, which pipefail takes
    # for this run failing)
    p="$(printf '%s\n' "$all" | awk -v p="$p" '$1 == p && !found { print $2; found = 1 }')"
  done
fi

if [ "$uninstall" = 1 ]; then
  stop_service
  # (what the keychain has of this machine's goes with it)
  node_bin="$(command -v node || true)"
  [ -z "$node_bin" ] || [ ! -f "$HOME_DIR/agent/agent.mjs" ] || MANYCLAWS_HOME="$NHOME" "$node_bin" "$(native "$HOME_DIR/agent/agent.mjs")" forget 2>/dev/null || true
  rm -f "$PLIST" "$UNIT"
  [ "$os" != windows ] || win schtasks.exe /delete /tn "$TASK" /f >/dev/null 2>&1 || true
  rm -rf "$HOME_DIR"
  echo "The ManyClaws agent is stopped and removed. If the mod was set to go through it,"
  echo "point it back at the server: claude plugin configure manyclaws@manyclaws --values-stdin"
  exit 0
fi

if [ "$update" = 1 ]; then
  [ -f "$HOME_DIR/agent.json" ] || { echo "There is no ManyClaws agent on this machine to $([ "$reinstall" = 1 ] && echo 'remove and install again' || echo update): $HOME_DIR/agent.json is not there. Install it as the guide's step 3 has it." >&2; exit 2; }
  # Starting it again ends the sessions it is running: each a Claude Code the agent started, under it
  if [ -n "$running" ] && [ "$end_sessions" = 0 ]; then
    hosted="$(procs | awk -v agent="$running" '$2 == agent' | grep -c -- '--input-format stream-json' || true)"
    if [ "${hosted:-0}" -gt 0 ]; then
      echo "The ManyClaws agent is running $hosted session(s) started from your page, and starting it again ends them: nothing was changed. Run this again when they are done, or with --end-sessions to end them now." >&2
      exit 3
    fi
  fi
fi
# Where it reports: what was named, else what this machine was set up with, else ManyClaws' own server
[ -n "$server" ] || [ ! -f "$HOME_DIR/agent.json" ] || server="$(sed -n 's/^[[:space:]]*"server"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$HOME_DIR/agent.json" | head -1)"
[ -n "$server" ] || server="https://beta.manyclaws.dev"
server="${server%/}"
token="${token:-${MANYCLAWS_TOKEN:-}}"
key="${key:-${MANYCLAWS_KEY:-}}"
# What this machine was set up with before is kept: run again, it asks for nothing it has
had_token=0 had_key=0
if [ -f "$HOME_DIR/agent.json" ]; then
  grep -q '"token"' "$HOME_DIR/agent.json" && had_token=1
  # (a key as this agent keeps one: anything written another way is not one)
  grep -q '"key": *"mcf_' "$HOME_DIR/agent.json" && had_key=1
  # (both kept in the keychain: their fingerprint is here in their place)
  grep -q '"has": *"' "$HOME_DIR/agent.json" && had_token=1 had_key=1
fi
# Where Claude Code runs this it says so (CLAUDECODE): what is said at the end is for it to pass on
by_claude=0
[ -z "${CLAUDECODE:-}" ] || by_claude=1
# (what was given in this run is the newest there is, and the plugin is given it)
[ -z "$token$key" ] || typed=1
# (a key is the account's written out, and nothing else: there is no passphrase to make one from)
case "$key" in "" | mcf_*) ;; *) echo "The key is not what a ManyClaws computer keeps (mcf_…). There is no passphrase: a computer is given its key as it is connected with the code the ManyClaws plugin shows in a new session. Give no key, and connect it so." >&2; exit 2 ;; esac
# With either of the two neither in hand nor kept, the agent waits for the plugin's
waiting=0
{ [ -n "$token" ] || [ "$had_token" = 1 ]; } && { [ -n "$key" ] || [ "$had_key" = 1 ]; } || waiting=1

# Node with its own SQLite (22.13 or later), by its full path: a service starts with no PATH to speak of
node_bin="$(command -v node || true)"
[ -n "$node_bin" ] || { echo "Node.js 22.13 or later is needed, and none is on the PATH" >&2; exit 1; }
"$node_bin" -e "require('node:sqlite').DatabaseSync && require('node:sqlite') && new (require('node:sqlite').DatabaseSync)(':memory:').exec(\"CREATE VIRTUAL TABLE t USING fts5(x)\")" 2>/dev/null ||
  { echo "This Node ($("$node_bin" --version)) has no built-in SQLite with full-text search; 22.13 or later is needed" >&2; exit 1; }

# The release: fetched whole, and checked, before anything that is here is replaced
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
if [ -d "$from" ]; then
  # (a checkout of the repository has the list and the agent in its plugin's folder; the plugin's folder has them at its top)
  base="$from"
  [ ! -f "$from/mod/release.json" ] || base="$from/mod"
  mkdir "$stage/from"
  for part in agent release.json release.json.sig; do [ ! -e "$base/$part" ] || cp -R "$base/$part" "$stage/from/"; done
elif [ -f "$from" ]; then tar -xzf "$from" -C "$stage"
else curl -fsSL "$from" | tar -xzf - -C "$stage" || { echo "The release could not be fetched from $from" >&2; exit 1; }
fi
# (the repository's archive has everything in one folder under its top, and the list in the plugin's folder there)
list="$(find "$stage" -maxdepth 3 -name release.json | head -1)"
[ -n "$list" ] && [ -f "$(dirname "$list")/agent/agent.mjs" ] || { echo "What $from gave is not a ManyClaws release: it has no release.json with the agent beside it. Nothing was changed." >&2; exit 1; }
top="$(dirname "$list")"
src="$top/agent"
# Signed by a key this installer knows: each signature in release.json.sig is tried
command -v ssh-keygen >/dev/null || { echo "ssh-keygen is needed to check the release's signature, and it is not on the PATH (it comes with OpenSSH). Nothing was changed." >&2; exit 1; }
if [ -n "$signers" ]; then
  [ -f "$signers" ] || { echo "--signers: $signers is not a file" >&2; exit 2; }
  cp "$signers" "$stage/signers"
else printf '%s\n' "$SIGNERS" > "$stage/signers"; fi
[ -f "$list.sig" ] || { echo "The release $from gave is not signed (it has no release.json.sig). Nothing was changed." >&2; exit 1; }
awk -v dir="$stage" '/-----BEGIN SSH SIGNATURE-----/ { n++ } n { print > (dir "/sig." n) }' "$list.sig"
signed=""
for sig in "$stage"/sig.*; do
  [ -f "$sig" ] || continue
  if ssh-keygen -Y verify -f "$stage/signers" -I manyclaws -n manyclaws-release -s "$sig" < "$list" >/dev/null 2>&1; then signed=1; break; fi
done
[ -n "$signed" ] || { echo "The release $from gave is not signed by a key this installer knows. Nothing was changed. If ManyClaws has changed its signing key since this agent was installed, the README at github.com/$REPO says how to go on." >&2; exit 1; }
# Every file of the agent as the signed list says, none missing and none besides; and no release older than the one here
had_release=0
[ ! -f "$HOME_DIR/agent/release.json" ] || had_release="$(sed -n 's/^[[:space:]]*"release"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*$/\1/p' "$HOME_DIR/agent/release.json" | head -1)"
"$node_bin" - "$(native "$top")" "${had_release:-0}" <<'CHECK' || { echo "Nothing was changed." >&2; exit 1; }
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [top, had] = [process.argv[2], Number(process.argv[3]) || 0]
const no = (why) => (console.error('The release is not as its signed list says: ' + why + '.'), process.exit(1))
let list
try {
  list = JSON.parse(fs.readFileSync(path.join(top, 'release.json'), 'utf8'))
} catch {
  no('release.json does not read')
}
if (!Number.isInteger(list.release) || !list.files || typeof list.files !== 'object') no('release.json is not a list of files')
if (list.release < had) (console.error(`The release fetched (${list.release}) is older than the one installed (${had}): it is not gone back to.`), process.exit(1))
// (the list names every file by its path in the repository, and is kept in the plugin's folder, mod/, where it is here:
// so mod/agent/x is agent/x beside it)
const listed = Object.keys(list.files).filter((f) => f.startsWith('mod/agent/'))
const at = (f) => path.join(top, f.slice('mod/'.length))
const there = fs.readdirSync(path.join(top, 'agent')).map((f) => 'mod/agent/' + f)
for (const f of there) if (!listed.includes(f)) no(f + ' is not on the list')
for (const f of listed) {
  let bytes
  try {
    bytes = fs.readFileSync(at(f))
  } catch {
    no(f + ' is missing')
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== list.files[f]) no(f + ' is not the file the list names')
}
if (!['agent.mjs', 'service.mjs', 'install.sh'].every((f) => listed.includes('mod/agent/' + f))) no('the agent is not whole')
CHECK
# Installed again: the agent that is here is stopped and taken away whole, with everything it kept (its files, its
# index, what it remembered, its log), once the release that takes its place is in hand and checked. How the machine was
# set up is kept and written back, but for what it signed in and sealed with: the new agent is given those again.
kept=""
if [ "$reinstall" = 1 ]; then
  kept="$("$node_bin" -e 'const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); for (const k of ["token", "key", "has"]) delete c[k]; process.stdout.write(JSON.stringify(c, null, 2) + "\n")' "$(native "$HOME_DIR/agent.json")")" || { echo "$HOME_DIR/agent.json does not read: nothing was changed" >&2; exit 1; }
  stop_service
  rm -rf "$HOME_DIR"
fi
# (the agent that was there, kept until the new one has said it started: --wait-start puts it back where it does not)
if [ "$update" = 1 ] && [ "$reinstall" = 0 ] && [ "$wait_start" -gt 0 ] && [ -d "$HOME_DIR/agent" ]; then
  rm -rf "$HOME_DIR/agent.before"
  cp -R "$HOME_DIR/agent" "$HOME_DIR/agent.before"
fi
mkdir -p "$HOME_DIR/agent"
chmod 700 "$HOME_DIR"
cp "$src"/*.mjs "$HOME_DIR/agent/"
# (and this installer as the release has it, with the list it was checked by: what the agent is next brought up to date with)
cp "$src/install.sh" "$list" "$list.sig" "$HOME_DIR/agent/"
# (and the keys it was checked by, for the agent's own check of what is installed: agent.mjs verify)
cp "$stage/signers" "$HOME_DIR/agent/release-signers"

# agent.json: what's there is kept (the machine's id among it), and the options given replace their own.
# An update writes nothing there: the machine is set up as it was.
if [ "$update" = 0 ]; then
  configure=(--server "$server")
  [ -n "$label" ] && configure+=(--label "$label")
  for d in "${roots[@]:-}"; do [ -n "$d" ] && configure+=(--root "$d"); done
  for d in "${spawn[@]:-}"; do [ -n "$d" ] && configure+=(--spawn "$d"); done
  for m in "${modes[@]:-}"; do [ -n "$m" ] && configure+=(--mode "$m"); done
  for d in "${files[@]:-}"; do [ -n "$d" ] && configure+=(--files "$d"); done
  [ "$relay" = 1 ] && configure+=(--relay)
  [ "$auto_folders" = 1 ] && configure+=(--auto-folders)
  [ "$keychain" = 0 ] && configure+=(--no-keychain)
  [ "$waiting" = 1 ] && configure+=(--wait)
  # (the key goes in the environment, not on a command line others can see)
  MANYCLAWS_HOME="$NHOME" MANYCLAWS_TOKEN="$token" MANYCLAWS_KEY="$key" "$node_bin" "$(native "$HOME_DIR/agent/agent.mjs")" configure "${configure[@]}" >/dev/null
else
  if [ "$reinstall" = 1 ]; then
    (umask 077; printf '%s' "$kept" > "$HOME_DIR/agent.json")
    # (and what the keychain had of the old one's goes too)
    MANYCLAWS_HOME="$NHOME" "$node_bin" "$(native "$HOME_DIR/agent/agent.mjs")" forget 2>/dev/null || true
  fi
  # (an agent brought up to date keeps its token and key where a new one does: on a Mac, in the keychain, unless this
  # machine was set up not to)
  MANYCLAWS_HOME="$NHOME" "$node_bin" "$(native "$HOME_DIR/agent/agent.mjs")" keychain || true
fi

stop_service
# (from here, whatever the new agent writes of its own start is what is waited for)
begun="$(date +%s)"
start_service() {
if [ "$os" = windows ]; then
  # A task of the user's own, in their own session (so that the sessions it starts run as them, with what they have),
  # started as they sign in and now, and started again a minute after it stops of itself, with no window of its
  # own: conhost --headless keeps the console the agent runs in off the screen, and cmd puts what it says in its log
  # (Task Scheduler keeps nothing of it). No administrator is asked for: the task is the user's and runs as them. Its
  # priority is said, normal (4): a task that does not say runs below normal, and so does every process it starts, the
  # sessions from the page and whatever they build among them.
  who="$(win "$(cygpath -W)/System32/whoami.exe" | tr -d '\r')"
  esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
  # What the task runs is a file of its own, agent-run.cmd: conhost takes what follows it apart and puts it together
  # again without the quotes inside it, so a command line with a quoted path in it (node's, in Program Files) arrives
  # broken, and one file's name is all it can be given whole. (Where the agent's folder is not the usual one, it says
  # where it is: a task sets no environment of its own.)
  runner="$HOME_DIR/agent-run.cmd"
  # It keeps the agent running itself: what the task ran ends as conhost does, and conhost ends well whatever ended what
  # it ran, so Task Scheduler never takes it for one that failed, and never starts it again. The agent goes and is
  # started again as launchd and systemd do it (it goes of itself to start again with a token the plugin gave it), five
  # seconds after; stopping the service ends this as well as the agent.
  {
    printf '@echo off\r\n'
    [ "$HOME_DIR" = "$(cygpath -u "$USERPROFILE")/.manyclaws" ] || printf 'set "MANYCLAWS_HOME=%s"\r\n' "$NHOME"
    printf ':run\r\n'
    printf '"%s" "%s" run >> "%s" 2>&1\r\n' "$(native "$node_bin")" "$(native "$HOME_DIR/agent/agent.mjs")" "$(native "$HOME_DIR/agent.log")"
    printf 'ping -n 6 127.0.0.1 >nul\r\n'
    printf 'goto run\r\n'
  } > "$runner"
  xml="$HOME_DIR/agent-task.xml"
  cat > "$xml.utf8" <<EOF
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>ManyClaws agent: this computer's Claude Code sessions, for the ManyClaws server</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$(printf '%s' "$who" | esc)</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$(printf '%s' "$who" | esc)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author"><Exec><Command>$(native "$(cygpath -W)/System32/conhost.exe" | esc)</Command><Arguments>--headless "$(native "$runner" | esc)"</Arguments></Exec></Actions>
</Task>
EOF
  # (Task Scheduler reads a task's XML as UTF-16; Git for Windows has no iconv, and node is here)
  "$node_bin" -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], Buffer.from("\ufeff" + fs.readFileSync(process.argv[1], "utf8"), "utf16le"))' "$(native "$xml.utf8")" "$(native "$xml")"
  rm -f "$xml.utf8"
  win schtasks.exe /create /tn "$TASK" /xml "$(native "$xml")" /f >/dev/null || { echo "Task Scheduler would not take the agent's task: nothing starts it. Its XML: $xml" >&2; exit 1; }
  win schtasks.exe /run /tn "$TASK" >/dev/null || { echo "Task Scheduler would not start the agent's task. Start it with: schtasks /run /tn \"$TASK\"" >&2; exit 1; }
elif [ "$os" = mac ]; then
  # Interactive, as an app is: every process the agent starts has its priority, the sessions from the page and whatever
  # they build among them, and those are the person's own work, asked for. Background held all of it to the lowest
  # priority (4) and throttled its disk, as a Mac does what nobody asked for.
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$node_bin</string><string>$HOME_DIR/agent/agent.mjs</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>MANYCLAWS_HOME</key><string>$HOME_DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$HOME_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/agent.log</string>
</dict></plist>
EOF
  started=0
  for _ in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then started=1; break; fi
    sleep 1
  done
  [ "$started" = 1 ] || { echo "launchd would not start the agent. Start it with: launchctl bootstrap gui/$(id -u) $PLIST" >&2; exit 1; }
else
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=ManyClaws agent: this machine's Claude Code sessions, for the ManyClaws server
After=network-online.target

[Service]
ExecStart=$node_bin $HOME_DIR/agent/agent.mjs run
Environment=MANYCLAWS_HOME=$HOME_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now manyclaws-agent.service
  loginctl enable-linger "$USER" 2>/dev/null || echo "Note: without 'loginctl enable-linger $USER' the agent stops when you log out."
fi
}
start_service
# Started: the new agent says so (agent.started, newer than this run). Where it does not in the time given, the agent
# that was there is put back as it was, and started again.
if [ "$wait_start" -gt 0 ] && [ -d "$HOME_DIR/agent.before" ]; then
  said=""
  for _ in $(seq 1 $((wait_start * 4))); do
    at="$(sed -n 's/.*"at":\([0-9][0-9]*\).*/\1/p' "$HOME_DIR/agent.started" 2>/dev/null | head -1 || true)"
    if [ -n "$at" ] && [ "$((at / 1000))" -ge "$begun" ]; then said=1; break; fi
    sleep 0.25
  done
  if [ -z "$said" ]; then
    stop_service
    rm -rf "$HOME_DIR/agent"
    mv "$HOME_DIR/agent.before" "$HOME_DIR/agent"
    start_service
    echo "The new ManyClaws agent did not say it had started within $wait_start seconds: the one that was here is put back, as it was, and started again. Its log: $HOME_DIR/agent.log" >&2
    exit 1
  fi
  rm -rf "$HOME_DIR/agent.before"
fi

if [ "$reinstall" = 1 ]; then
  echo "The old ManyClaws agent is removed, with its API token and its key and everything else it kept. Agent $(sed -n "s/^export const VERSION = '\(.*\)'\$/\1/p" "$HOME_DIR/agent/service.mjs") is installed in its place, as $from has it (a signed release, checked), and running, set up as the old one was. Its log: $HOME_DIR/agent.log"
  echo "It has no API token or encryption key, and asked for none: it takes both from the ManyClaws plugin."
  MANYCLAWS_HOME="$NHOME" "$node_bin" "$(native "$HOME_DIR/agent/agent.mjs")" plugin --look || echo "ONE STEP IS LEFT, AND IT IS THE PERSON'S: connect this computer. Start a new Claude Code session on it: the ManyClaws plugin shows a code, to type under Connect a computer where you are signed in to ManyClaws, and approve."
  exit 0
fi
if [ "$update" = 1 ]; then
  echo "The ManyClaws agent is $(sed -n "s/^export const VERSION = '\(.*\)'\$/\1/p" "$HOME_DIR/agent/service.mjs") now, as $from has it (a signed release, checked), and running, set up as it was. Its log: $HOME_DIR/agent.log"
  exit 0
fi
echo "The ManyClaws agent is installed in $HOME_DIR and running. Its log: $HOME_DIR/agent.log"
echo "To bring it up to date later: bash $HOME_DIR/agent/install.sh --update"
if [ ${#spawn[@]} -eq 0 ] && [ "$auto_folders" = 0 ]; then echo "Sessions on this machine can be read and searched from the page. Starting them is off (--spawn DIR or --auto-folders turns it on)."
else
  [ ${#spawn[@]} -eq 0 ] || echo "The page may start and resume sessions in: ${spawn[*]}"
  [ "$auto_folders" = 0 ] || echo "The page may start and resume sessions in the folders you have used Claude Code in on this machine (not your home folder, a temporary one or one inside a folder whose name starts with a dot; used in the last 90 days). It lists them, and can turn any of them off."
  if [ ${#modes[@]} -eq 0 ]; then echo "Sessions may be started in any permission mode, bypassing permissions too (--mode names the only ones to allow)."
  else case " ${modes[*]} " in *" bypassPermissions "*) echo "Sessions may be started with their permissions bypassed, as you asked (--mode bypassPermissions)." ;; *) echo "Sessions are not started with their permissions bypassed (--mode bypassPermissions allows it)." ;; esac
  fi
fi
if [ ${#files[@]} -gt 0 ]; then echo "The page may open files from: ${files[*]}, and from the temporary folders"
elif [ ${#spawn[@]} -gt 0 ] || [ "$auto_folders" = 1 ]; then echo "The page may open files from those folders and the temporary ones, and from nowhere else on this machine (--files DIR names others)."
else echo "The page may open files from the temporary folders, and from nowhere else on this machine (--files DIR names others)."; fi
if [ ${#spawn[@]} -gt 0 ] || [ "$auto_folders" = 1 ]; then echo "The page may put files into the folders sessions are started in, and nowhere else (\"upload\": false in agent.json has none put anywhere)."
else echo "The page puts no files on this machine."; fi

# The plugin beside it, in Claude Code, and this agent are given the same token and key.
# Given here (a set-up with nobody there), they are given to the plugin now. Otherwise the
# computer is connected with the code the plugin shows, and the agent takes them from the
# plugin. What is said says which, and what is left for the person to do.
if [ "$typed" = 1 ] && [ "$waiting" = 0 ]; then
  MANYCLAWS_HOME="$NHOME" "$node_bin" "$(native "$HOME_DIR/agent/agent.mjs")" plugin || echo "The ManyClaws plugin was NOT given its API token and key. Start a new Claude Code session on this computer: the plugin shows a code that connects it."
elif [ "$by_claude" = 1 ] || [ "$waiting" = 1 ]; then
  if [ "$waiting" = 1 ]; then echo "It has no API token or encryption key yet, and asked for none: it takes both from the ManyClaws plugin."; fi
  MANYCLAWS_HOME="$NHOME" "$node_bin" "$(native "$HOME_DIR/agent/agent.mjs")" plugin --look || echo "ONE STEP IS LEFT, AND IT IS THE PERSON'S: connect this computer. Start a new Claude Code session on it: the ManyClaws plugin shows a code, to type under Connect a computer where you are signed in to ManyClaws, and approve."
fi
