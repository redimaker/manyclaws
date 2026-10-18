# Set up a computer for {{name}}

{{name}} shows every Claude Code session you have running, on every computer, on one page and on your phone. This guide connects one computer. There is nothing personal in it: it is the same for everyone, and it is written so that Claude Code can follow it for you.

**The short way:** on the computer you want to connect, start Claude Code and say

> Read {{origin}}/setup.md and set this computer up.

Claude installs the plugin. Then, in a new Claude Code session, the plugin shows a code of nine digits that connects the computer: enter it under **Connect a computer** ({{origin}}/app#/connect) where you are signed in to {{name}}, on your phone or in a browser that has your key, press **Connect**, and give your passkey (Face ID, Touch ID, your device's PIN or a security key). Nothing is typed into Claude Code, a chat, a command or a file. From your page you can then give the computer its agent, which lets your phone start sessions there, and keep the plugin and the agent up to date.

## 1. Before you start: your account's key

Everything a computer's sessions say is end-to-end encrypted: sealed on that computer before it is sent, with your account's own key. There is no passphrase: the key is made of random bytes, the first time you sign in to [your page]({{origin}}/app) on a phone, or in a browser with passkeys, and it is kept there under a passkey of that device's own.

There is no copy of the key to keep anywhere else. If you ever lose every device that has it, you start afresh with a new key, on your page: your computers still have their sessions, and show them again once each is connected with its code. What you put on sessions there (their names, labels, colors and reminders) is removed.

Each other phone or browser you read your sessions on is given the key by one that has it: signed in there, it shows a code of six digits, and each of your devices that has your key asks you for it by itself. Type it there, say whether the new one is yours or borrowed, and approve it with your passkey. Each computer is given the key the same way, by the code it shows, in step 3.

## 2. Install the plugin

Claude Code can do this part, or you can paste the commands yourself. It needs Claude Code 2.1.287 or later (`claude --version`).

{{#elsewhere}}1. Say where this server is: the plugin reports to {{home}} unless a computer names another. In `~/.claude/settings.json`, make sure `env` has this entry, keeping whatever else the file holds:

   ```
   "env": { "MANYCLAWS_URL": "{{origin}}" }
   ```

{{/elsewhere}}1. Add the marketplace and install the plugin from it. It comes from the public repository the plugin is kept in, [github.com/redimaker/manyclaws](https://github.com/redimaker/manyclaws), where anyone can read what it does. The plugin carries the agent, and the signed list of every file it was released with:

   ```
   claude plugin marketplace add redimaker/manyclaws
   claude plugin install manyclaws@manyclaws
   ```

## 3. Connect the computer

This step is yours, and it is the one that matters: until it is done, nothing of this computer shows.

Start a new Claude Code session (in a terminal, VS Code or the desktop app). The plugin says that the computer is not connected yet, and shows a code of nine digits, with a link to `{{origin}}/app#/connect`, where it is typed. Type it there, where you are signed in to {{name}}: on your phone, or in a browser that keeps your key under a passkey. The page asks whether to connect the computer, by its name: press **Connect**, and give your passkey. The code works once, for ten minutes, and three wrong tries end it; `/manyclaws connect` in Claude Code makes another.

The first three digits find the computer on {{name}}'s server; the other six the plugin made, and never sends. With them the plugin and the page make a key between them (SPAKE2) through the server, which passes on what each side makes. The page makes an API token for the computer, named for it, and seals it and your key with that key. Claude Code then says which account it joined: if it is not yours, type `/manyclaws disconnect`.

The first session after that starts at once, and the computer is on your page. The key does one more thing than keep what is said private. What you ask of this computer from your phone or a browser (a reply, a yes to a permission prompt, a new session) is signed there, and this computer checks. It keeps what it needs to check and nothing it could sign with, so nobody between your phone and this computer, {{name}}'s server included, can ask in your name or send again what you asked before.

**A computer nobody sits at** (a server you reach over SSH): start one Claude Code session there, in a terminal, and connect it with its code. From then on its sessions, and its agent, go on with nobody there.

## 4. The agent

The plugin shows a computer's sessions while they run. The agent is a small background service that adds the rest: it lets you start a new session on that computer from your phone, pick up one that has ended, and search everything Claude Code has done there. It needs Node.js 22.13 or later (`node --version`), and runs on macOS and Linux.

A session started from your phone opens on the computer as any session does: on a Mac in a Terminal window, on Linux in a tmux session (`tmux ls` lists them, `tmux attach -t manyclaws-…` opens one; tmux has to be installed). It is that terminal's, not the agent's: it runs until it is closed there, whatever happens to the agent, and you can sit down at it and carry on. `"terminal"` under `"spawn"` in `~/.manyclaws/agent.json` names another app on a Mac (`"iTerm"`), or `"tmux"`. Claude Code is told it may trust the folder it is started in, which is one you allowed, as answering its question there would have it.

**From your page:** the computer's line in your list has a gear; on its page, press **Let my phone start sessions on** it. The plugin there installs the agent from its own folder, where it is carried: the installer checks every file against the signed list, and the list's signature, before anything is installed. Sessions may then be started from your phone in the folders you have used Claude Code in on that computer, and in no other: never your home folder or one above it, a temporary one, or one inside a folder whose name starts with a dot, and only one used in the last 90 days. The computer's page lists them, and turns any of them off.

**By hand**, from the copy of the agent the plugin carries (`claude plugin list --json` says where the plugin is installed: its `installPath`):

```
bash <the plugin's folder>/agent/install.sh --from <the plugin's folder> --auto-folders
```

`--spawn DIR` names a folder of your own choosing where sessions may be started too, and new project folders made; give it once for each. The installer asks for nothing: the agent takes the API token and the key from the plugin, once the computer is connected.

## 5. Check it worked

- The new session appears at {{origin}}/app within a few seconds, under the computer's name, with "encrypted" under its title.
- With the agent, the computer is listed there by its name with every session Claude Code has had on it, running or not, and its page says which release it is, as its agent checked it.
- If the session does not appear, the plugin says why in Claude Code itself: a token that has run out or been taken back (it then shows the code that connects the computer again), no key yet, or a server it cannot reach. A computer sends nothing unsealed, and the server takes nothing that is not sealed. Nothing checks your key for you: if the page says some sessions were sealed with another key and cannot be opened, a computer of yours has another one, from before your account was started afresh. **What to do**, beside it, says which, and how it is connected again.

## 6. Your phone

Open {{origin}}/app on your phone and sign in. Where your account has no key yet, make it there: your phone keeps it under Face ID or Touch ID. Where it has one, approve the phone from a browser that has it: the phone shows a code, and that browser asks you for it. Put the page on the Home Screen (on an iPhone: Share, then Add to Home Screen), open it from there, tap **Settings** at the foot of the list, and then **Turn on alerts**. Your phone then tells you when a session needs you or has finished.

## Keeping it up to date and running

Each release of the plugin and the agent is a list of every file with its SHA-256, signed with a key kept neither in the public repository nor on {{name}}'s server. Your page checks that signature itself, and holds each computer's plugin to it, as the computer's agent measured it there. Where a newer release is out, the computer's gear has a mark, and its page an **Update** button: you approve each update there, for that computer, and it says which sessions it ends. The agent has Claude Code fetch the plugin, holds what arrived to the release you approved before anything of it is used, and replaces itself from the copy the new plugin carries, putting the old one back if the new one does not start. A computer with no agent is updated the same way, by its plugin, through a session running there.

Where a plugin on a computer matches no signed release, its page says so in red, and nothing is sent to that computer until you decide: take back its access, keep it blocked, or, if you changed it yourself, allow it there with your passkey.

The page also says when a computer's sessions are reporting but its agent is not running: until it runs, no session can be started on that computer from your phone. **The short way:** on that computer, start Claude Code and say

> Read {{origin}}/setup.md and get {{name}} on this computer up to date and running.

By hand:

- **The plugin.** `claude plugin marketplace update manyclaws`, then `claude plugin update manyclaws@manyclaws`. A session that is already open keeps the plugin it started with: the new one is in every session started after.
- **The agent**, from the copy the plugin carries:

  ```
  bash <the plugin's folder>/agent/install.sh --update --from <the plugin's folder>
  ```

  It takes nothing that is not signed by a key the agent already has, and no release older than the one it has. Everything the computer was set up with is kept, and nothing is asked. Sessions started from your page are in terminals of their own, and go on as they are. Starting the agent again ends only a search it is running for your page: while there is one, the installer does nothing and says so. Add `--end-sessions` to end it.
- **A computer set up before plugin 6.0.0** is moved once, as [the move guide]({{origin}}/upgrade) has it (for Claude Code: `{{origin}}/upgrade.md`). From then on it is kept up to date from your page.
- If the agent will not stay running, `~/.manyclaws/agent.log` says why.

## Installing from source, to read it first

Everything that runs on your computer is in the public repository, as it is released: there is no build step. To install exactly what you read:

```
git clone https://github.com/redimaker/manyclaws && cd manyclaws
git checkout release-N
ssh-keygen -Y verify -f signers -I manyclaws -n manyclaws-release -s mod/release.json.sig < mod/release.json
jq -r '.files|to_entries[]|"\(.value)  \(.key)"' mod/release.json | shasum -a 256 -c
claude plugin validate ./mod
```

`signers` is the line `SIGNERS` holds in `mod/agent/install.sh`, in a file of its own; hold its key's fingerprint against the one the README publishes. Every file should read `OK`, and `claude plugin validate` lists every event the plugin handles and every call it makes. Then:

```
claude plugin marketplace add ./
claude plugin install manyclaws@manyclaws
bash mod/agent/install.sh --from mod
```

Claude Code loads the plugin from that folder as it is, so nothing changes until you check out another release. Connect the computer with the code a new session shows, as step 3 has it; the installer asks for nothing. Under **Account → Devices** on your page, each of your devices can be stopped from starting sessions on your computers.

## For Claude Code, when you are asked to follow this guide

- Do step 2 yourself, without stopping to ask: install the plugin. It asks the person for nothing.
- Step 3 is the person's, and it is the most important thing you tell them. When the plugin is installed, say it first and plainly: start a new Claude Code session, and type the code of nine digits the plugin shows there under **Connect a computer** ({{origin}}/app#/connect) where they are signed in to {{name}}, press **Connect** and give their passkey. The code works for ten minutes; `/manyclaws connect` makes another.
- Do not install the agent unless you are asked to: it is set up from their page, once the computer is connected (step 4). Where you are asked to, run it as step 4 has it, by hand, with `--from` the plugin's folder and `--auto-folders`, and no other option unless the person named one.
- Keep what you say short: what you installed, in a line or two; then step 3, as above; then that the computer's page can give it the agent, and the phone (step 6). Do not explain how the plugin works or what is and is not encrypted, unless you are asked: the guide says those things for whoever wants them.
- Never ask for the API token or the key, and do not use either if it is offered in the conversation: say that the computer is connected with its code.
- Never put a token or a key in a command, in `settings.json`, in an environment variable or in any file.
- Edit `~/.claude/settings.json` by merging: keep every setting that is already there.
- If `claude plugin marketplace add` says a marketplace named `manyclaws` is already there, go on. If it says that its source does not match its `extraKnownMarketplaces` entry, the computer was set up from {{name}}'s server long ago: it is moved as `{{origin}}/upgrade.md` has it, which is another guide than this one, so say so and stop. Never run `claude plugin marketplace remove manyclaws` here: it deletes the API token and the key the plugin was given. If `claude plugin install` says the plugin is already installed, run `claude plugin update manyclaws@manyclaws` and go on.
- Asked to update the plugin or the agent, or to get the agent running, on a computer that is already set up (**Keeping it up to date and running**): do what was asked and no more. `claude plugin list` says which plugin the computer has. Update the agent, or start one that is not running, with `--update --from` the plugin's folder and no other option: it keeps what the computer was set up with. An agent from before 6.0.0 (`VERSION` in `~/.manyclaws/agent/service.mjs`) is moved as `{{origin}}/upgrade.md` has it. Never run the installer as step 4 has it on a computer that already has an agent (`~/.manyclaws/agent.json` is there). Do not read `~/.manyclaws/agent.json`: the token and the key are in it.
- If the installer says the agent is running searches, or that it was run from one, nothing was changed: stop there and say so. Use `--end-sessions` only when the person has said to end those searches.
- The installer starts a background service of the person's own user. Where your commands run in a sandbox that refuses that, run it outside it.

## Taking a computer off again

- On the computer: `claude plugin uninstall manyclaws@manyclaws`, and for the agent the same installer with `--uninstall`.
- On [your account page]({{origin}}/app#/account): take back the API token it used. From that moment nothing signs in with it.

## What is sent, and what is not

- Sent, sealed with your key: what you ask Claude and what it answers, the tools it runs and their output, permission prompts and your answers to them, and everything about the session itself: its folder, model, mode, state and what it is called.
- Sent in the open, because the server cannot pass a session on without it: that a session exists, which of your computers it is on, what that computer is called, and when it sends, which kind of thing each is (a row of the chat, something asked, a piece of a reply) and about how much. Nothing about what is said, who said it, the tools, the model or the folder.
- Received, and done only when one of your own phones or browsers signed it, which are the ones you approved (this computer reads the list of them, signed with what your key's root makes, and does nothing asked by anyone else): replies, answers to permission prompts and questions, and requests to start or copy a session, or to hand a session's transcript over to another of your computers.
- Read from this computer, for your own devices: its list of sessions, a past session, a search, its folders. What is to be read (which session, which folder, what words) is asked sealed with your key and read no other way, and the answer goes back sealed.
- Never sent: your key in the open, your Claude account's credentials, or any file Claude has not read or written in the session.
