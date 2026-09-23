# v12 — Google Sheets-only A/B snapshots (verified user configuration)

## Workbook identities — final correction

A, B, CONTROL and the pre-existing/initial SHEET_ID are FOUR DISTINCT
spreadsheets. These three user-provided IDs live in
`config/gsheet_snapshots.json` and are loaded by BOTH Windows keyed sync and
the server-side Node duplicate checker. The legacy SHEET_ID is intentionally
NOT in Git; it must be an explicit environment value in Windows and Render.

| Purpose | Spreadsheet ID |
|---|---|
| Snapshot A | `1ZtNDikRHklwQMYxWQ6hkL1clvdH6g_Xfd3ojr5APDjo` |
| Snapshot B | `13yMsb_Vsi6eXDkau1zouaRi2viOefDkVHmIuK9SHLqk` |
| CONTROL | `1wnRHX84FXNG3zwoxDofr1dzj1vu6UsN3uo907xt3KJ4` |
| Legacy initial | Existing `SHEET_ID` from local .env and Render, MUST differ from A/B/CONTROL |

Do not guess the legacy ID from a DEFAULT_SHEET_ID; the previous hardcoded
default was equal to A and has been removed. If `SHEET_ID` is missing, the
sync and dual checker fail closed rather than modifying an ambiguous workbook.

## OAuth and cutover

Keep the existing laptop `.venv`, OAuth user token, client credentials, DB
environment, and local BAT. NO service account and NO private search DB.

Windows .env (do not replace the existing explicit SHEET_ID):
```dotenv
GSHEET_SNAPSHOT_MODE=dual
SHEET_ID=<the DIFFERENT existing initial/legacy workbook ID>
PRIVATE_INDEX_MODE=off
```
A/B/CONTROL are already loaded from the repo config file. You can optionally
set SHEET_A_ID, SHEET_B_ID and SHEET_CONTROL_ID in .env as overrides, but they
must represent the same intended workbooks and remain distinct from SHEET_ID.
Never paste OAuth token, client secret or corporate BP rows into GitHub.

1. Deploy GitHub code but keep Render's GSHEET_SNAPSHOT_MODE=legacy.
2. Download the new Windows scripts, including
   `config/gsheet_snapshots.json`, `scripts/sync_bp_keyed.py` and the BAT.
3. Check the Google OAuth user has edit access to A/B/CONTROL, and Render's
   existing OAuth user will have read access. ChatGPT's separate connector
   permissions are not a substitute for this validation.
4. Run the BAT ONCE manually. As CONTROL has no ACTIVE pointer, the initial
   full-source build always writes A, builds indexed tabs, verifies keyed
   source fields and index batches, then publishes CONTROL ACTIVE=A.
   Legacy initial workbook is untouched, so the old site remains usable.
5. Verify CONTROL ACTIVE=A/READY and A META READY, matching sync_id and
   source_digest. On Render set the SAME existing explicit SHEET_ID and
   GSHEET_SNAPSHOT_MODE=dual. Render sees A through CONTROL, not SHEET_ID.
6. Check /api/health reports KEYED_GOOGLE_SHEETS_DUAL and test known exact,
   fuzzy, and no-match BP inputs. Only after this should the Windows
   scheduler be enabled.
7. If source data changes, the next sync updates B (initial full B build);
   later it alternates inactive A/B by BP ID + row hash, preserving the
   active workbook throughout. Unchanged source digest = NOOP.

## Keyed behavior and consistency

Source BP ID uniqueness has been checked by the user; it is still validated
on EVERY sync. BP_DATABASE updates changed existing keys, appends new keys,
tombstones missing keys with H=DELETED, and does not clear/repopulate
unchanged BP rows. Index tabs are rematerialized when the source changes,
because contiguous search ranges and row references must reflect the
current staging BP data. Fuzzy scoring verifies full source key and row hash
on matching candidates. No check may PASS on a partial snapshot.
The control pointer switches only after staging validation; in-flight
checks reread CONTROL and reject cross-generation results.

The first A and first B are complete builds; keyed deltas begin when a
previous version already exists in a given staging workbook. This does NOT
claim Google Sheets latency is guaranteed or that there is a transactional
commit across separate workbooks. Benchmarks and credentials have not been
validated by a real Windows initial build in this change.

The v11 A=legacy migration flag ALLOW_LEGACY_A_STAGING is obsolete and not
used. Do not use the old full-clear sync BAT against A, B, or CONTROL.
