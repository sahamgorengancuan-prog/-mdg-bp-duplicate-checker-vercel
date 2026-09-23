# Identity-safe Duplicate Checker v3: exact KTP + name/address, independent evidence

The 2026-09-23 screenshot still says "Online · Last sync", while the current
GitHub frontend says "Ready · Exact index v1 · Sync". This is evidence that
the displayed site is using an older/different frontend. A GitHub push alone
does not confirm that a Vercel or Render service deployed that commit.

The supplied KTP_INDEX row has a 2026-09-22 sync ID while the supplied
BP_DATABASE row has a 2026-09-23 sync ID. Samples from different times alone
do not establish that the CURRENT spreadsheet has mixed generations. A real
mismatch in the same snapshot must return HTTP 503, not PASS.

## Exact decisions

KTP and Name 1 + Address are independent signals. When KTP matches BP A,
the engine still checks exact name+address; if those match BP B, return
FAIL / identity_conflict=true and show both IDs. KTP-only match returns FAIL.
Both exact paths are independent of MAX_CANDIDATES. A failed/mixed index is
HTTP 503. Fuzzy is attempted only if neither exact signal yields a match.
No special BP ID, KTP or user name is hardcoded in runtime code.

## Deployment proof (on the actual website hostname)

GET /api/health must show:
- engine_version = 2026-09-23-identity-v3
- sheet_ok = true, exact_index_ready = true
- meta.sync_state = READY, meta.exact_index_version = "1"
- meta.total_exact_index_rows = meta.total_bp_rows
- meta.sync_id matches the *current* local audit (not an older screenshot)

Then POST /api/check three times: KTP alone (expect its BP), name+address
alone (expect its BP), and both together (expect two distinct BP records
with identity_conflict=true if IDs differ). Do not share raw KTP, OAuth
tokens, or API access codes when reporting diagnostic outputs.

Vercel uses api/*.js. Render uses npm start, server.js, PORT environment.
The Node server serves only public/index.html, not private files.

If the live page still reads "Online · Last sync", confirm service URL,
connected repository, branch, root directory, build/deploy commit and
deployment status. Do not increase MAX_CANDIDATES to fix exact lookups.
If KTP_INDEX and BP_DATABASE belong to different generations in a live
snapshot, stop overlapping jobs and rerun a *single* patched Windows sync
through the single-run lock before retrying.

CI only exercises synthetic fixtures, not private Google Sheets, PostgreSQL
or the real hosting instance. The live tests above remain required.
