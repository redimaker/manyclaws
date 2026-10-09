# ManyClaws, the plugin and the agent: rules for working in this repository

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

- `mod/hooks/seal.js` and `agent/seal.mjs` are one file in two places, and the server's page has a third copy. A test with the server compares all three: change them together.
- `mod/hooks/rows.js` and `agent/rows.mjs` likewise.

## What is on main is what people run

- Computers install and update the plugin and the agent from this repository, as its `main` branch stands: the plugin through Claude Code's marketplace (`claude plugin marketplace add redimaker/manyclaws`), the agent through `agent/install.sh`, which fetches this repository's archive. **A push to main is a release to every computer that next updates.** Nothing half done goes to main, and nothing that the server it reports to would refuse.
- A change that the server has to match (what is sent, what is refused as too old) is pushed here and deployed there together: the server's repository says how.

## Versions

- The plugin's version is in `mod/.claude-plugin/plugin.json` and again as `PLUGIN_VERSION` in `mod/hooks/lib.js`: the two must agree. Claude Code takes an update only where the version has changed: a change to the plugin comes with a new one.
- The agent's is `VERSION` in `agent/service.mjs`. The server tells its pages which plugin and agent are the newest by what its own repository packaged from this one at its last deploy, and refuses a plugin or an agent older than it can hear.
