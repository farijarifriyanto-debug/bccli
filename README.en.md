# BCCLI

[English](README.en.md) · **Bahasa Indonesia**

[![npm](https://img.shields.io/npm/v/@botconnector/bccli/next?label=@botconnector/bccli)](https://www.npmjs.com/package/@botconnector/bccli?activeTab=versions)
[![npm downloads](https://img.shields.io/npm/dm/@botconnector/bccli)](https://www.npmjs.com/package/@botconnector/bccli)
[![Node.js](https://img.shields.io/node/v/@botconnector/bccli/next?label=Node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-botconnector.id-06305A)](https://botconnector.id/id/download)

An AI coding agent from [BotConnector](https://botconnector.id/) that works in your terminal: it reads code,
edits files, and runs commands — with your permission.

![BCCLI creating hello.js and running it with node](docs/demo.gif)

*Real session recording: BCCLI creates `hello.js` and runs it with `node`.*

```bash
# one-line install (macOS / Linux / WSL2) — provisions a portable Node if needed, no sudo
curl -fsSL https://raw.githubusercontent.com/farijarifriyanto-debug/bccli/main/install.sh | bash

# or manual, if you already have Node.js 22+
npm i -g @botconnector/bccli@next    # latest beta, requires Node.js 22+
bccli login                     # store your BotConnector Cloud API key
cd your-project && bccli
```

## Usage

| Command | What it does |
|---|---|
| `bccli` | interactive mode |
| `bccli -p "task"` | one-shot task (scripts/CI) |
| `bccli -p "task" --output-format json` | final result as a single JSON object; `stream-json` = JSONL events per stage (tool_use/tool_result/message/result) for CI |
| `bccli -c` / `bccli -r` | continue last session / pick a session |
| `bccli -m provider/model` | choose a model |
| `bccli --reasoning <auto\|off\|low\|medium\|high\|max>` | set reasoning level for this invocation |
| `bccli models` | list models |

In-session commands (type `/` for suggestions, ↑↓ to select, Enter to run):

| Command | What it does |
|---|---|
| `/help` | list commands and shortcuts |
| `/model` | switch model |
| `/reasoning` | pick Auto / Off / Low / Medium / High / Max |
| `/provider` | add/select an AI provider |
| `/language` | change display language (`en` / `id`) |
| `/mcp` | install/manage MCP servers |
| `/new` | new session (old sessions are kept) |
| `/resume` | continue another session in this folder |
| `/session` | info about this session |
| `/status` | version, model, permission mode, MCP, context |
| `/permissions` | view/revoke permissions |
| `/undo` | undo the last file-edit turn |
| `/diff` | git diff of the project |
| `/copy` | copy the last answer |
| `/export` | save the conversation to markdown |
| `/memory` | project instructions (/memory <text>, /memory global <text>) |
| `/init` | create/update AGENTS.md for this project |
| `/agents` | list subagents |
| `/skills` | list skills and custom commands |
| `/doctor` | check installation health |
| `/login` | store the active provider's API key |
| `/logout` | remove the active provider's API key |
| `/clear` | start a fresh conversation |
| `/compact` | compact the conversation |
| `/cost` | token usage for this session |
| `/exit` | quit |

`/undo` only reverts file edit/write tool changes (not bash commands), one turn at a time, up to 20 turns back.
Shift+Tab cycles permission modes: `default` → `acceptEdits` → `plan` → `allowAll`.

Reading a secret file (`.env`, `.ssh`, `.aws`, `id_rsa`, `*.pem`, `*.key`, `secret*`,
`credential*`) always asks for approval; `allowAll` is the only mode that does not, and the
approval cannot be granted "for this session".

`-p` mode never prompts: permission-requiring tools are refused unless you pass
`--allow-all` or `--allowed-tools bash,edit,fetch`.

## Language

BCCLI's UI (help, messages, permission prompts) is **English by default**. Indonesian stays available:

```bash
bccli --lang id          # one-off
BCCLI_LANG=id bccli      # via environment
/language id             # inside a session; stored in ~/.bccli/config.json ("language")
```

Priority order: `--lang`, then `BCCLI_LANG`, then `language` in config, then English. The model answers in
the language you write; tool messages the model reads (tool output, errors) are always English so they
don't distort the reply language.

## Providers

`/provider` in a session (or `bccli provider add <id>`) adds a provider with just an API key:

| Id | Provider |
|---|---|
| `bc-cloud` | BotConnector Cloud (default) |
| `openrouter` | OpenRouter |
| `openai` | OpenAI |
| `gemini` | Google Gemini |
| `deepseek` | DeepSeek |
| `groq` | Groq |
| `ollama-cloud` | Ollama Cloud |
| `ollama` | local Ollama (no key) |
| `lmstudio` | local LM Studio (no key) |

Any other OpenAI-compatible provider: pick **Custom…** in `/provider`, or
`bccli provider add corp --url https://corp.example/v1 --name "Corp"`.

`/model` lists models from **every** provider that has a key, grouped by provider;
type to filter. Your choice is saved as the default.

Reasoning can be set via `bccli --reasoning <auto|off|low|medium|high|max>` or `/reasoning`.
**Auto** uses the model/provider default and BCCLI sends no reasoning override. BCCLI never
silently lowers or raises reasoning effort. Manual levels pass through when the provider/model
contract supports them; unsupported levels produce a clear error instead of a silent downgrade.

`.bccli/config.json` inside a project may only pick a `model` and add new keyless providers —
the `reasoning` preference is read only from the user config `~/.bccli/config.json`, never from a
cloned repo — permissions (`permissionMode`, `allow`) and existing providers are configured only
from `~/.bccli/config.json`, so a cloned repo cannot grant itself full permissions or steal API keys.

## External agent integrations

BCCLI can set up BotConnector as a provider for other agents:

| Command | What it does |
|---|---|
| `bccli integrations` | show integration status |
| `bccli connect opencode` | connect OpenCode to BotConnector |
| `bccli connect aider` | connect Aider to BotConnector |
| `bccli connect cline` | connect Cline CLI to BotConnector |
| `bccli connect deepseek-harness` / `bccli connect dsh` | connect DeepSeek Harness to BotConnector |
| `bccli connect codex` | create Codex Responses API profile + BotConnector launcher |
| `bccli connect claude-code` | create a Claude Code launcher via Anthropic Messages compatibility |
| `bccli connect cursor` | guided Cursor setup + Base URL override warning |
| `bccli connect openai-cli` | create an OpenAI CLI launcher for BotConnector |
| `bccli connect openai-sdk` | create an env profile for the OpenAI Python/Node SDK |
| `bccli connect openai-compatible` | create a universal OpenAI-compatible env profile |
| `bccli disconnect <agent>` | restore the config from before the integration |

OpenCode uses the global config `~/.config/opencode/opencode.json`. BCCLI fetches the BotConnector
model catalog on connect, preserves other providers' config, and stores secrets in a separate file
under `~/.bccli/integrations/`.
Aider uses `~/.aider.conf.yml` pointing at a separate BCCLI env file; BCCLI refuses to overwrite
existing Aider OpenAI/env-file settings.

Cline uses an `openai-compatible` provider in `~/.cline/data/settings/providers.json`. If that slot
is taken by another endpoint, BCCLI refuses to overwrite it. Cline itself stores provider API keys
in that file.

DeepSeek Harness uses a custom `botconnector` provider in `$DSH_HOME/settings.yaml` with
`api: openai-completions` and `apiKeyEnv: BOTCONNECTOR_API_KEY`; the key goes in the BCCLI block of
`$DSH_HOME/.env`. Other DSH providers are kept. After connecting, run the web profile with
`dsh web` (same as `dsh --profile web`); bare `dsh` without a profile is rejected by DSH 0.1.x.

Codex uses a profile `$CODEX_HOME/botconnector.config.toml` with `wire_api = "responses"` and a BCCLI
launcher that reads the key from BCCLI storage at runtime. Claude Code gets an isolated launcher with
`ANTHROPIC_BASE_URL=https://api.botconnector.id` and the `/v1/messages` compatibility endpoint +
token counting. Codex and Claude Code primary login/config are not overwritten.

External agents call BotConnector directly, so model discovery does not use BCCLI-specific identity.
Access restricted to BCCLI/Web App (for example Luna launch access) is not automatically inherited.
Before changing external config, BCCLI makes a backup so `disconnect` can restore it.

## Internet

- `web_search`: web search with no permission prompt. Uses your BotConnector Cloud account when a key
  is present, otherwise goes straight to Keenable (free, no key). Results are titles, URLs, and short
  snippets, so they are token-efficient.
- `fetch`: open one URL from this machine (permission required per host).

## MCP

`/mcp` (or `bccli mcp add <name>`) installs servers from the catalog:
`playwright`, `context7`, `fetch`, `filesystem`, `git`, `github`. Other remote servers:
`bccli mcp add name --url https://…`. Stored in `~/.bccli/mcp.json` (`mcpServers` format, same as
Claude Code). All MCP tools always require permission.

A `.bccli/mcp.json` inside a repo is not executed until you approve it (asked once per folder).

`bccli mcp serve` runs a stdio MCP server with your BotConnector tools
(`bc_search`, `bc_fetch`, `bc_models`, `bc_chat`) for Claude Code, Cursor, opencode, and other MCP
hosts. Requires `bccli login` (or `BOTCONNECTOR_API_KEY`):

```bash
claude mcp add botconnector -- npx -y @botconnector/bccli@next mcp serve
```

## Subagents

The agent can delegate work via the `task` tool:
- `explore` — read & search only, can run in parallel;
- `general` — all tools (edits/commands still ask permission);
- custom — `.bccli/agents/name.md` or `.claude/agents/name.md`:

```markdown
---
name: reviewer
description: review code changes
tools: [read, grep, glob]
model: openrouter/qwen/qwen3-coder
---
You are a code reviewer. Report real bugs only.
```

## Skills & custom commands

- Skills: folders containing `SKILL.md` in `~/.bccli/skills/`, `.bccli/skills/`, `~/.claude/skills/`,
  `.claude/skills/` — used automatically when relevant, or via `/skill-name`.
- Commands: `commands/name.md` in the same folders → `/name arguments` (`$ARGUMENTS` is replaced).

## Todos & plan mode

Tasks with ≥ 3 steps show a checklist above the input box. In plan mode (Shift+Tab),
the agent only reads and then proposes a plan; `[a]` approves with automatic edits,
`[y]` approves asking at each step, `[n]` asks for revisions.

Project instructions are read from `AGENTS.md` and `BCCLI.md`.

## Development

```bash
npm install
npm test && npm run typecheck && npm run lint && npm run build
```

CI (`ci.yml`) runs the same on Linux, macOS, and Windows.
Releases: bump `version` in `package.json`, then push a `v<version>` tag — `release.yml`
runs tests, a smoke test against BotConnector Cloud, and `npm publish --provenance`.

## Learn more

- [Download & BCCLI guide](https://botconnector.id/id/download)
- [BotConnector Developer API](https://botconnector.id/id/developers/api) — OpenAI SDK-compatible endpoint
- [Switchboard](https://github.com/farijarifriyanto-debug/switchboard) — BotConnector's open source agent harness
- [Contributing](CONTRIBUTING.md)
