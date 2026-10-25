# Konfigurasi BCCLI

BCCLI membaca dua file konfigurasi:

| File | Cakupan |
|---|---|
| `~/.bccli/config.json` | **Global** — seluruh kunci di bawah ini hanya dibaca dari sini. Lokasi `~/.bccli` bisa dipindah dengan env `BCCLI_HOME`. |
| `<project>/.bccli/config.json` | **Project** — tidak dipercaya: hanya `model` dan provider baru **tanpa** `apiKeyEnv` yang dibaca; kunci lain diabaikan. |

Pembatasan itu disengaja: repo yang kamu clone (misalnya saat BCCLI dipakai untuk review PR) tidak boleh bisa memberi dirinya izin penuh, memuat plugin/hook, atau mencuri API key.

## Daftar kunci (global)

| Kunci | Nilai | Default | Keterangan |
|---|---|---|---|
| `model` | `"provider/model"` | `"bc-cloud/glm-5.3-flash"` | Boleh juga diisi dari config project. |
| `providers` | `{ "<id>": { "baseURL": "https://…", "apiKeyEnv": "NAMA_ENV" } }` | preset bawaan | `apiKeyEnv` opsional. Kunci API disimpan `bccli login` di `~/.bccli/credentials` (mode 600). Config project hanya boleh menambah provider baru tanpa kunci. |
| `permissionMode` | `"default"` \| `"acceptEdits"` \| `"plan"` \| `"allowAll"` | `"default"` | `plan` menolak semua selain baca; `allowAll` tanpa tanya. Opsi lain: Shift+Tab di dalam sesi. |
| `allow` | daftar rule izin (lihat bagian Izin) | `[]` | |
| `reasoning` | `"auto"` \| `"off"` \| `"low"` \| `"medium"` \| `"high"` \| `"max"` | `"auto"` | `auto` tidak mengirim override apa pun ke provider. |
| `language` | `"en"` \| `"id"` | `"en"` | Presedensi: `--lang` → `BCCLI_LANG` → kunci ini → `en`. |
| — (env) | `BCCLI_HTTP_IDLE_TIMEOUT_MS` | `60000` | Batas diam tanpa byte masuk untuk satu permintaan HTTP: fase header dan saat membaca stream. Lewat batas ini permintaan dibatalkan dengan pesan jelas, bukan menggantung. |
| `vision` | `true` \| `false` | `true` | Lampirkan gambar dari disk sebagai part vision. |
| `networkPolicy` | `"allow"` \| `"offline"` | `"allow"` | `offline` memblokir perintah internet yang dikenal di tool bash. |
| `maxSteps` | angka > 0 (langkah per giliran) | `null` | `null`/`0` = tanpa batas (BCCLI berhenti saat model berhenti atau Esc). |
| `sessionRetentionDays` | angka > 0 (hari) | `null` | `null`/`0` = sesi disimpan sampai kamu hapus sendiri. |
| `thinkingVisible` | `true` \| `false` | `false` | Tampilkan ringkasan reasoning dari provider. |
| `thinkingClickCollapse` | `true` \| `false` | `false` | Klik blok Thinking untuk expand/collapse (butuh mouse reporting terminal; `ctrl+t` tetap jalan). |
| `updateCheck` | `"on"` \| `"off"` | `"on"` | Cek harian ke registry npm + pemberitahuan versi baru. |
| `hooks` | `{ "PreToolUse" \| "PostToolUse" \| "SessionStart" \| "Stop": [{ "match": "*", "command": "…" }] }` | — | `match` = glob nama tool (omitted = semua tool, event tool saja). `PreToolUse` bisa memblokir tool call. |
| `plugins` | array spec modul JS | `[]` | Dimuat saat boot. |
| `keybinds` | `{ "thinking": "ctrl+t", "toolOutput": "ctrl+o", "pasteImage": "alt+v" }` | nilai contoh di kiri | Format: `ctrl`/`alt` + satu huruf. |
| `verifyCommands` | array perintah shell | `[]` | Dijalankan setelah giliran yang mengubah file (gaya `aider --test-cmd`). |
| `repoMap` | `true` \| `false` | `false` | Sertakan peta repo (file + simbol top-level) di system prompt. |
| `theme` | `"default"` \| `"blue"` \| `"amber"` \| `"magenta"` \| `"mono"` | `"default"` | |
| `editor` | `"emacs"` \| `"vim"` | `"emacs"` | Gaya pengeditan prompt. |
| `sandbox` | `"off"` \| `"on"` | `"off"` | Jalankan bash di sandbox OS (macOS `sandbox-exec` / Linux `bwrap`). |
| `lsp` | `{ "servers": [{ "extensions": [".ts"], "command": "typescript-language-server", "args": ["--stdio"] }] }` | — | Dipakai tool diagnostics. |
| `usageCap` | `{ "tokens": 2000000, "usd": 5, "prices": { "glm": { "input": 0.1, "output": 0.3, "cachedInput": 0.02 } } }` | - | Setidaknya satu dari `tokens`/`usd`. `usd` butuh `prices` (USD per 1 juta token; kunci = substring ref model, **match pertama menang — tulis kunci paling spesifik lebih dulu**). `cachedInput` opsional untuk token cache; tanpa itu token cache dihitung dengan harga `input`. Model yang tidak cocok dengan kunci mana pun tidak dihitung, jadi batas `usd` tidak menegang — pakai `tokens` bila butuh pagar pasti. Agen berhenti memanggil model setelah lewat batas. |

## Izin: kunci `allow`

Rule berupa string; bentuk yang dikenal:

| Rule | Arti |
|---|---|
| `"bash"`, `"edit"`, `"fetch"`, `"mcp"` | grant menyeluruh untuk jenis itu — pakai sadar risikonya |
| `"bash(npm test)"` | satu perintah. Runner (npm, pnpm, node, python, uv, make, cargo, go, …) memakai kata kunci + skrip/entry point: `bash(npm run build)` tidak mencakup `npm run deploy` |
| `"edit(project)"` | edit/write file di dalam folder project |
| `"fetch(example.com)"` | fetch satu host |
| `"mcp(tool-name)"` | satu tool MCP |

Catatan:

- Pembacaan file rahasia (`.env`, kunci SSH, `~/.bccli/credentials`, …) **tidak pernah** bisa di-grant: selalu ditanya di mode apa pun kecuali `allowAll`.
- Perintah yang menyembunyikan efek (substitusi `` ` ``, `$( )`, redirection, subshell) dan perintah wajib-tanya (`sudo`, `sh`, `bash`, `zsh`, `su`) tidak bisa di-grant per sesi.
- Env `BC_TOOL_POLICY_ENFORCE=true` membuat semua tindakan sensitif selalu ditanya (hardening opsional).
- Grant sementara untuk satu jalan: `bccli --allowed-tools "bash(npm test)"`.

## Contoh

```json
{
  "model": "bc-cloud/glm-5.3-flash",
  "permissionMode": "acceptEdits",
  "reasoning": "medium",
  "language": "id",
  "theme": "blue",
  "allow": ["bash(npm test)", "edit(project)"],
  "usageCap": { "usd": 5, "prices": { "glm": { "input": 0.1, "output": 0.3 } } }
}
```
