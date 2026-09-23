# Wide-batch Full Scope optimization (v14)

The reported 281,324 relevant BP postings in 153 groups required approximately
94 *application-level* continuations with the old 3,000-BP cap. Each
continuation performed fresh CONTROL, primary META and secondary META
checks plus an ending CONTROL read, so Google Sheets quota pressure occurred
even though group ranges were already indexed.

## Changes

- One check scans at most 12,000 candidate postings rather than 3,000
  for Full Scope; Normal Check also starts with up to 12,000.
- Up to eight indexed group slices of 1,500 rows are fetched in a single
  Google `values.batchGet` request. Every expected range, order and row count
  must match; a partial response fails closed.
- The estimated 281,324 eligible candidates require about 24 candidate
  continuations instead of 94, if each completes its budget.
  This is an arithmetic ceiling estimate, **not a real Google/Render latency
  benchmark**: per-request 20s work limit, rate limiting and network response
  size may reduce actual rows per request.
- Frontend no longer stops automatically at 10 minutes; it can continue for
  up to 45 minutes, including quota cooldowns. Signed cursor TTL is 2 hours.
- Local read limiter remains 36 reads/minute per instance. Do **not**
  override it upward to fake speed; upstream OAuth quota is shared.
  Legitimate 429 still pauses and resumes the identical signed cursor.
- Exact KTP, exact Name+Address, BP identity check, primary/index CONTROL
  consistency, no-match coverage, and signed cursor safety are unchanged.
  The search does not skip eligible groups or return PASS early.

## Deployment and migration

Update `_lib/duplicate.js`, `_lib/keyed-sheets.js`, `public/index.html`.
No Sheets schema change or BP resync is required. Keep private A/A2/B/B2
and CONTROL IDs exactly as configured. Confirm /api/health reports engine
`2026-09-23-gsheet-dual-v14-wide-batch`.

**Active older signed cursors are intentionally incompatible with the new
engine version**. Finish an existing long search first, or begin a new
Normal Check after deployment; never treat prior INCONCLUSIVE as PASS.

This improves quota amplification, but scanning hundreds of thousands of
postings for a single no-match still has real data-transfer and CPU cost.
Further structural speedups require a validated recall-preserving secondary
index or a changed coverage definition; neither is silently claimed here.
