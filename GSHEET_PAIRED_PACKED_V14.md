# V14 paired/packed Google Sheets — safe deployment and recovery

**Status:** Five workbook IDs configured in GitHub. The Google Drive connector
cannot verify their contents/permissions (403); local OAuth access, Render
configuration and real Windows sync have NOT been verified remotely. Do not set Render dual mode
or turn on Task Scheduler until CONTROL has committed and live health passes.

## Four data workbooks plus control and legacy

- LEGACY `SHEET_ID`: `1ZtNDikRHklwQMYxWQ6hkL1clvdH6g_Xfd3ojr5APDjo`.
  It is NEVER used as a keyed stage. Render stays legacy during initial build.
- A primary: `1vll0y7dO4bVTokeLbWctUUKjQvOV33V9TDp9iZfJPhA`.
  If prior incomplete v12/v13 staging remains, do not publish, remove or
  rewrite it until B+B2 is serving. If empty, the first build uses A+A2.
- A2 secondary: `1Qov9_QDbDwwLOOr3z7a2gCtA82dQXfy5bkKdAuwyDoA`.
- B primary: `13yMsb_Vsi6eXDkau1zouaRi2viOefDkVHmIuK9SHLqk`.
- B2 secondary: `1ju8u0vpMTVxIfi9J-VgwpIqj5rvTbmVW83pzHSXi3Sc`.
- CONTROL: `1wnRHX84FXNG3zwoxDofr1dzj1vu6UsN3uo907xt3KJ4`.

All SIX IDs are distinct. All new workbooks must be authorized to store BP
and KTP data under the same corporate OAuth permissions. Do not enable
"Anyone with link". No service account or private search PostgreSQL.

## Configuration (A2 and B2 are already user-provided)

All five snapshot/control IDs are recorded in
`config/gsheet_snapshots.json` and in the optional `render.yaml` blueprint.
Do NOT run `create_index_workbooks.py`: that helper was only needed before
the user provided A2 and B2. The local `.env` must contain these same IDs
and an explicit, DIFFERENT legacy `SHEET_ID`; `PRIVATE_INDEX_MODE=off`.
Local OAuth tokens and credentials remain only in authorized environments.
GitHub config does not update local `.env` or a live Render service.

## Ownership/layout

| Generation | Primary A/B | Secondary A2/B2 |
|---|---|---|
| BP_DATABASE | 8 original fields, stable BP ID and SHA-256 row hash | never |
| META | READY, sync ID, digest, BP count, version 14 | same |
| INDEX_LEN_TOKEN | never | group key + compact JSON [normalized text, BP row, BP ID] |
| EXACT_INDEX | never | exact hash + compact JSON [BP row, BP ID] |
| KTP_INDEX | never | KTP digits + compact JSON [BP row, BP ID] |
| INDEX_LEN + SHARD tabs | never | small seek maps |

All large indexes use **two columns**, not 3–6; no BP rows or KTP digits
are omitted. Google 50k-character cell limit still applies, so unusually
long source text must be handled safely. API checks read only A2/B2 indexes,
then verify matching BP pointer from paired A/B. Do not represent index
rows as raw authoritative BP identity.

Capacity guard is **7,500,000 allocated grid cells PER WORKBOOK**,
including unused default worksheet grid and old tabs. It fails BEFORE
BP data writes if any current or projected workbook crosses 75% of
a conservative 10-million-cell baseline. Google may reject editing below
that guard (as A already demonstrates). Neither quota nor latency nor
future scale is guaranteed. Above approximately 900k BP the 8-column
primary will need further sharding or an approved larger-capacity system.

## Safe rollout — do not bypass

1. Download v14 `scripts/sync_bp_keyed.py` and
   `config/gsheet_snapshots.json`. Ensure both A2/B2 IDs are present
   in .env and the OAuth user can access them.
2. Leave Render `GSHEET_SNAPSHOT_MODE=legacy` and scheduler OFF.
3. If A is genuinely empty, initial run selects **A+A2**. If A still has
   unpublished BP_DATABASE data from the failed run, it selects **B+B2**.
   Verify the actual startup STAGING label and preflight for BOTH books.
   Do not infer workbook emptiness from its title or the user's earlier log.
4. The selected primary receives initial keyed BP rows; its paired A2/B2 gets the packed indexes. Both META
   markers must be READY/version 14 with identical digest and sync ID before
   CONTROL publishes the exact selected pair.
5. Configure Render `SHEET_A2_ID`, `SHEET_B2_ID` and existing other
   IDs, then switch `GSHEET_SNAPSHOT_MODE=dual`. The API checks CONTROL,
   fresh primary META and fresh secondary META. If a pointer/identity or
   generation differs, it returns error rather than false PASS.
6. Test exact KTP, exact Name+Address, fuzzy match, no-match and live health.
   Turn on scheduler ONLY after BOTH generation pairs are operational.
7. If A still contains damaged v12/v13 staging, remediate or replace it
   while B+B2 is active; do not enable alternating scheduler until BOTH
   generation pairs have been validated. If all four workbooks are empty,
   build A+A2, validate B+B2 on the next changed run, then schedule.

## Incremental optimization

BP_DATABASE uses keyed delta: changed rows only; new rows appended; removed
rows tombstoned. The source query still scans the full PostgreSQL BP universe.
Compact index rows are sorted and rematerialized on a source change, because
range pointers must match the newly staged BP. Existing index batches are
compared before write; identical batches are reused and verified. Every
changed batch gets post-write readback; both META versions and CONTROL are
checked before publish. This is not an O(changed-BP-only) sync and cannot
promise sub-3-minute runs without a measured real-world benchmark.

Do not store passwords, tokens, raw BP rows or KTP digits in GitHub.
