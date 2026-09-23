# v13 compact-index recovery after Google Sheets 400

The 2026-09-23 initial A build stopped after KTP_INDEX 313,330 and before
EXACT_INDEX creation with "This document is too large to continue editing".
The failed-run workbook must be established from actual SHEET_ID / SHEET_A_ID
and timestamped logs; the legacy workbook is distinct from new snapshot A.
CONTROL must not publish an incomplete keyed snapshot; Render remains legacy
until A is verified and CONTROL points to READY A.

## What changed

BP_DATABASE retains A:H and its stable BP key + SHA-256 row hash.
Only secondary indexes are compacted:
- INDEX_LEN_TOKEN A:D: "len_bucket:token_count", normalized text,
  BP_DATABASE row, stable BP ID. It was A:F (two duplicate columns removed).
- KTP_INDEX A:C: digits, BP_DATABASE row, stable BP ID. It was A:D.
- EXACT_INDEX A:C: SHA-256 exact hash, BP_DATABASE row, stable BP ID.
  It was A:D.
The web reader verifies stable BP ID and normalized text at source BP row for
fuzzy matches; exact matches recompute exact hash from source Name/Address.
KTP hits verify source BP ID (raw KTP is not duplicated into BP_DATABASE).
No match is accepted from a mismatched row pointer. Every index batch is read
back before publishing READY. The indexed schema is now version 13, so v12
partials can NEVER be treated as READY by the compact web reader.

Preflight logs every existing allocated worksheet grid, computes the expected
final cell allocation, and defaults to a conservative 9.5M-cell threshold.
The Google domain's actual cell entitlement and non-cell document size can
still be lower or higher. DO NOT override GSHEET_MAX_CELLS to force a run
without verifying the account's limit. Existing old index columns are shrunk
after they are successfully rewritten; BP_DATABASE is never cleared.

## Safe recovery

1. Keep the scheduled task OFF and Render in legacy mode; do not delete any
   staging workbook tabs or reset a partial META to READY.
2. Download the new scripts/sync_bp_keyed.py and deploy matching Node code.
3. If Google allocated grid is already close to the limit or the document
   remains too large, inspect A's worksheet rowCount x columnCount values
   with the same local authorized OAuth before another retry. Avoid copying
   company rows or secrets into chat.
4. Re-run the BAT only against the confirmed separate A workbook; it rereads staged BP keys and hashes and keeps unchanged
   BP_DATABASE rows. It rewrites compact derived indexes and publishes CONTROL
   only after all validations. Rerun is NOT currently a checkpoint/resume
   for index rows; previous index batches are read/written again.
5. When successful, require A META keyed_index_version=13 and CONTROL
   sync_state=READY; only then set Render GSHEET_SNAPSHOT_MODE=dual.
   No guaranteed time-to-completion until this real run is successful.

## Capacity reminder

Google Sheets has phased cell-capacity rollouts. The user's 400 error is
authoritative for THEIR present workbook; a public announcement of a larger
limit does not prove the individual workbook/account is able to allocate it.
Both allocated grid cells and document payload/performance matter. Exact
capacity is only known from A's actual sheet metadata and successful writes.
