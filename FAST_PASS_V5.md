# v5: Evidence-based fast PASS / oversized bucket INCONCLUSIVE

The normal search is **not** a statistical confidence estimate or a blanket PASS.
It uses the existing indexed length-bucket scope (query text length +/- configured
tolerance). Exact KTP and exact Name+Address indices are checked before fuzzy.

Normal check:
1. Fetch INDEX_LEN and sum the row counts in **all eligible length buckets**.
2. If the union fits within MAX_CANDIDATES (default 60,000), visit **every row**
   of **every eligible bucket**. Score every candidate within the exact length
   tolerance; no potentially unsafe quickPrefilter silently discards rows.
3. If no matching BP is found, read META again. Only if it is still READY on the
   same sync_id issue PASS with stats.pass_basis=ALL_ELIGIBLE_BUCKET_ROWS_SCORED,
   coverage_complete=true, scanned_candidates=candidate_space, and
   completed_buckets=bucket_count.
4. If the union does not fit within MAX_CANDIDATES, inspect smaller eligible
   buckets first and perform up to OVERSIZED_SCAN_BUDGET (default 6,000) reads,
   without claiming PASS on partial coverage. If a duplicate is found -> FAIL;
   otherwise INCONCLUSIVE with an *opt-in* Full Scope Search button.
5. Full Scope stays manually initiated; it checks ALL BP_DATABASE rows in
   bounded 3,000-row HTTP chunks, not only eligible buckets. PASS there means
   all rows were scored without a match. ERROR/503 for corrupted or changing
   snapshots is never converted into PASS or INCONCLUSIVE.

**PASS SCOPE**: A normal PASS proves the configured length-bucket search was
complete under the current duplicate scoring rules. It does **not** claim
that every BP in the entire database was checked or that other lengths could
not contain semantically similar BPs. The UI exposes the basis and completed
bucket count. Only completed Full Scope covers the entire BP_DATABASE.

This improves normal workload predictability by not using all 60,000 reads
when the eligible space is much larger. It does **not** assert any real-world
PASS percentage; actual bucket sizes and thresholds determine the distribution.
Be mindful that a normal bucket space close to 60,000 can still be expensive
on Google Sheets / Render. MAX_CANDIDATES and OVERSIZED_SCAN_BUDGET may be
tuned after production latency is measured; never make PASS depend on a
guessed coverage score.

Engine: 2026-09-23-complete-bucket-v5. Render must deploy this repository's
main with Root Directory empty, then /api/health should show engine v5 and
the Sheets META snapshot READY.
