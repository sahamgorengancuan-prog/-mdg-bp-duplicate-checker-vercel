"""
Sync MDG BP data from PostgreSQL to protected Google Sheet with compact indexes for the duplicate-checker API.

Output tabs:
- BP_DATABASE      : bp_id, bp_type_id, name_1, address, norm_text, norm_digits, text_len
- KTP_INDEX        : ktp_digits, bp_db_row
- INDEX_LEN        : len_bucket, row_start, row_end, count
- INDEX_KTP_SHARD  : ktp_shard, row_start, row_end, count
- META             : key, value

Why compact indexes?
Google Sheets should remain the protected source-of-truth for the web app, but the Worker should not scan 1M rows.
BP_DATABASE is sorted by text_len bucket so the Worker can fetch only relevant A1 ranges.
KTP_INDEX is sorted by KTP shard so exact KTP lookup fetches only a small range.
"""
from __future__ import annotations

import os
import re
import sys
import math
import time
import json
import logging
from datetime import datetime
from typing import Dict, Iterable, List, Tuple

import pandas as pd
import psycopg2
from dotenv import load_dotenv
import gspread
from google.oauth2.service_account import Credentials

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(ROOT, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, "sync_gsheet_indexed.log"), encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

DEFAULT_QUERY = """
SELECT
    bgv.bp_id::text AS bp_id,
    bgv.bp_type_id::text AS bp_type_id,
    COALESCE(bgv.name_1, '')::text AS name_1,
    COALESCE(bgv.address, '')::text AS address,
    COALESCE(mbdc.ktp_number, '')::text AS ktp_number
FROM m_bp_general_view bgv
LEFT JOIN m_bp_doc_completion mbdc
       ON mbdc.bp_id = bgv.bp_id
WHERE bgv.bp_id IS NOT NULL;
"""

# If actual address column is not `address`, set DB_QUERY in .env or edit DEFAULT_QUERY, for example:
# COALESCE(CONCAT_WS(' ', bgv.street, bgv.street_2, bgv.street_3, bgv.city, bgv.postal_code), '') AS address


def normalize_text(value: str) -> str:
    value = str(value or "").lower()
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    value = re.sub(r"\b(pt|cv|tbk|ud|toko|tk|jl|jalan|gg|gang|no|nomor)\b", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def normalize_digits(value: str) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def len_bucket(text_len: int) -> str:
    return str(int(text_len or 0) // 5).zfill(3)


def ktp_shard(ktp: str) -> str:
    d = normalize_digits(ktp)
    return d[-2:].zfill(2) if d else ""


def read_env() -> None:
    env_path = os.path.join(ROOT, ".env")
    load_dotenv(env_path)
    logging.info("Loaded env: %s", env_path)


def db_connect():
    return psycopg2.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASS"],
        connect_timeout=30,
    )


def fetch_pg_dataframe() -> pd.DataFrame:
    query = os.environ.get("DB_QUERY", DEFAULT_QUERY)
    logging.info("Connecting to PostgreSQL...")
    with db_connect() as conn:
        logging.info("Running query...")
        df = pd.read_sql_query(query, conn)
    logging.info("Fetched %,d rows", len(df))
    return df


def prepare_indexes(df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    required = ["bp_id", "bp_type_id", "name_1", "address", "ktp_number"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Query output missing columns: {missing}")

    for col in required:
        df[col] = df[col].fillna("").astype(str)

    logging.info("Normalizing text...")
    df["norm_text"] = (df["name_1"] + " " + df["address"]).map(normalize_text)
    df["norm_digits"] = (df["name_1"] + " " + df["address"]).map(normalize_digits)
    df["text_len"] = df["norm_text"].str.len().astype(int)
    df["len_bucket"] = df["text_len"].map(len_bucket)
    df["ktp_digits"] = df["ktp_number"].map(normalize_digits)
    df["ktp_shard"] = df["ktp_digits"].map(ktp_shard)

    # Main database is sorted by length bucket, enabling A1 range lookup.
    bp = df[["bp_id", "bp_type_id", "name_1", "address", "norm_text", "norm_digits", "text_len", "len_bucket"]].copy()
    bp = bp.sort_values(["len_bucket", "text_len", "bp_id"], kind="mergesort").reset_index(drop=True)
    bp["bp_db_row"] = bp.index + 2  # Sheet row number; header is row 1.

    bp_out = bp[["bp_id", "bp_type_id", "name_1", "address", "norm_text", "norm_digits", "text_len"]]

    logging.info("Building INDEX_LEN...")
    idx_len = (
        bp.groupby("len_bucket", sort=True)
          .agg(row_start=("bp_db_row", "min"), row_end=("bp_db_row", "max"), count=("bp_id", "count"))
          .reset_index()
    )

    logging.info("Building KTP_INDEX...")
    # Map original rows to BP_DATABASE row by the complete key. This handles duplicate BP IDs safely.
    row_lookup = bp[["bp_id", "bp_db_row"]].drop_duplicates("bp_id", keep="first")
    ktp = df[df["ktp_digits"].str.len() > 0][["bp_id", "ktp_digits", "ktp_shard"]].copy()
    ktp = ktp.merge(row_lookup, on="bp_id", how="left")
    ktp = ktp.dropna(subset=["bp_db_row"])
    ktp["bp_db_row"] = ktp["bp_db_row"].astype(int)
    ktp = ktp.sort_values(["ktp_shard", "ktp_digits", "bp_db_row"], kind="mergesort").reset_index(drop=True)
    ktp["ktp_index_row"] = ktp.index + 2
    ktp_out = ktp[["ktp_digits", "bp_db_row"]]

    logging.info("Building INDEX_KTP_SHARD...")
    if len(ktp):
        idx_ktp = (
            ktp.groupby("ktp_shard", sort=True)
               .agg(row_start=("ktp_index_row", "min"), row_end=("ktp_index_row", "max"), count=("ktp_digits", "count"))
               .reset_index()
        )
    else:
        idx_ktp = pd.DataFrame(columns=["ktp_shard", "row_start", "row_end", "count"])

    cell_estimate = len(bp_out) * len(bp_out.columns) + len(ktp_out) * len(ktp_out.columns) + 10000
    if cell_estimate > int(os.environ.get("GSHEET_MAX_CELL_WARNING", "9500000")):
        logging.warning(
            "Estimated Google Sheet cells %,d is close to or above safe limit. Consider reducing columns or moving index to a dedicated database.",
            cell_estimate,
        )

    meta = pd.DataFrame([
        ["last_sync_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
        ["total_bp_rows", str(len(bp_out))],
        ["total_ktp_index_rows", str(len(ktp_out))],
        ["len_bucket_count", str(len(idx_len))],
        ["ktp_shard_count", str(len(idx_ktp))],
        ["source", "PostgreSQL MDG -> Protected Google Sheet"],
        ["schema", "BP_DATABASE:A:G; KTP_INDEX:A:B; INDEX_LEN:A:D; INDEX_KTP_SHARD:A:D"],
    ], columns=["key", "value"])

    return bp_out, ktp_out, idx_len, idx_ktp, meta


def gsheet_client():
    service_account_file = os.environ.get("SERVICE_ACCOUNT_FILE", os.path.join(ROOT, "service_account.json"))
    creds = Credentials.from_service_account_file(service_account_file, scopes=SCOPES)
    return gspread.authorize(creds), creds.service_account_email


def get_or_create_worksheet(sh, title: str, rows: int, cols: int):
    try:
        ws = sh.worksheet(title)
        if ws.row_count < rows or ws.col_count < cols:
            ws.resize(rows=max(ws.row_count, rows), cols=max(ws.col_count, cols))
        return ws
    except gspread.WorksheetNotFound:
        return sh.add_worksheet(title=title, rows=max(rows, 100), cols=max(cols, 10))


def chunks(values: List[List[str]], size: int) -> Iterable[Tuple[int, List[List[str]]]]:
    for i in range(0, len(values), size):
        yield i, values[i:i + size]


def dataframe_values(df: pd.DataFrame) -> List[List[str]]:
    out = [list(df.columns)]
    for row in df.itertuples(index=False, name=None):
        out.append(["" if pd.isna(x) else str(x) for x in row])
    return out


def write_dataframe(sh, title: str, df: pd.DataFrame, chunk_size: int = 20000) -> int:
    rows = len(df) + 1
    cols = len(df.columns)
    ws = get_or_create_worksheet(sh, title, rows=max(rows, 100), cols=max(cols, 10))
    logging.info("Writing %s: %,d rows x %,d cols", title, rows, cols)
    ws.clear()
    ws.resize(rows=max(rows, 100), cols=max(cols, 10))
    values = dataframe_values(df)

    # gspread update can handle a lot, but chunking is safer for very large sheets.
    # Keep column count fixed and use A1 ranges row-by-row chunks.
    for start_idx, chunk in chunks(values, chunk_size):
        row_start = start_idx + 1
        row_end = start_idx + len(chunk)
        col_end = column_letter(cols)
        ws.update(f"A{row_start}:{col_end}{row_end}", chunk, value_input_option="RAW")
        logging.info("%s updated rows %,d-%,d", title, row_start, row_end)
        time.sleep(float(os.environ.get("GSHEET_WRITE_SLEEP_SECONDS", "0.2")))
    return ws.id


def column_letter(n: int) -> str:
    result = ""
    while n:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result


def protect_and_hide_tabs(sh, service_account_email: str, protected_titles: List[str], hidden_titles: List[str]) -> None:
    if os.environ.get("APPLY_SHEET_PROTECTION", "true").lower() != "true":
        logging.info("Skipping sheet protection because APPLY_SHEET_PROTECTION=false")
        return

    sheet_meta = sh.fetch_sheet_metadata()
    title_to_id = {s["properties"]["title"]: s["properties"]["sheetId"] for s in sheet_meta.get("sheets", [])}

    requests = []
    for title in protected_titles:
        sid = title_to_id.get(title)
        if sid is None:
            continue
        requests.append({
            "addProtectedRange": {
                "protectedRange": {
                    "range": {"sheetId": sid},
                    "description": f"Protected by MDG BP Duplicate Checker sync: {title}",
                    "warningOnly": False,
                    "editors": {"users": [service_account_email]}
                }
            }
        })

    for title in hidden_titles:
        sid = title_to_id.get(title)
        if sid is None:
            continue
        requests.append({
            "updateSheetProperties": {
                "properties": {"sheetId": sid, "hidden": True},
                "fields": "hidden"
            }
        })

    if not requests:
        return
    try:
        sh.batch_update({"requests": requests})
        logging.info("Applied protection/hidden settings")
    except Exception as exc:
        # Owners can always edit; repeated addProtectedRange can fail if protections already exist.
        logging.warning("Protection/hidden update warning: %s", exc)


def main():
    read_env()
    sheet_id = os.environ["SHEET_ID"]
    chunk_size = int(os.environ.get("GSHEET_CHUNK_SIZE", "20000"))

    df = fetch_pg_dataframe()
    bp_out, ktp_out, idx_len, idx_ktp, meta = prepare_indexes(df)

    gc, service_account_email = gsheet_client()
    sh = gc.open_by_key(sheet_id)

    write_dataframe(sh, "BP_DATABASE", bp_out, chunk_size)
    write_dataframe(sh, "KTP_INDEX", ktp_out, chunk_size)
    write_dataframe(sh, "INDEX_LEN", idx_len, chunk_size)
    write_dataframe(sh, "INDEX_KTP_SHARD", idx_ktp, chunk_size)
    write_dataframe(sh, "META", meta, chunk_size)

    protect_and_hide_tabs(
        sh,
        service_account_email,
        protected_titles=["BP_DATABASE", "KTP_INDEX", "INDEX_LEN", "INDEX_KTP_SHARD", "META"],
        hidden_titles=["KTP_INDEX", "INDEX_LEN", "INDEX_KTP_SHARD"],
    )

    logging.info("DONE. Sheet synced and indexed successfully.")


if __name__ == "__main__":
    main()
