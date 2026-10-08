# gh-bot Canary Runbook (PERSIAPAN — eksekusi MENUNGGU izin eksplisit)

Status audit awal: tree bersih, `a24c4d9..53081c1` = **7 commit** (docs + 6 kode).
Prasyarat terverifikasi lokal: `gh --version` exit 0, `gh auth status` exit 0 (body tak
dicetak), `GITHUB_WEBHOOK_SECRET` **belum** di-set (False), prosedur redelivery terdokok
di `docs/gh-bot-api.md`. **Port default 18790 DIPAKAI SSH SOCKS forward VPS** → canary
memakai **`--port 18799`** (terverifikasi bebas). Banner enabled+secret sudah lolos
probe lokal (`enabled=true secret=detected`, gh nyata).

Aturan: tanpa tunnel/webhook/komentar/push/publish/deploy sebelum target repo+PR dari
user dan izin eksplisit. Secret TIDAK PERNAH dicetak — semua cek log memakai mode
boolean (`Select-String -Quiet` → True/False).

## Fase A — lokal loopback (TANPA GitHub; tetap butuh izin canary)

> **HASIL EKSEKUSI (2026-10-08): 17/17 PASS** — harness in-process `ghb-canary-a.ts`
> (dihapus setelah run). Ringkasan nilai: S0 real `gh --version` code=0; A1 valid→202 +
> `issues=1 posts=0` (accepted ≠ done); A11 duplikat inflight → collect tetap 1×;
> A9 antrean penuh **deterministik** `d2=202 d3=503` (maxQueue=1 + gate hang);
> A1c rilis → 2 post; V2 redelivery → collect/post identik (completed-LRU);
> A8 payload PR → `pr view`+`pr diff` semua `--repo`; matriks `401/400/405/415/413`
> + corrupt-signed→400 + alive=202; V3 timeout draft → `draftLog=1`, post identik;
> V4 close job aktif → `{"aborted":1,"terminationConfirmed":1,"terminationUnconfirmed":0}`
> tanpa baris UNCONFIRMED; V4b `unconfirmed=0`; V4d marker → `unconfirmed=1` + baris
> `UNCONFIRMED … (child may still be running)`; V5 `secret=false sig=false payload=false`;
> V6 port 18799 free, `ghb-*`=0, proses=0. Bug harness (baseline race post-A8 → guard
> `A8b`; duplikat deklarasi; gate sekali-pakai) diperbaiki inline — **tanpa bug produk**.

### A+ — Canary CLI sebagai SUBPROSES NYATA + SIGINT ConPTY (HASIL: PASS)

Mekanisme Windows: driver ConPTY (pywinpty) menulis byte `Ctrl+C` (`<CTRL_C>`) ke
pseudo-console → Node menerima **SIGINT nyata** → jalur `ghBotCli` (bukan `hub.close()`
langsung). `taskkill` TIDAK dipakai (tanpa SIGINT graceful); `os.kill(pid,0)` di
Windows = membunuh (dilarang utk cek proses — pakai `Get-Process`/OpenProcess).

- Fixture `gh.exe` = **salinan `node.exe`** + skrip tanpa-ekstensi di cwd (`issue`
  menulis marker+PID lalu hang; `pr` → JSON/diff; `api` → append argv ke `api.log`);
  CLI di-spawn dgn `cwd=fixture` + `PATH` fixture-di-depan → `spawn('gh')` menemukan
  fixture; `--version` di-resolve Node sendiri (probe startGhBot code0 ✓).
- Steps: banner `listening` → POST webhook **HMAC lokal** (python `hmac` identik dgn
  `signBody`) → **202** → `issue.started` muncul (**job aktif/hold di collect**) →
  `<CTRL_C>` → `until "gh-bot stopped"`.
- **Hasil**: banner hit; **202**; marker hit; ringkasan tercetak
  **`gh-bot stopped — aborted=1 confirmed=1 unconfirmed=0`** (tanpa baris UNCONFIRMED);
  `aliveAtEnd=false` (**CLI keluar sendiri**, bukan force); **anak fixture PID mati**;
  **`api.log` tidak ada** (job batal SEBELUM post — tanpa kerja parsial); **port 18805
  bebas**; sandbox + fixture dihapus; driver dihapus.
- Insiden: variabel PowerShell `$home` (read-only) sempat mengarahkan config canary ke
  `C:\Users\farij\config.json` → **terdeteksi & dihapus** (isinya murni cfg canary;
  tanpa kerusakan lain); pesan: pakai `$hb`, jangan `$home`.
- **Kesimpulan**: jalur SIGINT Windows TERUJI via ConPTY (bukan pengganti
  `hub.close()` — ringkasan dicetak oleh handler SIGINT proses CLI nyata). Verifikasi
  lokal **DIHENTIKAN** setelah ini; Fase B tetap ditahan.

Setup (sandbox `BCCLI_HOME` tmp, secret dummy proses, port 18799):

```powershell
$sb="$env:TEMP\bccli-ghb-canary"; New-Item -ItemType Directory $sb -Force|Out-Null
# config.json: {"githubBot":{"enabled":true,"repos":["OWNER/REPO"],"users":["USER"],"timeoutMs":1500,"maxQueue":1}}
$env:BCCLI_HOME=$sb; $env:BCCLI_LANG='en'; $env:GITHUB_WEBHOOK_SECRET='<dummy-proses>'
node dist\cli.js gh-bot serve --port 18799 *> "$sb\server.log"
```

Payload ditandatangani dgn skrip HMAC identik (`sha256` hex, prefix `sha256=`) atas
byte mentah — helper node satu-baris, secret dari env (tidak dicetak).

| # | Uji | Aksi | Hasil yang diharapkan |
|---|---|---|---|
| A1 | Signature valid | POST `/github`, sig benar, delivery `canary-1`, body `/bccli halo` | **202**; log memuat `collect failed` utk repo dummy (job jalan, gh tak kenal repo) |
| A2 | Signature invalid | sig `sha256=00…` | **401**; `Select-String -Quiet 'collect failed'` tetap False-tambahan (tak ada kerja baru) |
| A3 | Header hilang | tanpa `x-hub-delivery` | **400** |
| A4 | Method GET | GET `/github` | **405** |
| A5 | Content-type | `text/plain` | **415** |
| A6 | Body > max | > `maxBodyBytes` | **413**; server tetap hidup (POST ulang → 202/401) |
| A7 | JSON corrupt ber-signature-valid | `{corrupt` + sig atas byte itu | **400** (bukan 401 — membuktikan HMAC sebelum parse) |
| A8 | Event PR (payload `pull_request`) | `X-Hub-Event: issue_comment` + field `pull_request` + `/bccli halo` | **202**; log `collect failed (OWNER/REPO#n)` — jalur `isPR` → `gh pr view/diff` terpanggil (repo dummy → exit≠0) |
| A9 | Antrean penuh (503) | 10 POST **paralel** dgn `maxQueue:1,maxActive:1,timeoutMs:1500` | sebagian **503** (probabilistik — pasukan paralel; deterministik = unit test sudah); server tetap melayani |
| A10 | Timeout | `timeoutMs:1500` + gh lambat/timeout → log `collect failed … exit` (deadline membatalkan) | **tanpa post** (tak ada `repos/…/comments` di log) |
| A11 | Dedup | kirim `canary-1` ganda dalam <100ms (sebelum job pertama selesai) | dua **202**; hanya **1** blok `collect failed` utk `canary-1` (inflight) |
| A12 | Penghentian bersih | Ctrl+C / SIGINT pada proses serve | baris `gh-bot stopped — aborted=N confirmed=N unconfirmed=0` di stdout; proses keluar; port 18799 bebas |

Verifikasi log (TANPA mencetak secret):

```powershell
$slog="<...>\server.log"
"secret-bocor=" + [bool](Select-String -Path $slog -Pattern $env:GITHUB_WEBHOOK_SECRET -Quiet)
"signature-bocor=" + [bool](Select-String -Path $slog -Pattern 'sha256=' -Quiet)
"payload-bocor=" + [bool](Select-String -Path $slog -Pattern '/bccli halo' -Quiet)
```

Ketiganya harus **False** (HMAC tak di-log; payload komentar tak di-log — hanya
`repo#nomor`). Selesai: hapus sandbox + pastikan `Get-NetTCPConnection -LocalPort 18799`
kosong; `git status` tetap bersih.

## Fase B — GitHub nyata (**TARGET + IZIN WAJIB**)

Prasyarat (nilai tak pernah dicetak):
1. Target: `OWNER/REPO` + nomor issue/PR dari user; `USER` = login penulis yang
   masuk allowlist (cek `gh api user --jq .login` → simpan, jangan echo di laporan
   bila tidak perlu).
2. Secret nyata: dibuat saat eksekusi (`openssl rand -hex 32` → `$env:GITHUB_WEBHOOK_SECRET`)
   di sesi shell yang sama dengan server; jangan ditulis ke file repo.
3. Endpoint publik: **tunnel/reverse proxy** `https://<domain>/github` → `127.0.0.1:18799/github`
   (tindakan eksternal — minta izin dulu).
4. Server berjalan (sandbox home, config: enabled, repos/users, port 18799) dengan log
   ke file.

Langkah uji:
1. **Buat webhook** (repo Settings → Webhooks, via `gh api` atau UI): payload URL publik,
   content type JSON, secret = env, events = comment. *(tindakan eksternal)*
2. **Komentar test**: kirim `/bccli <task-ringkas>` sebagai PR/issue comment. *(tindakan
   eksternal — komentar nyata dari akun user)* — Hasil diharapkan: Recent Deliveries
   menunjukkan **202**; bot membalas **TEPAT SATU** komentar baru.
3. **Verifikasi komentar**: `gh api repos/O/R/issues/N/comments` → jumlah komentar
   naik +1; komentar balasan mengandung draf agent (tampilkan panjang/awal teks saja,
   tanpa token); pemeriksaan `secret-bocor/signature-bocor` (False/False) di log.
4. **Event PR**: ulangi di PR (bila target = PR, otomatis `isPR:true` → log memuat
   konteks `pr view`/`pr diff`).
5. **Dedup/redelivery**: setelah balasan sukses → GitHub → Recent Deliveries →
   **Redeliver** *(klik manual user)* → delivery-id sama → **202 + TANPA balasan kedua**
   (completed-LRU) → jumlah komentar tetap +1.
6. **Timeout & antrean penuh live**: opsional — `timeoutMs` kecil / paralel `/bccli`
   burst; amati 503 & log; unit test sudah menjamin determinisme.
7. **Penghentian bersih**: SIGINT → baris ringkasan `stopped — aborted/confirmed/unconfirmed`;
   `unconfirmed=0` diharapkan (bila >0 → jangan klaim child mati; catat).
8. **Rapikan**: delete webhook (atau biarkan dgn event mati — keputusan user), hapus
   sandbox, port bebas, `git status` bersih.

## Tindakan eksternal yang MEMBUTUHKAN PERSETUJUAN (daftar tunggal)

1. **Target** `OWNER/REPO` + nomor issue/PR (ditentukan user).
2. **Endpoint publik**: membuat tunnel / konfigurasi reverse proxy (mis. Cloudflared/nginx).
3. **Membuat/mengubah webhook** di repo GitHub (butuh aksi admin repo).
4. **Mengirim komentar GitHub nyata** `/bccli …` (tulis dari akun user) + balasan bot.
5. **Klik Redeliver** manual di UI GitHub (uji dedup) — atau menolaknya.
6. **Membuat & menyetor secret** nyata ke env proses (tanpa dicetak/ditulis ke file repo).
7. (Opsional) perubahan live `timeoutMs`/`maxQueue` untuk uji 503/timeout end-to-end.
