# Changelog

Notable changes per release. Versions follow semver; prereleases are published to the
`next` dist-tag, stable releases to `latest`.

## Unreleased

### Security

- **`bccli pr` no longer runs the PR task with every tool allowed by itself.** The task now
  starts in the normal permission mode; pass `--allow-all` explicitly to allow edits and
  commands, and BCCLI warns on stderr when you do. A pull request from an unfamiliar fork can
  carry its own `AGENTS.md`, so silently granting full tool access to it was unsafe.
- **Reading a secret file is no longer silent.** `read` of `.env*`, `.ssh`, `.aws`, `*.pem`,
  `*.p12`, `*.key`, `id_rsa`, `id_ed25519`, `secrets`, or `credentials` paths now asks for
  approval in every mode that can ask, and can never be granted for the session. `allowAll`
  (an explicit choice) behaves as before.
- **`save_memory` with `scope: "global"` asks before writing.** The global store lives outside
  the project, so it is no longer treated as an in-project edit that `acceptEdits` may
  auto-approve; the prompt now shows the file that is really written.
- Updated vulnerable dependencies: `@modelcontextprotocol/sdk` 1.30.1 → 1.32.1
  (GHSA-6qxp-vccf-f47h, OAuth credentials to a server-chosen authorization server) and
  `undici` 7.28.0 → 7.30.1. `npm audit --omit=dev` is clean again.

### Docs

- README badges now read the `next` dist-tag instead of the stale `latest` tag, and the
  `claude mcp add` line pins `@botconnector/bccli@next`.

### Tooling

- Added a `deprecate` workflow (manual dispatch) and `.github/dependabot.yml`; Dependabot
  security updates and vulnerability alerts are enabled on the repository.
