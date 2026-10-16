# Windows Node 24 BCCLI updater compatibility — 2026-10-16

## Status
P0 patch **prepared and tested locally**, NOT pushed / merged / published. Source branch `fix/bccli-update-windows-node24`, based on released beta.53 commit `592e2f8`. Published beta.53 cannot be altered in place. Future patch release would require separately authorized beta.54+ bump and CI/release.

## Bug proven on the owner's Windows laptop
- `bccli update` on global beta.50 exited 1 and left version unchanged, while npm registry `next` correctly pointed to beta.53.
- Node.js 24.18.0: `child_process.spawnSync('npm.cmd', ['--version'], {shell:false})` returns `EINVAL`.
- Running npm via `spawnSync('npm.cmd', ..., {shell:true})` works but creates avoidable shell/argument security risks.
- `node.exe <NodeDir>/node_modules/npm/bin/npm-cli.js --version` **PASS** with npm 11.16.0.

## Candidate patch
- `src/update.ts`: `updateSpawnCommand()` chooses original `npm` on non-Windows, but on Windows runs bundled npm JavaScript CLI with the same Node executable, no shell.
- Reuses official `next` prerelease or `latest` stable channel and ignores arbitrary package URLs.
- Fail-closed with a manual npm command if npm-cli.js is unavailable or process creation fails.
- Tests in `test/update.test.ts` check both Windows/Linux and prerelease/stable spawn specification.
- All BCCLI other functionality unchanged; no Cloud/provider calls for testing update launcher.

## Tests and live upgrade
- Focused update test: **12 PASS**.
- Full local candidate: typecheck, lint, `npm test` (871 PASS / 1 skipped), build: **PASS**.
- Manual official npm upgrade of installed BCCLI **beta.50 → beta.53 PASS**, with `config.json`, credentials and 92 session files verified unchanged.
- Backup: `%LOCALAPPDATA%/BotConnector/BCCLIUpdate/pre-beta53-20261016`.
- The actual published beta.53 update-notice module checked in isolated profile (simulated beta.54), **once-per-new-version PASS**.
- Real published beta.53 still has old Windows updater; until a patch is published and installed, Windows users should use `npm install -g @botconnector/bccli@next`.

## Need next approval
Publish a new prerelease (e.g. beta.54) with this fix after CI and test install from beta.53 through the repaired command. Do not tag / publish automatically under the authorization that was specific to beta.53.
