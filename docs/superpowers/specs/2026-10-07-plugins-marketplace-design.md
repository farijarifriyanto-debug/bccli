# Desain: `bccli plugins` — marketplace npm-based

Tanggal: 2026-10-07 (selesai ditulis 2026-10-08)
Status: disetujui user (arah) + 5 aturan wajib dari user di-*fold* sebelum spec final
Sub-proyek Fase 3 ke-2 dari 4 (serve ✓ → **plugins** → OAuth → gh-bot)

## 1. Tujuan & non-tujuan

**Tujuan**: perintah `bccli plugins install|remove|list|update` yang mengelola plugin
npm di direktori terkelola `~/.bccli/plugins/` dan menyinkronkan entry `plugins[]` di
**global config** (`~/.bccli/config.json`), tanpa menyentuh loader `src/plugins.ts`.

**Non-tujuan (v1)**: registry kurasi/browse/search, UI pinning versi, audit dependensi,
plugin project-level (loader global-only), auto-update terjadwal, eksekusi kode plugin
saat install.

## 2. Perintah

| Perintah | Aksi |
|---|---|
| `bccli plugins list` | semua entry `plugins[]` global + status resolve + versi bila ada; entry **manual** ikut ditampilkan |
| `bccli plugins install <spec>` | validasi spec → `npm install --prefix <home>/plugins <spec>` → sinkronkan entry config |
| `bccli plugins remove <nama\|entry>` | hanya entry **terkelola** → `npm uninstall --prefix <home>/plugins <nama>` + hapus dari config |
| `bccli plugins update [nama]` | hanya entry **terkelola** → `npm install --prefix <home>/plugins <nama>@latest`; tanpa argumen = semua entry terkelola |
| `bccli plugins <aksi-lain>` | pesan bantuan aksi, exit 1 |

Semua output lewat `t()` (EN + ID); HELP dapat baris `bccli plugins` (kolom 32).

## 3. Aturan 1 — validasi spec npm (wajib, sebelum spawn apa pun)

Spec hanya boleh: nama paket npm, nama scoped, versi konkret, atau dist-tag.

```ts
// src/pluginSpec.ts — full-anchor, HURUF KECIL saja
const NPM_SPEC_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._+-]*)?$/
```

- **Diterima**: `foo`, `@scope/bar`, `foo@1.2.3`, `foo@2.0.0-beta.1`, `foo@latest`, `@scope/bar@1.0.0`.
- **Ditolak** (semua gagal full-anchor): URL (`https://…`, `file:…`), git (`git+ssh://…`,
  `github:…`), path lokal (`./x`, `../x`, `/abs`), argumen berawalan `-` (`-f`, `--global`),
  spasi/metachar (`foo;rm -rf`), huruf besar (`FOO`), range npm (`foo@^1.2.0` — `^`/`~` di luar kelas karakter), `@scope` tanpa nama.
- Fungsi: `parseNpmSpec(raw): { name: string; spec: string } | null` — `name` = paket tanpa
  sufiks `@ver`/`@tag` (scope dipertahankan), dipakai untuk entry config dan arg uninstall.
- Kegagalan → pesan `t('Invalid npm package spec: {spec}. Use a name, @scope/name, name@version, or name@tag — URLs, git, paths, and flags are not accepted.', { spec })`, exit 1, **tanpa memanggil npm**.
- Sifat keamanan sekunder: karakter yang lolos regex (`[a-z0-9@/._+-]`) bebas metachar shell,
  jadi aman bahkan bila runner memakai shell.

## 4. Direktori terkelola & format entry

- **Seluruh path memakai `bccliHome(deps.env)`** (baca `env.BCCLI_HOME` bila ada, fallback
  `join(homedir(), '.bccli')`) — JANGAN pernah membaca `BCCLI_HOME ?? ''` langsung: tanpa
  env, path menjadi relatif-terhadap-cwd yang salah. Berlaku untuk prefix npm, resolusi
  entry di `list`, dan pesan `{path}` yang ditampilkan.
- Prefix npm: `<home>/plugins` (home = `bccliHome(env)`). Struktur hasil install:
  `<home>/plugins/node_modules/<nama>/`, `<home>/plugins/package.json`.
- Sebelum npm berjalan, `ensurePrefixDir()` membuat `package.json` minimal bila belum ada
  (`{"name":"bccli-plugins","private":true,"version":"0.0.0"}`) agar perilaku `npm install
  --prefix` deterministik.
- Entry config (canonical): `./plugins/node_modules/<nama>` — forward-slash, untuk scoped
  `./plugins/node_modules/@scope/nama`. Jalur ini resolve via cabang loader yang SUDAH ADA
  (`spec.startsWith('.') → join(home, spec)`), jadi loader tidak diubah.
- Helper murni di `src/pluginSpec.ts`:
  - `managedEntry(name): string` → `./plugins/node_modules/<name>`
  - `isManagedEntry(entry): boolean` → prefix `./plugins/node_modules/`
  - **`managedEntryName(entry): string | null`** — validasi ketat entry terelola:
    prefix canonical + sufiks HANYA nama paket npm polos (`BARE_NAME_RE =
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/`) — **tanpa versi/tag, tanpa
    traversal (`..`, `/` di luar scope), tanpa flag (`-x`), tanpa metachar (`;`, spasi),
    tanpa kapital. `null` = entry malformed.
- Entry yang bukan prefix ini = **entry manual** (mis. `C:/path/plugin` absolut atau
  `./path-relatif` lain) — sah untuk loader, tapi di luar kendali marketplace.
- **Entry malformed (prefix terelola + sufiks invalid) TIDAK PERNAH diteruskan ke npm**
  (aturan wajib): `remove`/`update` pada entry seperti itu ditolak dengan pesan khusus
  exit 1 tanpa memanggil npm; `update-all` melewatinya dengan peringatan (lihat §7).

## 5. Aturan 2 — install idempoten

`install <spec>` setelah npm sukses SELALU menulis daftar entry berikutnya —
`next = entries.includes(entry) ? entries : [...entries, entry]` — sehingga:

- duplikat entry **mustahil** tercipta (cek `includes` sebelum append), regardless
  dari apakah entry sudah ada;
- entry yang sudah ada ditulis kembali **identik** (bukan append) → jalur tulis seragam
  untuk SEMUA install, yang membuat kontrak kegagalan parsial §8 berlaku penuh untuk
  install baru MAUPUN reinstall;
- output membedakan: entry sudah ada → `t('{name} is already enabled.')`; baru →
  `t('{name} installed and enabled.')`.

Urutan selalu **npm dulu → config setelah npm sukses** (tidak pernah mengaktifkan entry
yang filenya gagal terpasang; tidak pernah menghapus/mengubah entry yang sudah ada bila
config gagal — lihat §8).

- Tes: install 2× → config tepat **1** entry (isi kedua tulis identik, bukan duplikat);
  install ulang saat entry sudah ada → `already enabled` + daftar entry tidak berubah.

## 6. Aturan 3 — remove/update hanya mengelola entry terkelola; list menampilkan semua

- `remove <arg>`:
  1. Bila `arg === entry` persis di `plugins[]` DAN `isManagedEntry(entry)` → wajib lolos
     `managedEntryName(entry)` dulu:
     - **valid** → jalur normal: npm uninstall + hapus entry.
     - **malformed (`null`)** → tolak, exit 1, **tanpa npm**:
       `t('Malformed managed entry: {entry} — fix it manually in {path}; bccli will not pass it to npm.', …)`
  2. Bila `arg` cocok entry persis tapi **manual** → tolak, exit 1:
     `t('{entry} is a manual plugin entry — edit the global config.json directly to remove it.')`
  3. Bila `arg` valid nama npm → lookup `managedEntry(arg)`; ada di config → jalur normal;
     tidak ada → `t('{name} is not an installed managed plugin.')`, exit 1 (tanpa npm).
  4. `arg` tidak valid nama DAN bukan entry persis di config → `t('Unknown plugin: {arg}.', …)`, exit 1.
- `update <arg>`: kasus manual (2) → tolak sama; kasus malformed (1b) → tolak sama
  (tanpa npm); tidak ada di managed set → (3) exit 1; jalur normal →
  `npm install --prefix … <nama>@latest` (config TIDAK ditulis). Nama yang masuk argv npm
  selalu hasil `managedEntryName`/`parseNpmSpec` yang sudah tervalidasi.
- `list` — **resolusi sejajar loader, tanpa meng-import/menjalankan plugin** (hanya
  `existsSync` + baca `package.json`), memakai cabang yang sama dengan `loadPlugins`:
  1. absolut → pakai apa adanya;
  2. diawali `.` → `join(bccliHome(env), entry)`;
  3. bare spec → `createRequire(import.meta.url).resolve(spec)` (base identik dengan
     `dist/plugins.ts`, gagal → tak-terresolve, jangan throw);
  lalu `✓` bila path hasil resolve ada, `✗` bila tidak/tak-terresolve; versi dari
  `package.json` di direktori hasil resolve (bila target file → `package.json` di
  direktornya); entry non-terkelola ditandai `(manual)`; entry terelola malformed
  ditandai `(malformed)`.

## 7. Aturan 5 — update-all tidak menyentuh plugin nonaktif

- **Sumber iterasi update-all = `plugins[]` di config** (bukan scan direktori).
- Plugin "nonaktif" = paket masih ada di `<home>/plugins/node_modules/` tetapi entry-nya
  sudah dihapus/di-disable user dari config → **tidak** di-reinstall, **tidak** diaktifkan
  kembali, tidak muncul di keluaran update.
- `update` tidak pernah menulis config sama sekali (tidak ada jalur enable/disable di update).
- **Entry terelola malformed dilewati** (validasi `managedEntryName` per entry): peringatan
  `t('Skipping malformed entry: {entry} — fix it manually in {path}.', …)` ke stderr, tidak
  pernah masuk argv npm; entry valid lain tetap di-update; **exit 1 bila ada yang dilewati**
  (config perlu dibereskan) walau update yang valid sukses.
- Tes: fixture berisi `pkga` (entry di config) + `pkgb` (files ada, entry TIDAK ada) →
  update-all → npm hanya dipanggil untuk `pkga`; config tetap tanpa `pkgb`; fixture +
  entry malformed → npm hanya `pkga`, peringatan keluar, exit 1.

## 8. Aturan 4 — penulisan global config atomik + kontrak kegagalan parsial (3 transisi)

- Helper baru `updateGlobalConfig(env, mutate)` di `src/config.ts`:
  1. baca JSON global (bila file belum ada → objek `{}`),
  2. jalankan `mutate(cfg)` in-memory (throw = batal, file tidak tersentuh),
  3. tulis **atomik**: tulis `config.json.tmp-<rand>` di direktori yang sama →
     `renameSync` menimpa target (sama-volume = operasi atomik; Node rename di Windows
     memakai replace), sisa `tmp` dibersihkan bila gagal.

  Karena atomik, **config gagal = file TIDAK berubah** (state lama utuh) — inilah dasar
  ketiga kontrak di bawah.

### Kontrak per transisi (npm sukses, lalu config gagal)

| # | Transisi | State setelah kegagalan | Pesan pemulihan (`t()`) |
|---|---|---|---|
| 1 | **Install baru** (entry belum ada) | Paket terpasang di direktori terkelola, **entry tidak terdaftar → plugin TIDAK aktif** (fail-safe: loader hanya baca config) | `npm finished but the config update failed: {reason}. {name} is installed but NOT enabled — fix the config error, then run "bccli plugins install {name}" again (safe to repeat), or add {entry} to {path} manually.` |
| 2 | **Reinstall plugin terdaftar** (entry sudah ada; install menulis ulang isi identik) | **Entry lama TETAP terdaftar dan AKTIF** (tulisan atomik gagal = file utuh); file paket SUDAH disinkron npm → **paket mungkin sudah berubah** sementara daftar entry tidak berubah | `npm finished but the config update failed: {reason}. {name} stays enabled through its existing entry {entry}; the package files may already be new. Fix the config error at {path} — no entry change was required.` |
| 3 | **Remove entry terelola** (npm uninstall sukses) | File paket HILANG, **entry TERTINGGAL di config → resolve gagal**: loader melempar `Plugin not found` → **bccli tidak mau start** sampai dibereskan | `npm removed the files of {name} but the config entry {entry} remains: {reason}. bccli will refuse to start while that entry is listed — fix the config error at {path}, then run "bccli plugins remove {name}" again (safe to repeat), or delete the entry manually.` |

- Ketiga pesan **berbeda** (jangan dipakai satu template): pesan #1 tidak boleh muncul
  untuk reinstall (yang tetap aktif) maupun remove (yang justru tertinggal), dan pesan
  #3 wajib memperingatkan bahwa sesi tidak akan start.
- Exit code **1** untuk ketiganya; npm yang sudah sukses TIDAK di-rollback (npm
  berwenang atas direktorinya); remediasi selalu langkah idempoten yang sama
  (install/remove ulang — aman diulang) atau edit manual `{path}`.
- **Kegagalan npm (exit ≠ 0)**: config **tidak disentuh sama sekali** → exit 1,
  tampilkan kode + ekor stderr npm (state tidak berubah, tanpa kontrak khusus).
- **Kegagalan baca config (`readPlugins`) vs kegagalan tulis — bedakan TAHAP dan OPERASI**:

| Tahap gagal | Operasi | State setelah kegagalan | Pesan (`t()`) |
|---|---|---|---|
| **read SEBELUM npm** | `list`, `remove` (di `resolveTarget`), `update` | Tidak ada perubahan apa pun (npm belum jalan) | `Cannot read the plugin config while running {action}: {reason} at {path} — no changes were made; fix the config, then retry.` (`action` = `list`/`remove`/`update`) |
| **read SESUDAH npm** | `install` | File sudah terpasang/tersinkron; **entry list tidak berubah** | `npm finished but the config could not be read: {reason} — the entry list is unchanged; fix {path}, then rerun the same command (safe to repeat).` |
| **read SESUDAH npm** | `remove` | File sudah terhapus; **entry masih terdaftar** (tak berubah) | `npm removed the files of {name} but the plugin config could not be read: {reason} — the entry list is unchanged; fix {path}, then run "bccli plugins remove {name}" again (safe to repeat).` |
| **write SESUDAH npm** | `install` baru / reinstall / `remove` | Tabel 3 transisi di atas | (tabel di atas) |

  Catatan: `install` tidak membaca config sebelum npm (validasi spec → npm → read → write);
  `update` tidak pernah menulis config sehingga satu-satunya kegagalan baca-nya = SEBELUM
  npm; `list` hanya membaca. Semua exit 1; npm yang sudah sukses tidak di-rollback.
- Tidak ada rollback file paket (npm yang berwenang atas direktorinya).

## 9. CLI & integrasi

- `src/args.ts`: tambah `'plugins'` ke union + `SUBCOMMANDS` + daftar `subArgs`
  (`['plugins','install','remove',…]` → `args.subArgs` = `[aksi, target]`), baris HELP:
  `  bccli plugins               list, install, remove, or update plugins`.
- `src/cli.ts`: dispatch pola `mcp` — `runPluginsCommand(args, deps)` dengan deps injection
  `{ out, err, env, runNpm, readPlugins, savePlugins }`; default `runNpm` memakai pola
  spawn persis `src/update.ts` (`npm.cmd` di win32) dengan argumen tervalidasi regex
  (aman).
- `src/i18n/id.ts`: key HELP byte-identik + semua pesan baru (lihat §3, §5, §6, §8).
- Tidak ada flag CLI baru; tidak ada dependency npm baru.

## 10. Pengujian (TDD, mapping aturan → tes)

Semua pakai `BCCLI_HOME` tmp + `runNpm` palsu (capture argv) + `savePlugins`/`readPlugins`
injected — **tanpa npm nyata**. Assertion teks keluaran `t()` memakai katalog **EN**;
file tes yang mengandungnya men-pin bahasa secara eksplisit
(`beforeAll(setLanguage('en'))` → `afterAll(setLanguage('id'))`) agar selaras dengan
setup i18n suite (`test/setup.ts` menyetel `'id'` per file).

1. **Aturan 1**: tabel valid/invalid spec (§3) → `parseNpmSpec`; `install` spec invalid →
   exit 1, `runNpm` **tidak terpanggil**.
2. **Aturan 2**: install 2× → config tepat 1 entry (kedua tulis isi identik, bukan
   duplikat); install ulang (entry sudah ada) → npm tetap terpanggil, output
   "already enabled", daftar entry tidak berubah.
3. **Aturan 3**: entry manual (`/abs/path`, `./lain`) → `list` menampilkannya (dengan
   `(manual)`); `remove`/`update` pada entry manual → tolak exit 1 + tidak ada pemanggilan
   npm; `remove` nama tak terpasang → exit 1 tanpa npm; nama valid + entry terelola → npm
   uninstall + entry hilang.
4. **Aturan 5**: fixture `pkga` di config + `pkgb` files-only → `update` (all) → argv npm
   hanya `pkga@latest`; config tidak berubah (tetap tanpa `pkgb`).
5. **Aturan 4 — kontrak kegagalan parsial, satu tes per transisi (§8, pesan WAJIB
   berbeda)**:
   - **5a Install baru**: entry awal kosong, `savePlugins` throw → exit 1; pesan memuat
     `NOT enabled` + nama + `{entry}` + path config + instruksi install-ulang; entry
     tetap tidak ada (baca ulang config = tanpa entry).
   - **5b Reinstall terdaftar**: entry awal `['​./plugins/node_modules/foo']`,
     `savePlugins` throw → exit 1; pesan memuat `stays enabled` + `existing entry` +
     path; **tidak** memuat `NOT enabled`; entry tetap `['​./plugins/node_modules/foo']`
     (aktif, tidak hilang); npm uninstall tidak dipanggil (ini install).
   - **5c Remove**: entry awal terelola, npm uninstall sukses, `savePlugins` throw →
     exit 1; pesan memuat `entry` + `remains` + peringatan `refuse to start` + path +
     instruksi remove-ulang; entry **masih ada** di config (tertinggal); `list` menandainya `✗`.
   - Pendukung: config lain (`model`, `providers`, …) dipertahankan lewat tes helper
     `updateGlobalConfig` (kunci lain utuh; mutate throw → file tak berubah; tidak ada
     sisa `.tmp` setelah sukses/gagal).
6. npm gagal (code 1 + stderr) → exit 1, config tidak diubah (berlaku untuk install
   maupun remove).
7. `list` resolve ✓/✗ + versi; unknown action → pesan bantuan, exit 1.
8. i18n: setiap `t('…')` baru (termasuk 3 pesan pemulihan §8 + matriks baca §8) punya
   key EN+ID (test i18n yang ada).
9. **Home (`bccliHome(deps.env)`)**: env TANPA `BCCLI_HOME` → prefix npm =
   `join(homedir(), '.bccli', 'plugins')` (bukan path relatif `plugins`/kosong); env
   DENGAN `BCCLI_HOME` → memakai nilai itu. (Deps config = fake; tidak menyentuh home
   asli.)
10. **Validasi entry terelola (`managedEntryName`)**: tabel — `./plugins/node_modules/foo`
    → `foo`, `./plugins/node_modules/@scope/bar` → `@scope/bar`; malformed → `null`:
    traversal (`./plugins/node_modules/../x`, `…/foo/../bar`), flag (`…/-f`),
    metacharakter (`…/foo;rm`, `…/foo bar`), sufiks versi/tag (`…/foo@1.2.3`,
    `…/foo@latest`), kapital (`…/FOO`). End-to-end: config berisi entry malformed →
    `remove <entry-persis>` → exit 1 + pesan `Malformed managed entry` + **npm tidak
    terpanggil** + entry tetap ada.
11. **Resolusi `list` sejajar loader** (tanpa import/menjalankan plugin): entry absolut
    path nyata → `✓` (+versi dari `package.json`); entry relatif `./x` yang ada di home →
    `✓ (manual)`; bare spec yang resolve di lingkungan test (mis. `ws`) → `✓`; bare
    tak-terresolve → `✗`; entry terelola malformed → `(malformed)`.
12. **Matriks kegagalan baca (§8)** — satu tes per sel:
    - `list`: read throw → exit 1 + pesan read-SEBELUM (`no changes were made`), tanpa npm;
    - `update`: read throw → exit 1 + read-SEBELUM (`action=update`), npm tidak terpanggil;
    - `remove` read SEBELUM npm → exit 1 + read-SEBELUM (`action=remove`), npm tidak
      terpanggil;
    - `remove` read SESUDAH npm (read pertama OK, kedua throw) → npm uninstall terpanggil,
      exit 1 + pesan read-SESUDAH khusus remove (`entry list is unchanged` + instruksi
      remove-ulang), entry tetap ada;
    - `install` read SESUDAH npm → npm terpanggil, exit 1 + pesan read-SESUDAH install;
    - write-failure tetap tercakup tes 5a/5b/5c.
13. **update-all + malformed**: entries = `[pkga valid, entry malformed]` → npm hanya
    `pkga@latest`, peringatan `Skipping malformed entry` ke stderr, **exit 1**, config
    tidak berubah.

**Gate**: `npx tsc --noEmit`, `npm run lint` 0/0, `npm test` (2× stabil), `npm run build`.
**Canary npm nyata DITAHAN** — hanya dengan izin eksplisit user setelah review plan
(ucapan user: "jangan jalankan npm install nyata" berlaku sampai review selesai).

## 11. Deviasi / keputusan sadar

| Keputusan | Alasan |
|---|---|
| Huruf ketat lowercase + tanpa range npm | Aturan 1 (validasi ketat) > kelengkapan; range bisa menyusul |
| Prefix `<home>/plugins` + entry `./…` | Loader `createRequire(import.meta.url)` tidak resolve `~/.bccli/node_modules` |
| npm dulu, config kemudian | Aturan 4: tak pernah mengaktifkan entry tanpa file |
| Update tidak menyentuh config sama sekali | Aturan 5: update = sinkronisasi file, bukan keputusan enable |
| Tanpa rollback file paket | Remediasi idempoten > transaksi dua sistem (npm + file) |
