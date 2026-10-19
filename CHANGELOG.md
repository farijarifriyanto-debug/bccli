# Changelog

Notable changes per release. Versions follow semver; prereleases are published to the
`next` dist-tag, stable releases to `latest`.

## 0.4.3 - 2026-10-19

Advanced next-gen capabilities: persistent warm LSP client with symbol navigation, Windows WSL2 `bwrap` sandbox bridge, `!cmd` / `#memory` TUI prompt shortcuts, and real-time `text_delta` / `thinking_delta` streaming in `-p --output-format stream-json`.

### Added
- **Persistent Warm LSP Client & Symbol Navigation (`src/lsp.ts`, `src/tools/diagnostics.ts`)**: `createWarmLspClient()` keeps language server processes warm across turns (`textDocument/didOpen` on first touch, incremental `textDocument/didChange` on edits) and adds `action: 'hover' | 'definition' | 'references'` (with 1-based `line` and `character`) to the `diagnostics` tool.
- **Windows WSL2 `bwrap` Sandbox Bridge (`src/tools/sandbox.ts`)**: `winPathToWsl()` and `sandboxArgv(..., { wslBwrap: true })` (or `BCCLI_WIN32_WSL_SANDBOX=1`) enable Linux kernel `bwrap` filesystem/network namespace sandboxing for Windows projects via `wsl.exe -- bwrap`, while preserving fail-closed behavior when WSL sandboxing is not enabled.
- **TUI Prompt Shortcuts (`!command` & `#memory` in `src/ui/App.tsx`)**: typing `!cmd` in the TUI executes the shell command locally without an LLM round-trip and attaches the output to the conversation context; typing `#note` saves the note directly to `AGENTS.md` / `BCCLI.md` and refreshes the system prompt.
- **Real-Time Token Delta Streaming (`src/print.ts`)**: `-p --output-format stream-json` now emits real-time `text_delta` and `thinking_delta` JSONL events as tokens stream from the provider in addition to the final `message` and `result` events.

## 0.4.2 - 2026-10-19

Security hardening, bug fixes, and feature upgrades across core tools, TUI/Vim, SDK/ACP/CLI, LSP, MCP, and providers.

### Security
- Secret-file detection (`requiresSensitiveToolApproval`) now matches extension-bearing filenames (`credentials.json`, `secrets.json`, `.npmrc`, `.netrc`, `.git-credentials`), and `grep` includes `input.path` in its permission target so searching inside secret paths requires approval.
- `Permissions.rulesFor()` blocks session grants (`[a]`) when any command segment starts a subshell (`(...)` or `{...}`), and `editInProject()` checks `.git` path segments case-insensitively.
- `collectGhContext()` escapes closing `</untrusted-github>` tags inside untrusted GitHub issue/PR/comment text, `authorizeMcpServer()` HTML-escapes OAuth callback error descriptions, and `trustFence()` accepts `Host: [::1]` on port 80.

### Added
- `edit` tool now supports multi-level fuzzy matching (stripping `read` line-number prefixes, normalizing typographic quotes/dashes and trailing whitespace), atomic multi-edit arrays (`edits: [...]`), and external file modification detection (`mtimeMs`).
- `read` tool now lists directory entries when given a directory path; `glob` sorts matches by modification time (`mtime` newest first) and walks up to the project root `.gitignore` when searching inside subdirectories.
- `grep` tool now supports searching a single file path, literal matching (`literal: true`), context lines (`context: N`), and `output_mode: 'content' | 'files_with_matches' | 'count'`.
- `bash` tool saves full truncated output (`>30,000` chars) to a temporary log file (`; full output saved to ...`).
- Automatic model fallback (`--fallback-model <ref>` and `fallbackModels` in config) via `withFallbackProvider` on HTTP 429/5xx or connection errors, plus `Retry-After` header support.
- `task` subagents now synthesize a final summary when reaching `maxSteps`, isolate provider instances across parallel subagents, and support `session_id` continuation.
- TUI & Vim: grapheme-aware Vim cursor motions (`Intl.Segmenter`) for emoji/surrogate pairs plus `D`, `C`, `cc`, `cw`, `I`, `e`; `Esc` to dismiss slash suggestions; `Alt+Enter` / `Ctrl+J` newline insertion; deep `@file` completion and automatic file pre-attachment (`expandAtFileMentions`); interactive `/config` slash command; dynamic model `contextWindow` in `/status`.
- Piped `stdin` support in `-p` print mode (combined with the `-p` prompt argument), plus `session_id`, `usage`, and `duration_ms` in `--output-format json` and `stream-json`.
- `lsp` maps 30+ file extensions to their official LSP `languageId` (`languageIdFor`) and automatically enables `shell: true` for `.cmd` language server wrappers on Windows; `McpManager` extracts image attachments (`type: 'image'`) and embedded resource text (`type: 'resource'`).

### Fixed
- `CheckpointStore.beginTurn()` now tracks every turn with an `offset` counter so `/rewind` after read-only turns no longer desynchronizes from file snapshots, and `/undo` works after `/redo`.
- `estimateMessages()` bounds base64 `image_url` token estimates (`1,000` tokens/image) and `trimToFit()` / `splitKeepRecent()` no longer split mid-turn on image attachment messages.
- `runTask()` / `streamTask()` surface provider errors with `stopReason: 'error'` and abort the running agent when a `streamTask` consumer exits early.
- `acp` rejects concurrent `session/prompt` calls on a busy session (`-32000`), aborts active turns on stream close, and forwards `embeddedContext` / `resource` prompt blocks and reasoning summaries.
- `bccli pr` forwards `--repo`, `-m`, `--reasoning`, `--permission-mode`, and `--allowed-tools`; `bccli stats --project` works as a bare flag; `bccli export <file>` overwrites existing destination files cleanly; `parseFrontmatter()` parses multi-line YAML lists.

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
