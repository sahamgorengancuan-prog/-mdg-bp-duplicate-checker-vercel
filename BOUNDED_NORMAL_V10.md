# v10: Eliminate indefinite single-BP loading without lowering PASS quality

Observed root causes in v9:
- A normal check with <=60,000 eligible candidates could score ALL of them in
  ONE HTTP request, even when that work took many minutes on Render.
- A Sheets 429 after a partial normal scan caused the whole request to fail.
  The browser waited up to eight quota-retry intervals and REPLAYED the
  entire normal search from the beginning.
- Full Scope is paginated but can still be long when there are many remaining
  candidate groups, or when a Sheets OAuth quota is busy.

v10 correctness-preserving controls:
- Normal fuzzy scan: up to 6,000 rows and approx 20 seconds of processing per
  request; reads capped to 1,000 rows per chunk so it can check its time budget
  between chunks. An operator may LOWER NORMAL_MAX_ROWS_PER_REQUEST (never
  increase beyond 6,000). Exact KTP and name+address checks stay first.
- The 60,000 MAX_CANDIDATES still defines the previous broad eligibility
  ceiling for oversized planning, NOT the amount of work one normal request
  must execute. Normal PASS only after all relevant indexed candidate groups
  have been scored or mathematically excluded, and META is still READY.
- When normal work hits quota DURING the fuzzy scan, it returns INCONCLUSIVE
  with a signed resume cursor and the completed row count. No 429 retry
  silently resubmits all completed BP rows.
- Unfinished normal work (time/rows/quota) is INCONCLUSIVE, never PASS.
  Full Scope resumes the original signed index plan at the FIRST UNREAD row.
- For early 429 on META/exact/index stages the normal browser retries at most
  ONCE, rather than silently waiting 8 times. No partial PASS.
- Full Scope shows per-batch progress and pauses after around 175 seconds of
  *active browser session time*, with a Continue button preserving the last
  signed cursor. It NEVER promises a complete result from a partial session.

Important limitations:
- This is a latency safety mechanism, NOT an SLA for a completed full scan.
  Slow OAuth/Google requests and exact index reads may exceed the processing
  budget; scores for an individual large row/batch may also exceed the
  approximate limit before the next boundary. Full Scope may need multiple
  sessions when candidate-space is huge or Sheets quota is busy.
- A reliably completed result in under three minutes for every ~396k-row
  snapshot requires measurement and potentially a securely hosted indexed
  search database—not arbitrarily deleting hard candidates or claiming PASS.
- INDEX_LEN_TOKEN/v1 needs the Windows sync to have completed and META READY
  to benefit from precomputed score-safe pruning. No schema changes in v10.

After deploy, verify /api/health ENGINE_VERSION 2026-09-23-bounded-normal-v10,
META sync_state READY and token_index_version=1 for index optimization.
