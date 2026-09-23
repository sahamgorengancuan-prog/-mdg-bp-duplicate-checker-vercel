# v8: Adaptive throughput, unchanged duplicate decision rules

Problem: v7 inserted a fixed 12-second sleep after EVERY successful 3,000-row
continuation. 15 chunks incurred ~3 minutes in artificial waiting alone,
even when Google Sheets had unused read quota.

v8 changes:
- Successful /api/check responses include local quota headroom (36
  reads/minute/process ceiling) and a suggested pause only near quota
  exhaustion. UI sends the next manual Full Scope chunk after ~200ms
  when headroom exists; when fewer than four local reads remain it
  waits until the rolling minute replenishes. Upstream HTTP 429 is
  retried using the SAME signed cursor and original inputs; no
  incomplete scan can become PASS.
- The query-side token and numeric-token sets are computed once per
  normal/full-scope request, instead of re-tokenizing the same query
  for every BP candidate. The Levenshtein, fuzzy-Jaccard, numeric,
  direct-reject thresholds, score weights, exact indexes, length
  tolerance and full coverage rules are unchanged.
- INDEX_LEN maps are retained for 30 minutes per sync_id (META is
  ALWAYS read fresh), eliminating redundant index reload during long
  manual search. BP range caches retain their existing TTL.
- No Google Sheet write, schema or local Python sync migration.

The quota estimate is PER Node process; it cannot see all Render instances,
the Windows sync, or other clients using the same OAuth user/project.
External 429 can still happen. This is not a three-minute SLA: actual
runtime depends on candidate-space size, Sheets latency, CPU and shared
quotas. When the relevant bucket space is massive, a prebuilt searchable
database or equivalent index outside Sheets is the architectural path
to predictable sub-minute checks without falsely shrinking coverage.

Engine fingerprint: 2026-09-23-adaptive-throughput-v8. Deploy main to the
actual Render service and verify /api/health engine_version and META READY.
CI fixture passing is NOT verification of live Google quota or latency.
