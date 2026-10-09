# Upgrade a computer for {{name}}

A computer that was set up for {{name}} before 9 October 2026 has to be upgraded once, by hand: its agent is removed and installed again, the plugin's marketplace is removed and added again, and the computer is signed in again with an API token and your encryption passphrase. We are sorry for the trouble. It is a one-time step, after a change to how {{name}} is secured, and it is not needed again.

**The short way:** on the computer, start Claude Code in a terminal or in VS Code (not a session you started from your {{name}} page) and say

> Read {{origin}}/upgrade.md and upgrade {{name}} on this computer.

Claude replaces the plugin and the agent. One step is yours, and it is the one that connects the computer again: in Claude Code, open **Manage Plugins** and give the {{name}} plugin two things, an **API token** and your **encryption passphrase**. [Make a new API token here]({{origin}}/app#/setup); the passphrase is the one you typed into your browser.

What changed, and why it takes this:

- **The plugin and the agent are released signed.** Both come from a public repository, [github.com/redimaker/manyclaws](https://github.com/redimaker/manyclaws), and the agent installs nothing that is not signed with a key kept neither there nor on any server. An agent from before that cannot check what it installs, so it is not updated in place: it is removed, and a new one is installed.
- **Your passphrase is no longer kept on your computers.** The plugin makes your key from it once and keeps the key in its place, and on a Mac the agent keeps its token and key in your keychain. Removing the old plugin's marketplace takes away what the old plugin kept, your passphrase among it, which is why both are typed again.
- **A computer does less for a phone or a browser unless you say so there.** Files are opened only from the folders sessions may be started in, and no session is started with its permissions bypassed unless the computer names that mode.

## 1. Before you start: two things from your account

1. **A new API token.** [Make one on your set-up page]({{origin}}/app#/setup). It is shown once, when it is made: leave that tab open until step 4 is done. A token made earlier is shown nowhere, so make a new one; the old one can be taken back on [your account page]({{origin}}/app#/account) once every computer has a new one.
2. **Your encryption passphrase**: the same one this account already has, which you typed into your browser. A different one would make a different key, and what this computer sends could not be opened on your page. If you have forgotten it, set a new one for your whole account first, on [your account page]({{origin}}/app#/account) (Change passphrase), and give every computer the new one.

## 2. Remove the old marketplace and add the new one

Claude Code can do this part, or you can paste the commands yourself.

```
claude plugin marketplace remove manyclaws
claude plugin marketplace add redimaker/manyclaws
claude plugin install manyclaws@manyclaws
```

The first removes the plugin with the marketplace it came from, and with them the API token and the passphrase the plugin was given: that is meant, and step 4 gives it both again. The other two install the plugin from the public repository. The install reports options that are "not yet set". That is expected: step 4 sets them.

{{#elsewhere}}This server is not where the plugin reports by itself. In `~/.claude/settings.json`, make sure `env` has `"MANYCLAWS_URL": "{{origin}}"`, keeping whatever else the file holds.

{{/elsewhere}}A session that is already open keeps the old plugin until it is closed: the new one is in every session started after step 4.

## 3. Remove the old agent and install the new one

A computer that has the agent has `~/.manyclaws/agent.json`. One that never had it skips this step (the guide at {{origin}}/setup.md says how to add one).

```
curl -fsSL https://raw.githubusercontent.com/redimaker/manyclaws/main/agent/install.sh | bash -s -- --reinstall --end-sessions
```

This stops the old agent and removes it with everything it kept: its files, its index of your transcripts, and its API token and key. Then it installs the newest release in its place, checked against its signature, set up as the old one was: the same computer on your page, with the same name and the same folders. It asks for nothing. The new agent has no token and no key, and waits: it takes both from the plugin once step 4 is done, and reads your transcripts into its index again, which takes a few minutes on a computer with many.

Removing the agent ends the sessions it is running, which are the ones started from your page: `--end-sessions` says that it may, and there is no need to wait for them. Nothing of them is lost. Once the computer is connected again (step 4) each is on your page as it was, and a reply there starts it again where it left off. Run the command in a terminal on the computer, or from a Claude Code session started there in a terminal or VS Code: not from a session started from your page, which the old agent itself is running, and which would end with it before the new agent was there.

## 4. Give the plugin your token and passphrase

This step is yours, and it is the one that matters: until the plugin has both, nothing of this computer shows on your page.

Using the VS Code Extension for Claude: type `/plugin`, which opens **Manage Plugins**, and press the gear icon beside manyclaws. Fill in **API token** and **Encryption passphrase** from step 1, and leave the other options as they are. In Claude Code in a terminal, type

```
/plugin configure manyclaws@manyclaws
```

Then start a new Claude Code session. In its first minute the plugin makes your key from the passphrase (it says so in the session), puts the key in the passphrase's place, and says that the passphrase is no longer kept on the computer. It gives the agent the same token and key, and the agent connects within a few seconds: there is nothing to type into the agent.

## 5. Check that it worked

- The new session shows on [your page]({{origin}}/app), and the computer is no longer listed there as one that needs upgrading.
- On a computer with the agent, this holds what is installed against the signed release, and what {{origin}} hands a browser for its page too:

  ```
  node ~/.manyclaws/agent/agent.mjs verify
  ```

- If the agent does not connect, `~/.manyclaws/agent.log` says why.

From here on the computer is kept up to date the ordinary way, which asks for nothing: `claude plugin marketplace update manyclaws` and `claude plugin update manyclaws@manyclaws` for the plugin, and `bash ~/.manyclaws/agent/install.sh --update` for the agent.

## For Claude Code, when you are asked to follow this guide

- Say first, in a line, what this is: a one-time upgrade after a security change, that it removes and reinstalls the plugin and the agent, and that at the end the person types their API token and their passphrase again. Say sorry for the trouble, once. Then do it.
- Look before you change anything. `claude plugin list` says whether the plugin is there. `~/.manyclaws/agent.json` being there says the computer has the agent, and `VERSION` in `~/.manyclaws/agent/service.mjs` says which: an agent that is 5.1.0 or later was installed from a signed release already and is not removed. Update it with `bash ~/.manyclaws/agent/install.sh --update` and leave step 3 out. Do not read `~/.manyclaws/agent.json`: the token and the key are in it.
- Do steps 2 and 3 yourself, without stopping to ask. Neither asks the person for anything.
- Step 2 is the three commands as they are written, in that order. `claude plugin marketplace remove manyclaws` deletes the API token and the passphrase the plugin was given: here that is what is wanted. If it says there is no such marketplace, go on. Do not edit `extraKnownMarketplaces` by hand instead.
- Step 3 is the one command, with `--reinstall --end-sessions` and no other option: it keeps how the computer was set up. Do not run the installer with `--uninstall`, or as the set-up guide has it, in its place: either would lose which computer this is, and the folders sessions may be started in.
- The old agent may be stopped while it is running sessions, and by force. That is what `--end-sessions` is for: do not wait for those sessions to be done, and do not ask first. They are the ones started from the person's page, nothing of them is lost, and each is started again from the page with a reply once the computer is connected. If the old agent is still running when the installer has done with it, or the new one cannot be started because of it, end the old agent's process yourself and run the command again. Say afterwards, in a line, that the sessions started from the page were ended and that a reply on the page starts each again.
- If the installer says that it was run from a session the agent itself started, nothing was changed: stop there and say so. Say that it is run from a terminal on that computer, or from a session started there in a terminal or VS Code. This is the one case `--end-sessions` does not cover: the installer would end with that session, before the new agent was there.
- The installer fetches the agent and starts a background service of the person's own user. Where your commands run in a sandbox that refuses that, run this one outside it.
- Step 4 is the person's, and it is the most important thing you tell them. When steps 2 and 3 are done, say it first and plainly: open **Manage Plugins** (using the VS Code Extension for Claude: type `/plugin`, then the gear icon beside manyclaws; in Claude Code in a terminal: `/plugin configure manyclaws@manyclaws`), fill in **API token** and **Encryption passphrase**, and start a new Claude Code session. Give the link from step 1 where a new token is made, and say that the passphrase is the one their account already has. Give both ways in, the VS Code Extension's and the terminal's, unless you know which of the two they are in.
- Never ask for the API token or the passphrase, and do not use either if it is offered in the conversation: say that they go into the plugin's own dialog, and nowhere else.
- Never put a token or a passphrase in a command, in `settings.json`, in an environment variable or in any file.
- Keep what you say short: what you removed and installed, in a line or two; then step 4, as above; then that you will check it worked once they have started a new session (step 5). Do not explain how the installer works or what is and is not encrypted unless you are asked.
- Edit `~/.claude/settings.json` by merging: keep every setting that is already there.
- This session keeps the old plugin until it is closed. Say that the page shows the computer again from the first session started after step 4.
