# v11: Private precomputed duplicate index + key-only incremental Sheets sync

## Intent and non-negotiable safety

The old BP_DATABASE sheet is sorted by length/token, and the old KTP/EXACT
indexes contain **physical BP_DATABASE row pointers**. Updating a BP's name,
address or length in place makes those legacy indexes unsound. A keyed
incremental Google Sheet CANNOT be combined with the legacy Sheets duplicate
checker. This patch therefore supports two explicit, mutually exclusive modes:

- PRIVATE_INDEX_MODE=off (default): legacy v10 Google Sheets checker only.
  Do NOT run the new keyed sync in this mode.
- PRIVATE_INDEX_MODE=required: transaction checks a privately hosted PostgreSQL
  index, never Google Sheets. If the private DB is unavailable, return 503,
  never silently fall back to the now-stale Sheets index.

Do not deploy company BP data to an unapproved personal/public database.
Obtain authorization and deploy a protected TLS PostgreSQL instance. Raw KTP
is NOT stored in the private search DB; KTP lookup uses HMAC-SHA256 with a
private, stable key. Name/address still require approved protected storage.

## Authorize/provision (no secrets in GitHub)

Configure the same private DB and HMAC key in laptop .env and Render secrets:

- PRIVATE_INDEX_DATABASE_URL=postgresql://... (TLS verify-full)
- PRIVATE_INDEX_KTP_HMAC_KEY=<random secret >=32 chars; stable across syncs>
- PRIVATE_INDEX_CURSOR_SECRET=<different random secret >=32 chars>
- PRIVATE_INDEX_MODE=required
- PRIVATE_INDEX_SSLMODE=verify-full (Windows; default)
- PRIVATE_INDEX_DB_CA_PEM=<root CA in Render only, if not OS-trusted>

Ensure Windows sync and Render can reach private PostgreSQL over an approved
network. Never paste secrets, tokens or DB URLs into chat or source control.

## Cutover order

1. Deploy main with default PRIVATE_INDEX_MODE=off. This does not write data.
2. Schedule a short maintenance window and switch Render to
   PRIVATE_INDEX_MODE=required; /api/health intentionally returns 503 until
   the first private sync commits. Never run keyed sync while Render is in
   legacy mode: it will invalidate the old row-pointer lookup.
3. Patch the laptop files **sync_bp_keyed.py** and **sync_to_gsheet_now.bat**.
   Existing local files are not automatically updated by a GitHub commit.
4. Run ONE manual sync, after PostgreSQL DNS/VPN is healthy, ensuring no
   scheduled sync is already running. The existing OS lock is reused.
5. The job fetches MDG rows, rejects blank/duplicate bp_id before writing,
   computes normalized text, text length, unique-token count, exact hash,
   change hash and keyed KTP HMAC. Private PostgreSQL writes only changed
   durable BP rows (ON CONFLICT WHERE row_hash differs), appends new IDs and
   tombstones absent IDs, then recomputes compact groups and commits META
   atomically in ONE transaction. Requests see old or new snapshot, never
   a partially published database.
6. Next it updates protected BP_DATABASE Google Sheet BY bp_id:
   * Existing unchanged A:G rows are preserved.
   * Existing changed records update their existing A:H rows.
   * New keys append only; missing keys get H=DELETED (no physical delete).
   * Initial migration necessarily populates H=row_hash for old rows in
     compact column batches. It does NOT clear/repopulate the old sheet.
   * Old META is set IN_PROGRESS before the first in-place change and NOT
     reset READY. This makes accidental legacy fallback fail closed.
   * KEYED_SYNC_META becomes READY only after all keyed updates succeed.
   * On failure: rerun; hashes and keys allow reconciliation, no clear.
7. Verify /api/health search_backend=PRIVATE_POSTGRES_INDEX,
   meta.sync_state=READY, total_bp_rows and newest sync ID. Check Google
   KEYED_SYNC_META READY for mirror health.

IMPORTANT: current source query may duplicate bp_id due to its joined
completion records. The keyed job explicitly REFUSES ambiguous bp_id.
Supply a stable unique source record identity before enabling duplicate
BP_ID rows. Never use name/address hash as a stable key: edits would produce
a different key and leave false duplicates. Do not bypass this guard.

The old manual full-sync script remains in the repo for an explicit rollback,
but the scheduled BAT no longer calls it. Rolling back to legacy requires a
fresh, complete rebuild of *all* legacy indexes before publishing old META
READY. Never flip PRIVATE_INDEX_MODE=off against an incrementally updated
BP_DATABASE.

## SLA, quota and capacity

Google Sheets is a secondary mirror only; transactions in private required
mode do not consume Sheets read quota. Search uses B-tree group pointers,
exact SHA256/HMAC lookup, score-safe upper bounds and original similarity
math. Normal checks are bounded, with signed continuation for hard cases;
PASS requires full configured length-scope coverage, not an arbitrary top-K
retrieval. Live latency must be benchmarked; code does NOT establish a
guaranteed sub-3-minute complete search SLA.

The first 396k-row hash bootstrap still writes the new hash column once.
Every subsequent sync writes only changed existing keys, newly appended
keys and tombstones. No clear(), delete or full BP row refill.

The user's prior two-hour laptop schedule cannot guarantee a maximum
90-minute data age. Reconfigure the schedule to <=60 minutes if 90 minutes
is a hard freshness SLA, allowing room for sync runtime and laptop offline
periods. Ensure only one job runs at a time.
