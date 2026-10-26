# Set up a computer for {{name}}

{{name}} shows every Claude Code session on every computer you have, on one page and on your phone. This guide connects one computer. It is the same for everyone, and Claude Code can follow it for you.

**The short way:** on the computer, start Claude Code and say

> Read {{origin}}/setup.md and set this computer up.

Claude installs the plugin. Start a new session and it shows a code of nine digits: enter it under **Connect a computer** ({{origin}}/app#/connect) on your phone or in a browser where you're signed in, press **Connect**, and confirm with your passkey. Nothing is typed into Claude Code, a chat, a command or a file.

## 1. Your account's key

Your sessions are end-to-end encrypted with your account's own key. There is no passphrase: the key is made of random bytes the first time you sign in to [your page]({{origin}}/app) on a phone, or in a browser with passkeys, and protected there by a passkey.

There is no copy of the key to keep anywhere else. If you ever lose every device that has it, you start afresh with a new key, on your page: your computers still have their sessions.

Each other phone, browser or computer gets the key when you enter the code it shows on a device that already has it.

## 2. Install the plugin

It needs Claude Code 2.1.287 or later (`claude --version`).

{{#elsewhere}}1. Say where this server is: the plugin reports to {{home}} unless a computer names another. In `~/.claude/settings.json`, make sure `env` has this entry, keeping whatever else the file holds:

   ```
   "env": { "MANYCLAWS_URL": "{{origin}}" }
   ```

{{/elsewhere}}1. Add the marketplace and install the plugin. It comes from the public repository [github.com/redimaker/manyclaws](https://github.com/redimaker/manyclaws):

   ```
   claude plugin marketplace add redimaker/manyclaws#beta
   claude plugin install manyclaws@manyclaws
   ```

   The install reports options that are "not yet set". That is expected: step 3 sets them.

## 3. Connect the computer

The computer won't appear in {{name}} until you connect it.

Start a new Claude Code session in a terminal, VS Code or the desktop app. The plugin shows a nine-digit code and a link to `{{origin}}/app#/connect`. Open the link on your phone, or in a browser that has your key, enter the code, press **Connect**, and confirm with your passkey. The code can be used once, and expires after ten minutes or three wrong tries. To get a new one, type `/manyclaws connect` in Claude Code.

Claude Code then shows which account the computer joined. If it isn't yours, type `/manyclaws disconnect`.

**A computer nobody sits at**, such as a server you reach over SSH, is connected the same way, from a Claude Code session in a terminal. Once connected, it keeps working with nobody there.

## 4. The agent

The agent is a small background service. It lets you start a session on the computer from your phone, pick up one that has ended, and search everything Claude Code has done there. It needs Node.js 22.13 or later (`node --version`), on macOS, Linux or Windows (where Git Bash, which Claude Code uses there, installs it, and Task Scheduler starts it as you sign in).

**From your page:** open the computer's gear and press **Let my phone start sessions on** it. Your phone can then start sessions only in folders you've used Claude Code in on that computer in the last 90 days, and never in your home folder or above it, a temporary folder, or one inside a folder whose name starts with a dot. The computer's page lists them.

A session started from your phone is run by the agent, in the background, and stays open for more replies until you end it with Exit on the page. Idle, it is closed only to make room for another, once the agent is running as many as it may (64), and a reply resumes it.

**By hand** (on Windows, in Git Bash), from the plugin's folder (Claude Code's default; with `CLAUDE_CONFIG_DIR` set it is under that folder instead, and `claude plugin list --json` gives it as `installPath`):

```
p=~/.claude/plugins/cache/manyclaws/manyclaws/{{plugin-version}}
bash "$p/agent/install.sh" --from "$p" --auto-folders
```

`--spawn DIR` adds a folder of your own choosing. The installer asks for nothing.

## 5. Your phone

Open {{origin}}/app on your phone and sign in. If your account has no key yet, make it there; otherwise approve the phone from a browser that has it. Add the page to your Home Screen, open it from there, and under **Settings** press **Turn on alerts** to hear when a session needs you or has finished.

## Keeping it up to date and running

Each release is signed. When one is out, the computer's gear has a mark and its page an **Update** button: you approve each update there, for that computer, and it says which sessions it ends. Where a plugin on a computer matches no signed release, its page says so in red, and nothing is sent to that computer until you decide.

**The short way:** on that computer, start Claude Code and say

> Read {{origin}}/setup.md and get {{name}} on this computer up to date and running.

By hand:

- **The plugin.** `claude plugin marketplace update manyclaws`, then `claude plugin update manyclaws@manyclaws`. Sessions started after that have the new one.
- **The agent**, from the copy the plugin carries, once the plugin is updated:

  ```
  p=~/.claude/plugins/cache/manyclaws/manyclaws/{{plugin-version}}
  bash "$p/agent/install.sh" --update --from "$p"
  ```

  It keeps how the computer was set up and asks for nothing. While the agent is running sessions started from your page it does nothing and says so; `--end-sessions` ends them.
- **A computer set up before plugin 6.0.0** is moved once, as [the move guide]({{origin}}/upgrade) has it (for Claude Code: `{{origin}}/upgrade.md`).
- If the agent will not stay running, `~/.manyclaws/agent.log` says why.

## Installing from source

Everything that runs on your computer is in the public repository, with no build step:

```
git clone https://github.com/redimaker/manyclaws && cd manyclaws
git checkout release-N
ssh-keygen -Y verify -f signers -I manyclaws -n manyclaws-release -s mod/release.json.sig < mod/release.json
jq -r '.files|to_entries[]|"\(.value)  \(.key)"' mod/release.json | shasum -a 256 -c
claude plugin validate ./mod
claude plugin marketplace add ./
claude plugin install manyclaws@manyclaws
bash mod/agent/install.sh --from mod
```

`signers` is the `SIGNERS` line of `mod/agent/install.sh`, in a file of its own: check its fingerprint against the README's. Then connect the computer as step 3 has it.

## Taking a computer off again

- On the computer: `claude plugin uninstall manyclaws@manyclaws`, and the agent's installer with `--uninstall`.
- On [your account page]({{origin}}/app#/account): disconnect it, which takes back its API token.

## What is sent

- **End-to-end encrypted:** what you ask Claude and what it answers, the tools it runs and their output, permission prompts and your answers, and everything about the session: its folder, model, mode, state and name.
- **Not encrypted:** that a session exists, which computer it is on, what that computer is called, and when it sends.
- **Done only when one of your own devices signed it:** replies, answers to prompts, and starting or copying a session.
- **Never sent:** your Claude account's credentials, or any file Claude has not read or written.

## For Claude Code, when you are asked to follow this guide

- First check what the computer has, without asking: `claude --version` must be 2.1.287 or later. If it is older, say so, and that `claude update` brings it up to date, and stop. `node --version` matters only for the agent (step 4), which needs 22.13 or later: if Node.js is older or not there, say so when you are done, and go on.
- Do step 2 yourself, without stopping to ask: install the plugin. It asks the person for nothing.
- Step 3 is the person's, and it is the most important thing you tell them: start a new Claude Code session, type the code of nine digits it shows under **Connect a computer** ({{origin}}/app#/connect), press **Connect** and give their passkey. `/manyclaws connect` makes another code.
- Do not install the agent unless you are asked to: it is set up from their page (step 4). Where you are asked to, run it as step 4 has it, by hand, with no other option unless the person named one.
- Keep what you say short: what you installed, then step 3, then that the computer's page can give it the agent, and the phone (step 5).
- Never ask for the API token or the key, and do not use either if it is offered in the conversation.
- Never put a token or a key in a command, in `settings.json`, in an environment variable or in any file.
- Edit `~/.claude/settings.json` by merging: keep every setting that is already there.
- If the marketplace `manyclaws` is already there, go on; if its source does not match its `extraKnownMarketplaces` entry, the computer is moved as `{{origin}}/upgrade.md` has it: say so and stop. Never run `claude plugin marketplace remove manyclaws` here: it deletes the API token and the key the plugin was given. If the plugin is already installed, run `claude plugin update manyclaws@manyclaws` and go on.
- Asked to update the plugin or the agent, or to get the agent running, on a computer already set up: do that and no more, as **Keeping it up to date and running** has it, with `--update --from` the plugin's folder and no other option. An agent from before 6.0.0 (`VERSION` in `~/.manyclaws/agent/service.mjs`) is moved as `{{origin}}/upgrade.md` has it. Never run step 4's installer where `~/.manyclaws/agent.json` exists. Do not read `~/.manyclaws/agent.json`: the token and the key are in it.
- If the installer says the agent is running sessions, or that it was run from one of them, nothing was changed: stop and say so. Use `--end-sessions` only when the person has said to end those sessions.
- The installer starts a background service of the person's own user. Where your commands run in a sandbox that refuses that, run it outside it.
