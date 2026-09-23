"""Incremental keyed BP sync. NEVER clear(), never delete a worksheet/row.

The existing length-sorted/row-pointer Google index is incompatible with
arbitrary in-place BP changes. This job MUST run with the private transactional
search service enabled. Old META is marked IN_PROGRESS (fail closed); the
separate KEYED_SYNC_META becomes READY only after keyed writes succeed.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime
from typing import Dict

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from sync_gsheet_indexed import (
    DEFAULT_SHEET_ID, logging, normalize_text, normalize_digits,
    fetch_pg_dataframe, gsheet_client, read_env, single_sync_lock,
)

COLUMNS = ["bp_id", "bp_type_id", "name_1", "address",
           "norm_text", "norm_digits", "text_len", "row_hash"]
LEGACY_COLUMNS = COLUMNS[:-1] + ["sync_id"]
BATCH = 5000
READ_BATCH = 20000

def required_secret(name: str) -> str:
    value = os.environ.get(name, "")
    if len(value) < 32:
        raise ValueError(f"{name} must be configured as a private secret (>=32 chars). No updates made.")
    return value

def make_records(source: pd.DataFrame) -> Dict[str, dict]:
    needed = ["bp_id", "bp_type_id", "name_1", "address", "ktp_number"]
    absent = [x for x in needed if x not in source.columns]
    if absent:
        raise ValueError(f"Missing source columns: {absent}. No updates made.")
    records = {}
    for record in source[needed].fillna("").itertuples(index=False, name=None):
        key, bp_type, name, address, ktp = (str(x) for x in record)
        key = key.strip()
        if not key or key in records:
            raise ValueError(
                "Blank/nonunique bp_id: keyed update cannot safely distinguish "
                "joined source rows. Supply a genuinely stable unique source ID "
                "before enabling this migration. No updates made."
            )
        norm = normalize_text(name+" "+address)
        digits = normalize_digits(name+" "+address)
        ktp_digits = normalize_digits(ktp)
        row_hash = hashlib.sha256(json.dumps(
            [key,bp_type,name,address,ktp_digits],
            ensure_ascii=False,separators=(",",":")
        ).encode("utf-8")).hexdigest()
        records[key] = {
            "bp_id":key,"bp_type_id":bp_type,"name_1":name,"address":address,
            "norm_text":norm,"norm_digits":digits,"text_len":len(norm),
            "ktp_number":ktp_digits,"row_hash":row_hash,
            "len_bucket":str(len(norm)//5).zfill(3),
            "token_count":len({t for t in norm.split(" ") if len(t)>=2}),
            "exact_hash":hashlib.sha256(
                (normalize_text(name)+"\x1f"+normalize_text(address)).encode()
            ).hexdigest()
        }
    if not records:
        raise ValueError("Source is empty. No updates made.")
    return records

def sheet_row(record: dict) -> list:
    return [str(record[k]) for k in COLUMNS]

def keyed_delta(records: Dict[str,dict], existing: Dict[str,dict]):
    """Pure planner: no Sheet writes, no hard deletes, no ambiguous keys."""
    changes, creates, tombstones = [], [], []
    for key,record in records.items():
        current = existing.get(key)
        if current is None:
            creates.append(record)
        elif current["hash"] != record["row_hash"]:
            changes.append((current["row"],record))
    for key,prior in existing.items():
        if key not in records and prior["hash"] != "DELETED":
            tombstones.append(prior["row"])
    return changes,creates,tombstones

def ensure_private_mode():
    if os.getenv("PRIVATE_INDEX_MODE","off").lower() != "required":
        raise ValueError(
            "PRIVATE_INDEX_MODE=required must be set before the keyed migration. "
            "The legacy length-sorted indexes cannot remain valid after in-place updates."
        )
    dsn = os.getenv("PRIVATE_INDEX_DATABASE_URL","")
    if not dsn.startswith(("postgres://","postgresql://")):
        raise ValueError("PRIVATE_INDEX_DATABASE_URL missing. No Sheet writes made.")
    required_secret("PRIVATE_INDEX_KTP_HMAC_KEY")
    required_secret("PRIVATE_INDEX_CURSOR_SECRET")
    return dsn

def sync_private(records: Dict[str,dict], sync_id: str, dsn: str) -> None:
    """Single DB transaction. Unchanged rows are NOT rewritten to durable table."""
    sslmode = os.getenv("PRIVATE_INDEX_SSLMODE","verify-full")
    if sslmode not in ("verify-full","verify-ca"):
        raise ValueError("Private index TLS verification is required. No sync performed.")
    logging.info("Preparing private search index; %s source BP keys",f"{len(records):,}")
    with psycopg2.connect(dsn,sslmode=sslmode,connect_timeout=15) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(49328217)")
            cur.execute("""CREATE TABLE IF NOT EXISTS bp_search (
                source_key text PRIMARY KEY,bp_id text NOT NULL,bp_type_id text NOT NULL,
                name_1 text NOT NULL,address text NOT NULL,norm_text text NOT NULL,
                text_len integer NOT NULL,len_bucket text NOT NULL,token_count integer NOT NULL,
                exact_hash text NOT NULL,ktp_hash text,row_hash text NOT NULL,
                active boolean NOT NULL DEFAULT true
            )""")
            cur.execute("""CREATE TABLE IF NOT EXISTS bp_search_group (
                len_bucket text NOT NULL,token_count integer NOT NULL,
                count bigint NOT NULL,PRIMARY KEY(len_bucket,token_count)
            )""")
            cur.execute("""CREATE TABLE IF NOT EXISTS bp_search_meta (
                id integer PRIMARY KEY CHECK(id=1),sync_id text NOT NULL,
                sync_state text NOT NULL,total_bp_rows bigint NOT NULL,
                last_sync_at text NOT NULL
            )""")
            for sql in [
                "CREATE INDEX IF NOT EXISTS bp_search_exact ON bp_search(exact_hash) WHERE active",
                "CREATE INDEX IF NOT EXISTS bp_search_ktp ON bp_search(ktp_hash) WHERE active",
                "CREATE INDEX IF NOT EXISTS bp_search_group_rows ON bp_search(len_bucket,token_count,source_key) WHERE active",
            ]: cur.execute(sql)
            cur.execute("CREATE TEMP TABLE bp_seen_keys (source_key text PRIMARY KEY) ON COMMIT DROP")
            items=list(records.values())
            hmac_key=required_secret("PRIVATE_INDEX_KTP_HMAC_KEY").encode("utf-8")
            for i in range(0,len(items),BATCH):
                group=items[i:i+BATCH]
                execute_values(cur,"INSERT INTO bp_seen_keys(source_key) VALUES %s",
                    [(row["bp_id"],) for row in group],page_size=1000)
                values=[]
                for row in group:
                    ktp_hmac=(hmac.new(hmac_key,row["ktp_number"].encode(),"sha256").hexdigest()
                              if row["ktp_number"] else None)
                    values.append((
                        row["bp_id"],row["bp_id"],row["bp_type_id"],row["name_1"],
                        row["address"],row["norm_text"],row["text_len"],
                        row["len_bucket"],row["token_count"],row["exact_hash"],
                        ktp_hmac,row["row_hash"],True
                    ))
                execute_values(cur,"""INSERT INTO bp_search (
                    source_key,bp_id,bp_type_id,name_1,address,norm_text,text_len,
                    len_bucket,token_count,exact_hash,ktp_hash,row_hash,active
                ) VALUES %s ON CONFLICT(source_key) DO UPDATE SET
                    bp_type_id=EXCLUDED.bp_type_id,name_1=EXCLUDED.name_1,
                    address=EXCLUDED.address,norm_text=EXCLUDED.norm_text,
                    text_len=EXCLUDED.text_len,len_bucket=EXCLUDED.len_bucket,
                    token_count=EXCLUDED.token_count,exact_hash=EXCLUDED.exact_hash,
                    ktp_hash=EXCLUDED.ktp_hash,row_hash=EXCLUDED.row_hash,active=true
                WHERE bp_search.row_hash IS DISTINCT FROM EXCLUDED.row_hash
                   OR NOT bp_search.active""",values,page_size=1000)
                logging.info("Private index keys processed: %s / %s",f"{min(i+BATCH,len(items)):,}",f"{len(items):,}")
            cur.execute("""UPDATE bp_search SET active=false
                WHERE active AND NOT EXISTS (
                  SELECT 1 FROM bp_seen_keys k WHERE k.source_key=bp_search.source_key
                )""")
            cur.execute("DELETE FROM bp_search_group")
            cur.execute("""INSERT INTO bp_search_group(len_bucket,token_count,count)
                SELECT len_bucket,token_count,count(*) FROM bp_search WHERE active
                GROUP BY len_bucket,token_count""")
            cur.execute("SELECT count(*) FROM bp_search WHERE active")
            count=cur.fetchone()[0]
            if count!=len(items):raise ValueError("Private index coverage mismatch. Transaction rolled back.")
            cur.execute("""INSERT INTO bp_search_meta
                (id,sync_id,sync_state,total_bp_rows,last_sync_at)
                VALUES(1,%s,'READY',%s,%s)
                ON CONFLICT(id) DO UPDATE SET sync_id=EXCLUDED.sync_id,
                sync_state=EXCLUDED.sync_state,total_bp_rows=EXCLUDED.total_bp_rows,
                last_sync_at=EXCLUDED.last_sync_at""",
                (sync_id,len(items),datetime.now().isoformat(timespec="seconds")))
    logging.info("Private index COMMITTED: %s rows; sync %s",f"{len(records):,}",sync_id)

def update_with_retry(action):
    for attempt in range(5):
        try:return action()
        except Exception as exc:
            status=getattr(getattr(exc,"response",None),"status_code",None)
            if status not in (429,500,502,503,504) or attempt==4:raise
            delay=min(90,4*(2**attempt))
            logging.warning("Sheets temporary HTTP %s; retry in %ss",status,delay)
            time.sleep(delay)

def read_sheet_index(ws, legacy: bool) -> Dict[str,dict]:
    existing={}
    total=ws.row_count
    for start in range(2,total+1,READ_BATCH):
        end=min(total,start+READ_BATCH-1)
        if legacy:
            raw=update_with_retry(lambda:ws.get(f"A{start}:H{end}"))
            for offset,row in enumerate(raw):
                if not row or not str(row[0]).strip():continue
                key=str(row[0]).strip()
                if key in existing:raise ValueError(f"Duplicate existing BP key {key}: no writes made.")
                existing[key]={"row":start+offset,"hash":str(row[7]) if len(row)>7 else "",
                    "old":row[:7]}
        else:
            parts=update_with_retry(lambda:ws.batch_get(
                [f"A{start}:A{end}",f"H{start}:H{end}"]))
            keys,hashes=parts
            for offset,row in enumerate(keys):
                if not row or not str(row[0]).strip():continue
                key=str(row[0]).strip()
                if key in existing:raise ValueError(f"Duplicate existing BP key {key}: no writes made.")
                old_hash=hashes[offset][0] if offset<len(hashes) and hashes[offset] else ""
                existing[key]={"row":start+offset,"hash":str(old_hash)}
        time.sleep(float(os.getenv("GSHEET_READ_BATCH_SLEEP_SECONDS","2.0")))
    return existing

def sync_sheet(records:Dict[str,dict], sync_id:str):
    gc,_=gsheet_client()
    sh=gc.open_by_key(os.getenv("SHEET_ID",DEFAULT_SHEET_ID))
    ws=sh.worksheet("BP_DATABASE")
    header=ws.row_values(1)[:8]
    if header not in (COLUMNS,LEGACY_COLUMNS):
        raise ValueError("BP_DATABASE layout differs from expected A:H; refusing keyed writes.")
    legacy=header==LEGACY_COLUMNS
    existing=read_sheet_index(ws,legacy)
    changes,creates,tombstones=keyed_delta(records,existing)
    # When migrating legacy H=sync_id, derive a hash from the SOURCE and compare
    # A:G so unchanged data needs only a one-column H hash update, never full refill.
    if legacy:
        changes=[]
        for key,record in records.items():
            old=existing.get(key)
            if not old:continue
            if old["old"]==sheet_row(record)[:7]:
                old["hash"]=record["row_hash"]
            else:changes.append((old["row"],record))
        tombstones=[x["row"] for key,x in existing.items() if key not in records]
    count_after=len(existing)+len(creates)
    sheet_metadata=sh.fetch_sheet_metadata().get("sheets",[])
    cells=sum(int(s["properties"].get("gridProperties",{}).get("rowCount",0))*
              int(s["properties"].get("gridProperties",{}).get("columnCount",0))
              for s in sheet_metadata)
    additional=max(0,count_after+1-ws.row_count)*8
    if cells+additional>int(os.getenv("GSHEET_MAX_CELLS","10000000")):
        raise ValueError("Not enough workbook cells for appended keyed records; no changes made.")
    keyed_meta=next((s for s in sheet_metadata if s["properties"].get("title")=="KEYED_SYNC_META"),None)
    if not keyed_meta and cells+additional+200>int(os.getenv("GSHEET_MAX_CELLS","10000000")):
        raise ValueError("Not enough cells to create KEYED_SYNC_META. No changes made.")
    logging.info("Keyed Sheet plan: change=%s append=%s tombstone=%s unchanged=%s legacy=%s",
        len(changes),len(creates),len(tombstones),
        len(records)-len(changes)-len(creates),legacy)
    try: status=sh.worksheet("KEYED_SYNC_META")
    except Exception:status=sh.add_worksheet(title="KEYED_SYNC_META",rows=100,cols=2)
    # Legacy reader MUST never issue PASS after its row-number indexes become
    # inconsistent. Do not ever set old META back to READY in keyed mode.
    old_meta=sh.worksheet("META")
    old_meta_rows=old_meta.get("A2:B50")
    old_row=next((i+2 for i,row in enumerate(old_meta_rows) if row and row[0]=="sync_state"),None)
    if not old_row:raise ValueError("META lacks sync_state; no BP rows modified.")
    update_with_retry(lambda:old_meta.update(range_name=f"B{old_row}",values=[["IN_PROGRESS"]],
                       value_input_option="RAW"))
    update_with_retry(lambda:status.update(range_name="A1:B4",
        values=[["sync_state","IN_PROGRESS"],["sync_id",sync_id],
                ["total_bp_rows",str(len(records))],["last_sync_at",datetime.now().isoformat()]],
        value_input_option="RAW"))
    if legacy:
        # Bootstrap ONLY the hash column, preserving every original BP row.
        # After an interrupted bootstrap rerun, each row is reconciled.
        by_row={v["row"]:key for key,v in existing.items()}
        changed_rows={row for row,_ in changes}
        values=[]
        for row_no in range(2,len(existing)+2):
            key=by_row.get(row_no)
            if key is None:
                raise ValueError("Noncontiguous BP_DATABASE keys; no safe bootstrap.")
            if key not in records:
                values.append(["DELETED"])
            elif row_no in changed_rows:
                # Never publish a new row hash BEFORE the corresponding A:G
                # fields have actually been updated; interrupted sync recovers.
                values.append(["PENDING"])
            else:
                values.append([records[key]["row_hash"]])
        for start in range(0,len(values),READ_BATCH):
            stop=min(start+READ_BATCH,len(values))
            update_with_retry(lambda start=start,stop=stop:ws.update(
                range_name=f"H{start+2}:H{stop+1}",values=values[start:stop],
                value_input_option="RAW"))
        update_with_retry(lambda:ws.update(range_name="H1",
            values=[["row_hash"]],value_input_option="RAW"))
    # Changed records: update existing A:H in place using stable BP key.
    for start in range(0,len(changes),100):
        part=changes[start:start+100]
        update_with_retry(lambda part=part:ws.batch_update([
            {"range":f"A{row}:H{row}","values":[sheet_row(rec)]}
            for row,rec in part],value_input_option="RAW"))
    if not legacy:
        for start in range(0,len(tombstones),100):
            part=tombstones[start:start+100]
            update_with_retry(lambda part=part:ws.batch_update([
                {"range":f"H{row}","values":[["DELETED"]]}
                for row in part],value_input_option="RAW"))
    # Append-only for newly discovered keys. Reconciliation on the next run
    # handles partial append failure without clearing or duplicating existing rows.
    for start in range(0,len(creates),1000):
        values=[sheet_row(x) for x in creates[start:start+1000]]
        ws.append_rows(values,value_input_option="RAW")
    update_with_retry(lambda:status.update(range_name="A1:B4",
        values=[["sync_state","READY"],["sync_id",sync_id],
                ["total_bp_rows",str(len(records))],
                ["last_sync_at",datetime.now().isoformat(timespec="seconds")]],
        value_input_option="RAW"))
    logging.info("Keyed Sheet READY, source=%s, updated=%s, appended=%s, tombstoned=%s",
        len(records),len(changes),len(creates),len(tombstones))

def main():
    read_env()
    dsn=ensure_private_mode()
    df=fetch_pg_dataframe()
    records=make_records(df)
    sync_id=datetime.now().strftime("%Y%m%dT%H%M%S")+"-"+uuid.uuid4().hex[:12]
    sync_private(records,sync_id,dsn)
    sync_sheet(records,sync_id)

if __name__=="__main__":
    try:
        with single_sync_lock():main()
    except (RuntimeError,ValueError) as exc:
        logging.error("%s",exc)
        sys.exit(2)
