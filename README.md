# MDG BP Duplicate Checker — Vercel Ready

> **Status terkini (v15):** Render memakai engine **in-memory full scan**. Semua BP
> dicek di setiap request, tanpa `MAX_CANDIDATES`, dengan 0 read Google Sheets per
> check. Sync Windows menulis tab `PACKED_SNAPSHOT` di A2/B2. Arsitektur, rollout,
> hasil benchmark, dan env var ada di **[MEMORY_FULL_SCAN_V15.md](MEMORY_FULL_SCAN_V15.md)**.
> Bagian di bawah ini adalah dokumentasi awal (legacy mode) dan tetap berlaku untuk
> `GSHEET_SNAPSHOT_MODE=legacy`.

Versi ini adalah hasil port dari paket **Cloudflare Pages GitHub Import** ke **Vercel**.
Dasar project ini merupakan port Cloudflare ke Vercel. Paket ini juga memuat patch direct reject Levenshtein/Jaccard yang dijelaskan pada bagian 3b.

## Ringkasan fitur dan perubahan

Fitur dasar yang tetap digunakan:

- Algoritma duplicate check: KTP exact match (via shard index) → direct reject Levenshtein/Jaccard → fallback Combined Weighted Similarity.
- Default utama: `SIMILARITY_DIRECT_REJECT_THRESHOLD=80`, `SIMILARITY_THRESHOLD=92`, `MAX_CANDIDATES=60000`, `MAX_BATCH_ROWS=10000`, `RANGE_CACHE_SECONDS=300`, dan `RATE_LIMIT_PER_MIN=60`.
- Default bobot similarity: Levenshtein 60% + Jaccard 30% + Numeric Weighted 10% (bisa diubah lewat environment variable, lihat bagian 3a).
- Semua nama environment variable: `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON_B64` (atau `GOOGLE_SERVICE_ACCOUNT_JSON`, atau pasangan `GOOGLE_CLIENT_EMAIL`+`GOOGLE_PRIVATE_KEY`), `API_ACCESS_CODE`, `REQUIRE_API_ACCESS_CODE`, dst.
- JWT RS256 signing ke Google OAuth (pakai Web Crypto `crypto.subtle`, tidak berubah).
- Rate limit + in-memory cache per warm instance (best-effort, karakteristiknya sama seperti di Cloudflare Worker — bukan distributed, akan reset kalau instance-nya cold start).
- Response shape JSON, CORS header, security header (`X-Frame-Options`, dll — sekarang lewat `vercel.json` bukan `_headers`, tapi value-nya sama).
- Frontend `public/index.html` tetap memakai form dan fetch yang sama, dengan tambahan tampilan Direct Reject Threshold serta status weighted calculation skipped.

Perubahan platform yang tetap dipertahankan dari versi Vercel:

- `functions/api/*.js` (Cloudflare `onRequestGet`/`onRequestPost`) → `api/*.js` (Vercel `export default { fetch(request) }`). Isinya cuma routing tipis, langsung panggil fungsi yang sama dari `_lib/duplicate.js`.
- `context.env` (Cloudflare bindings) → `process.env` (Node.js). Adapter di `api/*.js` yang menjembatani ini; `_lib/duplicate.js` sendiri tidak tahu bedanya.
- `wrangler.toml` dihapus, diganti `vercel.json` + `package.json` (perlu `"type": "module"` supaya Node membaca sintaks `import`/`export`).
- `public/_headers` dihapus, digantikan blok `headers` di `vercel.json` dengan value yang sama.
- 3 baris teks kosmetik di UI ("Cloudflare edge API" dsb) diganti jadi "Vercel serverless API" supaya tidak menyesatkan — bukan perubahan fungsi.
- `tools/service_account_to_cloudflare_secret.py` → `tools/service_account_to_vercel_env.py`: logic base64-encode-nya identik, cuma label output yang disesuaikan.

## Struktur repo

```text
api/
  check.js               # POST /api/check  (+ GET info, + OPTIONS)
  health.js               # GET /api/health  (+ OPTIONS)
  index.js                # GET /api

_lib/
  duplicate.js             # Google Sheet + duplicate engine — TIDAK BERUBAH dari versi Cloudflare

public/
  index.html               # UI frontend (sama persis, minus 3 label kosmetik)

scripts/
  sync_gsheet_indexed.py   # PostgreSQL MDG -> Protected Google Sheet indexed database
  requirements.txt

bats/
  install_sync_python.bat
  sync_to_gsheet_now.bat
  setup_windows_scheduler_0900_1500.bat
  remove_windows_scheduler.bat
  git_push_manual_template.bat

tools/
  service_account_to_vercel_env.py

vercel.json                # Headers + rewrite /api -> /api/index + output directory
package.json                # "type": "module" supaya import/export jalan di Node
.env.example                 # Template env lokal untuk sync script (tidak dipakai Vercel runtime)
.gitignore
```

---

## 1. Push folder ini ke Git (GitHub/GitLab/Bitbucket)

Buat repository, misalnya private, bernama `mdg-bp-duplicate-checker`, lalu upload semua isi paket ini ke root repo. Bisa pakai `bats\git_push_manual_template.bat` (edit `REPO_URL` dulu).

Jangan commit:

```text
.env
service_account.json
```

Kalau tidak mau pakai Git sama sekali, langsung lompat ke opsi CLI di langkah 2.

---

## 2. Deploy ke Vercel

### Opsi A — Import Git repository (paling gampang)

```text
vercel.com/new
→ Import Git Repository
→ pilih repo Anda
```

Build settings (biasanya otomatis terdeteksi karena ada `vercel.json`, tapi kalau diminta manual):

| Setting | Value |
|---|---|
| Framework Preset | `Other` |
| Build Command | kosongkan |
| Output Directory | `public` (sudah di-set lewat `vercel.json`) |
| Root Directory | `/` |
| Install Command | kosongkan (tidak ada dependency npm) |

Deploy.

### Opsi B — Vercel CLI (tanpa Git)

```bash
npm i -g vercel
cd mdg_bp_duplicate_checker_vercel_ready
vercel link
vercel --prod
```

---

## 3. Tambahkan Environment Variables di Vercel

Masuk ke:

```text
Vercel Dashboard
→ Project Anda
→ Settings
→ Environment Variables
```

### Variable non-secret (opsional)

Default-nya sudah tertanam di `_lib/duplicate.js` (persis sama dengan yang dulu ada di `wrangler.toml`), jadi **tidak wajib diisi** untuk deploy pertama. Isi manual di sini kalau mau override:

| Name | Value default kalau tidak diisi |
|---|---|
| `SHEET_ID` | `1VepIImbAMSMaDvRo6Vos9nRzxjiVWUYcestTizNJSjo` |
| `SIMILARITY_THRESHOLD` | `92` |
| `SIMILARITY_DIRECT_REJECT_THRESHOLD` | `80` |
| `MAX_CANDIDATES` | `60000` |
| `MAX_BATCH_ROWS` | `10000` |
| `RANGE_CACHE_SECONDS` | `300` |
| `RATE_LIMIT_PER_MIN` | `60` |

Terapkan ke environment **Production** (dan **Preview** kalau Anda juga test dari preview deployment).

### 3a. Bobot similarity (bisa di-set)

Kombinasi skor `Name 1 + Address` sekarang bisa diatur bobotnya lewat environment variable — tidak perlu edit kode atau redeploy ulang selain menambah variable dan redeploy:

| Name | Default | Keterangan |
|---|---|---|
| `SIMILARITY_WEIGHT_LEVENSHTEIN` | `60` | Bobot kemiripan karakter (edit distance) |
| `SIMILARITY_WEIGHT_JACCARD` | `30` | Bobot kemiripan token/kata |
| `SIMILARITY_WEIGHT_NUMERIC` | `10` | Bobot kemiripan angka (nomor jalan, RT/RW, dll di dalam address) |

Tiga nilai ini **otomatis dinormalisasi berdasarkan jumlahnya sendiri**, jadi tidak wajib totalnya 100. Contoh, `6/3/1` menghasilkan proporsi yang sama persis dengan `60/30/10`. Kalau salah satu di-set jadi `0`, komponen itu praktis dimatikan dari skor gabungan. Kalau ketiganya kosong/tidak valid, otomatis fallback ke default `60/30/10` (tidak akan pernah menghasilkan NaN/divide-by-zero).

Cek bobot yang sedang aktif kapan saja lewat `GET /api/health` → `config.similarity_weights` (ditampilkan dalam persen, sudah ternormalisasi).


### 3b. Direct reject Levenshtein/Jaccard

Sebelum menghitung Numeric Weighted dan skor gabungan, sistem mengecek dua metrik utama secara berurutan:

1. Jika Levenshtein ≥ `SIMILARITY_DIRECT_REJECT_THRESHOLD`, hasil langsung `FAIL`.
2. Jika Levenshtein masih di bawah batas tetapi Jaccard ≥ `SIMILARITY_DIRECT_REJECT_THRESHOLD`, hasil langsung `FAIL`.
3. Hanya ketika keduanya di bawah batas, Numeric Weighted dan Combined Weighted dihitung lalu dibandingkan dengan `SIMILARITY_THRESHOLD`.

Default batas direct reject adalah `80`. Nilai aktif dapat dilihat melalui `GET /api/health` → `config.similarity_direct_reject_threshold`. Setelah mengubah environment variable di Vercel, lakukan redeploy.

### 3c. Perbaikan "terlalu sensitif" (length tolerance + fuzzy matching)

Sebelumnya sistem ini punya 3 bug konkret yang bikin variasi kecil (typo 1 huruf, kata yang hilang, satu angka beda) gagal terbaca sebagai mirip:

1. **Hard cutoff panjang teks ±5 karakter** — muncul di 3 tempat (window bucket pencarian, skip per-row, dan bahkan di dalam `levenshteinSimilarity` sendiri). Begitu ada kata yang hilang/ditambah (misal "Timan" atau "Kec Ciledug" hilang), kandidat langsung di-skip total, bukan cuma dapat skor rendah.
2. **Jaccard exact-token-match** — "Sembako" vs "Sembayo" (typo 1 huruf) dihitung sebagai token yang 100% beda, padahal cuma beda 1 karakter.
3. **Numeric similarity yang tanpa sadar rusak** — "No 105 RT 001 RW 002" digabung jadi satu blok digit "105001002" sebelum dibandingkan, jadi begitu nomor rumah beda 1 angka, seluruh blok dianggap 0% mirip walau RT/RW-nya identik.

Fix yang diterapkan:

- Panjang teks sekarang toleran secara proporsional (persentase dari panjang teks, bukan angka mati 5 karakter), dan **bisa di-set**:

| Name | Default | Keterangan |
|---|---|---|
| `LENGTH_TOLERANCE_PERCENT` | `30` | Toleransi selisih panjang teks ternormalisasi, dalam persen dari panjang query |
| `LENGTH_TOLERANCE_MIN_CHARS` | `12` | Batas minimum toleransi (untuk query pendek) |

  Cek juga lewat `GET /api/health` → `config.length_tolerance_percent` / `length_tolerance_min_chars`.
- Jaccard sekarang fuzzy: token ≥4 karakter yang cuma beda 1-2 huruf dapat partial credit (bukan 0 total). Token pendek (rt/rw/gg, dsb) tetap harus exact match, supaya tidak salah-cocok kode administratif.
- Numeric similarity sekarang membandingkan angka per-chunk (nomor rumah, RT, RW dibandingkan terpisah, bukan digabung jadi satu blok), dan juga fuzzy untuk selisih 1 digit.

Trade-off yang perlu diketahui: window pencarian panjang teks yang lebih lebar berarti lebih banyak baris di-scan/lebih banyak Google Sheets range yang di-fetch per request (dibatasi tetap oleh `MAX_CANDIDATES`/`MAX_BATCH_ROWS` dan early-exit begitu ketemu match ≥ threshold). Kalau database Anda sangat besar dan mulai terasa lambat, turunkan `LENGTH_TOLERANCE_PERCENT`.

Catatan lain: kombinasi 3 perubahan sekaligus (kata hilang + 2 typo) akan tetap menghasilkan skor lebih rendah daripada kombinasi 1-2 perubahan saja — ini disengaja (algoritma tetap membedakan derajat perubahan, bukan jadi all-or-nothing). Kalau kombinasi seagresif itu tetap ingin ke-flag sebagai duplikat, turunkan `SIMILARITY_THRESHOLD` sedikit (dengan konsekuensi false-positive yang sedikit naik untuk alamat yang benar-benar beda).

### Secret wajib

Di laptop/server Windows, taruh `service_account.json` di root project lokal, lalu jalankan:

```bat
python tools\service_account_to_vercel_env.py
```

Copy output base64-nya, lalu buat environment variable:

| Name | Value | Catatan |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | hasil base64 dari script | Centang **Sensitive** |

Setelah menambah/mengubah environment variable, Vercel **tidak otomatis redeploy** — trigger **Redeploy** dari dashboard atau push commit kecil.

### Access control

Sama seperti versi Cloudflare: frontend tidak minta API URL atau Access Code dari user. `API_ACCESS_CODE` + `REQUIRE_API_ACCESS_CODE=true` masih tersedia hanya untuk skenario server-to-server. Untuk proteksi production, pakai **Vercel Deployment Protection** (Settings → Deployment Protection — bisa Password Protection atau Vercel Authentication/SSO tergantung plan), setara dengan Cloudflare Access / Zero Trust di versi lama.

---

## 4. Share Google Sheet ke service account

Sama seperti sebelumnya — buka `service_account.json`, cari `client_email`, lalu share Google Sheet ini ke email tersebut sebagai **Editor**:

```text
https://docs.google.com/spreadsheets/d/1VepIImbAMSMaDvRo6Vos9nRzxjiVWUYcestTizNJSjo/edit
```

Jangan publish Sheet ke web, jangan share ke user umum, proteksi tab database/index.

---

## 5. Jalankan sync database ke Google Sheet

Tidak berubah dari versi Cloudflare — sync ini jalan lokal/Windows server, tidak bergantung platform hosting API-nya:

```bat
bats\install_sync_python.bat
bats\sync_to_gsheet_now.bat
bats\setup_windows_scheduler_0900_1500.bat
```

Sheet harus punya tab: `BP_DATABASE`, `KTP_INDEX`, `INDEX_LEN`, `INDEX_KTP_SHARD`, `META`.

---

## 6. Test API

Buka:

```text
https://PROJECT.vercel.app/api/health
```

Expected kalau benar:

```json
{
  "ok": true,
  "service": "MDG BP Duplicate Checker API",
  "config": { "sheet_id_configured": true, "service_account_configured": true },
  "sheet_ok": true,
  "meta": { "last_sync_at": "..." }
}
```

`service_account_configured=false` → secret belum masuk atau belum redeploy.
`sheet_ok=false` → cek sharing Google Sheet ke service account, dan pastikan tab hasil sync sudah ada.

---

## 7. Cara kerja duplicate check

User input: Name 1, Address, KTP Number.

Rule gagal (`decision: "FAIL"`):

1. `KTP Number` exact match dengan `ktp_number` di protected Google Sheet (lookup via `INDEX_KTP_SHARD`).
2. `Name 1 + Address` langsung gagal jika Levenshtein atau Jaccard ≥ `SIMILARITY_DIRECT_REJECT_THRESHOLD` (default `80`); perhitungan weighted dilewati.
3. Jika kedua metrik tersebut di bawah direct-reject threshold, sistem menghitung Combined Weighted Similarity dan gagal jika skornya ≥ `SIMILARITY_THRESHOLD`.

Optimasi: tidak scan 1 juta row langsung, fetch batch (`MAX_BATCH_ROWS`), stop begitu match di atas threshold ditemukan, range Google Sheets di-cache sementara per warm function instance.

---

## 8. Security production recommended

1. Repository Git private.
2. Jangan commit `.env` dan `service_account.json`.
3. Google Sheet jangan dipublish, share hanya ke service account dan admin.
4. Jangan expose Sheet ID/credential ke frontend (sudah begitu by design).
5. Aktifkan **Vercel Deployment Protection** untuk restrict akses domain/user internal.
6. Jangan set `REQUIRE_API_ACCESS_CODE=true` kecuali API dipakai server-to-server.
7. Tandai `GOOGLE_SERVICE_ACCOUNT_JSON_B64` sebagai **Sensitive** di Vercel Environment Variables.

---

## 9. Troubleshooting cepat (khusus Vercel)

### Deployment gagal dengan error `SyntaxError: Unexpected token 'export'`

`package.json` belum ke-upload atau `"type": "module"` hilang. File `.js` di project ini pakai sintaks ES module (`import`/`export`), Node butuh `"type": "module"` di `package.json` untuk membacanya.

### `Google service account secret is not configured`

- Tambahkan environment variable `GOOGLE_SERVICE_ACCOUNT_JSON_B64` di Production.
- Redeploy setelah menambah variable (perubahan env var tidak auto-redeploy).

### `Google Sheets API error 403`

Google Sheet belum dishare ke service account `client_email`, atau service account salah project/file.

### `FUNCTION_INVOCATION_TIMEOUT`

Default duration function di Vercel (dengan Fluid Compute, aktif by default) adalah 300 detik di Hobby maupun Pro — biasanya lebih dari cukup untuk `MAX_CANDIDATES=60000`. Kalau tetap timeout (Sheet sangat besar / API Google lambat), turunkan `MAX_CANDIDATES`/`MAX_BATCH_ROWS`, atau tambahkan `functions` config di `vercel.json`:

```json
"functions": { "api/check.js": { "maxDuration": 120 } }
```

### `GET /api` mengembalikan 404

Pastikan `vercel.json` ikut ter-upload — ada rule `rewrites` yang mengarahkan `/api` ke `/api/index`.

### `Unable to parse range` / `Google Sheets API error 400`

Sync belum membuat tab `BP_DATABASE`/`KTP_INDEX`/`INDEX_LEN`/`INDEX_KTP_SHARD`/`META`, atau nama tab berubah.

---

## 10. Query default sync (tidak berubah)

```sql
SELECT
    bgv.bp_id::text AS bp_id,
    bgv.bp_type_id::text AS bp_type_id,
    COALESCE(bgv.name_1, '')::text AS name_1,
    COALESCE(bgv.address, '')::text AS address,
    COALESCE(mbdc.ktp_number, '')::text AS ktp_number
FROM m_bp_general_view bgv
LEFT JOIN m_bp_doc_completion mbdc
       ON mbdc.bp_id = bgv.bp_id
WHERE bgv.bp_id IS NOT NULL;
```

Kalau actual address bukan `bgv.address`, override via `.env` `DB_QUERY` atau edit `scripts/sync_gsheet_indexed.py`.
