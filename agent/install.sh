#!/usr/bin/env bash
# Installs the ManyClaws agent on this machine and starts it as a service of your
# own user (launchd on macOS, systemd --user on Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/redimaker/manyclaws/main/agent/install.sh | bash -s -- [options]
#
# The agent's files are fetched from the public repository they are kept in, as its main
# branch stands (github.com/redimaker/manyclaws): what runs here is what anyone can read
# there, and no server hands it out.
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
#   --from TGZ          take the agent's files from this .tgz, by its address or its path, where
#                       they are not to come from the repository (or MANYCLAWS_AGENT_FROM)
#   --label NAME        what the page calls this machine (default: its host name)
#   --root DIR          a Claude Code config dir to index; repeat for several (default: ~/.claude)
#   --spawn DIR         let the page start and resume sessions in DIR; repeat for several.
#                       Without it the machine's sessions can be read and searched, not started.
#   --mode MODE         a permission mode the page may start sessions in; repeat for several.
#                       Given, only the ones named are allowed; with none, every mode is
#                       (default, acceptEdits, plan, auto, dontAsk, bypassPermissions). The
#                       list is "spawn": { "modes": [...] } in agent.json, and can be changed there.
#   --relay             send this machine's ManyClaws mod through the agent, so the
#                       machine has one connection to the server
#   --token TOKEN       the API token, where it can't be asked for (or MANYCLAWS_TOKEN)
#   --key KEY           the encryption passphrase, where it can't be asked for (or
#                       MANYCLAWS_KEY). The key is made from it here and kept; the
#                       passphrase is not. Everything the agent sends of the machine's
#                       sessions is sealed with that key
#   --new-passphrase    ask for the encryption passphrase again, on a machine that has a key
#                       already: after you have chosen a new one for your account
#   --update            fetch the agent the server hands out now and start it again: for an
#                       agent that is older than that, or one that is not running. Everything
#                       the machine was set up with is kept, and nothing is asked. Where the
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
server="" token="" label="" relay=0 uninstall=0 rekey=0 typed=0 update=0 end_sessions=0
roots=() spawn=() modes=() key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server="${2%/}"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --root) roots+=("$2"); shift 2 ;;
    --spawn) spawn+=("$2"); shift 2 ;;
    --mode) modes+=("$2"); shift 2 ;;
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

# The agent's files: fetched whole, and looked at, before anything that is here is replaced
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
if [ -f "$from" ]; then tar -xzf "$from" -C "$stage"
else curl -fsSL "$from" | tar -xzf - -C "$stage" || { echo "The agent's files could not be fetched from $from" >&2; exit 1; }
fi
# (the repository's archive has them in its agent folder; a .tgz of the agent alone has them at its top)
found="$(find "$stage" -maxdepth 3 -name agent.mjs | head -1)"
[ -n "$found" ] && [ -f "$(dirname "$found")/service.mjs" ] || { echo "What $from gave is not the ManyClaws agent" >&2; exit 1; }
src="$(dirname "$found")"
for f in "$src"/*.mjs; do "$node_bin" --check "$f" || { echo "What $from gave does not read as the agent's files: nothing was changed" >&2; exit 1; }; done
mkdir -p "$HOME_DIR/agent"
chmod 700 "$HOME_DIR"
cp "$src"/*.mjs "$HOME_DIR/agent/"

# agent.json: what's there is kept (the machine's id among it), and the options given replace their own.
# An update writes nothing there: the machine is set up as it was.
if [ "$update" = 0 ]; then
  configure=(--server "$server")
  [ -n "$label" ] && configure+=(--label "$label")
  for d in "${roots[@]:-}"; do [ -n "$d" ] && configure+=(--root "$d"); done
  for d in "${spawn[@]:-}"; do [ -n "$d" ] && configure+=(--spawn "$d"); done
  for m in "${modes[@]:-}"; do [ -n "$m" ] && configure+=(--mode "$m"); done
  [ "$relay" = 1 ] && configure+=(--relay)
  [ "$waiting" = 1 ] && configure+=(--wait)
  # (the key goes in the environment, not on a command line others can see)
  MANYCLAWS_HOME="$HOME_DIR" MANYCLAWS_TOKEN="$token" MANYCLAWS_KEY="$key" "$node_bin" "$HOME_DIR/agent/agent.mjs" configure "${configure[@]}" >/dev/null
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
  echo "The ManyClaws agent is $(sed -n "s/^export const VERSION = '\(.*\)'\$/\1/p" "$HOME_DIR/agent/service.mjs") now, as $from has it, and running, set up as it was. Its log: $HOME_DIR/agent.log"
  exit 0
fi
echo "The ManyClaws agent is installed in $HOME_DIR and running. Its log: $HOME_DIR/agent.log"
if [ ${#spawn[@]} -eq 0 ]; then echo "Sessions on this machine can be read and searched from the page. Starting them is off (--spawn DIR turns it on)."
else echo "The page may start and resume sessions in: ${spawn[*]}"; fi

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
