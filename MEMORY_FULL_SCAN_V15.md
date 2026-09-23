# v15 — In-memory full scan (semua BP, tanpa MAX_CANDIDATES, ≤30 detik)

## Kenapa v14 tidak bisa mencapai target

v14 membaca range Google Sheets **di setiap check**. Google membatasi
±60 read/menit per user OAuth, dan engine sengaja memakai budget 36/menit.
Satu read memuat paling banyak ~3.000 posting, jadi full scan ±300k kandidat
butuh ±100 read, atau beberapa menit. Karena itu hasilnya INCONCLUSIVE lalu
Full Scope. Menaikkan MAX_CANDIDATES ke 300k tidak bisa cepat. Ini batas
arsitektur, bukan soal tuning.

## Arsitektur v15

```
PostgreSQL ──(BAT, tiap 2 jam)──> A/A2 atau B/B2 (standby) ──> CONTROL publish
                                   │
                                   └─ A2/B2: tab PACKED_SNAPSHOT
                                      semua BP aktif dalam 1 TSV gzip+base64,
                                      ±17 MB dibagi ±450 cell (bukan jutaan cell)

Render: saat boot dan setiap CONTROL berganti sync_id
   baca CONTROL + META + PACKED_SNAPSHOT (±8 request Google, sekali saja)
   verifikasi sync_id per part + SHA-256 + jumlah BP
   bangun index di RAM (norm text, token, histogram, exact hash, KTP)
Setiap /api/check: 0 read Google, semua BP dievaluasi di memori
```

Sumber data engine memory, berurutan:

1. **`packed`**: PACKED_SNAPSHOT (±8 request, paling hemat RAM).
2. **`v14_tabs`**: kalau PACKED_SNAPSHOT belum ada atau gagal verifikasi,
   engine membangun index yang sama dari tab v14 pair aktif
   (INDEX_LEN_TOKEN + KTP_INDEX, ±24 request, ±60 MB, sekali per generasi).
   Full scan langsung aktif tanpa menunggu sync baru. PASS tidak perlu read
   Google; FAIL membaca baris BP yang cocok dari BP_DATABASE (1 batch) dan
   memverifikasinya seperti v14. CONTROL dicek ulang setelah load.
3. **Engine keyed v14** (Full Scope + cooldown quota) hanya dipakai kalau
   kedua sumber di atas tidak konsisten atau tidak terbaca. Alasannya tampil
   di `/api/health` → `memory.fallback_reason` dan di log UI.

Engine memory tidak pernah mengeluarkan PASS dari data yang belum terverifikasi.

Ukuran 400k BP (sintetis) via `v14_tabs`: cold start ±7,5 detik (+ transfer
Google ±60 MB), check p50 ±0,13 detik, memori engine +243 MB (puncak load
+387 MB). Mode `packed` lebih hemat, jadi tetap jalankan BAT sync baru.

## Akurasi (keputusan identik dengan engine lama)

Keputusan akhir untuk kandidat mana pun tetap `computeSimilarity()` yang
sama (Levenshtein, soft Jaccard, Numeric Weighted, dan direct reject). Kandidat
hanya dilewati kalau **batas atas yang terbukti secara matematis** menunjukkan
tidak ada aturan yang bisa mencapai FAIL:

- Levenshtein: bag distance (histogram karakter) ≤ edit distance. Profil
  bigram L1/4 ≤ edit distance. Setelah itu banded Levenshtein yang eksak.
- Soft Jaccard: jumlah pasangan ≤ jumlah token kandidat yang "dekat"
  (aturan `tokenPairSimilarity ≥ 75` yang sama) dengan token query.
- Numeric ≤ 100. Bobot negatif atau tidak valid membuat kandidat tidak dipangkas.

Aturan toleransi panjang (`LENGTH_TOLERANCE_PERCENT`) tetap berlaku sama
seperti sebelumnya. Dengan default (80/92, bobot 60/30/10), jalur weighted
secara matematis tidak mungkin FAIL (maksimum 82 < 92), jadi hanya direct
reject yang perlu diuji.

Bukti: `tests/memory_engine.test.mjs` membandingkan hasil scan dengan
brute-force `computeSimilarity` di **setiap** BP: jumlah match dan top-5
harus sama persis, termasuk untuk konfigurasi non-default. Pengujian lokal
tambahan: 280 query × 7 konfigurasi, 0 selisih. Paritas Python→JS (norm,
exact hash, KTP) juga diuji di CI.

## Hasil ukur (data sintetis 400.000 BP, ±200k token unik, 1 core)

| Tahap | Waktu |
|---|---|
| Cold start (baca 17 MB + build index) sampai keputusan pertama | ±8–9 detik |
| Check biasa (full scan semua BP) | p50 ±0,1–0,2 detik, p95 ±0,35 detik |
| Exact KTP | ±1 ms |
| Read Google Sheets per check | 0 |
| Memori puncak / stabil | ±350–400 MB / ±360 MB RSS |

Catatan hosting: plan Render **Free / 0,1 CPU** kira-kira 10× lebih lambat
(cold start ±60–90 detik, check ±1–3 detik). Instance free juga tidur setelah
idle, sehingga request pertama menunggu instance bangun lalu load snapshot.
Supaya ≤30 detik konsisten, pakai instance yang selalu hidup (Starter 0,5
CPU atau lebih). Memori ±0,5 KB per BP: 512 MB cukup sampai ±600k BP; di
atas itu pakai 1 GB. Ukur sendiri dengan
`node tools/bench_memory_engine.mjs 400000`.

## Keputusan

| Keputusan | Arti |
|---|---|
| FAIL | KTP exact, Name+Address exact, atau similarity ≥ aturan (top-5 dikembalikan) |
| PASS | Semua BP dievaluasi (di-scoring atau dieliminasi batas atas yang terbukti) |
| INCONCLUSIVE | Hanya untuk input yang terlalu pendek (tanpa KTP dan teks < 3 karakter) |
| HTTP 503 `warming` | Generasi baru sedang dimuat; UI otomatis mengulang input yang sama |

## Rollout

1. **Deploy Render** dari branch ini. Aman diurutkan dulu: selama
   PACKED_SNAPSHOT belum ada, `/api/health` menampilkan
   `memory.fallback_reason=PACKED_SNAPSHOT_MISSING` dan check memakai v14.
2. **Copy ke folder lokal Windows**: `scripts\sync_bp_keyed.py`,
   `scripts\requirements.txt`, dan semua file `bats\`. `.env` dan token OAuth
   tidak berubah.
3. Jalankan `bats\sync_to_gsheet_now.bat` sekali. Walaupun data Postgres tidak
   berubah, sync ini mem-publish generasi baru karena pair aktif belum punya
   PACKED_SNAPSHOT. Log yang diharapkan:
   `Packed snapshot: … parts` → `PACKED_SNAPSHOT WRITTEN+VERIFIED` → `PUBLISHED`.
   Sync berikutnya dengan data yang sama akan NOOP.
4. Cek `https://<render>/api/health`: harus `search_backend: MEMORY_FULL_SCAN`
   dan `memory.records` = total BP.
5. Jadwal tiap 2 jam: `bats\setup_windows_scheduler_every_2h.bat` (hapus
   jadwal 09:00/15:00 lama dengan `bats\remove_windows_scheduler.bat`).

### Perbaikan "This document is too large to continue editing"

Tab index v12/v13 yang tertinggal di workbook **primary** (A) tidak pernah
dipakai di v14+, tetapi membuat A melewati batas ukuran Google. Sekarang,
sebelum workbook primary standby dipakai staging, tab `INDEX_LEN_TOKEN`,
`INDEX_LEN`, `KTP_INDEX`, `INDEX_KTP_SHARD`, `EXACT_INDEX`, dan
`INDEX_EXACT_SHARD` di workbook itu dihapus. BP_DATABASE dan META tetap ada,
dan pair aktif tidak pernah disentuh. Kalau Google tetap menolak, sync berhenti
dengan instruksi (hapus manual tab tersebut) dan pointer aktif tidak berubah.

## Log aktivitas (UI, pojok kanan atas)

Tombol **Log** mencatat setiap langkah di browser: health, submit, setiap
request `/api/check` (HTTP, waktu client/server, backend, sumber memory,
alasan fallback, sync_id, trace per step server), retry warming, tunggu quota,
progres Full Scope, reload versi, dan error JS/jaringan. Badge merah
menunjukkan jumlah error. **Download .txt / .json** juga menyertakan snapshot
`/api/health` terbaru. KTP selalu di-mask. Log disimpan di browser (1.000
entri terakhir) dan bisa dihapus dengan Clear. Kirim file ini saat
melaporkan masalah.

## Environment (Render)

| Variable | Default | Keterangan |
|---|---|---|
| `GSHEET_SNAPSHOT_MODE` | `legacy` | Harus `dual` |
| `SNAPSHOT_ENGINE` | `memory` | `keyed` = paksa engine v14 (rollback tanpa redeploy kode) |
| `SNAPSHOT_POLL_SECONDS` | `60` | Interval cek CONTROL di background |
| `SNAPSHOT_VERIFY_MAX_AGE_SECONDS` | `180` | Umur maksimum verifikasi CONTROL sebelum check memverifikasi ulang |
| `SNAPSHOT_LOAD_WAIT_MS` | `20000` | Lama check menunggu load generasi baru sebelum 503 `warming` |
| `SNAPSHOT_V14_TABS` | `on` | `off` = jangan bangun index memory dari tab v14 (langsung fallback keyed) |
| `SNAPSHOT_MAX_CHECK_MS` | `25000` | Batas CPU per check (pengaman konfigurasi ekstrem; tidak pernah PASS parsial) |

Windows `.env` (opsional): `GSHEET_PACKED_SNAPSHOT=off` mematikan penulisan
PACKED_SNAPSHOT (engine akan fallback ke v14).
