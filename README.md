# BCCLI

Agent AI coding dari BotConnector yang bekerja di terminal: membaca kode, mengedit file,
dan menjalankan perintah — dengan izin kamu.

```bash
npm i -g @botconnector/bccli@next    # v0.2 beta, butuh Node.js 22+
bccli login                     # simpan API key BotConnector Cloud
cd project-kamu && bccli
```

## Pemakaian

| Perintah | Fungsi |
|---|---|
| `bccli` | mode interaktif |
| `bccli -p "tugas"` | satu tugas tanpa interaksi (skrip/CI) |
| `bccli -c` / `bccli -r` | lanjutkan sesi terakhir / pilih sesi |
| `bccli -m provider/model` | pilih model |
| `bccli models` | daftar model |

Perintah di dalam sesi (ketik `/` untuk saran, ↑↓ pilih, Enter jalankan):

| Perintah | Fungsi |
|---|---|
| `/help` | daftar perintah dan pintasan |
| `/model` | ganti model |
| `/provider` | tambah/pilih provider AI |
| `/mcp` | pasang/kelola server MCP |
| `/new` | sesi baru (sesi lama tetap tersimpan) |
| `/resume` | lanjutkan sesi lain di folder ini |
| `/session` | info sesi ini |
| `/status` | versi, model, mode izin, MCP, konteks |
| `/permissions` | lihat/cabut izin |
| `/undo` | batalkan edit file giliran terakhir |
| `/diff` | git diff project |
| `/copy` | salin jawaban terakhir |
| `/export` | simpan percakapan ke markdown |
| `/memory` | instruksi project (/memory <teks>, /memory global <teks>) |
| `/init` | buat/perbarui AGENTS.md untuk project ini |
| `/agents` | daftar subagent |
| `/skills` | daftar skill dan perintah custom |
| `/doctor` | cek kesehatan instalasi |
| `/login` | simpan API key provider aktif |
| `/logout` | hapus API key provider aktif |
| `/clear` | mulai percakapan baru |
| `/compact` | ringkas percakapan |
| `/cost` | pemakaian token sesi ini |
| `/exit` | keluar |

`/undo` hanya membatalkan perubahan lewat alat edit/tulis (bukan perintah bash), per giliran, sampai 20 giliran ke belakang.
Shift+Tab ganti mode izin: `default` → `acceptEdits` → `plan` → `allowAll`.

Mode `-p` tidak pernah bertanya: alat yang butuh izin ditolak, kecuali memakai
`--allow-all` atau `--allowed-tools bash,edit,fetch`.

## Provider

`/provider` di dalam sesi (atau `bccli provider add <id>`) memasang provider hanya dengan API key:

| Id | Provider |
|---|---|
| `bc-cloud` | BotConnector Cloud (default) |
| `openrouter` | OpenRouter |
| `openai` | OpenAI |
| `gemini` | Google Gemini |
| `deepseek` | DeepSeek |
| `groq` | Groq |
| `ollama-cloud` | Ollama Cloud |
| `ollama` | Ollama lokal (tanpa key) |
| `lmstudio` | LM Studio lokal (tanpa key) |

Provider lain yang OpenAI-compatible: pilih **Custom…** di `/provider`, atau
`bccli provider add corp --url https://corp.example/v1 --name "Corp"`.

`/model` menampilkan model dari **semua** provider yang sudah punya key, dikelompokkan
per provider; ketik untuk menyaring. Pilihan tersimpan sebagai default.

`.bccli/config.json` di dalam project hanya boleh memilih `model` dan menambah provider baru tanpa API key —
izin (`permissionMode`, `allow`) dan provider yang sudah ada hanya diatur dari `~/.bccli/config.json`,
supaya repo yang kamu clone tidak bisa memberi dirinya izin penuh atau mencuri API key.

## Internet

- `web_search`: mencari di web tanpa perlu izin. Memakai akun BotConnector Cloud
  bila ada key, kalau tidak langsung ke Keenable (gratis, tanpa key). Hasilnya
  judul, URL, dan cuplikan singkat, jadi hemat token.
- `fetch`: membuka satu URL dari komputer ini (butuh izin per host).

## MCP

`/mcp` (atau `bccli mcp add <nama>`) memasang server dari katalog:
`playwright`, `context7`, `fetch`, `filesystem`, `git`, `github`. Server remote lain:
`bccli mcp add nama --url https://…`. Tersimpan di `~/.bccli/mcp.json` (format `mcpServers`
seperti Claude Code). Semua alat MCP selalu minta izin.

`.bccli/mcp.json` di dalam repo tidak dijalankan sebelum kamu setujui (ditanya sekali per folder).

## Subagent

Agent bisa mendelegasikan pekerjaan lewat alat `task`:
- `explore` — hanya baca & cari, bisa jalan paralel;
- `general` — semua alat (edit/perintah tetap minta izin);
- custom — `.bccli/agents/nama.md` atau `.claude/agents/nama.md`:

```markdown
---
name: reviewer
description: review perubahan kode
tools: [read, grep, glob]
model: openrouter/qwen/qwen3-coder
---
Kamu reviewer kode. Laporkan bug nyata saja.
```

## Skill & perintah custom

- Skill: folder berisi `SKILL.md` di `~/.bccli/skills/`, `.bccli/skills/`, `~/.claude/skills/`,
  `.claude/skills/` — dipakai agent otomatis bila cocok, atau `/nama-skill`.
- Perintah: `commands/nama.md` di folder yang sama → `/nama argumen` (`$ARGUMENTS` diganti argumen).

## Todo & mode plan

Tugas ≥ 3 langkah menampilkan checklist di atas kotak input. Di mode plan (Shift+Tab),
agent hanya membaca lalu mengajukan rencana; `[a]` setujui dengan edit otomatis,
`[y]` setujui dengan tanya tiap langkah, `[n]` minta perbaikan.

Instruksi project dibaca dari `AGENTS.md` dan `BCCLI.md`.

## Pengembangan

```bash
npm install
npm test && npm run typecheck && npm run lint && npm run build
```

CI (`ci.yml`) menjalankan hal yang sama di Linux, macOS, dan Windows.
Rilis: naikkan `version` di `package.json`, lalu push tag `v<version>` — `release.yml`
menjalankan test, smoke test ke BotConnector Cloud, dan `npm publish --provenance`.
