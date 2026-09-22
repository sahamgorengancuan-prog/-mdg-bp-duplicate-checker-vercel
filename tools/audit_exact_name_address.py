"""Read-only exact index verification for an arbitrary BP ID in the locally configured Sheet.

Usage (from repo root): py tools/audit_exact_name_address.py <BP_ID>
No live credentials or customer data are embedded in this file.
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.sync_gsheet_indexed import (  # noqa: E402
    DEFAULT_SHEET_ID, exact_hash, gsheet_client, read_env,
)
import os  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="Read-only BP exact index audit")
    p.add_argument("bp_id", help="BP ID stored in BP_DATABASE column A")
    args = p.parse_args()
    read_env()
    sheet_id = os.environ.get("SHEET_ID", DEFAULT_SHEET_ID).strip()
    gc, _ = gsheet_client()
    sh = gc.open_by_key(sheet_id)
    meta = dict(sh.worksheet("META").get("A2:B50"))
    print("SHEET_ID:", sheet_id)
    for key in ("sync_id", "last_sync_at", "sync_state", "exact_index_version", "total_bp_rows", "total_exact_index_rows"):
        print(f"META.{key}: {meta.get(key, '(MISSING)')}")
    if (meta.get("sync_state") != "READY" or meta.get("exact_index_version") != "1" or meta.get("total_exact_index_rows") != meta.get("total_bp_rows")):
        raise SystemExit("ERROR: exact index is not READY. Run patched full sync locally before deploying API.")
    ws = sh.worksheet("BP_DATABASE")
    ids = ws.col_values(1)
    positions = [i for i, value in enumerate(ids, 1) if value.strip() == args.bp_id.strip()]
    if not positions:
        raise SystemExit(f"ERROR: BP {args.bp_id} absent from BP_DATABASE")
    shard_idx = sh.worksheet("INDEX_EXACT_SHARD")
    exact_ws = sh.worksheet("EXACT_INDEX")
    for row_number in positions:
        row = ws.get(f"A{row_number}:H{row_number}")[0]
        if len(row) < 8 or row[7] != meta["sync_id"]:
            raise SystemExit(f"ERROR: BP row {row_number} sync mismatch")
        digest = exact_hash(row[2], row[3])
        shard = digest[:2]
        matches = [r for r in shard_idx.get("A2:E300") if r and r[0] == shard]
        print(f"BP_DATABASE.row: {row_number} | shard: {shard} | index_shard_rows: {len(matches)}")
        if len(matches) != 1 or len(matches[0]) < 5 or matches[0][4] != meta["sync_id"]:
            raise SystemExit(f"ERROR: exact index shard missing/mismatched for BP row {row_number}")
        _, start, end, count, _ = matches[0]
        entries = exact_ws.get(f"A{start}:D{end}")
        if len(entries) != int(count):
            raise SystemExit(f"ERROR: shard incomplete ({len(entries)}/{count})")
        found = [r for r in entries if len(r) >= 4 and r[0] == digest and r[1] == str(row_number) and r[2] == args.bp_id and r[3] == meta["sync_id"]]
        print(f"EXACT_INDEX.pointer_for_BP: {len(found)} | exact_hash_matches_in_shard: {sum(r[0] == digest for r in entries)}")
        if len(found) != 1:
            raise SystemExit("ERROR: exact hash/index BP row pointer not found. Re-run full sync.")
    print("RESULT: EXACT_INDEX VERIFIED for all matching BP_DATABASE rows. If live API differs, inspect /api/health engine_version and Sheet ID configuration.")


if __name__ == "__main__":
    main()
