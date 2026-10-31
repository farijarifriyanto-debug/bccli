# Handoff — rilis BCCLI 0.5.5 (2026-10-31)

Dokumen serah-terima untuk melanjutkan rilis `/model` yang bisa dicari. Ditulis
saat PR rilis masih menunggu dua gate TUI, supaya sesi berikutnya tidak mengulang
penyelidikan yang sudah memakan waktu.

## Keadaan sekarang

| Repo | Branch | Commit | Status |
|---|---|---|---|
| `farijarifriyanto-debug/bccli` | `main` | `538b8e3` | PR #118 (kolom cari TUI ink) dan #119 (dokumen celah rilis) sudah merged |
| `farijarifriyanto-debug/bccli-runtime` | `product` | `b4e29ce` | PR #25 (sumber `packages/cli`, **tidak ikut paket**) dan #27 (picker lapisan `candidate`, **ini yang dikirim**) sudah merged |
| `farijarifriyanto-debug/bccli-runtime` | `release/bccli-0.5.5` | `909d4e1` | PR #28 terbuka: `VERSION` → 0.5.5, pin workflow preview, `NOTES-0.5.5.md` |
| `farijarifriyanto-debug/bccli-runtime` | — | — | PR #26 (rilis pertama) **ditutup**: premisnya salah, lihat bagian "Jebakan" |

npm `latest` **masih `0.5.4`**; belum ada GitHub release `bccli-v0.5.5`; belum ada publish.

Artefak stabil 0.5.5 sudah dibangun dari tree PR #28 dan diverifikasi:

- `prepare-preview-ui.mjs --release` → `status: PASS`, `version: 0.5.5`, 1579 berkas
- sha256 `1fab7322f7e201aac20371c372828cfcea73acefdb2ad187d3b3143b885384a9`
- isi paket: `model-dialog.mjs` memuat `🔎 Search model: ` dan `BccliModelPicker`; `cli.mjs --version` → `0.5.5`
- overlay `prepareBrandedQwen` dijalankan pada engine di dalam paket itu: chunk `startInteractiveUI` memuat picker, filter `needle`, `/bccli/provider/switch`, rollback, dan `UpstreamModelDialog` yang dipertahankan → PASS

## Langkah yang tersisa (urut, dengan perintah)

### 1. Tunggu PR #28 hijau, lalu merge

Gate penentu hanya dua job TUI (`TUI parity snapshots` ~24 menit, `OpenTUI no-flicker gate` ~12 menit). `triage` selalu merah (tidak ada secret `openai_api_key`) dan CodeRabbit hanya bot — keduanya bukan gerbang.

```bash
gh pr checks 28                      # tunggu sampai dua job TUI pass
gh pr merge 28 --squash --delete-branch
git -C C:/Users/farij/worktrees/bccli-runtime-search checkout product && git pull
```

Catat commit hasil squash-merge — commit itu yang harus di-pin di job publish.

### 2. Build ulang dari commit rilis dan bandingkan hash

```bash
cd C:/Users/farij/worktrees/bccli-runtime-search
node integrations/botconnector/release/prepare-preview-ui.mjs --out C:/Users/farij/bccli-055-release --release
```

Harus menghasilkan sha256 `1fab7322f7e201aac20371c372828cfcea73acefdb2ad187d3b3143b885384a9`.
**Kalau berbeda, berhenti** — jangan rilis artefak yang tidak sama dengan yang diuji.

### 3. Buat GitHub release

```bash
gh release create bccli-v0.5.5 \
  C:/Users/farij/bccli-055-release/botconnector-bccli-0.5.5.tgz \
  C:/Users/farij/bccli-055-release/SHA256SUMS.txt \
  --repo farijarifriyanto-debug/bccli-runtime \
  --target <commit-hasil-merge> \
  --title "BCCLI 0.5.5 — searchable model picker" \
  --notes-file integrations/botconnector/release/NOTES-0.5.5.md --latest
```

### 4. Tambah job publish di repo `bccli`

Tiru blok `publish_054` (`.github/workflows/publish-runtime-0.5.0.yml` baris ~404) menjadi `publish_055`, yaitu:

- `if: inputs.confirm_version == '0.5.5'`, `environment: npm-production`, `id-token: write`
- `gh release download bccli-v0.5.5` (`--pattern` tarball + `SHA256SUMS.txt`)
- cek `gh api repos/.../git/ref/tags/bccli-v0.5.5 --jq .object.sha` **= commit rilis**
- `sha256sum -c SHA256SUMS.txt` dan cek `actual` = `1fab7322…`
- selaraskan `repository`/`bccliRuntimeSource` di `package.json` (blok JS yang sama), lalu verifikasi tidak ada perubahan lain
- cek `test -f "$pkg/model-dialog.mjs"` (tambahan baru; 0.5.4 belum punya) dan `--version` = `0.5.5`
- tolak republish, publish dengan `--provenance --tag latest`, lalu tunggu `dist-tags.latest` = `0.5.5` + integritas cocok

Perbarui juga deskripsi input `confirm_version` agar menyebut 0.5.5.

### 5. Dispatch dan verifikasi

```bash
gh workflow run publish-runtime-0.5.0.yml --repo farijarifriyanto-debug/bccli \
  -f confirm_version=0.5.5
npm view @botconnector/bccli dist-tags.latest --prefer-online   # harus 0.5.5
```

Kalau environment `npm-production` meminta approval manusia, laporkan sebagai blocker — jangan klaim terbit.

## Jebakan yang sudah memakan waktu (jangan diulang)

1. **Engine dibundel dari npm, bukan dari repo ini.** Packer memakai `npm pack @qwen-code/qwen-code@0.26.3` dengan pin `PINNED_ENGINE_SHA512`. Perubahan di `packages/cli` (PR #25) tidak pernah masuk paket; sudah dibuktikan dengan grep pada tarball dan itu sebabnya PR #26 ditutup.
2. **Fitur UI dikirim lewat `integrations/botconnector/candidate/`.** `branding.mjs` mengganti nama `ModelDialog` upstream menjadi `UpstreamModelDialog` lalu menyuntik `BccliModelPicker`; mode tambahan didelegasikan ke upstream. `BRAND_REVISION` wajib dinaikkan saat tambalan berubah.
3. **Tiga packer punya daftar berkas masing-masing.** `prepare-preview-ui.mjs`, `prepare-production.mjs`, `prepare-next.mjs`. Lupa satu = `ERR_MODULE_NOT_FOUND` saat start, dan yang menangkapnya adalah job smoke fresh-install di `bccli-production-release.yml`.
4. **Setiap PR head memunculkan tiap workflow dua kali** (`push` + `pull_request`), dan dua workflow punya job bernama `verify` dengan matriks 3 OS × Node 22/24. Itu sebabnya daftar check terlihat berlipat.
5. **`.qwen/*` di-gitignore**; rencana E2E harus `git add -f`. Berkas `integrations/botconnector/**` sengaja tidak dirapikan prettier; commit dengan `--no-verify` agar diff tetap kecil, tapi jalankan `npm run build` + `node --test` manual.
6. **Suite candidate di Windows punya 8 kegagalan bawaan** (guard Node 24.18, lookup engine, sweep TUI). Baseline terukur: 122/131 sebelum perubahan; sesudah perubahan 132/141 dengan 8 kegagalan yang sama.

## Bukti uji yang sudah ada

- Candidate suite Windows: 132/141 (8 gagal = baseline), tes dialog baru 10/10, tes lokator branding lulus.
- CI PR #27 (head `7a9602b`): `verify` 12/12 pass di dua workflow, `windows-candidate` 22/24 pass, `Check TUI impact`, `OpenTUI no-flicker` 12m21s, `TUI parity` 23m36s — semua pass.
- CI PR #28 (head `909d4e1`): `BCCLI 0.5.0 production package` ✅, `BCCLI candidate integration` ✅, preview ✅; dua job TUI masih berjalan saat dokumen ini ditulis.

## Yang masih manual dan belum boleh diklaim

- **Uji TUI interaktif di terminal asli** (mesin Windows ini tidak punya TTY): langkahnya di `bccli-runtime/.qwen/e2e-tests/2026-10-31-model-picker-search.md`.
- Klaim `NOTES-0.5.4.md` bahwa picker upstream punya "type-to-filter" **tidak benar**; dikoreksi di `NOTES-0.5.5.md`.
- Publikasi npm itu sendiri (langkah 5) belum dijalankan.

## Status lanjutan — 2026-10-31 (sesi berikutnya)

Langkah 1–4 sudah dijalankan dan diverifikasi:

- PR #28 di-squash-merge ke `product` → `5caed31a1a12a6d6257b815b3f5073f077b12716`
  (dua gate TUI pass: OpenTUI 13m8s, parity 19m31s); branch rilis dihapus.
- Build ulang dari `5caed31` **PASS**: `version 0.5.5`, 1579 berkas,
  sha256 `1fab7322f7e201aac20371c372828cfcea73acefdb2ad187d3b3143b885384a9`
  — **sama persis** dengan artefak yang diuji.
- Release **`bccli-v0.5.5`** dibuat: target commitish `5caed31`, tag ref `5caed31`,
  aset `botconnector-bccli-0.5.5.tgz` (43.114.502 byte, digest GitHub
  `sha256:1fab7322…`) + `SHA256SUMS.txt`, catatan dari `NOTES-0.5.5.md`.
  https://github.com/farijarifriyanto-debug/bccli-runtime/releases/tag/bccli-v0.5.5
- Job `publish_055` masuk `main` lewat PR #120 (`2a2df5b`, check macOS/Ubuntu/Windows
  pass) dengan semua pagar langkah 4, plus cek `model-dialog.mjs`, `BccliModelPicker`,
  dan string `Search model: `. Workflow di `main` sudah memuat job itu dan run push
  di `2a2df5b` **skipped** (tidak ada publish tak sengaja).

- Langkah 5 dijalankan dengan izin owner: run
  [41216613426](https://github.com/farijarifriyanto-debug/bccli/actions/runs/41216613426)
  **sukses** tanpa approval tambahan. Semua pagar pass
  (`PASS: byte-identical package from bccli-runtime commit 5caed31`,
  `PASS: 0.5.5 clean install, SDK, and searchable model picker`), lalu
  `npm publish --provenance --tag latest` menandatangani provenance SLSA v1
  (sigstore `logIndex=3614410022`).
- Registry terverifikasi: `dist-tags.latest = 0.5.5`,
  integritas `sha512-pDd7x5ay5IVnfnaXktVWZ7JnaWqltS65AwDqxyIDWHDNy+r/8l1bAGy8fpAJesOhTvMZIUDYlWvjKClDT0DJqA==`
  cocok dengan payload yang diterbitkan.

**Rilis 0.5.5 selesai.** Satu-satunya yang masih manual dan belum diklaim: uji TUI
interaktif di terminal asli (lihat berkas E2E di atas) — mesin ini tidak punya TTY.
