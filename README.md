# BCCLI

Agent AI coding dari BotConnector yang bekerja di terminal: membaca kode, mengedit file,
dan menjalankan perintah — dengan izin kamu.

```bash
npm i -g @botconnector/bccli    # butuh Node.js 22+
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

Di dalam sesi: `/help`, `/model`, `/clear`, `/compact`, `/cost`, `/exit`.
Shift+Tab ganti mode izin: `default` → `acceptEdits` → `plan` → `allowAll`.

Mode `-p` tidak pernah bertanya: alat yang butuh izin ditolak, kecuali memakai
`--allow-all` atau `--allowed-tools bash,edit,fetch`.

## Provider lain (OpenAI-compatible)

`~/.bccli/config.json`:

```json
{
  "model": "openrouter/qwen/qwen3-coder",
  "providers": {
    "openrouter": { "baseURL": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
    "local": { "baseURL": "http://127.0.0.1:11434/v1" }
  },
  "allow": ["bash(npm test)"]
}
```

`.bccli/config.json` di dalam project hanya boleh memilih `model` dan menambah provider baru tanpa API key —
izin (`permissionMode`, `allow`) dan provider yang sudah ada hanya diatur dari `~/.bccli/config.json`,
supaya repo yang kamu clone tidak bisa memberi dirinya izin penuh atau mencuri API key.

Instruksi project dibaca dari `AGENTS.md` dan `BCCLI.md`.

## Pengembangan

```bash
npm install
npm test && npm run typecheck && npm run lint && npm run build
```

CI (`ci.yml`) menjalankan hal yang sama di Linux, macOS, dan Windows.
Rilis: naikkan `version` di `package.json`, lalu push tag `v<version>` — `release.yml`
menjalankan test, smoke test ke BotConnector Cloud, dan `npm publish --provenance`.
