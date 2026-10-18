# Changelog

Notable changes per release. Versions follow semver; prereleases are published to the
`next` dist-tag, stable releases to `latest`.

## 0.4.1 - 2026-10-18

Patch release: two fixes found by directed runtime testing (rounds 3-4 on Windows).

### Fixed
- `bccli -r` no longer quits ~1 second after the TUI mounts (`exit 0`, session list and replay rendered but input dead). `rl.close()` from `node:readline/promises` leaves a TTY stdin read-stopped, and Ink only attaches `readable` listeners without resuming, so the event loop loses its last ref; the UI startup path now re-resumes `process.stdin` after closing the readline prompt. The same early-exit affected the first `bccli` run in a repo with untrusted MCP servers.
- `bccli serve` attach now resumes a session with the model recorded in the session's own usage log (`Session.lastModel()`) instead of silently switching it to the serving host's `config.model` across a server restart.

## 0.4.0 - 2026-10-18

First stable release of the current BCCLI line (the `0.4.0-beta.1` … `beta.55` series, which
stays available under the `next` dist-tag). The `latest` tag no longer points at the legacy
0.1.x launcher: `npm i -g @botconnector/bccli` now installs this line, and the old one is
marked deprecated on npm.

### Security

- **`bccli pr` no longer runs the PR task with every tool allowed by itself.** The task now
  starts in the normal permission mode; pass `--allow-all` explicitly to allow edits and
  commands, and BCCLI warns on stderr when you do. A pull request from an unfamiliar fork can
  carry its own `AGENTS.md`, so silently granting full tool access to it was unsafe.
- **Reading a secret file is no longer silent.** `read` of `.env*`, `.ssh`, `.aws`, `*.pem`,
  `*.p12`, `*.key`, `id_rsa`, `id_ed25519`, `secrets`, or `credentials` paths now asks for
  approval in every mode that can ask, and can never be granted for the session. `allowAll`
  (an explicit choice) behaves as before. Permission rules still come only from the global
  config, so a cloned project cannot grant them.
- **`save_memory` with `scope: "global"` asks before writing.** The global store lives outside
  the project, so it is no longer treated as an in-project edit that `acceptEdits` may
  auto-approve; the prompt now shows the file that is really written.
- Updated vulnerable dependencies: `@modelcontextprotocol/sdk` 1.30.1 → 1.32.1
  (GHSA-6qxp-vccf-f47h, OAuth credentials to a server-chosen authorization server),
  `undici` 7.28.0 → 7.30.1, and `source-map-js` 1.2.1 → 1.2.2. `npm audit` is clean again.
- Added `SECURITY.md` with the private reporting channel.

### Docs

- The install instructions, npm badges, and the `claude mcp add` line now describe the
  current line instead of the legacy `latest` tag (the Node badge used to claim `>=18`).
- Both READMEs document that reading a secret file asks for permission.

### Tooling

- `.github/dependabot.yml` (npm and GitHub Actions, weekly); vulnerability alerts and
  Dependabot security updates are enabled on the repository.
- A `deprecate` workflow (manual dispatch) marks or unmarks published version ranges using
  the npm credential that already lives in GitHub, and verifies the registry actually changed.
