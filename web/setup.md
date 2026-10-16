# Set up a computer for {{name}}

{{name}} shows every Claude Code session you have running, on every computer, on one page and on your phone. This guide connects one computer. There is nothing personal in it: it is the same for everyone, and it is written so that Claude Code can follow it for you.

**The short way:** on the computer you want to connect, start Claude Code and say

> Read {{origin}}/setup.md and set this computer up.

Claude installs the plugin. Then, in a new Claude Code session, the plugin shows a link that connects the computer: open it in a browser where you are signed in to {{name}}, or on your phone, type your **encryption passphrase** there, and press **Connect**. Nothing is typed into Claude Code, a chat, a command or a file. From your page you can then give the computer its agent, which lets your phone start sessions there, and keep the plugin and the agent up to date.

## 1. Before you start: your passphrase

[Choose your encryption passphrase on your account page]({{origin}}/app#/account) if you have not yet. Several unrelated words are stronger and easier to type than a clever password. It is the same passphrase on every computer you connect, and on each phone or browser you read your sessions on. Each of them makes your key from it, itself: neither the passphrase nor the key is sent anywhere. With it, everything a computer's sessions say is sealed on that computer before it is sent, and only your own devices can read it.

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

   The install reports options that are "not yet set". That is expected: step 3 sets them.

## 3. Connect the computer

This step is yours, and it is the one that matters: until it is done, nothing of this computer shows.

Start a new Claude Code session (in a terminal, VS Code or the desktop app). The plugin says that the computer is not connected yet, and shows a link to `{{origin}}/app#/connect/…`. Open it in a browser where you are signed in to {{name}}, or on your phone. The page asks whether to connect the computer, by its name: type your encryption passphrase and press **Connect**. The link works once, for two minutes; `/manyclaws connect` in Claude Code makes another.

What the link carries, after the `#`, is a key the plugin made for that one asking, which a browser sends nowhere: so it goes from that session to your browser, and never to {{name}}'s server. The page makes an API token for the computer, named for it, and seals it and your key to that key. Only the plugin that showed the link opens it. Claude Code then says which account it joined: if it is not yours, type `/manyclaws disconnect`.

The first session after that starts at once, and the computer is on your page. The passphrase does one more thing than keep what is said private. What you ask of this computer from your phone or a browser (a reply, a yes to a permission prompt, a new session) is signed there, and this computer checks. It keeps what it needs to check and nothing it could sign with, so nobody between your phone and this computer, {{name}}'s server included, can ask in your name or send again what you asked before.

**Without the link** (in a terminal, typed into the plugin itself): make an API token on [your set-up page]({{origin}}/app#/setup), then in Claude Code in a terminal type `/plugin configure manyclaws@manyclaws` and fill in **API token** and **Encryption passphrase**. In the VS Code extension: `/plugin`, then the gear beside manyclaws. They are kept in the system's secure storage.

## 4. The agent

The plugin shows a computer's sessions while they run. The agent is a small background service that adds the rest: it lets you start a new session on that computer from your phone, pick up one that has ended, and search everything Claude Code has done there. It needs Node.js 22.13 or later (`node --version`), and runs on macOS and Linux.

**From your page:** the computer's line in your list has a gear; on its page, press **Let my phone start sessions on** it. The plugin there installs the agent from its own folder, where it is carried: the installer checks every file against the signed list, and the list's signature, before anything is installed. Sessions may then be started from your phone in the folders you have used Claude Code in on that computer, and in no other: never your home folder or one above it, a temporary one, or one inside a folder whose name starts with a dot, and only one used in the last 90 days. The computer's page lists them, and turns any of them off.

**By hand**, from the copy of the agent the plugin carries (`claude plugin list --json` says where the plugin is installed: its `installPath`):

```
bash <the plugin's folder>/agent/install.sh --from <the plugin's folder> --auto-folders
```

`--spawn DIR` names a folder of your own choosing where sessions may be started too, and new project folders made; give it once for each. Run in a terminal of your own, the installer asks for an API token and the passphrase there, without showing what you type, and gives the plugin the same two. Where Claude Code runs it, it asks for nothing, and takes both from the plugin.

## 5. Check it worked

- The new session appears at {{origin}}/app within a few seconds, under the computer's name, with "encrypted" under its title.
- With the agent, the computer is listed there by its name with every session Claude Code has had on it, running or not, and its page says which release it is, as its agent checked it.
- `claude plugin configure manyclaws@manyclaws` lists the plugin's options and says which are set. It never shows their values.
- If the session does not appear, the plugin says why in Claude Code itself: a token that has run out or been taken back, no passphrase, or a server it cannot reach. A computer sends nothing unsealed, and the server takes nothing that is not sealed. Nothing of your passphrase is on the server, so nothing checks it for you: if the page says some sessions were sealed with a different passphrase and cannot be opened, a device of yours was given another one. **What to do**, beside it, says which.

## 6. Your phone

Open {{origin}}/app on your phone and sign in. Put it on the Home Screen (on an iPhone: Share, then Add to Home Screen), open it from there, tap **Settings** at the foot of the list, and then **Turn on alerts**. Your phone then tells you when a session needs you or has finished.

## Keeping it up to date and running

Each release of the plugin and the agent is a list of every file with its SHA-256, signed with a key kept neither in the public repository nor on {{name}}'s server. Your page checks that signature itself, and holds each computer's plugin to it, as the computer's agent measured it there. Where a newer release is out, the computer's gear has a mark, and its page an **Update** button: you approve each update there, for that computer, and it says which sessions it ends. The agent has Claude Code fetch the plugin, holds what arrived to the release you approved before anything of it is used, and replaces itself from the copy the new plugin carries, putting the old one back if the new one does not start. A computer with no agent is updated the same way, by its plugin, through a session running there.

Where a plugin on a computer matches no signed release, its page says so in red, and nothing is sent to that computer until you decide: take back its access, keep it blocked, or, if you changed it yourself, allow it there with your passphrase.

The page also says when a computer's sessions are reporting but its agent is not running: until it runs, no session can be started on that computer from your phone. **The short way:** on that computer, start Claude Code and say

> Read {{origin}}/setup.md and get {{name}} on this computer up to date and running.

By hand:

- **The plugin.** `claude plugin marketplace update manyclaws`, then `claude plugin update manyclaws@manyclaws`. A session that is already open keeps the plugin it started with: the new one is in every session started after.
- **The agent**, from the copy the plugin carries:

  ```
  bash <the plugin's folder>/agent/install.sh --update --from <the plugin's folder>
  ```

  It takes nothing that is not signed by a key the agent already has, and no release older than the one it has. Everything the computer was set up with is kept, and nothing is asked. Starting the agent again ends the sessions it is running, which are the ones started from your page: so while there are any, the installer does nothing and says so. Add `--end-sessions` to end them. Run it in a terminal on the computer, or from a Claude Code session started there: a session started from your page is run by the agent, and the installer does nothing from one.
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

Claude Code loads the plugin from that folder as it is, so nothing changes until you check out another release. In a terminal of your own the installer asks for an API token and your passphrase, without showing them, and gives both to the plugin: the server has no part in that. Under **Account → Devices** on your page, each of your devices can be stopped from starting sessions on your computers.

## For Claude Code, when you are asked to follow this guide

- Do step 2 yourself, without stopping to ask: install the plugin. It asks the person for nothing.
- Step 3 is the person's, and it is the most important thing you tell them. When the plugin is installed, say it first and plainly: start a new Claude Code session, open the link the plugin shows there in a browser where they are signed in to {{name}} (or on their phone), type their encryption passphrase on that page and press **Connect**. The link works for two minutes; `/manyclaws connect` makes another.
- Do not install the agent unless you are asked to: it is set up from their page, once the computer is connected (step 4). Where you are asked to, run it as step 4 has it, by hand, with `--from` the plugin's folder and `--auto-folders`, and no other option unless the person named one.
- Keep what you say short: what you installed, in a line or two; then step 3, as above; then that the computer's page can give it the agent, and the phone (step 6). Do not explain how the plugin works or what is and is not encrypted, unless you are asked: the guide says those things for whoever wants them.
- Never ask for the API token or the passphrase, and do not use either if it is offered in the conversation: say that the passphrase is typed on their page, or into the plugin's own dialog, and nowhere else.
- Never put a token or a passphrase in a command, in `settings.json`, in an environment variable or in any file.
- Edit `~/.claude/settings.json` by merging: keep every setting that is already there.
- If `claude plugin marketplace add` says a marketplace named `manyclaws` is already there, go on. If it says that its source does not match its `extraKnownMarketplaces` entry, the computer was set up from {{name}}'s server long ago: it is moved as `{{origin}}/upgrade.md` has it, which is another guide than this one, so say so and stop. Never run `claude plugin marketplace remove manyclaws` here: it deletes the API token and the passphrase the plugin was given. If `claude plugin install` says the plugin is already installed, run `claude plugin update manyclaws@manyclaws` and go on.
- Asked to update the plugin or the agent, or to get the agent running, on a computer that is already set up (**Keeping it up to date and running**): do what was asked and no more. `claude plugin list` says which plugin the computer has. Update the agent, or start one that is not running, with `--update --from` the plugin's folder and no other option: it keeps what the computer was set up with. An agent from before 6.0.0 (`VERSION` in `~/.manyclaws/agent/service.mjs`) is moved as `{{origin}}/upgrade.md` has it. Never run the installer as step 4 has it on a computer that already has an agent (`~/.manyclaws/agent.json` is there). Do not read `~/.manyclaws/agent.json`: the token and the key are in it.
- If the installer says the agent is running sessions, or that it was run from a session the agent itself started, nothing was changed: stop there and say so. Use `--end-sessions` only when the person has said to end those sessions.
- The installer starts a background service of the person's own user. Where your commands run in a sandbox that refuses that, run it outside it.

## Taking a computer off again

- On the computer: `claude plugin uninstall manyclaws@manyclaws`, and for the agent the same installer with `--uninstall`.
- On [your account page]({{origin}}/app#/account): take back the API token it used. From that moment nothing signs in with it.

## What is sent, and what is not

- Sent, sealed with your key: what you ask Claude and what it answers, the tools it runs and their output, permission prompts and your answers to them, and everything about the session itself: its folder, model, mode, state and what it is called.
- Sent in the open, because the server cannot pass a session on without it: that a session exists, which of your computers it is on, what that computer is called, and when it sends, which kind of thing each is (a row of the chat, something asked, a piece of a reply) and about how much. Nothing about what is said, who said it, the tools, the model or the folder.
- Received, and done only when one of your own phones or browsers signed it, which are the ones your passphrase was typed into (this computer reads the list of them, signed with what your passphrase makes, and does nothing asked by anyone else): replies, answers to permission prompts and questions, and requests to start or copy a session, or to hand a session's transcript over to another of your computers.
- Read from this computer, for your own devices: its list of sessions, a past session, a search, its folders. What is to be read (which session, which folder, what words) is asked sealed with your key and read no other way, and the answer goes back sealed.
- Never sent: your passphrase, your key, your Claude account's credentials, or any file Claude has not read or written in the session.
