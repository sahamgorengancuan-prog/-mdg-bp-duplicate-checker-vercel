"""Google-Sheets-only keyed BP sync. OAuth unchanged; no private search DB.

BP_DATABASE A:H is an append-only, keyed mirror: update only changed BP keys,
append new BP keys, tombstone missing ones. H is SHA-256 row hash (NOT sync ID).
Compact Google Sheets search indexes may need reordering/rebuilding when any BP
changes; they are separate tabs and NEVER clear/repopulate BP_DATABASE.

The INACTIVE snapshot META becomes IN_PROGRESS before its first changed cell.
The currently ACTIVE Google workbook stays untouched and usable by the web
app. READY and control-pointer publication follow keyed/index verification.
"""
from __future__ import annotations
import hashlib, json, os, sys, time, uuid
from pathlib import Path
from datetime import datetime
from typing import Dict
import pandas as pd
from sync_gsheet_indexed import (
    logging, normalize_text, normalize_digits,
    fetch_pg_dataframe, gsheet_client, read_env, single_sync_lock,
)
COLUMNS=["bp_id","bp_type_id","name_1","address",
         "norm_text","norm_digits","text_len","row_hash"]
LEGACY_COLUMNS=COLUMNS[:-1]+["sync_id"]
READ_BATCH=5000
INDEX_WRITE_BATCH=5000

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


def update_with_retry(action):
    for attempt in range(5):
        try:return action()
        except Exception as exc:
            status=getattr(getattr(exc,"response",None),"status_code",None)
            if status not in (429,500,502,503,504) or attempt==4:raise
            delay=min(90,4*(2**attempt))
            logging.warning("Sheets temporary HTTP %s; retry in %ss",status,delay)
            time.sleep(delay)



def build_index_rows(records, positions, sync_id):
    """Every posting carries BOTH immutable BP key and current BP row/hash.

    A physical row is a navigation hint; it never establishes BP identity.
    The API verifies bp_id+row_hash+normalized text before returning a hit.
    """
    source=[]
    for key, rec in records.items():
        position=positions.get(key)
        if not isinstance(position,int) or position<2:
            raise ValueError("Missing stable BP row position; no index may publish.")
        source.append((rec,position))
    source.sort(key=lambda t:(t[0]["len_bucket"],t[0]["token_count"],t[0]["bp_id"]))
    # Two-cell posting: searchable group and compact JSON array.
    # Array stores only text, physical row hint and stable BP ID.
    fuzzy=[[rec["len_bucket"]+":"+str(rec["token_count"]),
            json.dumps([rec["norm_text"],row,rec["bp_id"]],
                       ensure_ascii=False,separators=(",",":"))]
           for rec,row in source]
    groups=[]
    for index,(rec,row) in enumerate(source):
        key=rec["len_bucket"]+":"+str(rec["token_count"])
        if groups and groups[-1][0]==key:
            groups[-1][2]=str(index+2)
            groups[-1][3]=str(int(groups[-1][3])+1)
        else: groups.append([key,str(index+2),str(index+2),"1",sync_id])
    exact=sorted(
        [[rec["exact_hash"],json.dumps([row,rec["bp_id"]],
                                    ensure_ascii=False,separators=(",",":"))]
         for rec,row in source],key=lambda x:(x[0],x[1]))
    ktp=sorted(
        [[rec["ktp_number"],json.dumps([row,rec["bp_id"]],
                                    ensure_ascii=False,separators=(",",":"))]
         for rec,row in source if rec["ktp_number"]],
        key=lambda x:(x[0][-2:],x[0],x[1]))
    def shards(items,keyer):
        out=[]
        for i,row in enumerate(items):
            key=keyer(row)
            if out and out[-1][0]==key:
                out[-1][2]=str(i+2)
                out[-1][3]=str(int(out[-1][3])+1)
            else:out.append([key,str(i+2),str(i+2),"1",sync_id])
        return out
    exact_shards=shards(exact,lambda x:x[0][:2])
    ktp_shards=shards(ktp,lambda x:x[0][-2:].zfill(2))
    tabs={
      "INDEX_LEN_TOKEN":[["len_token_key","posting_json"]]+fuzzy,
      "INDEX_LEN":[["len_token_key","row_start","row_end","count","sync_id"]]+groups,
      "KTP_INDEX":[["ktp_digits","posting_json"]]+ktp,
      "INDEX_KTP_SHARD":[["ktp_shard","row_start","row_end","count","sync_id"]]+ktp_shards,
      "EXACT_INDEX":[["exact_hash","posting_json"]]+exact,
      "INDEX_EXACT_SHARD":[["exact_shard","row_start","row_end","count","sync_id"]]+exact_shards
    }
    assert sum(int(x[3]) for x in groups)==len(records)
    assert sum(int(x[3]) for x in exact_shards)==len(records)
    assert sum(int(x[3]) for x in ktp_shards)==len(ktp)
    return tabs, len(ktp), len(groups)

def make_meta(sync_id,bp_count,ktp_count,group_count,state):
    data=[
        ["sync_id",sync_id],
        ["last_sync_at",datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
        ["total_bp_rows",str(bp_count)],
        ["total_ktp_index_rows",str(ktp_count)],
        ["total_exact_index_rows",str(bp_count)],
        ["exact_index_version","1"],
        ["keyed_index_version","14"],
        ["token_index_version","1"],
        ["token_index_groups",str(group_count)],
        ["sync_state",state],
        ["source","PostgreSQL MDG -> protected keyed Google Sheets"],
        ["schema","KEYED_V14_SHARDED:BP_DATABASE:A:H primary; PACKED_INDEXES:A:B secondary"]
    ]
    return [["key","value"]]+data

def preflight_capacity(sh,plans,new_bp_rows,role):
    """Fail closed above 75% of the conservative 10M grid-cell ceiling, per book.

    This checks ALLOCATED cells, not only populated cells; Google's additional
    document-size limits can still refuse editing below the allocation cap.
    """
    metadata=sh.fetch_sheet_metadata().get("sheets",[])
    existing={s["properties"]["title"]:s["properties"].get("gridProperties",{})
        for s in metadata}
    result=0
    current=0
    for title,grid in existing.items():
        allocated=int(grid.get("rowCount",0))*int(grid.get("columnCount",0))
        current+=allocated
        if title in plans:
            rows=plans[title]
            result+=max(len(rows),100)*len(rows[0])
        elif title=="BP_DATABASE":
            result+=max(new_bp_rows,int(grid.get("rowCount",0)))*8
        else:
            result+=allocated
        logging.info("%s allocated %s: %s rows x %s cols = %s cells",
                     role,title,grid.get("rowCount",0),
                     grid.get("columnCount",0),f"{allocated:,}")
    for title,rows in plans.items():
        if title not in existing:
            result+=max(len(rows),100)*len(rows[0])
    limit=7500000
    logging.info("%s capacity preflight: current=%s projected=%s hard_guard=%s",
                 role,f"{current:,}",f"{result:,}",f"{limit:,}")
    if current>limit or result>limit:
        raise ValueError(
            f"{role} workbook capacity current={current:,} projected="
            f"{result:,} exceeds strict 75% guard {limit:,}. "
            "Do not raise the limit or publish partial snapshots.")
    return {"current":current,"projected":result,"limit":limit}

def write_index(sh,title,rows):
    try:ws=sh.worksheet(title)
    except Exception as exc:
        if exc.__class__.__name__!="WorksheetNotFound":raise
        ws=sh.add_worksheet(title=title,rows=max(100,len(rows)),cols=len(rows[0]))
    # Unlike the old full sync, this NEVER calls clear(). Only index tabs are
    # materialized; indexed rows must be contiguous for efficient range reads.
    need=max(100,len(rows))
    if ws.row_count<need or ws.col_count<len(rows[0]):
        ws.resize(rows=max(ws.row_count,need),cols=len(rows[0]))
    col=chr(ord("A")+len(rows[0])-1)
    for start in range(0,len(rows),INDEX_WRITE_BATCH):
        block=rows[start:start+INDEX_WRITE_BATCH]
        a,b=start+1,start+len(block)
        # Resume failed staging efficiently: if a complete block is already
        # identical, its readback serves as verification (no duplicate write).
        actual=update_with_retry(lambda a=a,b=b:
            ws.get(f"A{a}:{col}{b}"))
        if actual!=block:
            update_with_retry(lambda a=a,b=b,block=block:ws.update(
                range_name=f"A{a}:{col}{b}",
                values=block,value_input_option="RAW"))
            actual=update_with_retry(lambda a=a,b=b:
                ws.get(f"A{a}:{col}{b}"))
            if actual!=block:
                raise RuntimeError(
                    f"{title} read-back mismatch at {a}:{b}. No publish.")
            logging.info("%s WRITTEN+VERIFIED rows %s-%s",title,f"{a:,}",f"{b:,}")
        else:
            logging.info("%s REUSED+VERIFIED rows %s-%s",title,f"{a:,}",f"{b:,}")
        time.sleep(float(os.getenv("GSHEET_WRITE_SLEEP_SECONDS","0.2")))
    # Shrink obsolete *index tail* only, never BP_DATABASE physical rows.
    if ws.row_count!=need or ws.col_count!=len(rows[0]):
        ws.resize(rows=need,cols=len(rows[0]))
    return ws

def read_sheet_index(ws, legacy):
    existing={}
    max_row=1
    for start in range(2,ws.row_count+1,READ_BATCH):
        end=min(ws.row_count,start+READ_BATCH-1)
        rows=update_with_retry(lambda start=start,end=end:
                               ws.get(f"A{start}:H{end}"))
        for offset, row in enumerate(rows):
            if not row or not str(row[0]).strip():continue
            key=str(row[0]).strip()
            if key in existing:raise ValueError(
                f"Duplicate key {key} in BP_DATABASE; zero sheet writes.")
            old=row[:7]
            existing[key]={"row":start+offset,
                "hash":str(row[7]) if len(row)>7 else "","old":old}
            max_row=max(max_row,start+offset)
        logging.info("Scanned existing BP keys through row %s / %s",
                     f"{end:,}",f"{ws.row_count:,}")
        time.sleep(float(os.getenv("GSHEET_READ_BATCH_SLEEP_SECONDS","1.0")))
    if max_row!=len(existing)+1:
        raise ValueError("BP_DATABASE has physical key gaps; unsafe to append, no writes.")
    return existing


SNAPSHOT_CONFIG_PATH=Path(__file__).resolve().parents[1]/"config"/"gsheet_snapshots.json"

def snapshot_ids():
    """Shared Git config, optional environment overrides; legacy ID is explicit.

    Never guess SHEET_ID from old code: the previous default points to A,
    although the user's actual legacy/initial workbook is distinct.
    """
    with SNAPSHOT_CONFIG_PATH.open("r",encoding="utf-8") as f:
        config=json.load(f)
    mode=os.getenv("GSHEET_SNAPSHOT_MODE",config.get("mode","")).strip().lower()
    if mode!="dual":
        raise ValueError("GSHEET_SNAPSHOT_MODE=dual is required for keyed A/B sync.")
    names={"SHEET_A_ID":"sheet_a_id","SHEET_B_ID":"sheet_b_id",
           "SHEET_A2_ID":"sheet_a2_id","SHEET_B2_ID":"sheet_b2_id",
           "SHEET_CONTROL_ID":"sheet_control_id"}
    ids={key:os.getenv(key,config.get(field,"")).strip()
         for key,field in names.items()}
    legacy=os.getenv("SHEET_ID","").strip()
    if not legacy:
        raise ValueError("SHEET_ID must explicitly identify the DIFFERENT legacy/initial sheet in .env. No writes.")
    if (not all(ids.values()) or len(set(ids.values()))!=5 or
        legacy in ids.values()):
        raise ValueError(
            "A/A2, B/B2, CONTROL and legacy SHEET_ID must be SIX DISTINCT workbooks. "
            "Create the two authorized index workbooks before syncing; no writes."
        )
    if os.getenv("PRIVATE_INDEX_MODE","off").lower()=="required":
        raise ValueError("PRIVATE_INDEX_MODE=required is incompatible with Sheets-only dual mode.")
    return ids

def source_digest(records):
    digest=hashlib.sha256()
    for key in sorted(records):
        digest.update(key.encode("utf-8"))
        digest.update(b"\x1f")
        digest.update(records[key]["row_hash"].encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()

def control_active(sh):
    try: ws=sh.worksheet("ACTIVE")
    except Exception as exc:
        if exc.__class__.__name__=="WorksheetNotFound": return {}
        raise
    rows=update_with_retry(lambda:ws.get("A1:B20"))
    return {str(row[0]):str(row[1]) for row in rows if len(row)>=2 and row[0]}

def read_meta(sh):
    try: ws=sh.worksheet("META")
    except Exception as exc:
        if exc.__class__.__name__=="WorksheetNotFound":return {}
        raise
    rows=update_with_retry(lambda:ws.get("A2:B50"))
    return {str(row[0]):str(row[1]) for row in rows if len(row)>=2 and row[0]}

def safe_worksheet(sh,title,columns):
    try: return sh.worksheet(title)
    except Exception as exc:
        if exc.__class__.__name__!="WorksheetNotFound":raise
        return sh.add_worksheet(title=title,rows=100,cols=columns)

def sync_sheet(records,sync_id):
    ids=snapshot_ids()
    gc,_=gsheet_client()  # PROVEN local OAuth token; no other auth mechanism.
    control=gc.open_by_key(ids["SHEET_CONTROL_ID"])
    active=control_active(control)
    active_id=active.get("active_sheet_id","")
    book_pairs={
        ids["SHEET_A_ID"]:ids["SHEET_A2_ID"],
        ids["SHEET_B_ID"]:ids["SHEET_B2_ID"]}
    if active_id and (active.get("sync_state")!="READY" or
                      active_id not in book_pairs or
                      active.get("active_index_sheet_id")!=book_pairs[active_id]):
        raise ValueError("Invalid committed PRIMARY+INDEX control pair; no fallback.")
    digest=source_digest(records)
    if active_id:
        live=gc.open_by_key(active_id)
        live_meta=read_meta(live)
        index_live=gc.open_by_key(book_pairs[active_id])
        live_index_meta=read_meta(index_live)
        if any(
            m.get("sync_state")!="READY" or
            m.get("sync_id")!=active.get("sync_id") or
            m.get("source_digest")!=active.get("source_digest") or
            m.get("total_bp_rows")!=active.get("total_bp_rows") or
            m.get("keyed_index_version")!="14"
            for m in (live_meta,live_index_meta)
        ):
            raise ValueError("Active primary/index META does not match control.")
        if active["source_digest"]==digest and int(active["total_bp_rows"])==len(records):
            logging.info("NOOP: no changes to source BP keys/hashes. Active snapshot remains %s",
                         active["sync_id"])
            return {"updated":0,"appended":0,"tombstoned":0,
                    "unchanged":len(records),"sync_id":active["sync_id"]}
    # A already contains a failed oversized v12/v13 staging run. Initial
    # publication uses fresh B+B2 instead of attempting to edit that document.
    # A/A2 can only be reused after B is active and A has been remediated.
    stage_id=(ids["SHEET_B_ID"] if active_id==ids["SHEET_A_ID"]
              else ids["SHEET_A_ID"])
    if not active_id:
        a=gc.open_by_key(ids["SHEET_A_ID"])
        try:
            prior_a=a.worksheet("BP_DATABASE")
            if prior_a.row_values(1):
                stage_id=ids["SHEET_B_ID"]
                logging.warning("Existing unpublished A staging detected; initial "
                                "publication goes to fresh B+B2. A untouched.")
        except Exception as exc:
            if exc.__class__.__name__!="WorksheetNotFound":raise
    stage_index_id=book_pairs[stage_id]
    logging.info("Dual snapshot: ACTIVE=%s STAGING=%s (OAuth-controlled IDs)",
                 "A" if active_id==ids["SHEET_A_ID"] else
                 "B" if active_id else "LEGACY",
                 "A" if stage_id==ids["SHEET_A_ID"] else "B")
    sh=gc.open_by_key(stage_id)
    ish=gc.open_by_key(stage_index_id)
    ws=safe_worksheet(sh,"BP_DATABASE",8)
    header=ws.row_values(1)[:8]
    if header and header not in (COLUMNS,LEGACY_COLUMNS):
        raise ValueError("Staging BP_DATABASE has unexpected A:H schema; no writes.")
    legacy=header==LEGACY_COLUMNS
    existing=read_sheet_index(ws,legacy) if header else {}
    changes,creates,tombstones=keyed_delta(records,existing)
    # A hash alone cannot prove A:G was completely written after a crash or
    # concurrent manual edit. Reconcile real fields for every existing BP.
    if not legacy:
        changed={row for row,_ in changes}
        for key,record in records.items():
            prior=existing.get(key)
            if prior and prior["row"] not in changed and (
                    prior["old"]!=sheet_row(record)[:7]):
                changes.append((prior["row"],record))
    if legacy:
        changes=[]
        for key,record in records.items():
            prior=existing.get(key)
            if prior and prior["old"]!=sheet_row(record)[:7]:
                changes.append((prior["row"],record))
        tombstones=[v["row"] for k,v in existing.items() if k not in records]
    positions={key:rec["row"] for key,rec in existing.items() if key in records}
    for n,rec in enumerate(creates,start=len(existing)+2):
        positions[rec["bp_id"]]=n
    if len(positions)!=len(records):
        raise ValueError("Unique BP key coverage mismatch. No writes.")
    tabs,ktp_count,group_count=build_index_rows(records,positions,sync_id)
    final_meta=make_meta(sync_id,len(records),ktp_count,group_count,"READY")
    final_meta.extend([["source_digest",digest],
                       ["physical_bp_rows",str(len(existing)+len(creates))]])
    pending_meta=[list(row) for row in final_meta]
    next(row for row in pending_meta if row[0]=="sync_state")[1]="IN_PROGRESS"
    # Both workbooks must pass BEFORE any BP or index values are written.
    preflight_capacity(sh,{"META":final_meta},len(existing)+len(creates)+1,
                       "STAGING_PRIMARY")
    preflight_capacity(ish,{**tabs,"META":final_meta},1,"STAGING_INDEX")
    logging.info("Keyed delta: existing=%s changed=%s appended=%s tombstone=%s",
                 len(existing),len(changes),len(creates),len(tombstones))
    metadata=safe_worksheet(sh,"META",2)
    index_metadata=safe_worksheet(ish,"META",2)
    for marker in (metadata,index_metadata):
        update_with_retry(lambda marker=marker:marker.update(
            range_name=f"A1:B{len(pending_meta)}",
            values=pending_meta,value_input_option="RAW"))
    if not header:
        update_with_retry(lambda:ws.update(range_name="A1:H1",
                           values=[COLUMNS],value_input_option="RAW"))
    elif legacy:
        by_row={v["row"]:key for key,v in existing.items()}
        dirty={row for row,_ in changes}
        hashes=[["PENDING" if n in dirty else
                 ("DELETED" if by_row[n] not in records
                  else records[by_row[n]]["row_hash"])]
                for n in range(2,len(existing)+2)]
        for start in range(0,len(hashes),INDEX_WRITE_BATCH):
            stop=min(start+INDEX_WRITE_BATCH,len(hashes))
            block=hashes[start:stop]
            update_with_retry(lambda start=start,stop=stop,block=block:
                ws.update(range_name=f"H{start+2}:H{stop+1}",
                          values=block,value_input_option="RAW"))
        update_with_retry(lambda:ws.update(range_name="H1:H1",
                           values=[["row_hash"]],value_input_option="RAW"))
    required=max(100,len(existing)+len(creates)+1)
    if ws.row_count<required:
        ws.resize(rows=required,cols=8)
    for start in range(0,len(changes),100):
        batch=changes[start:start+100]
        update_with_retry(lambda batch=batch:ws.batch_update([
            {"range":f"A{row}:H{row}","values":[sheet_row(rec)]}
            for row,rec in batch],value_input_option="RAW"))
    if not legacy:
        for start in range(0,len(tombstones),100):
            batch=tombstones[start:start+100]
            update_with_retry(lambda batch=batch:ws.batch_update([
                {"range":f"H{row}","values":[["DELETED"]]}
                for row in batch],value_input_option="RAW"))
    for start in range(0,len(creates),INDEX_WRITE_BATCH):
        batch=creates[start:start+INDEX_WRITE_BATCH]
        begin=len(existing)+2+start
        finish=begin+len(batch)-1
        update_with_retry(lambda begin=begin,finish=finish,batch=batch:
            ws.update(range_name=f"A{begin}:H{finish}",
                      values=[sheet_row(x) for x in batch],
                      value_input_option="RAW"))
    # Verify EVERY key/hash in staging before publishing its precomputed index.
    reconciled=read_sheet_index(ws,False)
    if len(reconciled)!=len(existing)+len(creates):
        raise RuntimeError("Staging BP physical count changed during sync.")
    for key,record in records.items():
        actual=reconciled.get(key)
        if (not actual or actual["hash"]!=record["row_hash"] or
            actual["row"]!=positions[key]):
            raise RuntimeError(f"Staging BP key/hash mismatch for {key}; not published.")
    if any(key not in records and row["hash"]!="DELETED"
           for key,row in reconciled.items()):
        raise RuntimeError("Staging tombstone mismatch; not published.")
    logging.info("Verified %s keyed source rows against Google Sheets staging.",
                 f"{len(records):,}")
    for title in ("INDEX_LEN_TOKEN","INDEX_LEN","KTP_INDEX",
                  "INDEX_KTP_SHARD","EXACT_INDEX","INDEX_EXACT_SHARD"):
        write_index(ish,title,tabs[title])
    for title in ("INDEX_LEN_TOKEN","KTP_INDEX","EXACT_INDEX"):
        expected=tabs[title]
        if len(expected)>1:
            sheet=ish.worksheet(title)
            last=len(expected)
            got=update_with_retry(lambda sheet=sheet,last=last,expected=expected:
                sheet.get(f"A{last}:{chr(64+len(expected[0]))}{last}"))
            if not got or [str(v) for v in got[0]]!=expected[-1]:
                raise RuntimeError(f"{title} index boundary mismatch; not READY.")
    # Both READY markers must be verified before CONTROL can reference this pair.
    for marker in (index_metadata,metadata):
        update_with_retry(lambda marker=marker:marker.update(
            range_name=f"A1:B{len(final_meta)}",
            values=final_meta,value_input_option="RAW"))
    for book in (sh,ish):
        staged=read_meta(book)
        if (staged.get("sync_id")!=sync_id or
            staged.get("sync_state")!="READY" or
            staged.get("total_bp_rows")!=str(len(records)) or
            staged.get("source_digest")!=digest or
            staged.get("keyed_index_version")!="14"):
            raise RuntimeError("Primary/index READY marker mismatch; no publish.")
    # A final conservative cell cap check before publishing the pair.
    preflight_capacity(sh,{"META":final_meta},len(existing)+len(creates)+1,
                       "STAGING_PRIMARY_FINAL")
    preflight_capacity(ish,{**tabs,"META":final_meta},1,
                       "STAGING_INDEX_FINAL")
    # Check control has not changed before the SINGLE control-pointer write.
    current=control_active(control)
    if (current.get("active_sheet_id","")!=active_id or
        current.get("active_index_sheet_id","")!=
            active.get("active_index_sheet_id","") or
        (active_id and current.get("sync_id")!=active.get("sync_id"))):
        raise RuntimeError("Control changed concurrently; refusing pointer switch.")
    pointer=safe_worksheet(control,"ACTIVE",2)
    values=[["key","value"],
            ["active_sheet_id",stage_id],
            ["active_index_sheet_id",stage_index_id],
            ["sync_id",sync_id],
            ["total_bp_rows",str(len(records))],
            ["source_digest",digest],
            ["sync_state","READY"],
            ["last_sync_at",datetime.now().isoformat(timespec="seconds")]]
    update_with_retry(lambda:pointer.update(
        range_name="A1:B8",values=values,value_input_option="RAW"))
    verified=control_active(control)
    if (verified.get("active_sheet_id")!=stage_id or
        verified.get("active_index_sheet_id")!=stage_index_id or
        verified.get("sync_id")!=sync_id or
        verified.get("sync_state")!="READY"):
        raise RuntimeError("Control publish verification failed; check ACTIVE sheet.")
    logging.info("PUBLISHED snapshot %s: updated=%s appended=%s tombstones=%s",
                 sync_id,len(changes),len(creates),len(tombstones))
    return {"updated":len(changes),"appended":len(creates),
            "tombstoned":len(tombstones),"sync_id":sync_id}

def main():
    read_env()
    snapshot_ids()   # Fail BEFORE external DB fetch or any sheet writes.
    source=fetch_pg_dataframe()  # Original authorized WINGS MDG PostgreSQL.
    records=make_records(source)
    sync_id=datetime.now().strftime("%Y%m%dT%H%M%S")+"-"+uuid.uuid4().hex[:12]
    return sync_sheet(records,sync_id)

if __name__=="__main__":
    try:
        with single_sync_lock():
            main()
    except Exception:
        logging.exception("DUAL-SNAPSHOT GOOGLE SHEETS SYNC FAILED. Active pointer unchanged unless publish failed.")
        sys.exit(2)
