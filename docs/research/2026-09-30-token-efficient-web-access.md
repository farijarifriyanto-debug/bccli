# Akses web hemat token untuk bccli (2026-09-30)

Tujuan: mengurangi token yang habis hanya untuk membaca internet, tanpa menurunkan kualitas jawaban.
Semua angka "terukur" diambil 2026-09-30 dari VPS ini dengan endpoint publik tanpa key. Estimasi token = karakter / 4 (sama dengan estimasi bawaan bccli). Skrip ukur ada di scratchpad sesi, bukan di repo.

## 1. Kesimpulan singkat

1. **Sumber pemborosan utama adalah `fetch`, bukan `web_search`.** `web_search` mengembalikan maks 6 hasil x 600 karakter (sekitar 900 token). `fetch` mengembalikan sampai 50.000 karakter (sekitar 12.500 token) dan hasil itu tinggal di riwayat, dikirim ulang di setiap turn sampai kompaksi 80% konteks (`src/agent.ts`).
2. **Penghematan terbesar datang dari memotong per pertanyaan, bukan dari membersihkan HTML.** Parameter `prompt` Keenable Fetch menurunkan halaman OpenAI 47.391 -> 1.289 karakter (-97%) tanpa key. BM25 lokal menurunkan 25.388 -> 2.467 karakter (-90%) tanpa jaringan tambahan. Ekstraktor konten utama (Readability/trafilatura) hanya -30% sampai -70% dan tidak menjawab pertanyaan.
3. **Cara Claude Code (WebFetch + model kecil) adalah pola yang benar untuk dicontoh**: model utama menerima jawaban ringkas, bukan halaman mentah ([Claude Code tools reference](https://code.claude.com/docs/en/tools-reference.md#webfetch-tool-behavior)). bccli belum punya padanannya.

## 2. Ukuran nyata (hasil pengukuran)

Tiga halaman: `news.detik.com/` (indeks berita), `id.wikipedia.org/wiki/Nvidia`, `developers.openai.com/api/docs/guides/tools-web-search`.

| Cara | detik | Wikipedia id | OpenAI docs | Waktu | Catatan |
|---|---|---|---|---|---|
| HTML mentah (byte) | 297.449 | 444.790 | 848.287 | - | dasar |
| **bccli `htmlToText` (dikirim ke model, karakter)** | 18.293 | 36.322 | 50.000 (60.953 dipotong) | cepat | dari `test/zz-*` sesi sebelumnya, pakai kode `src/tools/fetch.ts` apa adanya |
| Keenable Fetch publik (markdown) | 3.041 | 15.247 | 47.391 | 0,4-0,6 s | tanpa key |
| **Keenable Fetch + `prompt`** | - | - | **1.289** | 2,2 s | jawaban terarah, dalam bahasa pertanyaan |
| Keenable Fetch + `max_chars=4000` | - | 4.071 | - | - | pemotongan kasar dari awal halaman |
| Mozilla Readability + turndown | 259 (salah: hanya satu artikel) | 53.199 md (23.213 teks) | 16.587 md | 2-5 s | jsdom, lambat |
| trafilatura 2.2.0 (markdown) | 3.860 | 25.388 | 18.356 | 0,2-0,6 s | Python |
| defuddle 0.x | gagal | gagal | gagal | 4-12 s | jsdom melempar `Selector exceeds maximum allowed length of 2048`, hasil jatuh ke fallback hampir tanpa reduksi (24.855 / 152.081 / 106.553) |
| Jina Reader `r.jina.ai` (byte) | 52.007 | 55.513 | 108.997 | 0,8-13,7 s | lebih besar dari `htmlToText`: memuat tautan gambar |
| `Accept: text/markdown` (byte) | tidak didukung (HTML) | tidak didukung (HTML) | 47.401 | - | hanya situs yang mengaktifkan |
| BM25 lokal, 3 potongan x ~800 karakter | - | 2.467 (dari 25.388) | 2.112 (dari 18.356) | 7-9 ms | keyword saja; `rank-bm25`, ~30 baris kode |

Bacaan angka:
- Ekstraksi konten utama menolong untuk halaman kaya navigasi (detik: 18.293 -> 3.041), tetapi tidak untuk halaman yang memang panjang (Wikipedia tetap 15-25 ribu karakter). Untuk halaman indeks/portal, Readability salah memilih satu artikel (259 karakter), jadi tidak aman dipakai sebagai satu-satunya jalur.
- `Accept: text/markdown` di developers.openai.com hanya -22% dibanding `htmlToText` (60.953 -> 47.401) tetapi kualitasnya lebih baik (blok kode utuh). Wikipedia dan detik mengabaikan header itu.
- Semua alat lokal berbasis jsdom lambat (2-12 s) dan berat sebagai dependensi CLI. trafilatura cepat tetapi Python, tidak cocok di binary Node/Bun.

## 3. Perbandingan pendekatan

Biaya = harga pihak ketiga. "Key" = perlu API key pihak ketiga. Kompleksitas = kerja di bccli/account-api.

| # | Pendekatan | Penghematan token | Biaya | Key | Kompleksitas | Sumber |
|---|---|---|---|---|---|---|
| A | Keenable Fetch + `prompt` | -97% terukur (47.391 -> 1.289) | gratis; berkunci 100.000 request/bulan; tanpa key 1.000 request/jam/IP | tidak wajib | rendah (satu GET) | [fetch](https://docs.keenable.ai/api-reference/fetch.md), [rate limits](https://docs.keenable.ai/rate-limits.md), [credits](https://docs.keenable.ai/credits.md) |
| B | Batas + `offset` di `fetch` bccli (mis. 12.000 karakter) | -76% pada kasus OpenAI docs (50.000 -> 12.000), model bisa minta halaman berikut | 0 | tidak | rendah | ukuran di atas; pola batas tetap juga dipakai Claude Code ("truncated to a fixed character limit") |
| C | BM25 lokal per query | -90% terukur | 0 | tidak | sedang (chunker + BM25 ~30 baris, tanpa dependensi jika ditulis sendiri) | terukur |
| D | Tavily Extract `query` + `chunks_per_source` | maks 5 x 500 = 2.500 karakter per sumber | 1.000 kredit/bulan gratis; basic extract 5 URL = 1 kredit; berbayar $0,008/kredit | ya | rendah | [extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract.md), [credits](https://docs.tavily.com/documentation/api-credits.md) |
| E | Exa `contents.highlights` | klaim vendor: 500 karakter highlight setara 8.000 karakter teks (16x lebih sedikit token); belum kita ukur | Free $10/bulan; `/contents` $1 per 1.000 halaman per jenis konten | ya | rendah | [highlights](https://exa.ai/docs/search/highlights.md), [pricing](https://exa.ai/docs/reference/pricing.md) |
| F | Firecrawl scrape (`markdown`) | konversi bersih, tidak terarah ke query | 1 kredit/halaman; ekstraksi JSON via LLM +4 kredit | ya | rendah | [billing](https://docs.firecrawl.dev/billing.md) |
| G | Jina Reader `r.jina.ai` | negatif pada 3 halaman uji (lebih besar dari `htmlToText`) | tier terendah tertulis 20 RPM (tidak terverifikasi itu tier tanpa key) | tidak wajib | rendah | [jina.ai/reader](https://jina.ai/reader/) |
| H | `Accept: text/markdown` | -22% pada OpenAI docs; 0% pada situs tanpa dukungan | 0 | tidak | sangat rendah (satu header) | [Cloudflare](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/index.md) |
| I | Pruning hasil tool lama (stub) | mencegah pengiriman ulang; opencode melindungi 40.000 token terbaru | 0 | tidak | sedang | [opencode compaction.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/compaction.ts) |
| J | `search_context_size:"low"` / `return_token_budget` pada tool `web_search` hosted OpenAI | belum terukur | 0 | tidak | rendah (di account-api) | [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search) |

### llms.txt / llms-full.txt
`llms.txt` berguna sebagai indeks kecil: OpenAI 6.201 byte, Exa 25.606, Tavily 18.340, Firecrawl 8.966, Cloudflare 16.193, Anthropic 69.795. Wikipedia dan detik tidak punya (404). **`llms-full.txt` adalah jebakan token**: `developers.openai.com/llms-full.txt` = 8.285.156 byte (sekitar 2 juta token). Agen tidak boleh mengambilnya utuh; jika model meminta, batas `MAX_BYTES` bccli (5 MB) pun masih terlalu besar.

## 4. Cara tiga agen lain menangani ini

| Agen | Perilaku | Sumber |
|---|---|---|
| Claude Code `WebFetch` | URL + `prompt`; HTML -> Markdown, dipotong ke batas karakter tetap, lalu **model kecil dan cepat** menjawab prompt; model utama menerima jawaban itu, bukan halaman. Cache 15 menit per URL. Tradeoff: lossy, hasil "tidak disebut" bisa berarti prompt kurang spesifik. | [tools reference](https://code.claude.com/docs/en/tools-reference.md#webfetch-tool-behavior) |
| opencode `webfetch` | Tanpa ekstraksi konten utama: HTML -> Markdown via turndown, batas respons 5 MB. Penghematan datang dari lapisan umum: keluaran tool dipotong ke 2.000 baris / 50 KB, sisanya ke file dengan retensi 7 hari (agen membaca ulang dengan grep/read), dan pruning hasil tool lama (`PRUNE_MINIMUM=20_000`, `PRUNE_PROTECT=40_000`, stub `[Old tool result content cleared]`; dokumen konfigurasi menyebut default `prune: false`). | [webfetch.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/webfetch.ts), [truncate.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/truncate.ts), [compaction.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/session/compaction.ts), [config](https://opencode.ai/docs/config/) |
| Codex | Tidak mengambil halaman di sisi klien; memakai tool `web_search` hosted OpenAI (mode cached atau live via `--search`); pembacaan halaman terjadi di sisi server OpenAI dan hanya hasilnya masuk ke konteks. | [Codex CLI features](https://developers.openai.com/codex/cli/features.md) |

Kapan paling hemat:
- Pertanyaan faktual satu-dua fakta dari satu halaman: gaya Claude Code (prompt + model murah) atau Keenable `prompt`. Terhemat paling besar.
- Perlu membaca banyak bagian halaman/kode: gaya opencode (file overflow + grep), karena tidak kehilangan detail. Hemat hanya jika model benar-benar grep, bukan membaca semuanya.
- Riset luas banyak sumber: hosted search (Codex, atau `web_search` OpenAI di account-api). Model tidak melihat halaman mentah.

## 5. Cache prompt dan kenapa hasil besar tetap mahal

Cache prompt bekerja pada prefiks (urutan `tools` -> `system` -> `messages`), TTL 5 menit atau 1 jam, dan pembacaan cache berharga 0,1x harga input dasar ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)). Artinya hasil fetch 12.500 token yang tinggal di riwayat tidak dikenai harga penuh di turn berikutnya selama cache hangat, tetapi: (a) tetap menghabiskan jendela konteks dan mempercepat kompaksi; (b) turn pertama dan setelah cache kedaluwarsa membayar penuh; (c) mengubah atau memangkas pesan lama **membatalkan cache** dari titik perubahan ke bawah. Jadi pruning harus dilakukan jarang dan dalam satu batch (gaya opencode: hanya bila total yang bisa dipangkas > 20.000 token), bukan tiap turn. Catatan: bccli memakai model non-Anthropic lewat gateway; aturan cache di gateway/OpenAI belum kita ukur, jadi angka 0,1x hanya berlaku pada API Anthropic.

## 6. `/v1/web/search` kita: bisa mengembalikan potongan relevan?

Dibaca dari `server.mjs` (tanpa perubahan):
- Route `POST /v1/web/search` (baris 2163) -> `keenableSearch` -> fallback `gatewaySearch`. Keenable dipanggil tanpa key ke `/v1/search/public`, hanya dengan `{query}`.
- `cleanResults` memotong `snippet` ke **600 karakter**. Panggilan Keenable nyata untuk satu query mengembalikan snippet 119-2.055 karakter (10 hasil, total 12.991). Jadi Keenable **sudah** menyediakan potongan yang relevan per URL dan sebagian besar dibuang oleh batas 600.
- Keenable Search punya parameter `site`, `mode` (`pro`/`realtime`), dan filter tanggal ([search](https://docs.keenable.ai/api-reference/search.md)); route kita tidak meneruskan satu pun. `site` cocok untuk permintaan "sumber resmi".
- Tidak ada route fetch di account-api; tidak ada env key Keenable (`KEENABLE` tidak muncul di file) sehingga semua lalu lintas keluar lewat kuota publik per IP VPS.
- Jalur hosted OpenAI (`web_search` yang menggantikan tool function untuk `gpt-6-luna`) tidak mengatur `search_context_size` maupun `return_token_budget` (tidak ada di `server.mjs`); dokumen OpenAI menyebut keduanya sebagai kendali ukuran konteks hasil.

Jawaban: ya, sebagian. Menaikkan batas snippet (mis. 1.200 untuk tiga hasil teratas, 300 sisanya) memberi model potongan relevan langsung dari pencarian sehingga banyak fetch tidak perlu, dengan tambahan sekitar 1-2 ribu karakter per pencarian. Ini bukan "highlights" sungguhan (Exa menjalankan model ekstraksi per query); Keenable menyebutnya snippet dan kualitas pemilihan kalimatnya tidak kita ukur.

## 7. Risiko dan hal yang tidak dikerjakan

- **Kuota per IP.** Jika `prompt`-fetch dijadikan route baru di account-api tanpa key, semua pengguna berbagi 1.000 request/jam dari satu IP VPS. Dua pilihan: bccli memanggil Keenable langsung dari IP pengguna (pola yang sudah dipakai fallback `websearch.ts`), atau account-api memakai key Keenable (100.000 request/bulan gratis, tanpa batas per jam; user harus membuat key, saya tidak membuat atau memakai key apa pun).
- **Privasi.** Endpoint publik Keenable menerima URL dan `prompt` dan memprosesnya dengan LLM mereka. Jangan dipakai untuk URL intranet atau berisi token; `fetch` bccli lokal tetap perlu jadi jalur cadangan.
- **Lossy.** Ekstraksi ber-`prompt` bisa salah menyatakan "tidak ada". Beri model jalur ulang: `fetch` dengan prompt berbeda, atau `raw: true` + `offset`.
- **Injeksi prompt.** Halaman web adalah data tak tepercaya; jawaban model kecil pun bisa memuat instruksi dari halaman. Tandai hasil sebagai data.
- Tidak diukur: kualitas jawaban akhir (hanya ukuran), kebenaran isi jawaban `prompt` Keenable di luar satu contoh (parameter `filters.allowed_domains` sesuai dokumen), harga cache di gateway.
- Disk `/` terpakai 84% saat riset (pemasangan jsdom/defuddle/trafilatura di scratchpad sekitar puluhan MB); dekat ambang 85% di AGENTS.md. Scratchpad bisa dihapus.

## 8. Rekomendasi berurutan (langkah kecil dulu)

1. **Batas dan offset di `fetch` bccli** (B). Turunkan `MAX_CHARS` dari 50.000 ke sekitar 12.000, tambah parameter `offset`, dan buang pesan-pesan yang mengulang halaman. Tanpa dependensi, tanpa jaringan tambahan. Pengaruh: kasus terburuk 12.500 -> 3.000 token per fetch.
2. **Kirim `Accept: text/markdown`** (H) sebagai header pertama; jika `content-type` markdown, pakai apa adanya, selain itu `htmlToText`. Satu header, gratis, kualitas kode lebih baik di situs dokumen.
3. **Parameter `prompt` di `fetch` bccli** (A) yang memanggil `https://api.keenable.ai/v1/fetch/public` langsung dari mesin pengguna (dengan `X-Keenable-Title: BotConnector`), fallback ke jalur lokal dengan batas B bila gagal atau URL privat. Pengaruh terukur: 47.391 -> 1.289 karakter. Ini setara pola Claude Code WebFetch tanpa membuat model kecil sendiri.
4. **Naikkan batas snippet `/v1/web/search`** dari 600 ke ~1.200 untuk tiga hasil teratas, dan teruskan `site` bila pengguna minta sumber resmi (butir 6). Perubahan `server.mjs` = deploy; butuh persetujuan.
5. **Pruning hasil tool lama** (I) di `src/agent.ts`: stub `[hasil tool lama dihapus: <nama tool> <url>]` hanya bila total hasil lama > 20.000 token, lindungi 40.000 token terbaru, satu batch (menjaga cache).
6. **Atur `search_context_size:"low"`** pada tool hosted di account-api untuk `gpt-6-luna` (J), lalu ukur dulu dampaknya pada kualitas sebelum dijadikan default.
7. **Cadangan tanpa jaringan:** BM25 lokal (C) hanya jika langkah 3 tidak cukup andal; jangan menambah dependensi jsdom/Readability/defuddle.
8. Tidak disarankan: `llms-full.txt` (8,3 MB), Jina Reader (lebih besar dari `htmlToText` di uji ini), defuddle via jsdom (gagal di ketiga halaman).

## Sumber

- Keenable: https://docs.keenable.ai/api-reference/fetch.md, /api-reference/search.md, /rate-limits.md, /credits.md, /authentication.md
- Exa: https://exa.ai/docs/search/highlights.md, https://exa.ai/docs/reference/pricing.md
- Tavily: https://docs.tavily.com/documentation/api-reference/endpoint/extract.md, /documentation/api-credits.md
- Firecrawl: https://docs.firecrawl.dev/billing.md, /features/scrape.md
- Jina Reader: https://jina.ai/reader/
- Cloudflare: https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/index.md
- Claude Code: https://code.claude.com/docs/en/tools-reference.md
- opencode: https://github.com/sst/opencode (`packages/opencode/src/tool/webfetch.ts`, `tool/truncate.ts`, `session/compaction.ts`), https://opencode.ai/docs/config/
- Codex: https://developers.openai.com/codex/cli/features.md
- OpenAI web search: https://developers.openai.com/api/docs/guides/tools-web-search
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md
- Kode lokal: `/home/botadmin/bccli-focus/src/tools/fetch.ts`, `src/tools/websearch.ts`, `src/agent.ts`; `/home/botadmin/newbotconnector/production-candidate/build/account-api/server.mjs`
