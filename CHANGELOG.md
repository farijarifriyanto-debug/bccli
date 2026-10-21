# Changelog

Notable changes per release. Versions follow semver; prereleases are published to the
`next` dist-tag, stable releases to `latest`.

## 0.4.9 - 2026-10-21

### Added
- **Serve: `tool_result` items now forward the optional `display` field (`src/serve.ts`)**: the same human-facing rendering the TUI shows (unified diff for `edit`, short summaries for `read`/`grep`/`glob`/`fetch`/`write`), broadcast to every mux client of the session. Capped at 100,000 characters with a trailing `\n[truncated]` marker; the key is absent when the tool provides none (e.g. `bash`). Additive - existing clients are unaffected, and the turn summary `result.toolCalls[]` still does not carry `display`.

## 0.4.8 - 2026-10-20

Keep terminal mouse tracking (`\x1b[?1000h`) off by default so mouse drag-to-copy and native 2-finger touchpad scrolling always work 100% of the time, and add single-key `Tab` (on an empty prompt) plus `alt+t` and `/thinking` (`/t`) to open/close `Thinking` effortlessly in both Windows Terminal and Termius on VPS.

### Fixed & Changed
- **Mouse Drag-to-Copy & Native Touchpad Scroll Always Work (`src/config.ts`, `src/ui/App.tsx`)**:
  - Kept `thinkingClickCollapse: false` by default and removed automatic `\x1b[?1000h` activation on modals so the terminal never hijacks left-button mouse drag-to-select (copying chat text) or native 2-finger touchpad scrollback.
- **Single-Key `Tab` (Empty Prompt), `alt+t`, and `/thinking` (`/t`) to Toggle `Thinking` (`src/ui/PromptInput.tsx`, `src/ui/App.tsx`)**:
  - Pressing `Tab` when the prompt input box `> ` is empty now immediately toggles `Thinking` open/closed (displayed as `✻ Thinking · N lines · tab / alt+t / ctrl+t`), working across Windows PowerShell, Windows Terminal, and Termius (desktop & mobile) without conflicting with Termius's `Ctrl+T` New Tab shortcut or disabling mouse drag-to-copy.
  - Added `alt+o` alongside `ctrl+o` and `/output` (`/o`) to toggle full tool output.

## 0.4.7 - 2026-10-20

Allow menu/inspection slash commands (`/help`, `/model`, `/config`, `/thinking`, etc.) to run immediately while the AI is thinking instead of being queued, enable click-to-toggle on `Thinking` by default with automatic 2-finger touchpad scroll passthrough, and add Termius-safe `alt+t` and `/thinking` (`/t`) shortcuts.

### Fixed & Changed
- **Menu & Slash Commands Run Immediately While AI Is Thinking (`src/ui/App.tsx`, `src/commands.ts`, `src/i18n/id.ts`)**:
  - Typing `/help`, `/model`, `/reasoning`, `/provider`, `/mcp`, `/config`, `/permissions`, `/status`, `/cost`, `/session`, `/thinking` (`/t`), `/output` (`/o`), `/diff`, `/tasks`, `/memory` (`#...`), etc. while the AI is busy thinking now executes immediately instead of getting stuck in `⏳ queued`.
  - Pressing `Esc` while any modal menu (`ModelPicker`, `ListPicker`, `ProviderMenu`, `McpMenu`, `LinePrompt`) is open closes only the menu without cancelling the running AI turn.
- **Click-to-Toggle `Thinking` Enabled by Default + 2-Finger Touchpad Scroll Auto-Passthrough (`src/config.ts`, `src/ui/App.tsx`, `src/ui/thinkingMouse.ts`)**:
  - Enabled `thinkingClickCollapse: true` by default so clicking `✻ Thinking · N lines` or the live `Thinking…` spinner works out of the box (both during and after a turn) with a wider 72-column hitbox covering the full `klik untuk buka/tutup` label.
  - When a 2-finger touchpad or mouse wheel scroll packet (`\x1b[<64..67;x;yM`) arrives, BCCLI immediately releases `\x1b[?1000l\x1b[?1006l` so the terminal scrolls its native scrollback buffer smoothly, then re-arms click reporting after scroll idle.
- **Termius-Safe `alt+t` & `/thinking` (`/t`) Shortcuts (`src/ui/App.tsx`, `src/commands.ts`)**:
  - Added `alt+t` keyboard shortcut and `/thinking` (`/t`) slash command alongside `ctrl+t` so users on Termius (where `Ctrl+T` opens Termius's New Menu/Tab) can toggle `Thinking` via mouse click, `alt+t`, or `/thinking`.

## 0.4.6 - 2026-10-19

Fix terminal mouse wheel & 2-finger touchpad scrolling, prevent screen clearing/scrollback wiping on long turns, add mouse wheel / touchpad scrolling to all interactive pickers and approval modals, and improve prompt input usability.

### Fixed & Changed
- **Native Terminal Mouse Wheel & 2-Finger Touchpad Scroll (`src/ui/App.tsx`, `src/ui/thinkingMouse.ts`)**:
  - Kept all `transcript.done` entries inside `<Static key={staticKey}>` and capped live streaming height so Ink's dynamic frame never exceeds the terminal viewport height (`shouldClearTerminalForFrame`), preventing `\x1b[3J` scrollback wipes and viewport jumps during streaming or typing.
  - Turned off SGR mouse tracking (`\x1b[?1000l\x1b[?1006l`) immediately when a turn ends even if `thinkingClickCollapse` is enabled, and ensured real TTYs reset stuck mouse tracking on startup/exit.
  - Hardened `isMouseControlInput` to filter SGR, Urxvt, X10, coalesced, and split mouse/touchpad scroll sequences so they never leak into prompt text or filter inputs.
- **2-Finger Touchpad & Mouse Wheel Scrolling in All Menus & Modals (`src/ui/ModelPicker.tsx`, `src/ui/ListPicker.tsx`, `src/ui/ProviderMenu.tsx`, `src/ui/McpMenu.tsx`, `src/ui/PermissionPrompt.tsx`, `src/ui/PlanApproval.tsx`)**:
  - Added `parseMouseWheel` support (`up`/`down`) and `PageUp`/`PageDown` navigation across all pickers, menus, and suggestion lists.
  - Added scrollable diff/plan windows (`MAX_DIFF_LINES = 16`, `MAX_PLAN_LINES = 16`) in `PermissionPrompt` and `PlanApproval`, and truncated long diffs (`> 20` lines) in `ToolBlock` until expanded with `ctrl+o`.
- **Prompt Input & Session Usability (`src/ui/PromptInput.tsx`, `src/ui/EditableText.tsx`, `src/ui/complete.ts`, `src/ui/App.tsx`, `src/ui/transcript.ts`)**:
  - Preserved unsent draft text when navigating history with `↑` and returning with `↓`.
  - Added `Shift+Enter`, `Ctrl+J`, and Bracketed Paste (`\x1b[?2004h`) multi-line input support without accidental auto-submission, plus 10-line cursor windowing in `EditableText`.
  - Added live `@file` autocomplete suggestions dropdown navigated via `↑`/`↓` or touchpad scroll and completed with `Tab`.
  - Updated `/clear`, `/new`, `/resume`, and `/rewind` to refresh `<Static>` cleanly so rewound turns disappear from screen and shorter resumed sessions always render.

## 0.4.5 - 2026-10-19

Render `Thinking` blocks in their chronological position at the top (before each step's tool call or assistant response, matching Claude Code and OpenCode) and make `ctrl+o` a reversible in-place expand/collapse toggle for tool outputs without duplicating scrollback.

### Fixed & Changed
- **Chronological `Thinking` Position at Top (`src/ui/App.tsx`, `src/i18n/id.ts`)**: `Thinking` blocks now render inline in the transcript where each reasoning step occurred (above the step's tool calls and assistant text) instead of accumulating at the bottom of the screen, and toggle open/closed in-place via `ctrl+t` or mouse click.
- **Reversible `ctrl+o` Tool Output Toggle (`src/ui/App.tsx`, `src/ui/ToolBlock.tsx`, `src/i18n/id.ts`)**: pressing `ctrl+o` now expands and collapses `<ToolBlock>` output in-place (`… (ctrl+o to collapse)` / `… {n} more lines (ctrl+o)`) instead of appending a permanent duplicate notice to scrollback.

## 0.4.4 - 2026-10-19

Fix `bash` tool hanging on background daemons (such as `agent-browser`) that inherit stdio pipes, show active tool progress in the live `Thinking` spinner and inspector, add `thinkingClickCollapse` to `/config`, and expand manual `/reasoning` support.

### Fixed & Changed
- **Prevent `bash` Tool Hang on Inherited Stdio Pipes (`src/tools/bash.ts`)**: `runCommand()` now listens to `child.on('exit')` with a 200ms pipe-drain grace timer, adds a 500ms post-kill timer on timeout/abort, and destroys `child.stdout` / `child.stderr` in `finish()` so background grandchildren (`agent-browser`, dev servers) can never block turn completion.
- **Live Tool Activity in `Thinking` Spinner & Inspector (`src/ui/App.tsx`)**: the live `<Spinner>` header and expanded `Thinking` inspector now display the currently running tool (`Berpikir · Bash …` / `▶ Bash …`), and `/config` immediately applies `thinkingVisible` and `thinkingClickCollapse` changes to the active session.
- **Manual `/reasoning` & Non-Streaming JSON Thinking (`src/reasoning.ts`, `src/provider.ts`)**: added `reasoning_effort` support for `gmi`, `gmicloud`, `vertex-maas`, `deepseek`, `groq`, `together`, `fireworks`, and `mistral`, and ensured non-streaming JSON chat completions invoke `onThinking` and `onText`.

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
