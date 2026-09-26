# BCCLI v0.2 — Rewrite dari nol (desain)

Tanggal: 2026-09-27 · Status: menunggu review

## Latar belakang

BCCLI `0.1.0-beta.1` (`@botconnector/bccli`, repo `BotConnector-CLI`) adalah fork
penuh opencode: 345 MB, puluhan paket, 30 workflow, TUI layar penuh. Tujuan
rewrite ini: CLI milik sendiri yang kecil dan bersih, dengan bentuk dan perilaku
seperti Claude Code / Codex CLI / agy — percakapan mengalir di terminal biasa.

Seluruh build, test, dan rilis berjalan di GitHub Actions. Tidak ada build di VPS.

## Keputusan yang sudah disepakati

| Topik | Keputusan |
|---|---|
| Bentuk | Inline di terminal (bukan layar penuh), seperti Claude Code |
| Provider | Semua OpenAI-compatible; BotConnector Cloud default |
| Hubungan dengan BCCLI lama | Pengganti penuh: paket `@botconnector/bccli`, perintah `bccli`, versi `0.2.0-beta.1`; repo lama diarsipkan setelah rilis dicoba |
| Stack | TypeScript + Ink di Node.js ≥ 22 (Ink 7 butuh Node 22; Node 20 sudah EOL April 2026) |
| Repo | `farijarifriyanto-debug/bccli`, public (Actions tanpa limit, npm provenance) |

## Lingkup v0.2.0-beta.1

Masuk:
- `bccli` (interaktif) dan `bccli -p "tugas"` (non-interaktif, untuk skrip/CI).
- 7 alat: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `fetch`.
- Izin sebelum menulis/mengedit/menjalankan dan sebelum `fetch` (akses internet bisa dipakai membocorkan data); baca & cari file bebas.
- Mode izin: `default`, `acceptEdits`, `plan`, `allowAll`.
- Provider OpenAI-compatible lewat config; `bc-cloud` bawaan.
- Instruksi project dari `AGENTS.md` / `BCCLI.md`.
- Sesi tersimpan, `--continue`, `--resume`.
- Slash command: `/help`, `/model`, `/clear`, `/compact`, `/cost`, `/exit`.
- `bccli login` untuk menyimpan API key.

Ditunda: MCP, subagent, hooks, plugin, skill, gambar/lampiran, mode lokal khusus
BotConnector Local (tetap bisa via URL OpenAI-compatible), web UI, desktop.

Kriteria berhasil:
1. Dari folder project mana pun, `bccli` bisa diminta "perbaiki bug X": membaca
   kode, mengusulkan edit (dengan diff), menunggu izin, menjalankan test, melapor.
2. `npm i -g @botconnector/bccli` berfungsi di Linux, macOS, Windows (Node.js ≥ 22).
3. CI dan rilis sepenuhnya di GitHub Actions.

## Arsitektur

```
src/
  cli.ts          argumen: interaktif vs -p, --continue, --resume, --model, --allow-all, --allowed-tools
  config.ts       ~/.bccli/config.json + .bccli/config.json + env
  provider.ts     klien OpenAI-compatible (fetch bawaan Node + parser SSE): chat streaming + tool calls
  agent.ts        loop agent; memancarkan event, tidak tahu soal UI
  tools/          satu file per alat: { name, schema (zod), needsPermission, run }
  permissions.ts  mode izin + aturan allow (sesi & permanen)
  context.ts      system prompt + AGENTS.md/BCCLI.md + info folder/git
  session.ts      ~/.bccli/sessions/<project>/<id>.jsonl
  ui/             komponen Ink: transcript, input, prompt izin, diff, status bar
```

Batas antar modul:
- `agent.ts` memancarkan event (`text`, `toolCall`, `permissionRequest`,
  `toolResult`, `done`, `error`). UI interaktif dan mode `-p` sama-sama
  mendengarkan event yang sama → satu loop, dua tampilan, loop bisa dites tanpa terminal.
- `provider.ts` satu-satunya yang bicara ke API.
- Alat baru = satu file baru di `tools/`.

Dependensi: `ink`, `react`, `zod`, `fast-glob`, `diff`. Tanpa SDK `openai`: protokolnya stabil dan cukup ditulis dengan `fetch`. Grep memakai
`rg` bila tersedia, fallback ke pencarian JS.

## Loop agent

1. Pesan user → riwayat → dikirim ke model (streaming) beserta definisi alat.
2. Tiap tool call: cek izin → jalankan → hasil dikembalikan ke model.
3. Ulangi sampai model menjawab tanpa tool call; batas 50 langkah per giliran,
   lalu berhenti dan tanya user.
4. Esc membatalkan giliran, termasuk proses bash yang berjalan.

Alat:
- `read`: maks 2000 baris, bernomor; tolak file biner.
- `write` / `edit`: `edit` = ganti teks persis; gagal bila tidak ditemukan atau
  tidak unik; file wajib sudah dibaca di sesi ini sebelum diedit.
- `bash`: timeout default 2 menit, output dipotong, cwd di project.
- `grep` / `glob`: mengikuti `.gitignore`.
- `fetch`: ambil URL, HTML → teks.

Izin:
- Prompt: `[y] ya · [a] ya untuk sesi ini · [n] tidak`; edit menampilkan diff.
- "Ya untuk sesi ini": bash per nama perintah (mis. `bash(npm test)`), edit/write per jenis.
- Penolakan dikirim ke model sebagai hasil alat ("user menolak").
- `plan`: alat tulis & bash otomatis ditolak. `allowAll`: tidak pernah tanya.
- Mode `-p`: alat yang butuh izin ditolak kecuali `--allow-all` atau `--allowed-tools`.
- Shift+Tab: default → acceptEdits → plan → allowAll → default.

Error:
- API 429/5xx/jaringan: retry 3× dengan backoff, lalu pesan jelas.
- Error alat dikirim ke model sebagai hasil, tidak membuat CLI crash.
- Model tanpa dukungan tool calling: saat provider menolak (400 soal tools), pesan error menyarankan ganti model lewat `/model`.
- Konteks hampir penuh: ringkas otomatis (seperti `/compact`) dan beri tahu user.

## Tampilan

```
 ✻ BCCLI 0.2.0 · glm-5.3 (BotConnector Cloud) · ~/project

> perbaiki test yang gagal di auth

● Saya cek dulu test-nya.
  ⎿ Bash  npm test -- auth
     FAIL src/auth.test.ts  ✗ token expired
     … 42 baris lagi (ctrl+o)
  ⎿ Edit  src/auth.ts
     41 -  if (expiresAt > now) throw new Expired()
     41 +  if (expiresAt < now) throw new Expired()
 ╭─ Izinkan edit src/auth.ts? ─ [y] ya  [a] ya sesi ini  [n] tidak ╮
 ╭─ > ─────────────────────────────────────────────────────────────╮
  ⏵ default · shift+tab ganti mode · 12k token · esc batal
```

- Tidak layar penuh; riwayat tetap di scrollback terminal setelah keluar.
- Jawaban streaming dengan markdown sederhana.
- Alat tampil ringkas `⎿ Nama target`; output panjang dipotong, ctrl+o untuk lengkap.
- Diff berwarna dengan nomor baris.
- Input: multi-baris (`\` + enter; Ink tidak bisa mendeteksi shift+enter di semua terminal), riwayat panah atas/bawah, saran `/` dan `@file`.
- Status bar: mode, token, pintasan. `allowAll` = status bar merah `⏵⏵ allow all`.
- Spinner dengan waktu berjalan. Satu warna aksen (hijau BotConnector); hormati `NO_COLOR`.

## Config, provider, sesi

`~/.bccli/config.json` (ditimpa per project oleh `.bccli/config.json`):

```json
{
  "model": "bc-cloud/glm-5.3-flash",
  "permissionMode": "default",
  "providers": {
    "bc-cloud":   { "baseURL": "https://api.botconnector.id/v1", "apiKeyEnv": "BOTCONNECTOR_API_KEY" },
    "openrouter": { "baseURL": "https://openrouter.ai/api/v1",   "apiKeyEnv": "OPENROUTER_API_KEY" },
    "local":      { "baseURL": "http://127.0.0.1:11434/v1" }
  },
  "allow": ["bash(npm test)", "edit"]
}
```

- Model ditulis `provider/model`. `bc-cloud` bawaan.
- Config menyimpan nama env var, bukan key. `bccli login` menyimpan key di
  `~/.bccli/credentials` (mode 600); env var mengalahkan file.
- `/model` mengambil daftar dari `GET /v1/models` provider.
- Sesi: `~/.bccli/sessions/<project>/<id>.jsonl`, satu baris per event (tahan crash);
  dibersihkan otomatis setelah 30 hari.
- Instruksi: `AGENTS.md` dan `BCCLI.md` di folder project dan induknya, plus `~/.bccli/BCCLI.md`.

## Test

Vitest:
- Alat: di folder sementara (read, edit termasuk kasus tidak unik, bash timeout &
  batal, glob, grep).
- Loop agent: provider palsu dengan skenario tool call terskrip — izin, penolakan,
  batas langkah, retry, ringkasan konteks. Tanpa API sungguhan.
- UI: `ink-testing-library` — prompt izin, diff, status bar per mode.
- Smoke sungguhan: `bccli -p` ke BotConnector Cloud dengan secret GitHub, hanya saat rilis.

## GitHub Actions

- `ci.yml` (PR & push): typecheck, lint, test, build — Linux, macOS, Windows.
- `release.yml` (tag `v*`): build, smoke Cloud, `npm publish --provenance` ke
  `@botconnector/bccli` via OIDC trusted publishing, GitHub Release.
- Pengembangan: kode di-push ke branch; hasil dibaca dari Actions. Tidak ada
  `npm install` atau build di VPS.

## Migrasi

- Rilis `0.2.0-beta.1` di tag npm `beta`; `0.1.0-beta.1` tetap ada.
- Setelah user mencoba rilis baru: arsipkan `BotConnector-CLI` (read-only, tidak dihapus).
- Trusted publishing npm untuk `@botconnector/bccli` perlu ditambahkan untuk repo
  `bccli` (langkah manual di npmjs.com oleh pemilik paket).
