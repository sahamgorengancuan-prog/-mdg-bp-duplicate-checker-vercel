"""Create ONLY the two new index workbooks using the proven local OAuth user.

No service account, BP queries, control writes or changes to existing sheets.
A successful rerun reuses the local receipt instead of creating duplicates.
Copy the printed IDs to local .env and the authorized Render environment.
"""
import json
import os
from pathlib import Path
from sync_gsheet_indexed import read_env, gsheet_client

ROOT=Path(__file__).resolve().parents[1]
RECEIPT=ROOT/"config"/"created_index_workbooks.local.json"

def main():
    read_env()
    conf=json.loads((ROOT/"config"/"gsheet_snapshots.json").read_text(encoding="utf-8"))
    names={"SHEET_A2_ID":"MDG BP Duplicate Snapshot A2 Index",
           "SHEET_B2_ID":"MDG BP Duplicate Snapshot B2 Index"}
    existing=json.loads(RECEIPT.read_text(encoding="utf-8")) if RECEIPT.exists() else {}
    gc,_=gsheet_client()  # Uses existing Sheets OAuth token, never a service account.
    fixed=[os.getenv("SHEET_ID",""),os.getenv("SHEET_A_ID",conf["sheet_a_id"]),
           os.getenv("SHEET_B_ID",conf["sheet_b_id"]),
           os.getenv("SHEET_CONTROL_ID",conf["sheet_control_id"])]
    for var,title in names.items():
        ident=os.getenv(var,"").strip() or existing.get(var,"").strip()
        if not ident:
            if os.getenv("CONFIRM_CREATE_A2_B2","")!="1":
                raise ValueError(
                    "Set CONFIRM_CREATE_A2_B2=1 for this one-time creation; "
                    "existing workbooks will not be modified.")
            new=gc.create(title)
            ident=new.id
            existing[var]=ident
            RECEIPT.parent.mkdir(parents=True,exist_ok=True)
            temp=RECEIPT.with_suffix(".tmp")
            temp.write_text(json.dumps(existing,indent=2)+"\n",encoding="utf-8")
            temp.replace(RECEIPT)
        if not ident or ident in fixed:
            raise ValueError(f"{var} duplicates an existing workbook. Stop.")
        fixed.append(ident)
        # Read-only access probe; actual write permission is tested by sync.
        gc.open_by_key(ident).fetch_sheet_metadata()
        print(f"{var}={ident}")
    print("Created/verified A2 and B2 using existing OAuth user.")
    print("Add both IDs to local .env and Render BEFORE enabling dual mode.")
    print("Repo config can be updated with these non-secret IDs after review.")

if __name__=="__main__":
    main()
