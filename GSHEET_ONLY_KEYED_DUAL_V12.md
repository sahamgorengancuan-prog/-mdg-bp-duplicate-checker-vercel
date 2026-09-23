# Google Sheets-only keyed dual-snapshot duplicate checker (v12)

## Exact intent
- **No private PostgreSQL search database.** The existing authorized MDG
  PostgreSQL connection is the source for Windows sync only.
- Use the **existing laptop OAuth user token and .venv**, unchanged.
- The first BAT run builds a complete keyed BP_DATABASE and all protected
  duplicate indexes in a new workbook. Subsequent runs compare by unique BP
  key + SHA-256 row_hash, updating existing changed rows, appending new keys,
  and marking vanished keys DELETED rather than deleting physical rows.
- BAT precomputes exact-hash, KTP and length/token fuzzy postings. The web API
  reads indexed Google Sheets ranges rather than broad BP_DATABASE ranges.
- Web checks run against an immutable **ACTIVE** Google Sheet snapshot while
  Windows updates **STAGING**. Switch only after data/index validations finish.
- An unfinished search is INCONCLUSIVE, never a speculative PASS.

## Required A/B/control setup (must be approved for company data)

Create **three separate Google Sheets workbooks**, all owned/shared only as
authorized by company policy; do not publish or share 'Anyone with link'.
Google's ~10 million grid-cell limit is per spreadsheet, so the two large
snapshot workbooks must be SEPARATE. The existing legacy SHEET_ID remains
unchanged as rollback/reference; do not use it as A or B.

- SHEET_A_ID: new workbook for snapshot A.
- SHEET_B_ID: new workbook for snapshot B.
- SHEET_CONTROL_ID: new small workbook with ACTIVE tab. On the initial run
  ACTIVE is created at final publish. Don't edit this tab manually.

All three IDs must differ from SHEET_ID and one another. The desktop OAuth
user must have edit access; the backend OAuth user must have read access to
all three. The same account can be used if authorized.

Windows .env (keep the existing DB and OAuth values):
    GSHEET_SNAPSHOT_MODE=dual
    SHEET_A_ID=<approved sheet A id>
    SHEET_B_ID=<approved sheet B id>
    SHEET_CONTROL_ID=<approved control sheet id>
    PRIVATE_INDEX_MODE=off

Render secrets/environment: set the same GSHEET_SNAPSHOT_MODE and three IDs,
with existing GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN. Do **not**
paste secret values into GitHub. No PRIVATE_INDEX_DATABASE_URL or private
PostgreSQL search DB is used by this mode.

## Safe cutover

1. Deploy code first but retain GSHEET_SNAPSHOT_MODE=legacy on Render. Old
   checker continues using existing SHEET_ID, which is not touched.
2. Download updated scripts/sync_bp_keyed.py, bats/sync_to_gsheet_now.bat,
   and bats/sync_to_gsheet_scheduled.bat into the local project. Local GitHub
   commits do not automatically update the laptop.
3. Configure the three approved, **empty** workbooks and Windows .env.
4. Run bats/sync_to_gsheet_now.bat manually with .venv and existing OAuth.
   First run writes the full current BP database plus indexes into A.
   B is untouched. CONTROL ACTIVE is the final publish step.
5. Check the BAT log for "PUBLISHED snapshot" and CONTROL ACTIVE
   sync_state=READY. In A, META.sync_id must equal CONTROL.sync_id and
   META.source_digest must match CONTROL.source_digest.
6. Configure Render dual environment and check /api/health returns
   search_backend=KEYED_GOOGLE_SHEETS_DUAL, exact_index_ready=true,
   meta.keyed_index_version=12, META READY. Test known exact, fuzzy and
   no-match BP inputs before accepting web traffic.
7. Enable scheduler **only after manual sync and live health tests pass**.

The old private-only v11 script is replaced. Do not add
PRIVATE_INDEX_MODE=required. Do not run the legacy full-clear BAT/script
against A, B or CONTROL.

## Subsequent sync behavior

If source BP key/hash digest is unchanged, BAT exits NOOP without rewriting
BP data or changing the active pointer. For a changed digest it updates the
**inactive** snapshot by BP ID / source row hash, appends new IDs, tombstones
deleted IDs, verifies all keys/hashes, rebuilds the derived compact index tabs
in that inactive workbook, reads back every written index batch, sets staging
META READY, then writes a SINGLE CONTROL ACTIVE range and verifies it.

Note that each A/B workbook was last written **two generations ago** after
both snapshots have been initialized. Therefore a sync computes a delta
relative to the selected *inactive* workbook, which may include changes from
two periods. The first build of previously empty B is a one-time full B
initialization. INDEX tabs are rematerialized to preserve sorted/contiguous
range lookup; BP_DATABASE is NOT cleared or fully rewritten on subsequent
runs. The per-run elapsed time and Google quota impact need production
benchmarking before promising a 90-minute freshness SLA.

If staging fails, the active snapshot stays usable. If the ACTIVE control
pointer does not match a READY snapshot, /api/health and /api/check refuse
to produce PASS/FAIL. In-flight web checks verify the control pointer again
before producing a decision, so snapshot switches don't mix generations.

## Scheduling and source key

The previously discussed 2-hour Windows schedule cannot guarantee a
90-minute maximum data age. If 90 minutes is a HARD maximum, use an approved
60-minute schedule plus alerts for sync failures, while allowing for laptop,
VPN and Google Sheets outages. This GitHub push does NOT register a Windows
task or touch the user's Task Scheduler.

Source query has been tested by the user: bp_id is currently unique. The
script still rejects duplicate/blank bp_id on every sync. Never use
mutable name/address hashes as BP record identities.

## Limitations and safeguards

Google Sheets has no true cross-workbook transaction. A/B + control-marker
verification provides fail-closed publication rather than database-grade
atomicity. Do not edit ACTIVE manually. Avoid overlapping sync tasks; the
BAT uses the existing OS file lock. Google read quota and fuzzy work still
limit the guaranteed latency; there is no claimed sub-3-minute SLA yet.

KTP_INDEX stores the same sensitive KTP digits as the legacy authorized
workbook, in new protected A/B workbooks. Protect access and don't export
raw snapshot files into GitHub, public drives or local backups outside policy.

The authoritative app and both snapshot workbooks must share authorized OAuth
scope/access; a 403 is a configuration failure, not permission to degrade to
an incomplete PASS. Keep the original legacy sheet untouched as an explicit
rollback target.
