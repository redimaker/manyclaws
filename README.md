# ManyClaws: the plugin, the agent and the page

[ManyClaws](https://manyclaws.dev) shows every Claude Code session you have running, on every computer, on one web page and on your phone, and lets you reply to them from there.

This repository holds every part of it that runs on your own devices:

- **The plugin** (`mod/`): a Claude Code plugin. It reports each session to the ManyClaws server and does what your own devices ask of that session.
- **The agent** (`agent/`): a small background service, one per computer. It indexes that computer's Claude Code transcripts so past sessions can be read and searched, and starts or resumes sessions when you ask from the page.
- **The page** (`web/`): what your browser and your phone run, as the server hands it out. It is where your passphrase is typed and your key is made, so it is published here with the rest, and what a server hands you can be held against it (see "Checking what you run").

The server is not in this repository. It stores and forwards what your devices sealed, and cannot read it.

## What leaves your computer

Everything a session says is encrypted on the computer it runs on, before it is sent, with a key made from a passphrase only you know. The server stores and forwards what it is given and cannot read it.

- **Sent, encrypted with your key:** what you ask Claude and what it answers, the tools it runs and their output, permission prompts and your answers, and everything about the session itself: its folder, model, mode, state and title.
- **Sent in the open**, because the server cannot pass a session on without it: that a session exists, which of your computers it is on, what that computer is called, when it sends, and which kind of thing each message is and roughly how large.
- **Acted on only when one of your own phones or browsers signed it:** replies, answers to permission prompts and questions, and requests to start, resume or copy a session. A computer reads the list of your devices, which is signed with a key made from your passphrase, and does nothing asked by anyone else, the server included.
- **Never sent:** your passphrase, your key, your Claude account's credentials, or any file Claude has not read or written in a session.

A plugin that has not been given your passphrase sends nothing at all.

## What this protects against, and what it does not

- **Whoever holds the server's data, or watches what passes through it, reads nothing of your sessions** and can ask nothing of your computers: what they have is sealed, and a computer acts only on what one of your own devices signed.
- **Whoever can change the code your devices run can do anything those devices can.** That is true of any software, and it is why this code is public and released signed: the agent installs nothing that is not a release signed with a key kept neither here nor on any server, and the page's HTML names each of its scripts by its hash, which your browser enforces. What is left is the page's HTML itself, which a server hands your browser each time you open it: a server that had been taken over could hand out another. Nothing a web page does can rule that out. "Checking what you run" says how to look from outside the page.
- **Your passphrase is the whole of it.** Whoever has it and can sign in to your account can make a device of their own one of yours, read your sessions, and ask things of your computers. So a passphrase that is being chosen is held to four or more unrelated words, it is never the password you sign in with (which the server keeps a stretched form of, and a passphrase never), and what a device may ask of a computer is limited on the computer (see "What a computer allows").
- **Whoever can run programs as you on one of your computers** can read what that computer keeps: your key, though not your passphrase, which is kept nowhere once the key is made. They could read your sessions there anyway.


## How the encryption works

`mod/hooks/seal.js` is the whole of it, and its opening comment is the specification: how a key is made from a passphrase, what a sealed value is, and how a request from a phone or browser is signed and checked. In short:

- Your key is made on each device from your passphrase and your account's id with Argon2id (64 MiB, 3 passes), then HKDF-SHA256.
- What is sealed is encrypted with AES-256-GCM, padded so its length says little about its contents.
- Each phone and browser signs what it asks with an Ed25519 key of its own that never leaves it. Your computers accept a request only from a device on a list signed with a key derived from your passphrase.
- The server is given nothing made from the passphrase: no hash, no verifier, not even a record that one was set. The only way to tell a passphrase is right is that it opens what was sealed with it.

Claude Code's plugin runtime has no crypto library, so every primitive (SHA-256, SHA-512, HMAC, HKDF, BLAKE2b, Argon2id, AES-256-GCM, Ed25519) is implemented in that one file in plain JavaScript. `agent/seal.mjs` and `web/seal.js` are identical copies. (The page seals and signs with the browser's own WebCrypto, and keeps its keys where no script can read them back: `web/keys.js`.) The plain JavaScript is not written to run in constant time: that matters only to someone who can time code on your own computer.

What is known, and not hidden: a sealed value is not tied to the session or the place it was sealed for, so a server could show one sealed thing where another belongs, or leave things out, though it can read and write none; removing a device stops its orders and signs it out, and it takes a new passphrase to make a key it does not have; and one key seals everything an account says.

### Where your key is kept

- **In the plugin**: you type your passphrase into the plugin's options. The first session after that makes your key, and puts the key (written out, `mcf_…`) in the passphrase's place among those options, where Claude Code keeps what is secret (the system keychain on a Mac). From then on the passphrase is kept nowhere on that computer. `MANYCLAWS_KEY` in the environment takes the key written out, never a passphrase.
- **In the agent**: on a Mac, its API token and your key are in your login keychain, and `~/.manyclaws/agent.json` has only a fingerprint of the two. Elsewhere they are in that file, which only you can read (`--no-keychain` keeps them there on a Mac too).
- **In a browser**: as keys the browser will use and not hand back, and only on a device you said is your own.

The key reads what your sessions say. It cannot sign the list of your devices, so nothing that has only the key can ask anything of your computers; and it cannot be turned back into your passphrase except by guessing, at what Argon2id costs a guess.

## Layout

| Path | What it is |
|---|---|
| `mod/.claude-plugin/plugin.json` | The plugin's manifest: its version and the options it asks for (API token, passphrase, label, capabilities) |
| `mod/hooks/register.js` | The plugin: reports the session, polls for what is asked of it, answers permission prompts routed to the page |
| `mod/hooks/lib.js` | Helpers with no side effects, including the plugin's version and which capability each request needs |
| `mod/hooks/rows.js` | Turns what Claude Code reports into the rows of a chat, before they are sealed |
| `mod/hooks/seal.js` | The encryption and signing |
| `mod/tests/` | The plugin's own tests |
| `agent/agent.mjs` | The agent's command line: `run`, `index`, `search`, `sessions`, `read`, `configure` |
| `agent/service.mjs` | The agent as a service: its connection to the server and what it answers |
| `agent/host.mjs` | Sessions the agent starts or resumes itself, and the rules for which it may |
| `agent/indexer.mjs`, `store.mjs`, `transcript.mjs` | The index of this computer's transcripts (SQLite, with full-text search) |
| `agent/files.mjs` | Opening a file that a link in a chat names |
| `agent/cswap.mjs` | Switching between Claude accounts with `cswap`, where it is installed |
| `agent/rows.mjs`, `agent/seal.mjs` | Identical copies of the plugin's `rows.js` and `seal.js` |
| `agent/secrets.mjs` | Where the agent keeps its token and your key: the keychain on a Mac |
| `agent/verify.mjs` | Holds what is installed, and what a server hands a browser, against the signed release |
| `agent/install.sh` | Installs the agent as a service of your own user (launchd on macOS, systemd on Linux), from a signed release and nothing else |
| `web/` | The page: `index.html`, `app.js`, `keys.js`, `seal.js` and what they show; and the two guides Claude Code can follow, `setup.md` and `upgrade.md` |
| `release.json`, `release.json.sig` | The release: every file here with its SHA-256, and that list signed |
| `release.mjs` | Makes a release, and writes the page's integrity values |
| `.claude-plugin/marketplace.json` | Lets Claude Code install the plugin from this repository |

## Installing

The guide at <https://manyclaws.dev/setup> walks through it, and Claude Code can follow it for you. It installs both parts from this repository, as its `main` branch stands:

```
claude plugin marketplace add redimaker/manyclaws
claude plugin install manyclaws@manyclaws
curl -fsSL https://raw.githubusercontent.com/redimaker/manyclaws/main/agent/install.sh | bash -s -- --spawn ~/code
```

The first two install the plugin; the third installs the agent as a service of your own user and lets sessions be started in `~/code` (leave `--spawn` out and they can only be read and searched). Then give the plugin your API token and your encryption passphrase in its own dialog (`/plugin` in Claude Code), and start a new session.

To update: `claude plugin marketplace update manyclaws`, `claude plugin update manyclaws@manyclaws`, and for the agent its own copy of the installer, `bash ~/.manyclaws/agent/install.sh --update`.

**A computer set up before 9 October 2026** (its agent is older than 5.1.0) is upgraded once, by hand, and is not updated: <https://manyclaws.dev/upgrade> says how (`web/upgrade.md` here), and the page says so of an account that has such a computer. The old marketplace is removed and this repository's added (`claude plugin marketplace remove manyclaws`, which takes away the API token and the passphrase the old plugin kept), the old agent is removed and a new one installed in its place as the same computer (`install.sh --reinstall`), and the computer is given an API token and the passphrase again. It is a one-time step, after the change to signed releases: an agent from before cannot check what it installs.

The plugin needs Claude Code 2.1.287 or later. The agent needs Node.js 22.13 or later and `ssh-keygen` (which comes with OpenSSH), and nothing else; it is for macOS and Linux.

### Releases are signed

`release.json` lists every file in `agent/`, `mod/` and `web/` with its SHA-256, and `release.json.sig` is that list signed (an SSH signature, under the namespace `manyclaws-release`) with a key that is kept neither in this repository nor on any server. The key it must be signed by is written in `agent/install.sh` (`SIGNERS`).

- **The agent's installer** installs nothing unless the list is signed by a key it knows, every file of the agent is as the list says with none missing and none besides, and the release is no older than the one installed. An installed agent is brought up to date by its own copy of the installer, with the keys it already has: so whoever came to control this repository could not put code on a computer that has the agent. The first install has only the installer it was handed to go by, which is why the installer is short enough to read.
- **The plugin** is fetched by Claude Code's own marketplace, which checks no signature. `node ~/.manyclaws/agent/agent.mjs verify` holds the plugin as Claude Code installed it against the signed list.
- **A new signing key** comes in a release signed by the old one, whose installer names it.

## Checking what you run

On a computer that has the agent:

```
node ~/.manyclaws/agent/agent.mjs verify
```

It checks the signature on the list the agent was installed by, that the agent's files and the plugin Claude Code installed are as that list has them, and that what your server hands a browser for its page is as the (signed) list the server says its page is of.

The page can be checked by hand, from any computer. Every script and style sheet the page loads is named in its HTML with the hash of the file, and a browser does not run one that is anything else; so the HTML is the one file to compare:

```
curl -s -H 'Accept: text/html' https://manyclaws.dev/app | shasum -a 256
```

against `web/index.html` in `release.json` (the server hands out the same list at `/release.json`, with `/release.json.sig`). The header asks as a browser asks for a page: a proxy in front of a server that adds a script of its own to pages adds it to what is asked for so, and to nothing else, and `verify` asks both ways for the same reason. The page shows the same hashes under Account, as your browser has the files: that is the page's own word, and a page that had been changed could say anything, so it is there for convenience and the checks above are the ones that count. What neither can see is a server that hands one page to whoever checks and another to you.

What ends up on your computer is these files, so you can also compare them yourself:

- the agent, in `~/.manyclaws/agent/`, against `agent/` here (its version is `VERSION` in `agent/service.mjs`);
- the plugin, in Claude Code's plugin cache under `manyclaws/`, against `mod/` here (its version is in `mod/.claude-plugin/plugin.json`).

## What a computer allows

Both parts are limited by what the computer's owner sets, on that computer:

- **The plugin** does only what its **capabilities** option allows. By default a session can be inspected, sent prompts, sent notifications and messages, and have its permission prompts answered. The rest are off until turned on there, among them reading files directly (`+files`) and running commands (`+exec`); the full list is in `mod/hooks/lib.js`.
- **The agent** starts sessions only in the folders it was installed with (`--spawn`), and without that option it only reads and searches. It starts them in any of Claude Code's permission modes but `bypassPermissions`, in which a session does whatever it is prompted to with nobody asked: that one is allowed only where the computer's owner named it (`--mode bypassPermissions`, or the list `spawn.modes` in `~/.manyclaws/agent.json`).
- **Files** are opened for your devices only from inside those same folders, or the ones named for it (`--files`, or `"files": [...]` in `agent.json`; `"files": false` opens none). Where a file really is decides: a link inside those folders that leads out of them opens nothing.
- **Files are taken** from your devices into the folders sessions may be started in (`--spawn`), and nowhere else: one you upload to a session's folder, one you attach to a reply (kept in `.manyclaws-uploads` under that folder, which git ignores), or one you opened, changed on the page and saved back. A folder named only for opening files (`--files`) is read and not written, unless `agent.json` says `"upload": true`; `"upload": false` has none taken anywhere. A new file never takes the place of one that is there, and a file saved back is written only over the file you opened: where it has changed on the computer since, it is left alone until you say to save over what is there now. Nothing is written among the agent's own files.

## Tests

The plugin's tests run with Claude Code's own test runner:

```
cd mod && claude plugin test .
```

The end-to-end tests, which run the plugin and the agent against a real server and real Claude Code sessions, live with the server.
