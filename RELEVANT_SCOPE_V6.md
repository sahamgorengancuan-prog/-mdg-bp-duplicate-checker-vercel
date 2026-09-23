# v6: Optimized manual Full Scope (complete relevant buckets, no redundant rescans)

Goal: Fast evidence-backed PASS remains normal when every configured length bucket is
completed; INCONCLUSIVE appears when relevant bucket sizes exceed the ordinary cap.
Only an explicit user click starts the longer continuation. This version supersedes
the earlier v4 behavior that re-read every BP_DATABASE record from row 2.

## Candidate scope and safety

- KTP exact and SHA exact Name+Address run first in the normal request.
- INDEX_LEN, sorted into eligible length buckets using LENGTH_TOLERANCE_PERCENT
  (default 30%) and LENGTH_TOLERANCE_MIN_CHARS (default 12), defines the normal
  and extended fuzzy scope. All eligible bucket rows are examined before a PASS.
- A manual continuation resumes at the first UNREAD row of the first incomplete
  bucket. It does not start at BP_DATABASE row 2 and does not re-read completed
  normal-check ranges.
- Small buckets are prioritized for oversized normal checks, then the remaining
  bucket/index order stays identical throughout continuation.
- Server validates a signed cursor: original input, engine, scoring settings,
  index plan, META sync ID, bucket and row pointer, scanned count, elapsed
  lifetime. Invalid/stale pointers return errors and never produce PASS.
- Every continuation request reads <=3000 rows and never crosses a bucket boundary
  within a Sheets range. If a batch ends at a boundary, it can continue the next
  relevant bucket in the same request. Exact in-tolerance rows reach the real
  scoring engine; heuristic token prefiler does not determine PASS.
- INDEX_LEN and Sheets ranges already use bounded per-process caching by sheet ID,
  sync ID, range, and TTL. META is fetched fresh at the start and end of each
  request so a changing/partial sync cannot be treated as PASS.
- A relevant match yields FAIL and ends early. PASS only after scanned equals
  the full eligible candidate count and the same META generation is still READY.
  Interrupted/unfinished work remains INCONCLUSIVE. HTTP errors remain errors.

## Meaning of Full Scope

"Full Scope Search — Relevant Buckets" means completing the CONFIGURED LENGTH
BUCKETS, NOT searching every one of the ~396k BP records. Therefore normal PASS
and manual PASS both certify the same configured similarity scope. This does
not prove that a semantically related BP with vastly different text length
does not exist. Detecting such cases requires a separate broader retrieval
index and explicit coverage semantics; do not falsely label scoped search as
a whole-database exhaustive scan.

Normal MAX_CANDIDATES defaults to 60000; the oversized normal work budget defaults
to 6000. FULL_SCOPE_CHUNK_ROWS may lower the default batch size of 3000.
Google Sheets API requests and Render runtime may still be significant for large
bucket unions; measure latency and quota before increasing limits.

Deploy commit main to the *actual* Render service. yarn start starts server.js.
Verify /api/health engine_version is 2026-09-23-resumable-buckets-v6 and META READY.
No new Sheets tabs, local sync migration, secrets, or PostgreSQL writes are needed.
