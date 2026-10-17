# Kontribusi untuk BCCLI

Terima kasih mau berkontribusi. Issues dan pull request kecil selalu diterima.

## Mulai dari sini

1. Bug atau perbaikan kecil → langsung buka PR (tautkan issue bila ada).
2. Fitur baru → buka [Feature request](https://github.com/farijarifriyanto-debug/bccli/issues/new?template=feature_request.yml) dulu, jangan langsung PR besar. Sebagian besar fitur baru sebaiknya menjadi tool/MCP/plugin daripada masuk core — tanyakan dulu lewat issue.
3. Pertanyaan pemakaian → [Issues](https://github.com/farijarifriyanto-debug/bccli/issues) dengan label `question`, atau forum BotConnector.

## Pengembangan

```bash
git clone https://github.com/farijarifriyanto-debug/bccli.git
cd bccli
npm install
npm test && npm run typecheck && npm run lint && npm run build
npm run coverage   # gerbang coverage (juga dijalankan di CI Linux)
```

Rilis: naikkan `version` di `package.json`, push tag `v<versi>` — CI menjalankan test, smoke test ke BotConnector Cloud, dan `npm publish --provenance`.

## Aturan PR

- Perubahan perilaku butuh test yang gagal tanpa perubahan itu, plus baris di `CHANGELOG.md`.
- Isi template PR: apa yang berubah, issue yang ditutup, dan cara menguji.
- Jangan kirim API key, token, atau data pelanggan di issue/PR/log.
- Vulnerability keamanan: jangan issue publik — lihat `SECURITY.md` bila ada, atau hubungi pemilik repo.

## Kode perilaku

- PR kecil dan terfokus lebih mudah direview daripada satu PR besar.
- Ikuti gaya kode yang sudah ada; jangan refactor yang tidak diminta.
- Issue dengan label `bug` harus punya langkah reproduksi.
