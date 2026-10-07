# `bccli serve` API

Kontrak HTTP untuk konsumen eksternal: IDE extension, GitHub bot, Switchboard, SDK.
Server loopback-only (127.0.0.1); desain mengikuti pola DeepSeek Harness (trust fence,
disiplin `ready`, approvals fail-closed + replay pending). Spesifikasi lengkap:
`docs/superpowers/specs/2026-10-07-serve-design.md`.

## Menjalankan

```
bccli serve [--port 8787] [--host 127.0.0.1] [--token <t>]
```

Token acak 32-byte hex dicetak sekali di stderr saat start:

```
bccli serve http://127.0.0.1:8787 — Authorization: Bearer <token>
```

Override: `--token` atau env `BCCLI_SERVE_TOKEN`. `--host` non-loopback ditolak saat parse.

## Keamanan

Dua lapis, terpisah status — berlaku untuk SEMUA request HTTP dan upgrade WS:

| Cek | Status | Keterangan |
|---|---|---|
| Trust fence | **403** | `Host` wajib loopback + port cocok listener; `Origin` (bila ada) wajib loopback + port cocok; `sec-fetch-site: cross-site` ditolak. Tidak menetapkan identitas. |
| Bearer token | **401** | `Authorization: Bearer <token>`, timing-safe. `GET /health` dikecualikan. |

Token tidak pernah lewat query string. Tanpa TLS (localhost-only).

## Endpoint unary (JSON)

| Method & path | Body | Respons |
|---|---|---|
| `GET /health` | — | `200 {ok, version}` (tanpa auth) |
| `GET /v1/models` | — | `200` ModelGroup `[{providerId, providerName, models[]}]` |
| `POST /v1/sessions` | `{cwd?, permissionMode?, model?}` | `201 {id, cwd, permissionMode}` |
| `GET /v1/sessions?cwd=` | — | `200 [{id, mtime, preview}]` |
| `GET /v1/sessions/:id?cwd=` | — | `200 {id, cwd, permissionMode, messages}` (baseline history) |
| `POST /v1/sessions/:id/messages` | `{prompt}` | `202 {turnId}` — hasil lewat stream; `409` bila turn berjalan |
| `POST /v1/sessions/:id/approvals` | `{requestId, answer}` | `200 {accepted:true}`; `404` bila sudah dijawab/tidak dikenal |
| `POST /v1/sessions/:id/cancel` | — | `200 {cancelled:true}` — abort turn berjalan |

`permissionMode`: `'ask'` (default) atau `'bypassPermissions'` (bot/CI — auto-allow).
`answer`: `'yes' | 'no' | 'session' | 'all'` (semantik sama dengan prompt izin CLI).

Error selalu `{"error": {"message"}}` dengan status benar (400/401/403/404/409/413/500).
Body request maks 1 MB (413). Error route = 404.

## Streaming: WebSocket `/v1/mux`

Satu koneksi WS memuat banyak logical stream. Frame JSON satu-objek:

```ts
// client → host
{ type: 'open',   streamId: string, target: 'session:<id>' }
{ type: 'cancel', streamId: string }          // menutup stream, BUKAN turn
// host → client
{ type: 'item',  streamId: string, value: unknown }
{ type: 'end',   streamId: string }
{ type: 'error', streamId: string, message: string }  // streamId '' = koneksi
```

Upgrade juga melewati trust fence + bearer (401/403). Heartbeat ping tiap 2 detik —
socket yang tidak balas pong sebelum interval berikutnya di-terminate.

### Siklus sesi

```jsonc
→ { "type": "open", "streamId": "s1", "target": "session:2026-10-07T…-ab12cd" }
← { "type": "item", "streamId": "s1", "value": { "type": "ready", "sessionId": "…", "host": { "home": "…", "version": "0.4.0-beta.38" } } }
// POST /v1/sessions/:id/messages { "prompt": "…" } → 202 { turnId }
← { "type": "item", "streamId": "s1", "value": { "type": "text", "delta": "Halo" } }
← { "type": "item", "streamId": "s1", "value": { "type": "result", "text": "Halo", "toolCalls": [], "usage": { "inputTokens": 12, "outputTokens": 4 }, "stopReason": "done" } }
→ { "type": "cancel", "streamId": "s1" }
← { "type": "end", "streamId": "s1" }
```

Item `result` menandai SELESAI TURN — stream tetap terbuka untuk turn berikutnya.
`end` hanya dikirim saat stream ditutup (cancel/dispose/shutdown).

### Tipe item

| `value.type` | Field | Kapan |
|---|---|---|
| `ready` | `sessionId`, `host{home,version}` | pertama setelah `open` (listener sudah terpasang sebelumnya) |
| `text` / `thinking` | `delta` | streaming token |
| `tool_use` | `tool`, `target` | tool mulai |
| `tool_result` | `tool`, `output`, `isError` | tool selesai |
| `usage` | `inputTokens`, `outputTokens` | kumulatif per sesi |
| `approval_request` | `requestId`, `tool`, `kind`, `target`, `preview?` | izin dibutuhkan (mode `ask`) |
| `error` | `message` | error agent (stream tetap terbuka) |
| `result` | `text`, `toolCalls[]`, `usage`, `stopReason` | akhir turn (`done`/`aborted`/`stepLimit`/`budgetExceeded`) |

### Replay & disiplin reconnect

- Setelah `GET /v1/sessions/:id` (baseline), client `open` stream → `ready` →
  kirim konten baru. **Notifikasi transient TIDAK di-replay** — reconnect wajib
  re-read baseline.
- **Satu-satunya replay**: `approval_request` yang masih pending untuk sesi itu
  (dikirim tepat setelah `ready`, `requestId` sama).
- Jawaban yang datang setelah requestId terjawab → 404 (sekali pakai).

### Approvals (mode `ask`)

```
← approval_request { requestId, tool: "bash", target: "npm test" }
POST /v1/sessions/:id/approvals { requestId, answer: "yes" }
← tool_use / tool_result …
```

Fail-closed: cancel turn, turn selesai, atau server shutdown → semua pending
dijawab `'no'`. Putus stream TIDAK menjawab — akan direplay saat buka ulang.
`answer: 'session'` menyimpan rule izin in-memory sesi; `'all'` = allowAll sesi itu.

### Batasan v1

- Loopback-only; satu turn in-flight per sesi (409); sesi berbeda paralel.
- `permissionMode` in-memory (attach ulang setelah restart = `ask`).
- MCP server tidak di-start oleh serve (jalankan via TUI/CLI bila perlu).
- Tidak ada seq-journal/gap-repair — baseline re-read + replay approval sudah race-free.
