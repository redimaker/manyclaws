# Move a computer to the new release of {{name}}

From plugin 6.0.0 the {{name}} plugin carries the agent, and the signed list of every file it was released with, and both are kept up to date from your page: you approve each update there, for each computer. And there is no passphrase any more: your account's key is made of random bytes, kept on your phone or browser under a passkey, and given to each computer as it is connected from a link. A computer whose plugin or agent is from before knows nothing of either, so the first time is done on the computer, once, by this guide. After that it is never needed again.

**First, on your page:** sign in on your phone, or in a browser with passkeys. Your account's key of before was made from your passphrase, and is not carried over: no device has a key of the new kind yet, so open **I have neither** on the page and start afresh with a new key, made there and kept under its passkey. The page shows your recovery key: keep it. Your stored sessions on the server go (your computers still have them), and every computer is disconnected, to be connected again with the new key, as below.

**The short way:** on the computer, start Claude Code in a terminal, in VS Code or in the desktop app (not a session you started from your {{name}} page, which the old agent itself is running) and say

> Read {{origin}}/upgrade.md and move ManyClaws on this computer to the new release.

Claude updates the plugin and hands the agent over to the copy the new plugin carries. Where that would end sessions your page started there, it asks you first. Then, in a new Claude Code session, the plugin shows a link that connects the computer again: open it where you are signed in to {{name}}, on your phone or in a browser that has your new key, press **Connect** and give your passkey (as [the set-up guide]({{origin}}/setup)'s step 3 has it).

## 1. Look first

```
claude plugin list
claude plugin marketplace list
sed -n "s/^export const VERSION = '\(.*\)'$/\1/p" ~/.manyclaws/agent/service.mjs
ls ~/.manyclaws/agent/release.json
```

The first says which plugin the computer has, the second where its marketplace comes from (`redimaker/manyclaws` on GitHub, or {{name}}'s server), the third which agent it has, and the fourth whether that agent was installed from a signed release. A computer with no `~/.manyclaws` has no agent: only the plugin is moved, and the agent is set up afterwards from your page.

## 2. Where the plugin comes from GitHub, and the agent is 5.1.0 or later

1. **The plugin.**

   ```
   claude plugin marketplace update manyclaws
   claude plugin update manyclaws@manyclaws
   ```

   The API token and the key the plugin has stay as they are.

2. **The agent**, handed over to the copy the new plugin carries. `claude plugin list --json` says where the plugin is installed (its `installPath`):

   ```
   bash <the plugin's folder>/agent/install.sh --update --from <the plugin's folder>
   ```

   It checks every file of the agent against the signed list the plugin carries, and the list's signature, before anything is replaced, and keeps everything the computer was set up with: which computer it is, its name, its folders, its token and its key. Where the agent is running sessions started from your page, it does nothing and says how many: starting the agent again ends them. Run it again with `--end-sessions` to end them; a reply on your page resumes each one.

3. **Connect the computer again.** Start a new Claude Code session: the plugin, whose token was taken back as your account started afresh, shows a link and a code. Open it where you are signed in to {{name}}, press **Connect** and give your passkey. The plugin gives the agent the new token and key.

4. **Check:** `node ~/.manyclaws/agent/agent.mjs verify --here` says the agent and the plugin are each as their release lists them.

New Claude Code sessions use the new plugin; sessions already open keep the old one until they are started again.

## 3. Where the computer was set up before 9 October 2026

Its marketplace comes from {{name}}'s server, or its agent is older than 5.1.0 and cannot check what it installs.

1. **The plugin**, where its marketplace is not `redimaker/manyclaws`:

   ```
   claude plugin marketplace remove manyclaws
   claude plugin marketplace add redimaker/manyclaws
   claude plugin install manyclaws@manyclaws
   ```

   The first removes the old plugin with the marketplace it came from, and with them the API token and the passphrase it was given: here that is meant, and step 3 gives it a token and the key again. Where the marketplace is `redimaker/manyclaws` already, update the plugin as section 2 has it instead.

2. **The agent**, removed and installed again from the copy the new plugin carries:

   ```
   bash <the plugin's folder>/agent/install.sh --reinstall --end-sessions --from <the plugin's folder>
   ```

   This stops the old agent and removes it with everything it kept, its API token and key among it, and installs the new one in its place, set up as the old one was: the same computer on your page, with the same name and folders. It ends the sessions the old agent is running, which are the ones started from your page; nothing of them is lost, and a reply there resumes each once the computer is connected again.

3. **Connect the computer again.** Start a new Claude Code session: the plugin, which has no token now, shows a link and a code. Open it where you are signed in to {{name}}, on your phone or in a browser that has your key, press **Connect** and give your passkey. The plugin gives the new agent the same token and key.

4. **Check:** `node ~/.manyclaws/agent/agent.mjs verify --here`.

## From a clone of the repository

Where you installed from source: `git fetch && git checkout release-N` in the clone, check the release as [the set-up guide]({{origin}}/setup) has it, then `bash mod/agent/install.sh --update --from mod`.

## For Claude Code, when you are asked to follow this guide

- Say first, in a line, what this is: a one-time move to the new way of keeping ManyClaws up to date, after which the person approves each update on their page, and connects the computer from a link with their passkey, with no passphrase. Then do it.
- Look first, as step 1 has it, and follow section 2 or section 3, whichever the computer is. Do not read `~/.manyclaws/agent.json`: the token and the key are in it.
- Section 2: run its commands as they are written. If the installer says the agent is running sessions started from the page, tell the person how many end, and ask whether to end them now; only on a yes, run it again with `--end-sessions`. Otherwise stop there and say that it can be run again once those sessions are done.
- Section 3: run its commands as they are written, `--end-sessions` with them: the old agent may be stopped while it is running sessions, and nothing of them is lost. `claude plugin marketplace remove manyclaws` deletes the API token and the passphrase the plugin was given: it is run here and nowhere else, and only where the marketplace is not `redimaker/manyclaws`. Do not edit `extraKnownMarketplaces` by hand instead.
- Do not type anything into the plugin's options: there is no passphrase any more, and the plugin takes nothing but the key its link gives it.
- If the installer says it was run from a session the agent itself started, nothing was changed: stop there and say so. Say that it is run from a terminal on that computer, or from a Claude Code session started there in a terminal, VS Code or the desktop app.
- In both sections, the last step is the person's: say it first and plainly, once the commands are done. Start a new Claude Code session, open the link the plugin shows there (or read its code with their phone) where they are signed in to {{name}}, press **Connect** and give their passkey. Where the page has not yet started their account afresh with a new key, they do that first, on their phone or in a browser with passkeys.
- Never ask for the API token, the passphrase, the key or the recovery key, and do not use any of them if it is offered in the conversation. Never put a token or a key in a command, in `settings.json`, in an environment variable or in any file.
- The installer starts a background service of the person's own user. Where your commands run in a sandbox that refuses that, run it outside it.
- Keep what you say short: what you updated and installed, in a line or two; the link to open, as above; what `verify --here` said; and that from now on the computer is kept up to date from their page, where they approve each update.
