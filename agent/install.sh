#!/usr/bin/env bash
# Installs the ManyClaws agent on this machine and starts it as a service of your
# own user (launchd on macOS, systemd --user on Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/redimaker/manyclaws/main/agent/install.sh | bash -s -- [options]
#
# and, once it is installed, to bring it up to date, the copy of this that it keeps:
#
#   bash ~/.manyclaws/agent/install.sh --update
#
# The agent's files are fetched from the public repository they are kept in
# (github.com/redimaker/manyclaws): what runs here is what anyone can read there, and no
# server hands it out. What is fetched is a release: a list of every file with its SHA-256
# (release.json), signed (release.json.sig) with a key that is kept neither in that
# repository nor on any server. Nothing is installed unless the signature is by a key this
# installer knows (SIGNERS, below) and every file is as the list says; and none older than
# the release installed is taken. So an agent that is installed updates itself by a key it
# already has: whoever came to control the repository could not put code on this machine.
# The first install has nothing but this script to go by, which is why the script is worth
# reading before it is run.
#
# The agent signs in with an API token of your account's and seals with a key made from
# your encryption passphrase: the same two the ManyClaws plugin in Claude Code is given.
# It needs both: nothing of this machine's sessions is sent unsealed. They are typed
# once. Where Claude Code runs this for you, it asks for nothing: the agent is
# installed and waits, and takes both from the plugin once you have typed them
# into the plugin's own dialog (Manage Plugins) and started a session. Where you run it
# yourself, it asks for both on the terminal, without showing what is typed, and gives
# the plugin the same. Neither goes in the command.
#
#   --server URL        the ManyClaws server this machine reports to (default: what it was set
#                       up with, else https://manyclaws.dev)
#   --from WHERE        take the release from here, where it is not to come from the repository:
#                       a .tar.gz by its address or its path, or a folder, laid out as the
#                       repository is (or MANYCLAWS_AGENT_FROM). It is checked all the same
#   --signers FILE      the keys a release may be signed by, in place of the ones this installer
#                       knows: a file as ssh-keygen's "allowed signers" are written. For a
#                       release of your own making
#   --label NAME        what the page calls this machine (default: its host name)
#   --root DIR          a Claude Code config dir to index; repeat for several (default: ~/.claude)
#   --spawn DIR         let the page start and resume sessions in DIR; repeat for several.
#                       Without it the machine's sessions can be read and searched, not started.
#   --mode MODE         a permission mode the page may start sessions in; repeat for several.
#                       Given, only the ones named are allowed. With none: default, acceptEdits,
#                       plan, auto and dontAsk, and not bypassPermissions, which lets a session
#                       do anything it is prompted to with nobody asked: name it here to have
#                       it. The list is "spawn": { "modes": [...] } in agent.json.
#   --files DIR         a folder the page may open files from; repeat for several. With none,
#                       the --spawn folders. A file anywhere else on the machine is not opened.
#   --relay             send this machine's ManyClaws mod through the agent, so the
#                       machine has one connection to the server
#   --token TOKEN       the API token, where it can't be asked for (or MANYCLAWS_TOKEN)
#   --key KEY           the encryption passphrase, where it can't be asked for (or
#                       MANYCLAWS_KEY). The key is made from it here and kept; the
#                       passphrase is not. Everything the agent sends of the machine's
#                       sessions is sealed with that key
#   --no-keychain       on a Mac, keep the token and the key in agent.json (which only you can
#                       read) and not in your login keychain, where they are kept otherwise
#   --new-passphrase    ask for the encryption passphrase again, on a machine that has a key
#                       already: after you have chosen a new one for your account
#   --update            fetch the newest release and start the agent again: for an agent that
#                       is older than that, or one that is not running. Everything the machine
#                       was set up with is kept, and nothing is asked. Where the
#                       agent reports is what it was set up with, unless --server names another.
#                       Starting the agent again ends the sessions it is running (the ones
#                       started from the page), so while there are any nothing is done
#   --end-sessions      with --update: do it all the same, and end those sessions
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

REPO="redimaker/manyclaws"
from="${MANYCLAWS_AGENT_FROM:-https://codeload.github.com/$REPO/tar.gz/refs/heads/main}"
# The keys a release may be signed by, as ssh-keygen's "allowed signers" are written. A
# release signed by one of these may bring an installer with others: that is how a key is
# replaced, and it is why an installed agent is updated by its own copy of this script.
SIGNERS='manyclaws namespaces="manyclaws-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMPeEfWVnYHahu/dRpMq7J+2eRNg67sQS+IJh/bH8PDD'
server="" token="" label="" relay=0 uninstall=0 rekey=0 typed=0 update=0 end_sessions=0 keychain=1 signers=""
roots=() spawn=() modes=() files=() key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server="${2%/}"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --root) roots+=("$2"); shift 2 ;;
    --spawn) spawn+=("$2"); shift 2 ;;
    --mode) modes+=("$2"); shift 2 ;;
    --files) files+=("$2"); shift 2 ;;
    --signers) signers="$2"; shift 2 ;;
    --no-keychain) keychain=0; shift ;;
    --relay) relay=1; shift ;;
    --key) key="$2"; shift 2 ;;
    --new-passphrase) rekey=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --update) update=1; shift ;;
    --end-sessions) end_sessions=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

stop_service() {
  if [ "$(uname)" = Darwin ]; then
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

# This machine's agent where it is running (the one in $HOME_DIR): its pid, or nothing
agent_pid() {
  ps -axww -o pid=,command= 2>/dev/null | grep -F -- "$HOME_DIR/agent/agent.mjs run" | grep -v grep | awk '{ print $1 }' | head -1
}
running="$(agent_pid || true)"
# A session the agent itself started (one started from the page) runs under the agent:
# stopping the agent ends that session, and this run with it, before the agent is started
# again. So from one of those nothing here is done, and it says so.
if [ -n "$running" ]; then
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    if [ "$p" = "$running" ]; then
      echo "This was run from a session the ManyClaws agent itself started (one started from your page). Stopping the agent ends that session, and this run with it, before the agent is started again: nothing was changed. Run it in a terminal on this machine, or from a Claude Code session started there in a terminal or VS Code." >&2
      exit 3
    fi
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' || true)"
  done
fi

if [ "$uninstall" = 1 ]; then
  stop_service
  # (what the keychain has of this machine's goes with it)
  node_bin="$(command -v node || true)"
  [ -z "$node_bin" ] || [ ! -f "$HOME_DIR/agent/agent.mjs" ] || MANYCLAWS_HOME="$HOME_DIR" "$node_bin" "$HOME_DIR/agent/agent.mjs" forget 2>/dev/null || true
  rm -f "$PLIST" "$UNIT"
  rm -rf "$HOME_DIR"
  echo "The ManyClaws agent is stopped and removed. If the mod was set to go through it,"
  echo "point it back at the server: claude plugin configure manyclaws@manyclaws --values-stdin"
  exit 0
fi

if [ "$update" = 1 ]; then
  [ -f "$HOME_DIR/agent.json" ] || { echo "There is no ManyClaws agent on this machine to update: $HOME_DIR/agent.json is not there. Install it as the guide's step 3 has it." >&2; exit 2; }
  # Starting it again ends the sessions it is running: each a Claude Code the agent started, under it
  if [ -n "$running" ] && [ "$end_sessions" = 0 ]; then
    hosted="$(ps -axww -o ppid=,command= 2>/dev/null | awk -v agent="$running" '$1 == agent' | grep -c -- '--input-format stream-json' || true)"
    if [ "${hosted:-0}" -gt 0 ]; then
      echo "The ManyClaws agent is running $hosted session(s) started from your page, and starting it again ends them: nothing was changed. Run this again when they are done, or with --end-sessions to end them now." >&2
      exit 3
    fi
  fi
fi
# Where it reports: what was named, else what this machine was set up with, else ManyClaws' own server
[ -n "$server" ] || [ ! -f "$HOME_DIR/agent.json" ] || server="$(sed -n 's/^[[:space:]]*"server"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$HOME_DIR/agent.json" | head -1)"
[ -n "$server" ] || server="https://manyclaws.dev"
server="${server%/}"
token="${token:-${MANYCLAWS_TOKEN:-}}"
key="${key:-${MANYCLAWS_KEY:-}}"
# What this machine was set up with before is kept: run again, it asks for nothing it has
had_token=0 had_key=0
if [ -f "$HOME_DIR/agent.json" ]; then
  grep -q '"token"' "$HOME_DIR/agent.json" && had_token=1
  # (a key as this agent keeps one: anything written another way is not one, and the passphrase is asked for)
  grep -q '"key": *"mcf_' "$HOME_DIR/agent.json" && had_key=1
  # (both kept in the keychain: their fingerprint is here in their place)
  grep -q '"has": *"' "$HOME_DIR/agent.json" && had_token=1 had_key=1
fi
# (a new passphrase makes a new key: the one kept is not gone by)
[ "$rekey" = 0 ] || had_key=0
# Asked on the terminal itself (the script is what's on standard input), and not shown
ask() {
  { : >/dev/tty; } 2>/dev/null || return 1
  printf '%s' "$1" >/dev/tty
  IFS= read -r -s answer </dev/tty || answer=""
  printf '\n' >/dev/tty
}
# Where Claude Code runs this, nothing is asked: there is no terminal to ask on, and what
# would be typed is not to pass through what is said to Claude. The agent is installed
# without what it has not been given, and takes it from the plugin (see the end).
by_claude=0
[ -z "${CLAUDECODE:-}" ] || by_claude=1
# (what was typed or given in this run is the newest there is, and the plugin is given it)
[ -z "$token$key" ] || typed=1
if [ "$update" = 0 ] && [ -z "$token" ] && [ "$had_token" = 0 ] && [ "$by_claude" = 0 ]; then
  ask "API token (from your account page, under API tokens): " || { echo "The API token has to be typed in, and there is no terminal here to ask on. Run this in a terminal of your own, or give it in MANYCLAWS_TOKEN." >&2; exit 2; }
  token="$answer"
  [ -n "$token" ] || { echo "No token was given." >&2; exit 2; }
  typed=1
fi
if [ "$update" = 0 ] && [ -z "$key" ] && [ "$had_key" = 0 ] && [ "$by_claude" = 0 ]; then
  ask "Encryption passphrase (the one you type on your account page): " || { echo "The encryption passphrase has to be typed in, and there is no terminal here to ask on. Run this in a terminal of your own, or give it in MANYCLAWS_KEY." >&2; exit 2; }
  key="$answer"
  [ -n "$key" ] || { echo "No passphrase was given: nothing of this machine's sessions is sent unsealed, so the agent needs it." >&2; exit 2; }
  typed=1
fi
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
  mkdir "$stage/from"
  for part in agent release.json release.json.sig; do [ ! -e "$from/$part" ] || cp -R "$from/$part" "$stage/from/"; done
elif [ -f "$from" ]; then tar -xzf "$from" -C "$stage"
else curl -fsSL "$from" | tar -xzf - -C "$stage" || { echo "The release could not be fetched from $from" >&2; exit 1; }
fi
# (the repository's archive has everything in one folder under its top)
list="$(find "$stage" -maxdepth 2 -name release.json | head -1)"
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
"$node_bin" - "$top" "${had_release:-0}" <<'CHECK' || { echo "Nothing was changed." >&2; exit 1; }
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
const listed = Object.keys(list.files).filter((f) => f.startsWith('agent/'))
const there = fs.readdirSync(path.join(top, 'agent')).map((f) => 'agent/' + f)
for (const f of there) if (!listed.includes(f)) no(f + ' is not on the list')
for (const f of listed) {
  let bytes
  try {
    bytes = fs.readFileSync(path.join(top, f))
  } catch {
    no(f + ' is missing')
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== list.files[f]) no(f + ' is not the file the list names')
}
if (!listed.includes('agent/agent.mjs') || !listed.includes('agent/service.mjs') || !listed.includes('agent/install.sh')) no('the agent is not whole')
CHECK
for f in "$src"/*.mjs; do "$node_bin" --check "$f" || { echo "What $from gave does not read as the agent's files: nothing was changed" >&2; exit 1; }; done
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
  [ "$keychain" = 0 ] && configure+=(--no-keychain)
  [ "$waiting" = 1 ] && configure+=(--wait)
  # (the key goes in the environment, not on a command line others can see)
  MANYCLAWS_HOME="$HOME_DIR" MANYCLAWS_TOKEN="$token" MANYCLAWS_KEY="$key" "$node_bin" "$HOME_DIR/agent/agent.mjs" configure "${configure[@]}" >/dev/null
else
  # (an agent brought up to date keeps its token and key where a new one does: on a Mac, in the keychain, unless this
  # machine was set up not to)
  MANYCLAWS_HOME="$HOME_DIR" "$node_bin" "$HOME_DIR/agent/agent.mjs" keychain || true
fi

stop_service
if [ "$(uname)" = Darwin ]; then
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
  <key>ProcessType</key><string>Background</string>
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

if [ "$update" = 1 ]; then
  echo "The ManyClaws agent is $(sed -n "s/^export const VERSION = '\(.*\)'\$/\1/p" "$HOME_DIR/agent/service.mjs") now, as $from has it (a signed release, checked), and running, set up as it was. Its log: $HOME_DIR/agent.log"
  # (what a machine set up before bypassPermissions had to be named would no longer start)
  if grep -q '"enabled": *true' "$HOME_DIR/agent.json" && ! grep -q '"modes"' "$HOME_DIR/agent.json"; then
    echo "Sessions are no longer started here with their permissions bypassed unless this machine says so. To allow it: add \"modes\": [\"default\", \"acceptEdits\", \"plan\", \"auto\", \"dontAsk\", \"bypassPermissions\"] to \"spawn\" in $HOME_DIR/agent.json and run this again."
  fi
  exit 0
fi
echo "The ManyClaws agent is installed in $HOME_DIR and running. Its log: $HOME_DIR/agent.log"
echo "To bring it up to date later: bash $HOME_DIR/agent/install.sh --update"
if [ ${#spawn[@]} -eq 0 ]; then echo "Sessions on this machine can be read and searched from the page. Starting them is off (--spawn DIR turns it on)."
else
  echo "The page may start and resume sessions in: ${spawn[*]}"
  case " ${modes[*]:-} " in *" bypassPermissions "*) echo "Sessions may be started with their permissions bypassed, as you asked (--mode bypassPermissions)." ;; *) echo "Sessions are not started with their permissions bypassed (--mode bypassPermissions allows it)." ;; esac
fi
if [ ${#files[@]} -gt 0 ]; then echo "The page may open files from: ${files[*]}"
elif [ ${#spawn[@]} -gt 0 ]; then echo "The page may open files from those folders, and from nowhere else on this machine (--files DIR names others)."
else echo "The page opens no files from this machine (--files DIR names folders it may)."; fi

# The plugin beside it, in Claude Code, and this agent are given the same token and key,
# typed once. Typed here, on a terminal, they are given to the plugin now (where it
# reports, the token, and the key that was made). Where Claude Code ran this, nothing
# was typed here: the plugin's own dialog is where they go, and the agent takes them
# from the plugin. What is said says which, and what is left for the person to do.
if [ "$typed" = 1 ] && [ "$waiting" = 0 ]; then
  MANYCLAWS_HOME="$HOME_DIR" "$node_bin" "$HOME_DIR/agent/agent.mjs" plugin || echo "The ManyClaws plugin was NOT given its API token and passphrase, and still needs to be configured: /plugin configure manyclaws@manyclaws in Claude Code."
elif [ "$by_claude" = 1 ] || [ "$waiting" = 1 ]; then
  if [ "$waiting" = 1 ]; then echo "It has no API token or encryption key yet, and asked for none: it takes both from the ManyClaws plugin."; fi
  MANYCLAWS_HOME="$HOME_DIR" "$node_bin" "$HOME_DIR/agent/agent.mjs" plugin --look || echo "ONE STEP IS LEFT, AND IT IS THE PERSON'S: give the ManyClaws plugin the API token and the encryption passphrase (/plugin in Claude Code, the gear beside manyclaws), then start a new Claude Code session."
fi
