# v7: Google Sheets 429 quota-safe search

Google Sheets has a 60 read-requests/minute/user/project quota; the same
OAuth user quota can also be consumed by Windows sync or other services.
Every getSheetRange call previously consumed a separate read, including
two fresh META reads per full-scope chunk. A UI delay of only 1.3 seconds
could exceed the quota rapidly even when all rows are relevant.

Controls:
- MAX 36 Google Sheet reads per minute per Node process. This is a
  conservative local ceiling, **not** a distributed quota guarantee.
- In-flight identical range requests coalesce (including META when in flight).
  Existing per-sheet/per-sync/per-range caches remain; META is never
  reused from stale cache. Only conclusive FAIL/PASS requires fresh META
  verification at the end of a continuation chunk; partial work checks
  fresh META on the next chunk.
- Google API HTTP 429 becomes controlled HTTP 429 to browser with
  retry_after_seconds >=70. No Google project or consumer identifier is
  exposed. Local quota exhaustion is also HTTP 429 with retry seconds;
  no request waits inside Render for the next minute.
- UI full scope paces calls at >=12 seconds between successful chunks and
  retries the exact SAME signed cursor and input after a 429 delay, with a
  visible countdown. It never treats a quota error as PASS. Max eight
  consecutive quota retries; then it clearly stops without PASS.
- INDEX_LEN chooses relevant buckets, cursor resumes unscanned ranges
  from the previous normal result; no all-database scan or redundant reads.

If several Render instances, Windows sync and other projects use the same
Google OAuth user/project, quota can still be hit: rate limiting on one
Node process is not shared. Avoid multiple concurrent Full Scope tabs and
coordinate Windows sync schedules. Check actual Google Cloud quota/metrics
before raising defaults. No credentials are stored in the repository.

To activate, Render deploys main and /api/health shows engine
2026-09-23-quota-safe-v7 and META READY. CI fixture tests cannot prove
actual live throughput or external quota availability.
