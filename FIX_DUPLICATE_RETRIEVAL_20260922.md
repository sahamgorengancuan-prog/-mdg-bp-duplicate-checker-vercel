# BP Duplicate Checker — comprehensive false-PASS retrieval fix (2026-09-22)

## Problem reproduced

`110035698 / Wr Santi` was present in BP_DATABASE row 295606 and all old indexes, but the old fuzzy code visited the shorter length buckets first. The exact row would have been scanned at candidate 250924, beyond the default 60000 cap. The old code could return PASS or an earlier, worse candidate even though an exact name+address BP existed.

## What this release changes

1. `scripts/sync_gsheet_indexed.py`: creates `EXACT_INDEX` (SHA-256 normalized name, field separator, normalized address; BP_DATABASE row; BP ID; sync ID) and `INDEX_EXACT_SHARD` (256 hash-prefix range index). Keeps the existing `BP_DATABASE A:H`, `KTP_INDEX A:D`, `INDEX_LEN A:E`, `INDEX_KTP_SHARD A:E` intact. Uses the same Unicode normalization as the API. No KTP is needed to find exact name+address matches.
2. The sync writes `META.sync_state=IN_PROGRESS` **before** touching other tabs and sets `META.sync_state=READY` only after all six data/index tabs complete. If a sync fails mid-write, the API refuses a check instead of silently treating incomplete data as ready.
3. `_lib/duplicate.js`: KTP exact (existing) -> indexed exact name+address -> fuzzy length buckets nearest-first. Exact hash hits verify the pointed BP ID, both normalized fields, and sync generation. Multiple identical BP records are counted; up to five previews are returned. Does not use the fuzzy candidate cap.
4. Fuzzy results retain the best score among examined candidates rather than stopping on the first qualifying row. A capped search with no hit returns `INCONCLUSIVE`, not PASS. A matching candidate can still produce FAIL, with partial coverage disclosed.
5. META, index counts/ranges and row `sync_id`s are fail-closed (HTTP 503) on missing/mixed snapshot data. Google Sheets read errors are returned as errors, not empty matches. The health API requires READY + version 1 exact index.
6. Frontend displays `INCONCLUSIVE` distinctly; it is never styled as a green PASS.
7. The Google Sheets writer removes the old accidental 10-column padding from large tabs; quota is checked before any sheet is cleared. New exact index at ~396k BP costs ~1.6 million extra cells, rather than ~4 million.
8. BAT sync scripts support the main Python launcher if an existing `.venv` is missing the required libraries. Nothing in this package contains live Google or PostgreSQL credentials.

## IMPORTANT deployment order

**Do not deploy the new API before syncing with the new Python script.** The new API deliberately returns 503 on old snapshots rather than returning false PASS. The old API can still use the existing tabs while the new sync finishes, but a mixed snapshot may temporarily return 503.

1. Back up your existing project folder and preserve its `.env`, `oauth_token.json`, and `client_secret_oauth.json` locally. These are intentionally **not included** in the ZIP; do not share or push them to Git.
2. Extract the supplied ZIP and copy its application source over your existing project, preserving your private `.env`/OAuth files. The `BP_DATABASE` tab is not edited until you explicitly run the sync.
3. From CMD, inside your existing project folder:

   ```bat
   py -m pip install -r scripts\requirements.txt
   py scripts\sync_gsheet_indexed.py
   ```

   Or run `bats\fix_dependencies_and_sync.bat`. Run this **once** to build the two new tabs. The original 09:00/15:00 scheduler can then use the updated `bats\sync_to_gsheet_now.bat`.
4. Inspect `META`: `sync_state=READY`, `exact_index_version=1`, `total_exact_index_rows=total_bp_rows`, `sync_id` equal across all seven tabs.
5. Deploy the updated `_lib/duplicate.js`, `api/`, `public/`, `server.js` and `package.json` through the **same** hosting deployment mechanism as your current app (Vercel/Koyeb). Environment settings (`SHEET_ID`, OAuth refresh token) remain on your existing host; never put credentials into a ZIP/repo.
6. Check `/api/health` → `ok:true`, `sheet_ok:true`, latest `META.sync_id`. Submit POST `/api/check`:

   ```json
   {"name_1":"Wr Santi","address":"Kp Cisaat Lebak RT 013 RW 003 Kel Bolang Kec Malingping Stlh Sdn 3 Bolang","ktp_number":""}
   ```

   Expected `decision=FAIL`, `exact_name_address_match.bp_id=110035698`, `score=100`, **without** KTP.

## Decision semantics

| Decision | Meaning |
|---|---|
| FAIL | Confirmed exact KTP, exact name+address, or fuzzy threshold match. |
| PASS | No exact/fuzzy match after the configured retrieval window was fully checked. Length tolerance and business-rule thresholds still apply. |
| INCONCLUSIVE | Search space exceeded the configured candidate cap or insufficient text was provided. Must not be treated as PASS or approval. |
| HTTP 503 | Index, sheet generation, pointer, or metadata unsafe/incomplete; must not be treated as PASS. |

Note: the 60k candidate cap is retained for fuzzy to control Google API cost. This release guarantees that **exact Name 1 + Address matches** are not hidden by that cap. A fuzzy-only near-duplicate outside the configured retrieval space may remain undetected; partial scans are now explicitly INCONCLUSIVE, never falsely represented as a complete PASS.

## Local test commands

```bat
node --version
npm run check
npm test
py -m pytest -q tests\test_sync_indexes.py
```

Live Google Sheet/API verification is necessary after deploying. The tests use synthetic data and do not access or mutate the company's production database or spreadsheets.
