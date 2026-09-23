# Manual full-scope search on INCONCLUSIVE (v4)

Normal duplicate checks retain MAX_CANDIDATES and run independent exact KTP and exact Name+Address first. An inconclusive normal fuzzy check caused by the candidate cap returns a signed, one-hour full_scope_cursor and full_scope_available=true. The button is only shown when decision=INCONCLUSIVE and such a cursor exists. Short/unusable text is not eligible.

Clicking "Full Scope Search — Check All BP" makes sequential /api/check calls using the signed cursor and unchanged input. Each call scans at most 3,000 consecutive BP_DATABASE rows, independently of length-bucket and quick-prefilter exclusions. Only the backend reads Sheet rows. The browser displays incremental progress and waits 1.3 seconds between chunks to reduce rate-limit pressure. Keep the tab open.

An exact/fuzzy match leads to FAIL and stops immediately. PASS is returned only after every BP_DATABASE row was read and checked with the existing scoring rules. Incomplete chunks, mixed sync IDs, changed input/config/engine, stale cursor and META no longer READY fail without PASS. The signature is derived from the backend Google OAuth refresh token, never exposed to the browser. The cursor contains a query fingerprint and counts but not customer names or raw KTP. There is no persistent background task: closing the tab stops progression.

This is exhaustive with respect to current BP_DATABASE records and the configured similarity decision rules; no fuzzy algorithm guarantees detecting every possible semantic duplicate. The 3,000 row ceiling protects Render's per-request execution time; FULL_SCOPE_CHUNK_ROWS can optionally reduce it. Do not configure it above 3,000.

Existing Render service must deploy this repository main with Root Directory empty; yarn start launches server.js. Live /api/health must show engine_version 2026-09-23-full-scope-v4 and META READY. If META IN_PROGRESS, resolve the Windows sync first; full search cannot run against inconsistent sheets.
