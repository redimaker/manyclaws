# ManyClaws: the plugin and the agent

[ManyClaws](https://manyclaws.dev) shows every Claude Code session you have running, on every computer, on one web page and on your phone, and lets you reply to them from there.

This repository holds the two parts of it that run on your own computers:

- **The plugin** (`mod/`): a Claude Code plugin. It reports each session to the ManyClaws server and does what your own devices ask of that session.
- **The agent** (`agent/`): a small background service, one per computer. It indexes that computer's Claude Code transcripts so past sessions can be read and searched, and starts or resumes sessions when you ask from the page.

The server and the web page are not in this repository.

## What leaves your computer

Everything a session says is encrypted on the computer it runs on, before it is sent, with a key made from a passphrase only you know. The server stores and forwards what it is given and cannot read it.

- **Sent, encrypted with your key:** what you ask Claude and what it answers, the tools it runs and their output, permission prompts and your answers, and everything about the session itself: its folder, model, mode, state and title.
- **Sent in the open**, because the server cannot pass a session on without it: that a session exists, which of your computers it is on, what that computer is called, when it sends, and which kind of thing each message is and roughly how large.
- **Acted on only when one of your own phones or browsers signed it:** replies, answers to permission prompts and questions, and requests to start, resume or copy a session. A computer reads the list of your devices, which is signed with a key made from your passphrase, and does nothing asked by anyone else, the server included.
- **Never sent:** your passphrase, your key, your Claude account's credentials, or any file Claude has not read or written in a session.

A plugin that has not been given your passphrase sends nothing at all.

## How the encryption works

`mod/hooks/seal.js` is the whole of it, and its opening comment is the specification: how a key is made from a passphrase, what a sealed value is, and how a request from a phone or browser is signed and checked. In short:

- Your key is made on each device from your passphrase and your account's id with Argon2id (64 MiB, 3 passes), then HKDF-SHA256.
- What is sealed is encrypted with AES-256-GCM, padded so its length says little about its contents.
- Each phone and browser signs what it asks with an Ed25519 key of its own that never leaves it. Your computers accept a request only from a device on a list signed with a key derived from your passphrase.
- The server is given nothing made from the passphrase: no hash, no verifier, not even a record that one was set. The only way to tell a passphrase is right is that it opens what was sealed with it.

Claude Code's plugin runtime has no crypto library, so every primitive (SHA-256, SHA-512, HMAC, HKDF, BLAKE2b, Argon2id, AES-256-GCM, Ed25519) is implemented in that one file in plain JavaScript. `agent/seal.mjs` is an identical copy, and the web page runs a third.

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
| `agent/install.sh` | Installs the agent as a service of your own user (launchd on macOS, systemd on Linux) |
| `.claude-plugin/marketplace.json` | Lets Claude Code install the plugin from this repository |

## Installing

The guide at <https://manyclaws.dev/setup> walks through it, and Claude Code can follow it for you. It installs both parts from this repository, as its `main` branch stands:

```
claude plugin marketplace add redimaker/manyclaws
claude plugin install manyclaws@manyclaws
curl -fsSL https://raw.githubusercontent.com/redimaker/manyclaws/main/agent/install.sh | bash -s -- --spawn ~/code
```

The first two install the plugin; the third installs the agent as a service of your own user and lets sessions be started in `~/code` (leave `--spawn` out and they can only be read and searched). Then give the plugin your API token and your encryption passphrase in its own dialog (`/plugin` in Claude Code), and start a new session.

To update: `claude plugin marketplace update manyclaws`, `claude plugin update manyclaws@manyclaws`, and the installer again with `--update`.

The plugin needs Claude Code 2.1.287 or later. The agent needs Node.js 22.13 or later and nothing else; it is for macOS and Linux.

What ends up on your computer is these files, so you can compare them:

- the agent, in `~/.manyclaws/agent/`, against `agent/` here (its version is `VERSION` in `agent/service.mjs`);
- the plugin, in Claude Code's plugin cache under `manyclaws/`, against `mod/` here (its version is in `mod/.claude-plugin/plugin.json`).

## What a computer allows

Both parts are limited by what the computer's owner sets, on that computer:

- **The plugin** does only what its **capabilities** option allows. By default a session can be inspected, sent prompts, sent notifications and messages, and have its permission prompts answered. The rest are off until turned on there, among them reading files directly (`+files`) and running commands (`+exec`); the full list is in `mod/hooks/lib.js`.
- **The agent** starts sessions only in the folders it was installed with (`--spawn`), and without that option it only reads and searches. Which permission modes it may start a session in is the list `spawn.modes` in `~/.manyclaws/agent.json`; with no list, every mode is allowed.

## Tests

The plugin's tests run with Claude Code's own test runner:

```
cd mod && claude plugin test .
```

The end-to-end tests, which run the plugin and the agent against a real server and real Claude Code sessions, live with the server.
