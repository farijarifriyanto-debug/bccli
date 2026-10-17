# Desain: `bccli mcp serve` - MCP server stdio BotConnector

Status: disetujui user (2026-10-07). Implementasi mengikuti TDD; spec ini
sumber kebenaran sebelum implementation plan.

## 1. Tujuan & non-tujuan

**Tujuan**

- Rilis pertama MCP server resmi BotConnector sebagai subcommand
  `bccli mcp serve` (stdio), supaya Claude Code / Cursor / opencode / Switchboard
  bisa memakai tools BotConnector tanpa memasang apa pun selain bccli.
- Menempatkan BotConnector sebagai penyedia tool developer, bukan hanya
  penyedia AI cloud (positioning produk).
- Tools rilis pertama: `bc_search`, `bc_fetch`, `bc_models`, `bc_chat`.

**Non-tujuan (fase lanjutan, bukan bagian spec ini)**

- Remote MCP over HTTP/SSE di `api.botconnector.id` (butuh auth OAuth/session
  di gateway). Stdio dulu; remote menyusul bila ada permintaan.
- Tool `usage`/`quota`: endpoint usage/quota untuk API key **belum ada**
  (diverifikasi 2026-10-07: tidak ada route di account-api maupun gateway).
  Menjadi fase 2 setelah endpoint backend tersedia.
- Paket npm standalone `@botconnector/mcp` (onboarding `npx` satu baris) —
  dirilis belakangan setelah `bccli mcp serve` terbukti dipakai.
- Fitur session server `bccli serve` (spec terpisah:
  `2026-10-07-serve-design.md`) — tidak tumpang tindih; jalurnya berbeda
  (`bccli serve` top-level vs `bccli mcp serve` subcommand).

## 2. Endpoint yang dipakai (sudah diverifikasi live, 2026-10-07)

| Endpoint | Method | Keterangan |
|---|---|---|
| `/v1/web/search` | POST | Live; auth Bearer; query 1-500 char; `max_results` di-server di-clamp 1..8; free 100/hari/akun lalu PAYG (kode 402) |
| `/v1/chat/completions` | POST | OpenAI-compatible; auth Bearer; non-streaming untuk tool ini |
| `https://botconnector.id/data/cloud-models.json` | GET | Katalog otoritatif (id, context, access, capabilities) untuk `bc_models`; harga dari `payg-pricing.json` (`tokenRates`, USD/1M) |

Base URL default: `https://api.botconnector.id/v1` (preset `bc-cloud` di
`src/presets.ts`).

## 3. Arsitektur

Modul baru di dalam repo bccli (bukan repo terpisah):

```
src/mcpServer/
  server.ts   — createMcpServer(deps): McpServer (SDK @modelcontextprotocol/sdk)
                + registrasi 4 tools. deps = { fetchFn, baseUrl, apiKey, defaultModel }
                (semua injectable → test tanpa jaringan).
  serve.ts    — runMcpServe(args): resolve auth + base URL, buat server,
                connect StdioServerTransport, hidup sampai stdin menutup.
```

- Dispatch: `src/mcpCli.ts` `runMcpCommand` mendapat aksi baru `serve`
  (bukan command top-level baru — `bccli serve` sudah milik session server).
- Pendekatan **A** (disetujui): SDK `McpServer` + `StdioServerTransport`,
  memakai dependency `@modelcontextprotocol/sdk` ^1.30.1 yang sudah ada
  (dipakai client `src/mcp/manager.ts`). Test memakai `InMemoryTransport`.

**Refactor minimal berbagi inti:** handler MCP **membungkus ulang pabrik tool
agent yang sudah ada** (`createWebSearchTool`, `createFetchTool`) — bukan
menyalin logic dan bukan memindahkan fungsi. Kontrak wajib: perilaku tool agent
TIDAK berubah sama sekali (tidak ada kode tool agent yang disentuh); test
vitest `test/tools/websearch.test.ts` & `test/tools/fetch.test.ts` tetap
patokan (regression guard).

## 4. Tools rilis pertama

Nama tool di-prefix `bc_` agar tidak bentrok dengan tool bawaan host
(Claude Code/opencode sudah punya `web_search` sendiri; MCP tool di-host
dapat prefix `mcp__<server>__`, tapi nama tetap dibedakan untuk kejelasan).

| Tool | Params | Respons | Annotations |
|---|---|---|---|
| `bc_search` | `query` (string, 1-500), `max_results` (int 1-8, default 6) | Numbered list `title/url/snippet` | readOnly |
| `bc_fetch` | `url` (string, http/https) | Teks halaman bersih (HTML di-strip), cap mengikuti tool `fetch` yang ada (12.000 char) | readOnly |
| `bc_models` | — | Daftar model: `context`/`access`/`capabilities` dari `cloud-models.json` + harga `tokenRates` (USD/1M token) dari `payg-pricing.json` (keduanya cache 1 jam/proses) | readOnly |
| `bc_chat` | `prompt` (string, wajib), `model` (string, opsional), `max_tokens` (int, default 1024, cap 4096) | Teks hasil + blok `usage` (prompt/completion tokens) | baca-tulis ringan: `readOnlyHint:false`, `destructiveHint:false` |

Kontrak respons:

- `bc_search`/`bc_fetch`/`bc_models` mengembalikan konten teks tunggal
  (`content: [{type:'text'}]`).
- `bc_chat` mengembalikan teks hasil; `usage` disertakan di teks akhir
  dalam format `[usage: X in / Y out]` supaya host yang tidak mendukung
  structured output tetap melihat biaya.
- Tool error → `isError: true` + pesan English satu baris (protocol-level,
  tidak di-i18n-kan), host yang menerjemahkan UI-nya.

## 5. Auth & konfigurasi

Urutan resolusi (pola `src/integrationCli.ts`, mekanisme baru tidak dibuat):

1. Flag CLI `--base-url <url>` → override base URL.
2. API key: `readCredentials(env)['bc-cloud']` (hasil `bccli login`).
3. Fallback: `env.BOTCONNECTOR_API_KEY`.
4. Kosong semua → `exit 1` + pesan yang sudah ada:
   `No BotConnector API key yet. Run bccli login bc-cloud first.`

Aturan keamanan:

- Key **tidak pernah** ditulis ke stdout (stdout = kanal protocol MCP);
  hanya dikirim sebagai header `Authorization: Bearer` ke API.
- Log hanya ke stderr; default senyap, `-v` menambah info.
- Default model `bc_chat` = `config.model` (default `bc-cloud/glm-5.3-flash`),
  bisa di-override per-call lewat param `model`.

## 6. Error & limit

- Timeout 30s per tool call (AbortSignal) — berlaku untuk `bc_search`,
  `bc_fetch`, dan `bc_chat`.
- `bc_fetch`: hanya `http:`/`https:`; tolak host private/loopback
  (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, [::1]) di
  handler MCP sebelum tool agent dipanggil — cegah SSRF karena URL datang
  dari agent/host eksternal. (Tool agent sendiri mengizinkan host lokal
  untuk pemakaian agent; guard ini khusus jalur MCP.)
- `bc_chat`: `max_tokens` di-cap 4096; error upstream (402 billing, 429, 5xx)
  diteruskan apa adanya sebagai pesan tool error.
- `bc_search`: gagal di kedua provider → pesan gabungan
  `BotConnector: <err>; Keenable: <err>` (pola sudah ada di
  `src/plugins/tools-web.ts` Switchboard dan inti bccli).
- Seluruh failure mode berupa `isError:true` (bukan exception yang mematikan
  server stdio).

## 7. CLI

```
bccli mcp serve [--base-url <url>]
```

- Help line baru di `src/args.ts` (HELP) **dan** terjemahannya di
  `src/i18n/id.ts` — `test/i18n.test.ts` menuntut keduanya (key EN + key ID).
- Saat start, tulis SATU baris info ke stderr (contoh:
  `mcp serve: 4 tools, base=https://api.botconnector.id/v1` tanpa key) —
  stderr bebas untuk protocol MCP. Tidak ada flag verbose baru (`-v` sudah
  dipakai `--version`).

## 8. Testing (TDD, vitest)

1. **Unit via `InMemoryTransport`** (SDK): connect client ↔ server;
   - `listTools` → tepat 4 tools, nama & schema sesuai bagian 4.
   - `callTool` per tool dengan `fetchFn` stub: kasus sukses, error upstream,
     validasi input (query >500, url private, max_tokens > cap).
2. **Regression guard refactor**: test vitest tool agent `websearch`/`fetch`
   yang sudah ada tetap hijau tanpa perubahan ekspektasi.
3. **Integrasi stdio**: spawn `node dist/cli.js mcp serve` dengan key stub →
   handshake `initialize` + `tools/list` via stdio nyata (dibangun dulu;
   skip otomatis bila `dist/` belum ada).
4. **Gates**: `npx tsc --noEmit`, `npm test`, `npx biome check src test`,
   build OK.

## 9. Deliverables

1. `src/mcpServer/server.ts` + `src/mcpServer/serve.ts` (baru).
2. Refactor inti `searchWeb`/`fetchPage` bersama (tool agent tak berubah).
3. Dispatch `serve` di `src/mcpCli.ts` + help `src/args.ts` + `src/i18n/id.ts`.
4. Test: `test/mcpServer.test.ts` (unit) + integrasi stdio.
5. Docs: baris README pada bagian MCP (cara pasang di Claude Code/opencode:
   `npx @botconnector/bccli mcp serve`).

## 10. Fase 2 (di luar spec ini, urutan sudah disetujui)

1. Endpoint usage/quota di backend (butuh nginx route + docs) → tool `bc_usage`.
2. Paket npm standalone `@botconnector/mcp` bila ada permintaan onboarding
   tanpa bccli.
3. Remote HTTP/SSE di `api.botconnector.id`.
