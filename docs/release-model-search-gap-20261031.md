# Celah rilis: kolom cari `/model` belum sampai ke pengguna npm (2026-10-31)

**Status: NO-GO untuk publish dari repo `bccli`. Tidak ada perubahan yang dikirim ke npm.**

Permintaan owner: "lakukan tambahan menu search di pemilihan model", lalu "publish".
Perbaikan UI-nya sudah selesai dan di-merge (`PR #118`), tetapi ia berada di repo yang
**tidak lagi menghasilkan paket npm `latest`**. Dokumen ini mencatat bukti dan jalur rilis
yang benar sebelum ada yang menjalankan publish.

## Fakta yang terverifikasi

| # | Fakta | Bukti |
|---|---|---|
| 1 | `latest` npm = `0.5.4`, dibangun dari repo lain | `npm view @botconnector/bccli dist-tags` → `{"latest":"0.5.4"}` |
| 2 | Paket 0.5.1 (dari repo `bccli` ini) memakai TUI ink | `npm view @botconnector/bccli@0.5.1 bin main` → `dist/cli.js` / `dist/sdk.js` |
| 3 | Paket 0.5.4 memakai engine native dari `bccli-runtime` | `npm view @botconnector/bccli@0.5.4 bin main` → `bccli-bootstrap.cjs` / `./legacy/dist/sdk.js` |
| 4 | Job publish workflow hanya untuk 0.5.1–0.5.4 | `.github/workflows/publish-runtime-0.5.0.yml`: job 0.5.1 membangun dari repo ini (gerbang `pkg.version !== '0.5.1'`), job 0.5.2/0.5.3/0.5.4 mengunduh arsip dari `bccli-runtime` dengan commit+sha256 ter-pin (`999fe7d…`, `52702af…`). Tidak ada job 0.5.5. |
| 5 | Dialog `/model` di produk (0.5.4) tidak punya pencarian | `bccli-runtime` `packages/cli/src/ui/components/ModelDialog.tsx`: 0 kemunculan `search`/`Search`, 0 `TextInput`, 0 `type to`; daftar memakai `DescriptiveRadioButtonSelect` (radio bernomor, `maxItemsToShow`) |
| 6 | Bundle yang benar-benar terpasang sama | Install `@botconnector/bccli@0.5.4` ke prefix sementara, `node bccli-bootstrap.cjs --version` → `0.5.4`; di `engine/chunks/startInteractiveUI-*.js` dialog `Select Model` tampil tanpa state pencarian. String `searchQuery`/`type to filter…` yang ada di bundle milik dialog **Settings** dan **Skills**, bukan model. |
| 7 | Komentar sumber menyesatkan | `integrations/botconnector/candidate/dialog-models.mjs` menulis picker "stays upstream-owned (arrow keys, **search**, …)", padahal modul itu hanya menyuntik katalog gateway ke `settings.modelProviders`; `ModelDialog.tsx` tidak punya pencarian. |

## Matriks permintaan vs hasil

| PERILAKU DIMINTA | IMPLEMENTASI | BUKTI UJI | STATUS |
|---|---|---|---|
| Menu `/model` punya kolom cari yang terlihat + jumlah hasil + cari nama provider | `src/ui/ModelPicker.tsx` (repo `bccli`, TUI ink) | `test/ui/pickers.test.tsx` 11 tes; render katalog live 256 model | ADA, tetapi **tidak sampai ke pengguna npm** (hanya TUI legacy) |
| Pencarian pada picker yang dipakai `npm i -g @botconnector/bccli` | belum ada di `bccli-runtime` | ModelDialog.tsx + bundle 0.5.4 | **BELUM ADA** |

## Jalur publish yang benar untuk membawa fitur ini ke pengguna

1. Kerjakan di repo `farijarifriyanto-debug/bccli-runtime`, branch `product`:
   tambahkan pencarian ke `packages/cli/src/ui/components/ModelDialog.tsx` (dan varian
   opentui `packages/cli/src/ui/opentui/dialogs-model.tsx` bila dipakai), lengkapi tesnya.
2. Bangun arsip rilis di sana, buat GitHub release `bccli-v0.5.5` beserta
   `botconnector-bccli-0.5.5.tgz` + `SHA256SUMS.txt`.
3. Di repo ini, tambah job `publish_055` pada `.github/workflows/publish-runtime-0.5.0.yml`
   meniru job 0.5.4: pin commit tag dan sha256 arsip, `confirm_version == '0.5.5'`,
   `environment: npm-production`, publish via OIDC `--tag latest`.
4. Dispatch workflow dengan `confirm_version=0.5.5`, lalu pastikan
   `npm view @botconnector/bccli dist-tags.latest` = `0.5.5`.

Jangan publish repo `bccli` ini sebagai `latest`: bin-nya `dist/cli.js` (TUI ink), sehingga
semua pengguna turun dari engine native 0.5.4 ke TUI legacy.

## Batas verifikasi

- Sesi TUI 0.5.4 tidak dijalankan interaktif (runner ini bukan TTY); kesimpulan #5–#6 dari
  kode sumber produk dan bundle terpasang, bukan dari ketikan di terminal.
- Tidak ada publish, tag, atau release yang dibuat pada 2026-10-31 oleh sesi ini.
- Pemeriksaan registry memakai jaringan nyata (`npm view`), bukan fixture.
