# `bccli gh-bot` — GitHub Comment Bot API

Bot komentar GitHub **off-by-default** untuk `bccli`. Loopback-only di belakang TLS
reverse proxy; HMAC diverifikasi atas byte mentah sebelum UTF-8/parse. Kontrak desain
lengkap: `docs/superpowers/specs/2026-10-08-gh-bot-design.md`.

## Menjalankan

```bash
export GITHUB_WEBHOOK_SECRET='<secret>'
bccli gh-bot serve --port 18790        # default 18790, host 127.0.0.1
```

Banner (tanpa nilai secret): `bccli gh-bot listening on http://127.0.0.1:18790/github`
+ `enabled=… secret=detected|missing`. `enabled:false` → semua route **404**;
`enabled:true` tanpa secret → start ditolak fail-loud (pesan memuat nama env, bukan
nilai). Ctrl+C/SIGTERM → stop terima request → tutup hub → ringkasan
`aborted/confirmed/unconfirmed`.

## Konfigurasi (`~/.bccli/config.json`, global)

```jsonc
"githubBot": {
  "enabled": false,                    // default OFF — wajib true utk menerima webhook
  "path": "/github",                   // route eksak
  "secretEnv": "GITHUB_WEBHOOK_SECRET", // aksesor PER-REQUEST (rotasi tanpa restart)
  "repos": ["owner/name"],             // allowlist repo (kosong = tak ada yang diproses)
  "users": ["login"],                  // allowlist penulis (signature ≠ izin penulis)
  "maxBodyBytes": 1048576,
  "maxActive": 1,                      // concurrency agent
  "maxQueue": 10,                      // penuh → 503 (drop; tanpa retry otomatis)
  "stepLimit": 8,
  "timeoutMs": 120000                  // SATU deadline: collect → draft → post
}
```

## Setup webhook GitHub (di sisi GitHub)

1. Repository → Settings → Webhooks → Add webhook.
2. Payload URL: `https://<domain-publik>/github` (reverse proxy TLS → `127.0.0.1:18790/github`).
3. Content type: **application/json** (x-www-form-urlencoded → 415).
4. Secret: nilai env `GITHUB_WEBHOOK_SECRET` yang sama.
5. Events: **Only the comment events** (Issue comments).

## Kontrak HTTP

Hanya `POST application/json`; body byte-bounded (`maxBodyBytes`).

| Status | Kondisi |
|---|---|
| 202 | Terverifikasi + diterima (queued / duplikat / inflight — idempoten) |
| 400 | Header wajib hilang / UTF-8 fatal / JSON invalid / bukan objek / field event hilang |
| 401 | Signature HMAC invalid |
| 405 | Bukan POST |
| 413 | Body > `maxBodyBytes` |
| 415 | Bukan `application/json` |
| 503 | Secret tak tersedia / antrian penuh / server menutup |
| 404 | Route nonaktif (`enabled:false`) atau path salah |

Verifikasi: `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, **byte mentah**) —
SEBELUM decode UTF-8 fatal dan `JSON.parse`. Header wajib `X-Hub-Delivery`,
`X-Hub-Event`. Filter: `issue_comment` + `action=created`, bukan Bot, allowlist
repo+user, komentar diawali `/bccli <task>` (task kosong = abaikan). Dedup per
`X-GitHub-Delivery` (in-memory).

## Pemulihan manual (TANPA retry otomatis)

**bccli tidak pernah retry.** 503 (`queue full`) = delivery DIBUANG — pulihkan dari
GitHub: Settings → Webhooks → **Recent Deliveries → Redeliver**. Job yang gagal TIDAK
masuk dedup completed → delivery-id sama bisa diproses ulang; `full` juga tidak
menyimpan dedup. Antrian penuh saat ada aktivitas = kurangi `maxActive`/`maxQueue` atau
naikkan `timeoutMs`.

## Perilaku agent

- Konteks di-pra-kumpulkan via `gh` CLI **dengan `--repo`** (issue/pr view, pr diff
  dipotong 60/40 ≤100KB); komentar asli ≤8KB byte; semua data dalam blok
  `<untrusted-github>` (instruksi di dalamnya = DATA, bukan perintah).
- Agent berjalan **TANPA TOOL** (`setTools([])`), satu deadline (`timeoutMs`) melewati
  collect→draft→post; `stepLimit` membatasi langkah.
- Hanya `stopReason: done` + teks non-kosong yang dipost: `gh api --method POST
  --input - repos/<repo>/issues/<n>/comments` (JSON body via stdin, tanpa shell).
- Hard-timeout subprocess → marker `<child did not close after termination>` →
  reason `termination-unconfirmed` (TERKONFIRMASI hanya setelah child `close`);
  ringkasan `close()` melaporkan `UNCONFIRMED n (child may still be running)`.

## Keterbatasan

- Dedup & antrian in-memory (hilang restart; queue persisten/retry ditunda).
- `gh` CLI = prasyarat runtime (start mengecek fail-loud).
- TLS/Host publik = konfigurasi reverse proxy di luar bccli.
- Inline review comments (`pull_request_review_comment`) belum diproses.
