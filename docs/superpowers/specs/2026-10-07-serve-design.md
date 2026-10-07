# Desain: `bccli serve` — session server (fondasi IDE/bot/Switchboard)

Tanggal: 2026-10-07
Status: disetujui user (desain DSH-aligned)
Referensi pola matang: DeepSeek Harness (`C:\Users\farij\Projects\dsh-reference`) —
`packages/api/gateway` (mux WS `/api/remote.mux`, stream-protocol), `packages/client/connection`
(trust fence + launch token), `packages/api/remotes` (disiplin `$events`/`ready`),
`packages/interaction/user-approval` (fail-closed, replay pending), `packages/sdk` (stdio JSON-RPC).

## 1. Tujuan & non-tujuan

**Tujuan**: server lokal yang mengekspos agent bccli sebagai sesi persisten multi-turn
kepada proses eksternal (IDE extension, GitHub bot, Switchboard, SDK konsumen), mengikuti
pola transport/auth/events/approvals DSH tanpa infrastruktur Cordis/codegen.

**Non-tujuan (v1)**: multi-user/remote non-loopback, TLS, seq-journal + gap-repair,
replay notifikasi transient, UI presentasi, load-balancing, WebSocket uplink item bisnis
(uplink hanya frame kontrol `open`/`cancel`).

## 2. Arsitektur

Satu server `node:http` + upgrade WebSocket via dep `ws` (sudah ada di package.json).
Modul baru `src/serve.ts` (+ `src/serveProtocol.ts` untuk framing murni) mengorkestrasi
fondasi yang sudah ada:

- `createRuntime()` (setup.ts) → provider/tools/permissions per sesi.
- `Agent` (agent.ts) → loop dengan `AskPermission` callback dan `AgentEvent`.
- `Session` (session.ts) → persistensi JSONL per `(home, cwd)`, kompatibel TUI
  (sesi serve bisa dilanjutkan di CLI lokal dan sebaliknya; resume lintas restart serve).
- Pemetaan event → bentuk `SdkEvent` yang sama dengan `--output-format stream-json`.

Tidak ada dependency npm baru. Tidak ada perubahan pada loop agent; serve adalah
konsumen `AgentOptions` yang sudah ada.

## 3. CLI & konfigurasi

```
bccli serve [--port 8787] [--host 127.0.0.1] [--token <t>] [--cwd <dir>]
```

- Port default `8787`; host default `127.0.0.1` (loopback-only; nilai non-loopback
  ditolak kecuali `--host 0.0.0.0` TIDAK didukung sama sekali — mengacu DSH
  "unsupported", fail loud saat parse argumen).
- Token: default acak 32-byte hex (crypto) dicetak SEKALI ke stderr saat start bersama
  URL; override via `--token` atau env `BCCLI_SERVE_TOKEN`.
- `--cwd`: root kerja default sesi (default: cwd proses).
- HELP EN (`src/args.ts`) + nilai ID (`src/i18n/id.ts`), kolom deskripsi 32.

## 4. Auth dua lapis (pola `api-request-trust.ts` DSH)

Dipisahkan per status, berlaku untuk SEMUA request HTTP dan upgrade WS:

1. **Trust fence → 403** (anti DNS-rebinding/CSRF; tidak pernah menetapkan identitas):
   - `Host` header wajib loopback (`127.0.0.1[:port]`, `localhost[:port]`, `[::1][:port]`)
     dan portnya cocok dengan listener.
   - `Origin` bila terlampir wajib same-origin dengan Host.
   - `sec-fetch-site: cross-site` ditolak.
2. **Auth → 401**: `Authorization: Bearer <token>`, dibandingkan timing-safe
   (`crypto.timingSafeEqual`). `/health` dikecualikan dari auth (tetap kena trust fence).

Deviasi sadar vs DSH: launch-token→signed-cookie DSH ada karena browser tidak bisa
set header; konsumen serve adalah proses lokal (IDE/bot/SDK) → Bearer header adalah
bentuk yang benar. Token tidak pernah diterima via query string.

## 5. API unary (HTTP POST/GET, JSON)

| Method & path | Body | Respons |
|---|---|---|
| `GET /health` | — | `{ok: true, version}` (tanpa auth) |
| `GET /v1/models` | — | daftar provider/model (reuse `listModels`) |
| `POST /v1/sessions` | `{cwd?, permissionMode?: 'ask'\|'bypassPermissions', model?}` | `201 {id, cwd, permissionMode}` |
| `GET /v1/sessions?cwd=` | — | `[{id, mtime, preview}]` (via `Session.list`) |
| `GET /v1/sessions/:id` | — | `{id, cwd, permissionMode, messages}` (baseline history dari JSONL) |
| `POST /v1/sessions/:id/messages` | `{prompt: string}` | `202 {turnId}` — admission saja; hasil lewat stream mux. `409` bila turn sedang berjalan |
| `POST /v1/sessions/:id/approvals` | `{requestId, answer: 'yes'\|'no'\|'session'\|'all'}` | `200 {accepted: true}`; `404` bila requestId tidak pending (jawaban telat dibuang) |
| `POST /v1/sessions/:id/cancel` | — | `200 {cancelled: true}`; abort turn berjalan (AbortController) |

Error selamanya JSON `{error: {message}}` dengan status benar (400/401/403/404/409/413).
Body request dibatasi (1 MB; 413 bila lebih).

## 6. Streaming: WS mux `/v1/mux` (subset stream-protocol DSH)

Satu koneksi WS bersama memuat banyak logical stream. Frame JSON newline-free:

```ts
// uplink (client → host)
{ type: 'open',   streamId: string, target: string }   // target: 'session:<id>'
{ type: 'cancel', streamId: string }
// downlink (host → client)
{ type: 'item',  streamId: string, value: unknown }    // value pertama = {type:'ready',...}
{ type: 'end',   streamId: string }
{ type: 'error', streamId: string, message: string }
```

- `open session:<id>` → host memasang listener SEBELUM mengirim item `ready`
  (`{type:'ready', sessionId, host:{home, version}}`) — disiplin `$events` DSH:
  baseline read tidak bisa balapan dengan delivery incremental.
- Setelah `ready`, tiap `AgentEvent` turn berjalan dikirim sebagai item:
  `{type:'text'|'thinking'|'tool_use'|'tool_result'|'approval_request'|'usage'|'error', ...}`
  (bentuk sama dengan SdkEvent stream-json). Turn selesai ditandai item `result`
  (dengan `stopReason`) — BUKAN `end`; `end` hanya dikirim saat stream ditutup
  (client `cancel`, dispose, atau shutdown server).
- Stream sesi tetap terbuka lintas turn (client bisa biarkan terbuka; turn berikutnya
  mengalir di stream yang sama). `cancel` menutup stream (bukan turn; turn dibatalkan
  lewat unary `POST .../cancel`).
- **Heartbeat**: ping control frame tiap 2 detik; socket yang tidak membalas pong
  sebelum interval berikut di-terminate (koneksi, bukan per-stream).
- **Inbox bounded**: buffer uplink per koneksi maks 256 KB; overflow → `error` pada
  stream terkait TANPA menutup socket. Frame untuk streamId tidak dikenal/telah selesai
  di-drop; hanya `open` duplikat yang menghasilkan `error`.
- **Replay saat `open`**: notifikasi transient TIDAK di-replay (client re-read baseline
  `GET /v1/sessions/:id`); SATU-SATUNYA replay = `approval_request` yang masih pending
  untuk sesi itu (dikirim tepat setelah `ready`).

## 7. Sesi & concurrency

- Id sesi = nama file JSONL `Session` (tanpa ekstensi); pemetaan id→file via
  `Session.list(home, cwd)`. Sesi baru via `Session.create`.
- Instance `Agent` + history di memori per sesi; history dimuat dari JSONL saat
  attach pertama; `onMessage` meng-append ke JSONL seperti TUI.
- Satu turn in-flight per sesi; `POST messages` saat busy → `409`. Sesi berbeda
  berjalan paralel.
- `permissionMode` per sesi disimpan in-memory (tidak dipersist ke JSONL — default
  attach ulang = `ask`, fail-closed).
- Turn menerima AbortController sendiri; `cancel` → abort → item `result`
  `{stopReason:'aborted'}` pada stream sesi (stream tetap terbuka).

## 8. Approvals (pola `user-approval` DSH)

- Mode `ask` (default): `AskPermission` di-wire ke host serve → buat `requestId`
  (random), emit item `approval_request {requestId, tool, kind, target, preview?}`
  ke stream sesi, simpan promise pending di map.
- Jawaban via unary `POST .../approvals`; `answer` diteruskan apa adanya ke
  `PermissionAnswer` (`yes|no|session|all`); aturan `session`/`all` dipegang
  `Permissions` in-memory sesi itu (semantik sama dengan TUI).
- **Fail-closed**: cancel turn, disconnect tanpa jawaban, atau answerer hilang →
  promise diselesaikan `no`. Jawaban untuk requestId yang sudah selesai → `404`
  (sekali pakai, telat dibuang).
- Mode `bypassPermissions`: `AskPermission` auto-`yes` (untuk bot/CI; setara
  `--allow-all` CLI). Audit tetap lewat hooks `PreToolUse`/`PostToolUse` yang ada.

## 9. Testing

Unit (vitest, node:http port ephemeral, stub provider pola `req.onText?.()`,
client WS nyata dari dep `ws`):

1. Trust fence: Host salah / Origin cross / `sec-fetch-site: cross-site` → 403;
   token salah/hilang → 401; `/health` tanpa token → 200.
2. CRUD sesi: create→201, list, get baseline messages.
3. Turn happy path: `POST messages` → 202 {turnId}; stream mux menerima
   ready→text→result (stream tetap terbuka; `cancel` uplink → `end`); JSONL ter-append.
4. 409 busy: dua POST beruntun pada sesi sama.
5. Approvals: mode ask → item `approval_request`; POST jawaban `yes` → tool jalan;
   fail-closed (cancel turn → tool ditolak); jawaban telat → 404; replay pending
   saat `open` ulang.
6. `bypassPermissions`: tool berisiko jalan tanpa approval.
7. Mux: open streamId tak dikenal target → error; open duplikat → error; cancel
   menutup stream; inbox overflow → error tanpa putus socket; heartbeat terminate
   (fake timers / socket tanpa pong).
8. Resume: instance serve kedua (home/cwd sama) melampirkan sesi lama dari JSONL.
9. i18n: kunci HELP baru EN+ID (test i18n yang ada mengawal).

Live canary (model nyata gmi): `bccli serve` → script WS+fetch: health, create session,
prompt "sebutkan satu kata", verifikasi stream text/result, approval round-trip dengan
tool bash, cancel. Bukti disimpan di laporan.

Gate: `npx tsc --noEmit -p tsconfig.json`, `npm run lint` (0/0), `npm test` (2× stabil),
`npm run build`. Rilis tetap ditahan.

## 10. Deviasi sadar vs DSH

| Deviasi | Alasan |
|---|---|
| Bearer token, bukan launch-token→signed cookie | Konsumen = proses lokal, bukan browser |
| Tanpa seq-journal / gap-repair | Butuh infrastruktur journal; baseline re-read + replay approval pending sudah race-free untuk skala CLI |
| Tanpa uplink item bisnis (hanya kontrol) | Kebutuhan v1 = prompt (unary) + approval (unary); menjaga subset frame kecil |
| Tanpa codec/typert codegen | bccli single-package; tipe wire dijaga test, bukan generator |
| Notifikasi transient tidak di-replay | Keputusan eksplisit DSH juga (client re-read baseline) |

## 11. Deliverables

- `src/serveProtocol.ts` (framing murni + validasi frame), `src/serve.ts` (server,
  registry sesi, approvals), wiring `src/args.ts`/`src/cli.ts`/`src/i18n/id.ts`.
- `docs/serve-api.md`: kontrak API untuk konsumen (IDE ext, gh-bot, Switchboard).
- Test unit + live canary; HELP `bccli serve`.
