#!/usr/bin/env bash
# The plugin's own settings hooks (hooks.json): what Claude Code hands one is left for the hooks module in a folder of
# the session's, and a permission prompt's answer is waited for there.
#
# Where an organization manages Claude Code (settings of its own are in force on the computer, or the person's plan is
# Team or Enterprise), its built-in guard (sec-default) passes every settings hook event (classic.*) over the plugins a
# person installed: the hooks module never hears one. A plugin's own settings hooks still run, as the person's own do.
# So the session's permission mode, which these events carry, and a permission prompt the app is asking in its own
# dialog, reach the module this way (register.js, relayFolder and what follows it).
#
# The folder is <Claude Code's config folder>/manyclaws/relay/<session id>:
#   mode       the permission mode, as the latest event said it
#   N.ask      a permission prompt, as the PermissionRequest event gave it
#   N.taken    the module is answering N (until it says so, three seconds on nobody is, and this hook stops)
#   N.answer   the module's answer, which this hook says to Claude Code: nothing, for none
#   N.done     the module has written N.answer whole
# The dialog is up beside this hook, and stays: what is answered there first is the answer, and this hook goes on until
# the module says it has none (Claude Code does not end it).
umask 077
input=$(cat)

# A top-level string field of the event. The first of its name is the top level's (Claude Code writes those before the
# tool's input), and one inside a string is escaped, so not matched; only a plain word is taken.
field() {
  printf '%s' "$input" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[A-Za-z0-9_-]*\"" | head -n 1 | sed 's/.*"\([A-Za-z0-9_-]*\)"$/\1/'
}

sid=$(field session_id)
[ -n "$sid" ] || exit 0
base="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/manyclaws/relay"
dir="$base/$sid"
mkdir -p "$dir" 2>/dev/null || exit 0

mode=$(field permission_mode)
if [ -n "$mode" ]; then
  printf '%s' "$mode" > "$dir/mode.$$" && mv -f "$dir/mode.$$" "$dir/mode"
fi

event=$(field hook_event_name)
# (now and then, the folders of sessions a week gone)
if [ "$event" = UserPromptSubmit ] && [ $((RANDOM % 20)) -eq 0 ]; then
  find "$base" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
fi
[ "$event" = PermissionRequest ] || exit 0

n="$(date +%s)-$$-$RANDOM"
trap 'rm -f "$dir/$n".*' EXIT
trap 'exit 0' TERM INT HUP
printf '%s' "$input" > "$dir/$n.part" && mv -f "$dir/$n.part" "$dir/$n.ask" || exit 0
SECONDS=0
while [ ! -f "$dir/$n.done" ]; do
  # Not taken up: the module is not waiting for one (another mode, another route, or no module loaded)
  if [ ! -f "$dir/$n.taken" ] && [ "$SECONDS" -ge 3 ]; then exit 0; fi
  sleep 0.2
done
cat "$dir/$n.answer" 2>/dev/null
exit 0
