# Desain: `bccli login openrouter` — OAuth PKCE (provider login #11)

Tanggal: 2026-10-08
Status: disetujui user (scope: **OpenRouter saja**; desain di-setujui + 6 kontrak tambahan wajib)
Sub-proyek Fase 3 ke-3 dari 4 (serve ✓ → plugins ✓ → **OAuth** → gh-bot)

## 1. Tujuan & non-tujuan

**Tujuan**: `bccli login openrouter` memperoleh API key OpenRouter lewat **OAuth PKCE
resmi** (dokumen `openrouter.ai/docs/use-cases/oauth-pkce`), menyimpannya lewat pipeline
credential yang ada, plus jalur `--key` (manual, lama) dan `--logout` (hapus kredensial
lokal + info revoke remote).

**Non-tujuan (v1)**: OAuth provider lain (Gemini/generic), refresh token (hasil flow ini
bukan access token — lihat §5), revoke API otomatis di sisi OpenRouter, mengubah
perilaku `provider add/remove`, auto-verify models setelah login (pesan hanya
menyarankan `bccli models openrouter` — keputusan sadar, beda dengan `provider add` yang
memang memverifikasi).

## 2. Perintah & UX

| Perintah | Aksi |
|---|---|
| `bccli login openrouter` | Flow OAuth PKCE (browser + paste kode) |
| `bccli login openrouter --key` | Jalur LAMA: prompt API key (`readSecret`) — tidak berubah |
| `bccli login openrouter --logout` | Hapus credential tersimpan (config provider TETAP) + cetak URL revoke dashboard |
| `bccli login openrouter --key --logout` | **Ditolak di awal**: `t('Use either --key or --logout, not both.')`, exit 1 — **sebelum** membuka browser / membaca input / membaca/menulis credential apa pun (kontrak #6; test spy memastikan `open`/`readLine`/`saveCredential`/`removeCredential` tidak terpanggil) |
| `bccli login <provider lain> --logout` | **Ditolak** (rev #5): `t('Logout is not supported for {id}; use bccli provider remove {id} to delete its stored key and config.')`, exit 1, **`removeCredential` TIDAK dipanggil** — logout OAuth hanya untuk `openrouter`, tidak pernah diam-diam menghapus credential provider lain (maupun provider yang salah) |
| `bccli login openrouter` saat stdin non-TTY | exit 1 `t('bccli login openrouter needs a terminal. Use --key to paste an API key instead.')` — tanpa membuka browser |

Flag baru di `parseCliArgs`: `--key` (boolean), `--logout` (boolean) — keduanya hanya
bermakna pada subcommand `login`.

## 3. Flow OAuth (ikuti dokumen resmi; tanpa param tak terdokumentasi)

Sumber: `https://openrouter.ai/docs/use-cases/oauth-pkce` (+ halaman auth-nya).

1. **PKCE**: `code_verifier = base64url(randomBytes(32))`;
   `code_challenge = BASE64URL(SHA256(verifier))`; `code_challenge_method = S256`.
2. **URL otorisasi** (varian **tanpa redirect** — docs: kode ditampilkan di halaman
   untuk di-copy ke aplikasi terminal):
   `https://openrouter.ai/auth?code_challenge=<c>&code_challenge_method=S256&key_label=bccli`
   — hanya parameter yang didokumentasikan (`code_challenge`, `code_challenge_method`,
   `key_label`); **tanpa** `state`/`callback_url` (tidak didokumentasikan untuk mode
   paste; tidak ada server redirect untuk diproteksi).
3. Buka browser via `defaultOpen` (pola MCP OAuth; E2E MCP OAuth di sesi lama dengan URL
   berm `&` terbukti lolos). Gagal membuka → cetak URL manual:
   `t('Could not open the browser automatically — open this URL manually: {url}')`.
4. Prompt **terlihat** (`readLine` baru — kode harus terlihat saat di-paste; jangan
   pakai `readSecret` yang menutupi input). **Klasifikasi hasil `readLine` (celah #1):**
   - mengembalikan `ABORT` ATAU melempar error klasifikasi-batal
     (`name === 'AbortError'` ATAU `code === 'SIGINT'`) → exit **130** senyap
     (pola `readSecret`; produksi exit langsung, bentuk throw dipakai test);
   - **error stdin biasa apa pun** (EIO, dll) → `t('Failed to read the authorization code: {reason}. Your stored credential was not changed.')`
     (reason di-truncate 200), exit **1** — BUKAN 130; tidak ada tulis apa pun.
5. Kode kosong/spasi → `t('Authorization code is empty. Run bccli login openrouter again.')`, exit 1, **fetch tidak dipanggil**.
6. **Exchange**: `POST https://openrouter.ai/api/v1/auth/keys`
   body `{code, code_verifier, code_challenge_method: 'S256'}` (JSON, `Content-Type: application/json`),
   **timeout 15 detik** (AbortSignal, injectable utk test).
   **Kontrak status/payload (rev #2):**
   - **HANYA HTTP 200 diterima** — 201/204 (atau status 2xx lain) → `kind: 'http-other'`
     dengan statusnya, **meski body-nya berisi key valid** (tolak pertama di status).
   - Body 200 wajib: JSON valid → **payload object non-null** (bukan array/null/scalar)
     → field `key` berupa **string non-blank** (`trim() !== ''`; spasi-saja = invalid).
   - Pelanggaran apa pun → `kind: 'invalid-body'`; sukses hanya `{ok:true, key}`.
7. Simpan: `saveCredential('openrouter', key)` (file mode 0600) — **hanya** setelah
   exchange 200 + `key` valid.

## 4. Resolusi key & prioritas env (kontrak #1)

Urutan resolusi yang SUDAH ada di `resolveModel` (`src/config.ts`):
`env[apiKeyEnv] (OPENROUTER_API_KEY) || credentials['openrouter'] || undefined`
— **env MENANG** atas credential tersimpan. Kontrak pesan yang akurat:

| Kondisi | Pesan login sukses | Pesan logout (rev #4: keempat selalu + urutan ini) |
|---|---|---|
| env TIDAK ada | `t('Logged in: openrouter credential saved.')` | ada credential → `t('openrouter credential removed.')`; tidak ada → `t('openrouter credential was not stored.')` — lalu **selalu** `t('To revoke keys on your account, open https://openrouter.ai/settings/keys.')` |
| env ADA | sukses di atas + `t('Note: {env} is set in the environment and takes priority over the stored credential.', { env: 'OPENROUTER_API_KEY' })` | baris pertama (removed ATAU not-stored) + **`t('Note: {env} is still set in the environment and will keep being used.', { env: … })` TAMPIL JUGA WALAU credential lokal tidak ada** + baris revoke |

Logout TIDAK menghapus/mengubah env dan TIDAK menyentuh config provider.
Test eksplisit prioritas resolusi: env+credential → `resolveModel` mengembalikan env;
credential saja → credential (env-absent).

## 5. Penyimpanan, refresh, revoke

- **Penyimpanan**: `credentials` file (sudah ada, mode 0600); hasil flow = **API key
  user-controlled biasa** → integrasi langsung dengan `resolveModel`/`models.ts`/
  `provider add` tanpa perubahan apa pun.
- **Refresh**: TIDAK ADA dan TIDAK DIPERLUKAN — menurut docs hasil exchange adalah API
  key biasa (bukan access token 24-jam); kadaluarsa/credit-limit diatur di dashboard.
  Dicatat eksplisit sebagai keputusan, bukan kelalaian.
- **Revoke remote**: tidak ada endpoint revoke resmi yang terdokumentasi (hasil riset) →
  manual via `https://openrouter.ai/settings/keys` (dicetak oleh `--logout`).
- Credential ditulis SETELAH exchange sukses saja → semua kegagalan di §6 menjamin
  credential lama TETAP UTUH (write terjadi setelah semua yang bisa gagal sudah lewat;
  tulisan credential sendiri non-atomik — keterbatasan yang dicatat di §9).

## 6. Kontrak kegagalan (pesan BEBEDA per kondisi; semua exit 1 kecuali disebut)

Semua output lewat `t()`; `{detail}`/`{reason}` = **hanya** field ter-whitelist dari body
JSON (`error`/`message` bila string) → **di-redact dulu, baru di-truncate 200 char**
(urutan wajib, rev #1 — lihat §7).

**Taksonomi kegagalan (rev #3) — tiga kelas berbeda, jangan disamakan:**
- **Pembatalan (Ctrl+C)**: saat prompt kode → exit **130** senyap (pola `readSecret`);
  **selama exchange** → handler `SIGINT` sementara mem-abort fetch → `kind:'cancelled'`
  → `t('Login cancelled.')` + exit **130**; listener SIGINT **wajib dibersihkan di
  `finally`** (baseline `process.listenerCount('SIGINT')` pulih di SEMUA jalur —
  sukses/timeout/network/cancel; test memverifikasi).
- **Timeout**: exit **1** + pesan timeout khusus (baris a) — bukan 130, bukan network.
- **Error input/network biasa**: exit **1** + pesan masing-masing (baris c/d/g/h/i/j).

**Klasifikasi pembatalan berlaku di SELURUH exchange (celah #2)** — mencakup
`await fetch(...)` **dan** `await res.json()` (pembacaan body). Sumber kebenaran =
**asal signal gabungan** (caller `deps.signal` vs `AbortSignal.timeout`), bukan nama
exception: caller-aborted → `cancelled`; timeout-aborted → `timeout`; keduanya dicek
SEBELUM fallback network. Contoh kegagalan yang dulu salah klasifikasi: header 200
sudah diterima lalu body tertahan → abort saat `res.json()` → HARUS tetap
timeout/cancelled, **bukan `invalid-body`**. Sebaliknya: JSON rusak **tanpa abort
apa pun** → tetap `invalid-body` (baris h).

| # | Kondisi | Deteksi | Pesan (inti) |
|---|---|---|---|
| a | **Timeout** exchange | `AbortSignal.timeout` aborted saat `fetch` **atau** `res.json()` | `…timed out after {seconds}s. Your stored credential was not changed.` |
| b | Ctrl+C di prompt kode | `\u0003` di `readLine` | exit **130** senyap, tanpa pesan sensitif, tanpa tulis |
| b2 | **Ctrl+C SELAMA exchange** (rev #3; celah #2 — berlaku juga saat membaca body) | `process.once('SIGINT')` → caller-signal aborted saat `fetch` **atau** `res.json()` → `kind:'cancelled'` | `t('Login cancelled.')`, exit **130**, credential tak tersentuh, listener dibersihkan (`finally`) |
| c | Kode kosong | trim == '' | `Authorization code is empty…` — **fetch tak dipanggil** |
| d | Jaringan gagal | fetch throw | `Could not reach OpenRouter: {reason}. Your stored credential was not changed.` (reason ikut di-redact) |
| e | **HTTP 403 kode expired** | status 403 DAN `{detail}` lowercase memuat `'expired'` | `Authorization code expired — codes are valid for 10 minutes. Run bccli login openrouter again.` |
| f | **HTTP 403 lain** (code/verifier invalid, dll) | status 403 tanpa kata `expired` (termasuk body kosong) | `OpenRouter rejected the authorization code (403): {detail}. Run bccli login openrouter again.` — **TIDAK boleh memuat kata `expired`** (kontrak #3: semua 403 ≠ expired) |
| g | HTTP non-200 lain | status lain | `OpenRouter exchange failed ({status}): {detail}. Your stored credential was not changed.` |
| h | Balasan 200 tanpa `key` string non-kosong (**hanya bila TIDAK ada abort** — JSON rusak/`null`/whitespace tanpa abort) | object/payload check setelah body terbaca penuh | `OpenRouter did not return an API key in the expected format. Your stored credential was not changed.` |
| i | **Exchange SUKSES tapi `saveCredential` throw** | try/catch tulis | `The key was created on your OpenRouter account but could not be saved locally ({reason}). Manage it (copy or revoke) at https://openrouter.ai/settings/keys, then run bccli login openrouter again.` — exit 1; **wajib** menyampaikan: key REMOTE SUDAH dibuat, BELUM tersimpan lokal, pemulihan via dashboard (kontrak #4) |
| j | **`readLine` error stdin biasa** (celah #1) | throw selain `AbortError`/`code==='SIGINT'` | `Failed to read the authorization code: {reason}. Your stored credential was not changed.` (reason truncate 200), exit **1** — bukan 130 |

Umum (kontrak #2): kegagalan a/c/d/e/f/g/h TIDAK menyentuh credential — seeded
credential lama wajib terbaca utuh di semua test gagal. Umum (kontrak #5): **key, kode,
`code_verifier`, dan body respons mentah TIDAK PERNAH muncul di stdout/stderr/alamat
error** — lihat §7.

## 7. Redaksi (kontrak #5)

- Helper murni `redact(text, secrets: string[]): string` — mengganti setiap kemunculan
  secret (key hasil exchange, kode yang ditempel, verifier) dengan `***`.
- **Pipeline wajib (rev #1): extract whitelist → `redact(full secrets)` → `slice(0, 200)`.**
  Redact SEBELUM truncate — truncate dulu memotong secret di tengah sehingga redact tak
  cocok lagi dan separuh secret bocor. Berlaku untuk SEMUA `{detail}`/`{reason}` (termasuk
  pesan jaringan dan alasan `saveCredential` gagal; alasan save juga ikut truncate).
- Uji jaringan (d) boleh memuat URL tantangan (publik) tapi bukan verifier — bila
  `error.message` memuat salah satu secret → tetap di-redact.
- **Tes boundary (rev #1)**: test mengambil verifier **aktual** dari body request stub
  (bukan literal) dan menyusun detail sehingga secret berada **melintasi batas byte-200**
  (mis. `'x'.repeat(196) + verifier`) → output wajib memuat `***` dan **tidak** memuat
  8-char-prefix verifier maupun verifier utuh — membuktikan redact berjalan sebelum potong.
- Test memeriksa: `JSON.stringify([...outLines, ...errLines])` tidak memuat substring
  key/verifier/kode yang diketahui test (assert negatif eksplisit), di SEMUA jalur
  sukses & gagal.
- Response body mentah tidak pernah dicetak (hanya field whitelist setelah redact).

## 8. Arsitektur & injection

- `src/oauthLogin.ts` (baru, murni + orkestrasi) — signature FINAL (rev #4: selaras,
  tanpa `as never`):
  - `pkcePair(): { verifier: string; challenge: string }`
  - `buildAuthUrl(challenge: string): string`
  - `redact(text: string, secrets: string[]): string`
  - `classifyExchange403(detail: string): 'expired' | 'rejected'`
  - `type ExchangeResult = { ok: true; key: string } | { ok: false; kind: 'timeout' | 'network' | 'cancelled' | 'http403-expired' | 'http403-rejected' | 'http-other' | 'invalid-body'; status?: number; detail: string }`
  - `exchangeAuthCode(code: string, verifier: string, deps: { fetch: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<ExchangeResult>` —
    `signal` dari AbortController pemanggil (dipakai saat SIGINT); `AbortSignal.any([timeout, signal])`
    dipakai untuk **seluruh exchange: `await fetch(...)` DAN `await res.json()`**
    (celah #2). Klasifikasi di catch memakai **ASAL signal dulu** — `deps.signal?.aborted`
    → `cancelled`; `timeout.aborted` → `timeout`; baru fallback `network` (bukan sekadar
    nama exception). `res.json()` yang reject **karena abort** diteruskan ke klasifikasi
    itu; reject **tanpa abort** (body rusak) → `parsed = undefined` → `invalid-body`
    pada status 200. Pipeline detail: whitelist → redact(`[code, verifier]`) → truncate 200.
  - `export const ABORT: unique symbol` (balasan `readLine` saat Ctrl+C utk test; di
    produksi `readLine` exit 130 langsung — keduanya didukung orkestrasi).
  - `interface OauthLoginDeps { out(s: string): void; err(s: string): void; env: NodeJS.ProcessEnv; isTTY: boolean; open(url: string): void; readLine(prompt: string): Promise<string | typeof ABORT>; saveCredential(id: string, key: string): void; fetch: typeof fetch; timeoutMs?: number }`
  - `runOauthLogin(deps: OauthLoginDeps): Promise<number>` — pasang `process.once('SIGINT')`
    **hanya selama exchange**, `finally` wajib: hapus listener + tutup controller.
    **Catch `readLine` (celah #1)**: `ABORT` ATAU error klasifikasi-batal
    (`name === 'AbortError'` | `code === 'SIGINT'`) → 130 senyap; error lain →
    baris `j` (exit 1, reason truncate 200).
  - `interface OauthLogoutDeps { out(s: string): void; err(s: string): void; env: NodeJS.ProcessEnv; removeCredential(id: string): boolean }`
  - `runOauthLogout(deps: OauthLogoutDeps): Promise<number>` — parameter id selalu `'openrouter'`
    dari dispatch (lihat guard §2); env-note dicetak bila `env[OPENROUTER_ENV_KEY]` ada
    **tanpa syarat credential** (rev #4); revoke URL selalu.
- `src/login.ts`: `readLine(prompt)` baru (input terlihat; `\u0003` → `process.exit(130)`),
  `readSecret` tak diubah; **dispatch lengkap** (rev #5 — kode nyata, bukan pseudocode):

```ts
export interface LoginDeps {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  isTTY: boolean
  open(url: string): void
  readLine(prompt: string): Promise<string | typeof ABORT>
  saveCredential(id: string, key: string): void
  removeCredential(id: string): boolean
  fetch: typeof fetch
  legacyAdd(providerId: string, cwd: string): Promise<number>
}
export function defaultLoginDeps(): LoginDeps
export async function runLogin(providerId: string, cwd: string, args: CliArgs, deps: LoginDeps): Promise<number>
```

  `defaultLoginDeps()` (WIRING NYATA, bukan placeholder): `out/err` → `console.log/error`;
  `isTTY` → `process.stdin.isTTY ?? false`; `open` → `defaultOpen(new URL(url))`;
  `readLine` → `readLine` lokal (src/login.ts); `saveCredential/removeCredential` →
  dari `src/config.ts` dengan `process.env`; `fetch` → `globalThis.fetch`;
  **`legacyAdd` = jalur lama persis**: `runProviderCommand(parseCliArgs(['provider', 'add', providerId]), { env, cwd, out, err, readSecret })`
  (signature `CliDeps` providerCli: `{env, cwd, out, err, readSecret, fetch?}`).
  Pemanggil di `src/cli.ts` ikut diperbarui:
  `runLogin(args.loginProvider ?? 'bc-cloud', cwd, args, defaultLoginDeps())`.

  Aturan dispatch (urutan ketat):
  1. `args.key && args.logout` → `Use either --key or --logout, not both.` exit 1
     (sebelum semua side effect);
  2. `args.logout`:
     - `providerId === 'openrouter'` → `runOauthLogout({…, removeCredential: (id) => deps.removeCredential(id)})`;
     - lain → `t('Logout is not supported for {id}; use bccli provider remove {id} to delete its stored key and config.')` exit 1 — **`removeCredential` tidak dipanggil** (tidak pernah diam-diam menghapus credential yang salah);
  3. `args.key` → `deps.legacyAdd(providerId, cwd)` (jalur lama, semua provider);
  4. default: `providerId === 'openrouter'` → `runOauthLogin({…})`; selain itu → `legacyAdd` (tak berubah).
- `src/args.ts`: flag `key` (boolean) + `logout` (boolean); field di `CliArgs` default
  `false`; keduanya hanya bermakna pada subcommand `login`.
- Tanpa dependency baru. Tanpa perubahan `resolveModel`/`saveCredential`/`removeCredential`.

## 9. Keterbatasan yang dicatat

- Tulisan `saveCredential` non-atomik (pola existing) — kegagalan I/O di tengah tulis
  bisa merusak file credential; di luar scope v1 (tidak diubah; dicatat di sini + laporan).
- Tidak ada auto-verify model setelah login (beda dengan `provider add`).
- Tidak ada `state` (tidak didokumentasikan utk mode paste; tidak ada endpoint balik
  yang otomatis menerima callback).
- Canary login live = interaktif (butuh browser akun OpenRouter user) → **DITAHAN**,
  sama seperti larangan login nyata di sesi ini.

## 10. Pengujian (mapping kontrak → test)

Semua test pakai deps injection (fetch/open/readLine/saveCredential palsu) + `BCCLI_HOME`
tmp + seed credential — **tanpa jaringan nyata**:

1. **PKCE/URL**: challenge = b64url(sha256(verifier)) (recompute), charset/panjang; URL
   berisi persis3 param terdokumentasi, TIDAK memuat `state`/`callback_url`, encoding benar.
2. **Sukses**: fetch 200 `{key}` → `saveCredential('openrouter', key)` sekali; pesan
   sukses akurat (env absen → tanpa catatan); **assert negatif** key/verifier/kode tak
   ada di seluruh output.
3. **Prioritas env (kontrak #1)**: `resolveModel` env-menang vs credential-saja; pesan
   login sukses DENGAN env memuat `takes priority`; logout dengan env memuat
   `still set` — **termasuk saat credential lokal tidak ada** (baris `not stored` +
   catatan env, rev #4); logout tanpa env → tanpa catatan; logout saat tak ada
   credential → `was not stored` (revoke URL tetap dicetak).
4. **Timeout (a)**: fetch tak pernah resolve + `timeoutMs: 1` → pesan timeout, `saveCredential`
   tak terpanggil, credential lama utuh, verifier tak bocor.
5. **Ctrl+C (b)**: `readLine` mengembalikan ABORTED (stub `\u0003`) → exit 130,
   `saveCredential` & exchange tak terpanggil.
6. **Kode kosong (c)**: fetch spy `0` panggilan, exit 1, credential utuh.
7. **403 ganda (e/f)**: body `{"error":"Authorization code expired: …"}` → pesan expired;
   body `{"error":"invalid code"}` → pesan rejected dan `not.toContain('expired')`;
   body kosong → rejected. Cross-assert kedua arah.
7b. **Status/payload ketat (rev #2)**: 200 + payload `null` → invalid-body; 200 + key
   `'   '` (whitespace) → invalid-body; 200 + body JSON bukan-JSON → invalid-body;
   **201 dengan body key valid → `http-other` status 201 (ditolak)**; **204 kosong →
   `http-other` status 204** — semua tanpa menyentuh credential.
7c. **Boundary redact (rev #1)**: verifier diambil dari body request stub (aktual),
   detail = `'x'.repeat(196) + verifier` → output mengandung `***`, TIDAK mengandung
   8-char-prefix verifier maupun verifier utuh (redact sebelum truncate).
7d. **SIGINT saat exchange (rev #3)**: fetch stub menunggu; `process.emit('SIGINT')`
   selama berjalan → `kind:'cancelled'` → `Login cancelled.` + exit 130 + credential
   utuh; `process.listenerCount('SIGINT')` kembali ke baseline SEBELUM & SESUDAH
   `runOauthLogin` di SEMUA jalur (sukses/timeout/network/cancel).
7e. **Celah #1 — readLine error I/O biasa**: `readLine` melempar `Error('EIO: …')`
   (bukan AbortError/SIGINT) → exit **1** + `Failed to read the authorization code: {reason}`
   (reason tampil, di-truncate), **bukan** 130; credential lama utuh; listener baseline.
7f. **Celah #2 — klasifikasi seluruh exchange** (tiga sub-tes, semua: credential utuh
   + listener baseline setelahnya):
   - header **200 diterima**, body tertahan sampai `timeoutMs` → exit 1 + pesan
     `timed out`, **bukan** `expected format`/invalid-body;
   - header **200 diterima**, body tertahan → `process.emit('SIGINT')` → exit **130** +
     `Login cancelled.`, **bukan** invalid-body;
   - **JSON malformed tanpa abort** (body rusak terbaca penuh) → exit 1 +
     `did not return an API key in the expected format` (invalid-body), **bukan**
     `timed out`/`Login cancelled.`.
8. **Save gagal (i)**: `saveCredential` throw → pesan memuat konjungsi wajib: `created on
   your OpenRouter account` + `could not be saved locally` + URL dashboard + `reason`
   (di-redact); exit 1; key tidak tercetak; credential lama (yang belum terganti) utuh.
9. **Redact (kontrak #5)**: unit `redact` (multi-secret, kemunculan berulang);
   network-error memuat secret dalam `error.message` → output mengandung `***`, bukan
   secret; test gelap menyapu semua jalur (sukses + a–i) dengan assert gabungan.
10. **Konflik `--key --logout` (kontrak #6)**: exit 1, pesan `not both`, spy `open`/
    `readLine`/`saveCredential`/`removeCredential` SEMUA nol panggilan, credential tak
    terbaca-ubah.
11. **Non-TTY**: `isTTY: false` tanpa `--key` → exit 1 + instruksi `--key`, `open` nol.
12. **Logout**: `removeCredential('openrouter')` terpanggil (argumen id diverifikasi);
    output memuat URL revoke; tanpa token apa pun. **`login groq --logout` (rev #5)** →
    exit 1 + pesan `Logout is not supported…` + `removeCredential` spy **0 panggilan**
    (tidak pernah diam-diam menghapus OpenRouter/credential lain).
13. **Dispatch lengkap (rev #5)**: semua test memakai `LoginDeps` interface nyata +
    `legacyAdd` spy — **tanpa `as never`/cast liar** di signature maupun test; urutan
    guard terverifikasi (konflik → logout → --key → default).
14. **i18n**: semua key EN baru punya terjemahan ID (test i18n yang ada).

Gate: tsc 0, lint 0/0, `npm test` 2× stabil, build OK. Rilis/push/publish tetap ditahan.
