# ManyClaws: the plugin, the agent and the page

[ManyClaws](https://manyclaws.dev) shows every Claude Code session you have running, on every computer, on one web page and on your phone, and lets you reply to them from there.

This repository holds every part of it that runs on your own devices:

- **The plugin** (`mod/`): a Claude Code plugin. It reports each session to the ManyClaws server and does what your own devices ask of that session. It carries the agent, and the signed list of every file it was released with (`mod/release.json`).
- **The agent** (`mod/agent/`): a small background service, one per computer, which the plugin installs from its own folder when you ask from the page. It indexes that computer's Claude Code transcripts so past sessions can be read and searched, starts or resumes sessions when you ask from the page, each in a terminal of its own there (a Terminal window on a Mac, tmux on Linux) that outlives the agent, and checks the plugin there against the release it carries.
- **The page** (`web/`): what your browser and your phone run, as the server hands it out. It is where your account's key is made and kept, and where every device is approved, so it is published here with the rest, and what a server hands you can be held against it (see "Checking what you run").

The server is not in this repository. It stores and forwards what your devices sealed, and cannot read it.

## What leaves your computer

Everything a session says is encrypted on the computer it runs on, before it is sent, with your account's own key: made of random bytes on your first phone or browser, and handed from one of your devices to another, sealed, as you approve each. There is no passphrase. The server stores and forwards what it is given and cannot read it.

- **Sent, encrypted with your key:** what you ask Claude and what it answers, the tools it runs and their output, permission prompts and your answers, and everything about the session itself: its folder, model, mode, state and title.
- **Sent in the open**, because the server cannot pass a session on without it: that a session exists, which of your computers it is on, what that computer is called, when it sends, and which kind of thing each message is and roughly how large.
- **Acted on only when one of your own phones or browsers signed it:** replies, answers to permission prompts and questions, and requests to start, resume or copy a session. A computer reads the list of your devices, which is signed with a key drawn from your account's root, and does nothing asked by anyone else, the server included.
- **Never sent in the open:** your key, your recovery key, your Claude account's credentials, or any file Claude has not read or written in a session. (The key goes from one of your devices to another sealed to a key the new device made for that, which the server hands over and cannot open.)

A plugin that has not been given your key sends nothing at all.

## What this protects against, and what it does not

- **Whoever holds the server's data, or watches what passes through it, reads nothing of your sessions** and can ask nothing of your computers: what they have is sealed, and a computer acts only on what one of your own devices signed.
- **Whoever can change the code your devices run can do anything those devices can.** That is true of any software, and it is why this code is public and released signed: the agent installs nothing that is not a release signed with a key kept neither here nor on any server; it and the page hold the plugin each computer runs to that release, and say so in red where it is not, with nothing sent to that computer until you decide; each update is approved by you on your page, for each computer; and the page's HTML names each of its scripts by its hash, which your browser enforces. A plugin that is changed where it is has the account's key from the moment it runs: what is checked is said, not stopped. What is left is the page's HTML itself, which a server hands your browser each time you open it: a server that had been taken over could hand out another. Nothing a web page does can rule that out. "Checking what you run" says how to look from outside the page.
- **There is nothing to guess.** Your key is drawn from 32 random bytes, not from anything a person chose, so a copy of everything the server holds is no help to anyone trying to read it. What makes a device one of yours is another device of yours approving it, with its passkey (Face ID, Touch ID, a PIN or a security key), from the link or the code the new device shows: so approve only a device you have just opened yourself. And what a device may ask of a computer is limited on the computer (see "What a computer allows").
- **Your recovery key is your key, written out.** Whoever has it can give a browser of their own your key. Keep it where you keep what matters; it is shown once as the key is made, and again only on a device of yours after its passkey.
- **Whoever can run programs as you on one of your computers** can read what that computer keeps: your key, though not your root, which no computer is given. They could read your sessions there anyway.


## How the encryption works

`mod/hooks/seal.js` is the whole of it, and its opening comment is the specification: what your key is drawn from, what a sealed value is, how a key is handed to a new device, and how a request from a phone or browser is signed and checked. In short:

- Your account's root is 32 random bytes, made by its first phone or browser. Your key, and the Ed25519 key that signs the list of your devices, are drawn from it with HKDF-SHA256. The root written out (Crockford's base32, 52 characters) is your recovery key.
- A phone or browser keeps the root wrapped with AES-256-GCM under a key drawn from a passkey's PRF secret, which its authenticator gives only after Face ID, Touch ID, a PIN or a security key's touch. Nothing of the passkey goes to the server: the page asks the authenticator for the secret, and checks no signature.
- A new device shows a code: six digits on a phone or browser, nine on a computer (the first three of which the server gave, to find it by). It is typed on a device that has your key, which asks for it by itself where a phone or browser is asking. With the code the two make a key between them, SPAKE2 (RFC 9382) over edwards25519, through the server, which passes what each side makes and cannot make the key, nor test a code by itself: it has one guess a try, and three tries end a code. Each side confirms the key to the other before anything is sealed with it, and what the new device is given is sealed with it (AES-256-GCM). A computer is given the key and the half that checks the list; a phone or browser of yours, the root; one that is borrowed, the key alone, for a day.
- What is sealed is encrypted with AES-256-GCM, padded so its length says little about its contents.
- Each phone and browser signs what it asks with an Ed25519 key of its own that never leaves it. Your computers accept a request only from a device on the list signed with the root's key.
- The server is given nothing of the root or the key: no hash, no verifier. The only way to tell a key is right is that it opens what was sealed with it.

Claude Code's plugin runtime has no crypto library, so every primitive (SHA-256, SHA-512, HMAC, HKDF, AES-256-GCM, Ed25519, SPAKE2, and the check of an SSH signature) is implemented in that one file in plain JavaScript. `mod/agent/seal.mjs` and `web/seal.js` are identical copies. (The page seals and signs with the browser's own WebCrypto, and keeps its keys where no script can read them back: `web/keys.js`.) The plain JavaScript is not written to run in constant time: that matters only to someone who can time code on your own computer.

What is known, and not hidden: a sealed value is not tied to the session or the place it was sealed for, so a server could show one sealed thing where another belongs, or leave things out, though it can read and write none; removing a device stops its orders and signs it out, and it takes starting afresh with a new key to shut it out of what is said from then on; and one key seals everything an account says.

### Where your key is kept

- **In the plugin**: you type the code it shows on a device that has your key, and approve it there with the passkey; the page seals the key and an API token made for the computer with the key the two made from the code. The plugin keeps the two among its options, where Claude Code keeps what is secret (the system keychain on a Mac): the key written out, `mcf_…`. `MANYCLAWS_KEY` in the environment takes the key written out, for a set-up with nobody there, and nothing else is a key.
- **In the agent**: on a Mac, its API token and your key are in your login keychain, and `~/.manyclaws/agent.json` has only a fingerprint of the two. Elsewhere they are in that file, which only you can read (`--no-keychain` keeps them there on a Mac too).
- **In a browser**: as keys the browser will use and not hand back, and the root wrapped under a passkey of that device's own; on a borrowed device, the key alone, while the page is open.

The key reads what your sessions say. It cannot sign the list of your devices, so nothing that has only the key can ask anything of your computers; and the root, which can, is never on a computer, and on a phone or browser only behind its passkey.

## Layout

| Path | What it is |
|---|---|
| `mod/.claude-plugin/plugin.json` | The plugin's manifest: its version and its options (API token and key, filled in as the computer is connected; label; capabilities) |
| `mod/hooks/register.js` | The plugin: reports the session, polls for what is asked of it, answers permission prompts routed to the page |
| `mod/hooks/lib.js` | Helpers with no side effects, including the plugin's version and which capability each request needs |
| `mod/hooks/rows.js` | Turns what Claude Code reports into the rows of a chat, before they are sealed |
| `mod/hooks/seal.js` | The encryption and signing |
| `mod/tests/` | The plugin's own tests |
| `mod/agent/agent.mjs` | The agent's command line: `run`, `index`, `search`, `sessions`, `read`, `configure`, `verify` |
| `mod/agent/service.mjs` | The agent as a service: its connection to the server, what it answers, the plugin's measure and its own upgrade |
| `mod/agent/host.mjs` | Sessions the agent starts or resumes, each opened in a terminal of its own (and searches, which it runs itself), and the rules for which it may, and where |
| `mod/agent/launch.mjs` | What runs a session in the console window the agent opens for it on Windows |
| `mod/agent/indexer.mjs`, `store.mjs`, `transcript.mjs` | The index of this computer's transcripts (SQLite, with full-text search) |
| `mod/agent/files.mjs` | Opening a file that a link in a chat names |
| `mod/agent/cswap.mjs` | Switching between Claude accounts with `cswap`, where it is installed |
| `mod/agent/rows.mjs`, `mod/agent/seal.mjs` | Identical copies of the plugin's `rows.js` and `seal.js` |
| `mod/agent/secrets.mjs` | Where the agent keeps its token and your key: the keychain on a Mac |
| `mod/agent/verify.mjs` | Holds what is installed, the plugin Claude Code installed, and what a server hands a browser, against the signed release |
| `mod/agent/install.sh` | Installs the agent as a service of your own user (launchd on macOS, systemd on Linux), from a signed release and nothing else |
| `mod/release.json`, `mod/release.json.sig` | The release: every file of the plugin, the agent and the page with its SHA-256, and that list signed |
| `web/` | The page: `index.html`, `app.js`, `keys.js`, `seal.js` and what they show; and the two guides Claude Code can follow, `setup.md` and `upgrade.md` |
| `release.mjs` | Makes a release, writes the page's integrity values, and tags the commit a release is in |
| `.claude-plugin/marketplace.json` | Lets Claude Code install the plugin from this repository |

## Installing

The guide at <https://manyclaws.dev/setup> walks through it, and Claude Code can follow it for you. It installs the plugin from this repository, as its `main` branch stands:

```
claude plugin marketplace add redimaker/manyclaws
claude plugin install manyclaws@manyclaws
```

Then, in a new Claude Code session, the plugin shows a code of nine digits that connects the computer: type it under Connect a computer (`<server>/app#/connect`) where you are signed in to ManyClaws, press Connect, and give your passkey. Nothing is typed into Claude Code. The agent is set up from the computer's page, by the plugin, from the copy it carries; or by hand, `bash <the plugin's folder>/agent/install.sh --from <the plugin's folder> --auto-folders`.

Updates are offered on your page, for each computer, and you approve each one there: the agent has Claude Code fetch the plugin, holds what arrived to the release you approved, and replaces itself from the copy the new plugin carries, putting the old one back where the new one does not start. By hand: `claude plugin marketplace update manyclaws`, `claude plugin update manyclaws@manyclaws`, then `bash <the plugin's folder>/agent/install.sh --update --from <the plugin's folder>`.

**A computer whose plugin or agent is from before 6.0.0** is moved once, by <https://manyclaws.dev/upgrade> (`web/upgrade.md` here), which the page sends an account to; from then on it is kept up to date from the page. **To install from source**, so that what runs is what you read: the guide's "Installing from source" checks out a release by its tag (`release-N`), checks its signature and every file with `ssh-keygen` and `shasum`, and has Claude Code load the plugin from that folder as it is.

The plugin needs Claude Code 2.1.287 or later. The agent needs Node.js 22.13 or later and `ssh-keygen` (which comes with OpenSSH), and nothing else; it is for macOS and Linux.

### Releases are signed

`mod/release.json` lists every file in `mod/` (the agent among them), `web/` and `.claude-plugin/` with its SHA-256, and `mod/release.json.sig` is that list signed (an SSH signature, under the namespace `manyclaws-release`) with a key that is kept neither in this repository nor on any server. The key it must be signed by is written in `mod/agent/install.sh` (`SIGNERS`) and in `web/app.js` (`RELEASE_SIGNERS`); its fingerprint is `SHA256:io1QPFB46L+VwdcC+tboq0RQktgBYAn92v0we2RdK+A`. Each release is the commit tagged `release-N`, for its number.

- **The agent's installer** installs nothing unless the list is signed by a key it knows, every file of the agent is as the list says with none missing and none besides, and the release is no older than the one installed. An installed agent is brought up to date by its own copy of the installer, with the keys it already has: so whoever came to control this repository could not put code on a computer that has the agent. The first install has only the installer it was handed to go by, which is why the installer is short enough to read.
- **The plugin** is fetched by Claude Code's own marketplace, which checks no signature. The agent holds every copy of it there to the list it carries, by the keys the agent was installed with, before it starts a session with it, and says what it found, sealed, to your devices; the page checks the list's signature itself, and says in red where a computer runs a plugin that is no release, signing nothing for it until you allow that plugin there with your passkey. Where there is no agent, the plugin says what it is of itself, which is its own word. `node ~/.manyclaws/agent/agent.mjs verify` holds the plugin as Claude Code installed it against the list it carries.
- **A new signing key** comes in a release signed by the old one, whose installer names it.

## Checking what you run

On a computer that has the agent:

```
node ~/.manyclaws/agent/agent.mjs verify
```

It checks the signature on the list the agent was installed by, that the agent's files are as that list has them and that the plugin Claude Code installed is as the list it carries has it, and that what your server hands a browser for its page is as the (signed) list the server says its page is of. `--here` leaves the page out.

The page can be checked by hand, from any computer. Every script and style sheet the page loads is named in its HTML with the hash of the file, and a browser does not run one that is anything else; so the HTML is the one file to compare:

```
curl -s -H 'Accept: text/html' https://manyclaws.dev/app | shasum -a 256
```

against `web/index.html` in `release.json` (the server hands out the same list at `/release.json`, with `/release.json.sig`). The header asks as a browser asks for a page: a proxy in front of a server that adds a script of its own to pages adds it to what is asked for so, and to nothing else, and `verify` asks both ways for the same reason. The page shows the same hashes under Account, as your browser has the files: that is the page's own word, and a page that had been changed could say anything, so it is there for convenience and the checks above are the ones that count. What neither can see is a server that hands one page to whoever checks and another to you.

What ends up on your computer is these files, so you can also compare them yourself:

- the agent, in `~/.manyclaws/agent/`, against `mod/agent/` here (its version is `VERSION` in `mod/agent/service.mjs`);
- the plugin, in Claude Code's plugin cache under `manyclaws/`, against `mod/` here (its version is in `mod/.claude-plugin/plugin.json`).

## What a computer allows

Both parts are limited by what the computer's owner sets, on that computer:

- **The plugin** does only what its **capabilities** option allows. By default a session can be inspected, sent prompts, sent notifications and messages, and have its permission prompts answered. The rest are off until turned on there, among them reading files directly (`+files`) and running commands (`+exec`); the full list is in `mod/hooks/lib.js`.
- **The agent** starts sessions only in the folders it was installed with (`--spawn`), and, where its owner allows it (`--auto-folders`, or from the page), in the folders a person has used Claude Code in on that computer in the last 90 days: never the home folder or one above it, a temporary one, or one inside a folder whose name starts with a dot, and no new folder is made in those. Without either it only reads and searches. It starts one only for a device of yours that may start sessions: one you said is your own, unless you turned that off for it under Account, Devices. It starts them in any of Claude Code's permission modes but `bypassPermissions`, in which a session does whatever it is prompted to with nobody asked: that one is allowed only where the computer's owner named it (`--mode bypassPermissions`, or the list `spawn.modes` in `~/.manyclaws/agent.json`).
- **Files** are opened for your devices only from inside those same folders, or the ones named for it (`--files`, or `"files": [...]` in `agent.json`; `"files": false` opens none). Where a file really is decides: a link inside those folders that leads out of them opens nothing.
- **Files are taken** from your devices into the folders sessions may be started in (`--spawn`), and nowhere else: one you upload to a session's folder, one you attach to a reply (kept in `.manyclaws-uploads` under that folder, which git ignores), or one you opened, changed on the page and saved back. A folder named only for opening files (`--files`) is read and not written, unless `agent.json` says `"upload": true`; `"upload": false` has none taken anywhere. A new file never takes the place of one that is there, and a file saved back is written only over the file you opened: where it has changed on the computer since, it is left alone until you say to save over what is there now. Nothing is written among the agent's own files.

## Tests

The plugin's tests run with Claude Code's own test runner:

```
cd mod && claude plugin test .
```

The end-to-end tests, which run the plugin and the agent against a real server and real Claude Code sessions, live with the server.
