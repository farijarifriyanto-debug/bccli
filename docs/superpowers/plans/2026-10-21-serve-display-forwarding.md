# bccli serve: forward tool `display` (diffs) to remote clients — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote clients of `bccli serve` (the mobile Agent feature's Device CLI bridge) receive the same rich tool output the TUI shows — most importantly the unified diff of `edit` results — by forwarding the optional `display` field in `tool_result` stream items.

**Architecture:** One additive change in the serve event mapper (`runTurn`'s `toolEnd` case): include `event.display` in the broadcast `tool_result` item, capped so a single mux frame stays far below the 256 KB protocol limit. No other wire item changes; old clients ignore the new optional field.

**Tech Stack:** TypeScript (ESM, Node >= 22), vitest, biome, tsup; WS mux protocol in `src/serveProtocol.ts`.

**Spec:** `farijarifriyanto-debug/BotConnector-Chat` repo, branch `docs/agent-remote-laptop-design-20261021`, file `docs/superpowers/specs/2026-10-21-agent-remote-laptop-design.md` (§5 wire contract, §7 bccli patch). Read the spec first.

## Global Constraints

- Wire changes are **additive only**: existing item shapes (`text`, `thinking`, `tool_use`, `tool_result{tool,output,isError}`, `usage`, `approval_request`, `error`, `result`) must keep working for current clients (`docs/serve-api.md:33-123`).
- `display` cap: **100_000 characters**, suffix marker exactly `\n[truncated]` when cut. Frame limit is 256 KB (`src/serveProtocol.ts:11`) — the cap keeps `tool_result` frames safe even with max-size `output` (bash outputs already truncate to a file per CHANGELOG).
- The turn-summary `result.toolCalls[]` (`WireToolCall`) stays **unchanged** (no `display` there — size).
- Gates before any commit/PR: `npm run typecheck`, `npm run lint`, `npm test` all green (repo CI runs the same).
- `main` is protected: work lands via PR; release tag `v0.4.9` is pushed by the owner after merge (`.github/workflows/release.yml` publishes to npm).
- Serve stays loopback-only; do not touch the trust fence.

## Review Focus

1. **Tools without `display`** (bash, write, most errors): `tool_result` item must not gain a `display` key at all (not `undefined` serialized) — pinned by Task 1 Step 1 test b.
2. **Oversized `display`** (huge edit diff, long fetch excerpt): capped at 100_000 chars + `\n[truncated]` — pinned by Task 1 Step 1 test c.
3. **Multi-client broadcast**: both mux streams of the same session receive the identical `tool_result` item including `display` — pinned by Task 1 Step 1 test a (second assertion block).
4. **Turn summary stability**: `result.toolCalls[0]` keeps exactly `{name, target, output, isError}` — pinned by Task 1 Step 1 test a.
5. **Docs truth**: `docs/serve-api.md` item table matches the actual wire (a future builder trusts it) — pinned by Task 2 Step 2.

---

### Task 1: Forward `display` in serve `tool_result` items

**Files:**
- Modify: `src/serve.ts:414-422` (the `case 'toolEnd':` block inside `runTurn`'s `map`)
- Test: `test/serve.test.ts` (append a new `test(...)`; helpers from `test/helpers/serve.ts`)

**Interfaces:**
- Consumes: `AgentEvent` variant `{ type: 'toolEnd'; id: string; tool: string; output: string; display?: string; isError: boolean }` (`src/agent.ts:19`); test helpers `api`, `connectMux`, `isItem`, `startServe` (`test/helpers/serve.ts`), provider stub pattern `call(name, args, id?)` / `reply(text)` (`test/agent.test.ts:28-29`); `ToolCall {id, name, arguments: string}` (`src/provider.ts:20-25`).
- Produces: mux item `{ type: 'tool_result', tool: string, output: string, isError: boolean, display?: string }` — `display` present only when the engine provided one, capped per Global Constraints. Downstream consumers (Device CLI bridge, mobile app — later plans) rely on this exact shape.

- [ ] **Step 1: Write the failing tests**

Append to `test/serve.test.ts` one `test('tool_result forwards display (capped, additive, broadcast)', ...)` that:
- builds its own serve instance (the shared `withServe` hides `cwd`, and these tests need a real file on disk): `mkdtempSync` a home + a cwd, `writeFileSync(join(cwd,'a.txt'), 'x\n')`, then `startServe({ port: 0, cwd, provider, env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } })` — same shape as `withServe` in `test/helpers/serve.ts:27-46`; close in `finally`.
- provider stub: first `chat()` returns `{ text: '', toolCalls: [call('edit', { path: 'a.txt', oldString: 'x', newString: 'y' })], usage: { inputTokens: 1, outputTokens: 1 } }` (remember `req.onText?.()` is not needed when text is empty); second returns `reply('done')`.
- creates a session with `api(base, token, '/v1/sessions', { permissionMode: 'bypassPermissions' })` so tools execute without approval round-trips; connects **two** mux clients (`connectMux`), opens `session:<id>` streams on both; posts the prompt `go`; waits `isItem('tool_result')` on both.
- asserts (a) item on client 1: `display` is a string matching `/- x/` and `/\+ y/` (formatDiff line format, `src/diff.ts:31-34`); (b) identical item on client 2; (c) after `isItem('result')`: `result.toolCalls[0]` has keys exactly `name, target, output, isError` (no `display`).
- a second `test('tool_result has no display key when the tool provides none', ...)`: same scaffolding, provider scripts `call('bash', { command: 'echo hi' })`; assert the `tool_result` item satisfies `!('display' in item)`.
- a third `test('oversized display is capped with a marker', ...)`: same scaffolding, but `a.txt` pre-written with `'x'.repeat(150000)` and the edit replaces it with `'short'`; assert `item.display.length <= 100000 + '\n[truncated]'.length` and `item.display.endsWith('\n[truncated]')`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/serve.test.ts -t display`
Expected: FAIL — first test's `display` assertion fails (item has no `display`), second test PASSES already (additive check), third FAILS. (Second passing pre-implementation is correct: it pins the no-key guarantee.)

- [ ] **Step 3: Implement the forwarding in `src/serve.ts`**

In `case 'toolEnd':` (lines 414-422), broadcast with the capped display; keep `WireToolCall` assignment untouched:

```ts
case 'toolEnd': {
  const call = byId.get(event.id)
  if (call) {
    call.output = event.output
    call.isError = event.isError
  }
  const item: Record<string, unknown> = { type: 'tool_result', tool: event.tool, output: event.output, isError: event.isError }
  if (typeof event.display === 'string') {
    item.display = event.display.length > DISPLAY_MAX ? `${event.display.slice(0, DISPLAY_MAX)}\n[truncated]` : event.display
  }
  broadcast(s, item as never)
  break
}
```

with `const DISPLAY_MAX = 100_000` defined next to the other serve constants (near `src/serve.ts:62`). If `broadcast`'s item type is a closed union, extend the `tool_result` member in `src/serveProtocol.ts`/`src/serve.ts` types with optional `display?: string` instead of casting — follow whichever keeps `typecheck` honest without `never` escapes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/serve.test.ts`
Expected: all PASS (new tests + existing suite in that file).

- [ ] **Step 5: Full gates**

Run: `npm run typecheck; npm run lint; npm test`
Expected: all exit 0 (biome `--error-on-warnings` included).

- [ ] **Step 6: Commit**

```bash
git add src/serve.ts test/serve.test.ts
git commit -m "feat(serve): forward tool display (edit diffs) in tool_result items, capped at 100k chars"
```

### Task 2: Docs + 0.4.9 release prep

**Files:**
- Modify: `docs/serve-api.md` (stream-items section, around lines 60-100)
- Modify: `CHANGELOG.md` (top)
- Modify: `package.json:3` (`"version": "0.4.8"` → `"0.4.9"`)

**Interfaces:**
- Consumes: the shipped wire shape from Task 1.
- Produces: the public contract text the Device CLI bridge (next plan) codes against: `tool_result` item `{type, tool, output, isError, display?}` with the cap and marker documented verbatim.

- [ ] **Step 1: Update `docs/serve-api.md`**

In the stream-items list, extend the `tool_result` entry: optional `display` (string) — the human-facing rendering the TUI shows (unified diff for `edit`, short summaries for `read`/`grep`/`glob`/`fetch`); absent when the tool provides none; capped at 100,000 characters with a trailing `\n[truncated]` marker. State explicitly: `result.toolCalls[]` does not carry `display`.

- [ ] **Step 2: Verify docs against behavior**

Run: `npx vitest run test/serve.test.ts -t display`
Expected: PASS — then re-read the edited docs paragraph next to the three test names; every documented claim (cap value, marker text, absence rule, summary exclusion) must match an assertion. Fix docs (not tests) on mismatch.

- [ ] **Step 3: Bump version + changelog**

`package.json` version → `0.4.9`. `CHANGELOG.md` new top section `## 0.4.9` with one line: serve `tool_result` items now forward the optional `display` field (edit diffs, tool summaries), capped at 100k chars with `\n[truncated]`; additive — existing clients unaffected.

- [ ] **Step 4: Gates + build**

Run: `npm run typecheck; npm run lint; npm test; npm run build`
Expected: all exit 0; `dist/` builds (tsup + tsc).

- [ ] **Step 5: Commit, push, PR**

```bash
git add docs/serve-api.md CHANGELOG.md package.json
git commit -m "docs+release: serve tool_result display field; 0.4.9"
git push origin docs/agent-display-plan-20261021
```

Open a PR against `main` titled "serve: forward tool display (diffs) to remote clients — 0.4.9" describing the additive wire change, the cap, and the spec link (BotConnector-Chat `docs/superpowers/specs/2026-10-21-agent-remote-laptop-design.md` §7). CI must go green. Owner merges; owner pushes tag `v0.4.9` (npm release workflow).

---

## Out of scope (other plans in this program)

- Device CLI bridge + relay changes (plan: BotConnector-Desktop repo).
- Phone UI (plan: BotConnector-Chat repo, feature branch held until App Store 2.0.0 resolves).
- Todo/plan/subagent event broadcasting and MCP in served sessions (spec §3 gaps — deferred, not this program's MVP).
