# BCCLI 0.5.1 — Native Engine, Clean Install

## Why this release exists

BCCLI 0.5.0's default interactive runtime depended on `@qwen-code/qwen-code` and its `@qwen-code/audio-capture` installation hook. A repository rename and console rebrand do not remove transitive packages. BCCLI 0.5.1 uses the existing first-party BCCLI native terminal runtime from `farijarifriyanto-debug/bccli` rather than bundling or invoking the third-party runtime.

The native BCCLI runtime already provides BotConnector Cloud and other OpenAI-compatible providers, an interactive provider selector (`/provider`), an in-terminal model picker (`/model`), tool calling, MCP, session handling, and `runTask`/`streamTask` SDK exports. First interactive run now offers a direct hidden API-key prompt for a configured provider with a missing key. Existing non-interactive commands never prompt.

## Installation and checks

```powershell
npm install -g @botconnector/bccli@latest --no-fund
bccli --version
npm ls -g @qwen-code/qwen-code @qwen-code/audio-capture --all
bccli
```

Expected version: `0.5.1`. The `npm ls` command should report an empty tree. No approval of `@qwen-code/audio-capture` install scripts is required. Funding suggestions printed by npm for unrelated dependencies are informational; `--no-fund` suppresses those notices for one installation.

## Important compatibility and security notes

- BCCLI 0.5.1 changes the default interactive coding engine back to BCCLI's first-party TypeScript/Ink implementation. It does **not** retain or execute the Qwen-backed 0.5.0 engine. Its terminal layout, exact tool policy and model behavior can differ from 0.5.0; compatibility testing cannot claim bit-for-bit parity.
- The first-party runtime's default home is `~/.bccli`. Sessions/configuration written by the separate 0.5.0 engine under its preview home are **not silently migrated**. The earlier files are preserved; this release neither deletes nor rewrites them.
- First-party BCCLI currently stores provider credentials in its per-user `~/.bccli/credentials` file with restrictive permissions. It **does not** import Windows DPAPI-encrypted credentials from the experimental 0.5.0 engine. Users may need to re-enter their key. Windows users should ensure their profile is not shared with other accounts.
- Node.js 22+ is required. The old warning about `@qwen-code/audio-capture` is eliminated by removing the dependency, not by overriding npm's script security controls.
- Legal attribution for any historical third-party builds remains unchanged in their original repositories and released versions.

## Release gates

Linux, Windows and macOS CI; source typecheck, lint, audit, unit tests, integration MCP tests; packaged SDK/CLI import; a fresh non-global installation; and a check that neither the package lock nor installed tree includes `@qwen-code/*`. The OIDC publishing workflow has the same trusted publisher identity (`farijarifriyanto-debug/bccli`, `publish-runtime-0.5.0.yml`, `npm-production`), with repository metadata matching the provenance.
