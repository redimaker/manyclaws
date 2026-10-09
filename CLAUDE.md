# ManyClaws, the plugin, the agent and the page: rules for working in this repository

## This repository is public

Nothing private goes in it: no internal host names or addresses, no tokens or keys, no notes on how the server is run. Those are kept with the server, in its own repository.

## Tests: ten minutes, always, under a watchdog

These are the owner's standing instructions (2026-10-08). They have no exceptions.

- **Every test run of any kind is under a hard 10-minute watchdog that ends it.** No test command is ever started without it, and there are no circumstances in which the limit is raised, skipped, switched off or worked around.
- The plugin's own tests are started so that they are killed at ten minutes:
  `cd mod && perl -e 'alarm 600; exec @ARGV' -- claude plugin test .`
- The end-to-end tests live with the server. Its repository reaches this one through two links (`mod` and `agent`, to `../manyclaws/mod` and `../manyclaws/agent`), so a change made here is tested there, with its runner, which carries the watchdog: `npm test` in its `e2e/` folder. A change to the plugin or the agent is not done until that suite has passed on it.
- A run that reaches the limit has failed, and the slowness is the fault to fix. Do not run it again with more time.
- When handing work to a subagent that may run tests, give it these rules in its brief.

## Copies that must stay the same

- `mod/hooks/seal.js`, `agent/seal.mjs` and `web/seal.js` are one file in three places. A test with the server compares all three: change them together.
- `mod/hooks/rows.js` and `agent/rows.mjs` likewise.

## The page

- `web/` is what the server hands a browser: the server's repository reaches it through a link (`server/public`), as it reaches `mod` and `agent`.
- `web/index.html` names every script and style sheet the page loads with the SHA-384 of the file, and a browser runs none that is anything else. **After changing any of them, run `node release.mjs`**, which writes those values, and commit `web/index.html` with the change: a page whose HTML is stale runs nothing. The server's test runner does it before every run, and its deploy refuses a checkout where it is not done.
- A module the page's script imports is named in `index.html` too (`<link rel="modulepreload">`): one that is added gets a line there, before anything that imports it.

## What is on main is what people run, and it is a signed release

- Computers install and update the plugin and the agent from this repository, as its `main` branch stands: the plugin through Claude Code's marketplace (`claude plugin marketplace add redimaker/manyclaws`), the agent through `agent/install.sh`, which fetches this repository's archive. **A push to main is a release to every computer that next updates.** Nothing half done goes to main, and nothing that the server it reports to would refuse.
- **What is pushed to main is signed.** `release.json` lists every file under `agent/`, `mod/`, `web/` and `.claude-plugin/` with its SHA-256, and `release.json.sig` is that list signed. The agent's installer installs nothing else: a main whose list is stale, or not signed by a key the installer knows, is refused by every computer, and says so. So the last step before a push, after any change under those folders, is

  `MANYCLAWS_RELEASE_KEY=<the release key> node release.mjs --sign`

  and the two files are committed with the change. `node release.mjs --check` says whether it is done. The key is not here: the server's repository says where it is kept, and who may use it.
- **A change to the plugin is not pushed to main without the owner's say.** His standing instruction (2026-10-09): "Do not automatically publish a change that contains a fix in the plugin." A change that touches anything under `mod/` is finished, tested and committed on a branch, and waits there, with whatever else belongs to the same change, until he has said so for that change.
- The keys a release may be signed by are `SIGNERS` in `agent/install.sh`. A key is replaced by a release, signed with the old one, whose installer names the new one: never by a release signed with a key no installed agent knows.
- A change that the server has to match (what is sent, what is refused as too old) is pushed here and deployed there together: the server's repository says how.

## Versions

- The plugin's version is in `mod/.claude-plugin/plugin.json` and again as `PLUGIN_VERSION` in `mod/hooks/lib.js`: the two must agree. Claude Code takes an update only where the version has changed: a change to the plugin comes with a new one.
- The agent's is `VERSION` in `agent/service.mjs`. The server tells its pages which plugin and agent are the newest by what its own repository packaged from this one at its last deploy, and refuses a plugin or an agent older than it can hear.
