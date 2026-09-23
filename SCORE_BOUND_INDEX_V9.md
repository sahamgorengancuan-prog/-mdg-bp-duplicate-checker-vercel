# v9: Precomputed Score-Bound Search Index — safe candidate pruning

This implementation moves reusable candidate grouping into Windows Python sync.
It does NOT put private BP data, NIK/KTP or a SQLite database in GitHub.

## Windows full sync change (REQUIRED to enable speedup)
- BP_DATABASE is sorted by (length bucket, distinct normalized token count,
  text length, BP ID, source row). The BP_DATABASE A:H schema remains unchanged.
- New protected + hidden INDEX_LEN_TOKEN sheet has six columns:
  len_bucket, token_count, row_start, row_end, count, sync_id.
- META includes token_index_version=1 and token_index_groups. The tab is
  written before META READY; the existing single-sync lock remains in place.
- KTP and exact Name+Address indexes are rebuilt against NEW row pointers.
- The new index is read and validated as a complete partition of INDEX_LEN
  and BP_DATABASE. Missing/misaligned/partial index returns HTTP 503.

## Why pruning is safe
Within the configured length tolerance, each group's candidate text length
lies in [bucket*5, bucket*5+4]; group token count is exact according to the
same unique normalized-token rule the Node scorer uses.

The Levenshtein maximum possible similarity is bounded by the candidate
length interval. The soft-Jaccard maximum possible similarity is bounded
by min(query token count, candidate token count) / max(...), irrespective
of spelling or fuzzy token pairing; numeric score is conservatively <=100.

Only SKIP group if ALL fail rules are mathematically impossible:
  LevUpper < direct-reject threshold AND JacUpper < direct-reject threshold
  AND wLev*LevUpper + wJac*JacUpper + wNum*100 < weighted threshold.
Near-threshold comparisons retain a 0.025-point margin. Custom negative
or non-finite weights disable pruning. No new heuristic confidence PASS.
The actual Levenshtein/Jaccard/numeric scoring of retained rows is unchanged.

Normal and manually resumed Full Scope use the SAME safe plan and signed
continuation. A PASS means all groups either scored completely or proven
incapable of triggering the configured similarity rules within the existing
length tolerance. It is NOT a full-database semantic-duplicate guarantee.

## Deployment and rollback
The new Node code has a safe compatibility path if META has no
token_index_version: v8 complete-length-bucket behavior (no pruning).
Speedup is ONLY enabled once patched Windows sync completes and publishes
META READY + token_index_version=1. Do not manually edit META.
The Google Sheets read rate cap and 429 fail-closed retry remain.

Build/regression results are fixtures; speed on ~396k protected company BPs,
quota usage, and percent of candidates pruned require live measurement.
If relevant groups remain huge or real checks exceed 3 minutes,
the next deployment needs a private indexed DB/search service instead
of assuming Google Sheets can satisfy a hard latency SLA.
