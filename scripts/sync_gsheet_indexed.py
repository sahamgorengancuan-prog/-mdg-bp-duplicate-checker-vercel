"""
Sync MDG BP data from PostgreSQL to protected Google Sheet with compact indexes for the duplicate-checker API.

Authentication uses OAuth 2.0 user authorization, not a Google service account.
Run bats\\setup_google_oauth.bat once using a @wingscorp.com account that has edit access
to the target Google Sheet.

Output tabs:
- EXACT_INDEX / INDEX_EXACT_SHARD: SHA-256 name/address exact lookup and row pointers
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
import uuid
import hashlib
import unicodedata
from contextlib import contextmanager
from datetime import datetime
from typing import Dict, Iterable, List, Tuple

import pandas as pd
import psycopg2
from dotenv import load_dotenv
import gspread
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow

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

DEFAULT_SHEET_ID = "1ZtNDikRHklwQMYxWQ6hkL1clvdH6g_Xfd3ojr5APDjo"

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
]

def oauth_token_file() -> str:
    return os.environ.get("OAUTH_TOKEN_FILE", os.path.join(ROOT, "oauth_token.json"))


def oauth_client_secret_file() -> str:
    return os.environ.get("OAUTH_CLIENT_SECRET_FILE", os.path.join(ROOT, "client_secret_oauth.json"))

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
    value = unicodedata.normalize("NFKD", str(value or "").lower())
    value = re.sub(r"[\u0300-\u036f]", "", value)
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    value = re.sub(r"\b(pt|cv|tbk|ud|toko|tk|jl|jalan|gg|gang|no|nomor)\b", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def exact_hash(name: str, address: str) -> str:
    """Full SHA-256 prevents exact matches from depending on length-bucket scans.

    Names and addresses are separated BEFORE hashing, so different field boundaries
    cannot collide merely because the joined text looks identical.
    """
    key = normalize_text(name) + "\x1f" + normalize_text(address)
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


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
    logging.info("Fetched %s rows", f"{len(df):,}")
    if df.empty:
        raise ValueError("PostgreSQL returned zero BP rows. Refusing to replace the live database with an empty snapshot.")
    return df


def prepare_indexes(df: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    required = ["bp_id", "bp_type_id", "name_1", "address", "ktp_number"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Query output missing columns: {missing}")

    for col in required:
        df[col] = df[col].fillna("").astype(str)

    # Preserve the exact source-row identity before any sorting.  KTP rows must map
    # back to the BP_DATABASE row generated from the SAME joined source record, not
    # merely the first row that happens to share a bp_id.
    df = df.reset_index(drop=True).copy()
    df["_source_row_id"] = df.index.astype(int)
    sync_id = datetime.now().strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:12]

    logging.info("Normalizing text...")
    df["norm_text"] = (df["name_1"] + " " + df["address"]).map(normalize_text)
    df["norm_digits"] = (df["name_1"] + " " + df["address"]).map(normalize_digits)
    df["text_len"] = df["norm_text"].str.len().astype(int)
    df["len_bucket"] = df["text_len"].map(len_bucket)
    df["ktp_digits"] = df["ktp_number"].map(normalize_digits)
    df["ktp_shard"] = df["ktp_digits"].map(ktp_shard)
    df["exact_hash"] = [exact_hash(n, a) for n, a in zip(df["name_1"], df["address"])]

    # Main database is sorted by length bucket, enabling A1 range lookup.
    bp = df[["_source_row_id", "bp_id", "bp_type_id", "name_1", "address", "norm_text", "norm_digits", "text_len", "len_bucket", "exact_hash"]].copy()
    bp = bp.sort_values(["len_bucket", "text_len", "bp_id", "_source_row_id"], kind="mergesort").reset_index(drop=True)
    bp["bp_db_row"] = bp.index + 2  # Sheet row number; header is row 1.
    bp["sync_id"] = sync_id

    bp_out = bp[["bp_id", "bp_type_id", "name_1", "address", "norm_text", "norm_digits", "text_len", "sync_id"]]

    logging.info("Building INDEX_LEN...")
    idx_len = (
        bp.groupby("len_bucket", sort=True)
          .agg(row_start=("bp_db_row", "min"), row_end=("bp_db_row", "max"), count=("bp_id", "count"))
          .reset_index()
    )
    idx_len["sync_id"] = sync_id

    logging.info("Building KTP_INDEX...")
    # Map each KTP-bearing source record to the exact BP_DATABASE row produced from
    # that same source record.  bp_id alone is NOT unique after the completion join.
    row_lookup = bp[["_source_row_id", "bp_db_row"]].copy()
    ktp = df[df["ktp_digits"].str.len() > 0][["_source_row_id", "bp_id", "ktp_digits", "ktp_shard"]].copy()
    ktp = ktp.merge(row_lookup, on="_source_row_id", how="left", validate="one_to_one")
    ktp = ktp.dropna(subset=["bp_db_row"])
    ktp["bp_db_row"] = ktp["bp_db_row"].astype(int)
    ktp = ktp.sort_values(["ktp_shard", "ktp_digits", "bp_db_row"], kind="mergesort").reset_index(drop=True)
    ktp["ktp_index_row"] = ktp.index + 2
    ktp["sync_id"] = sync_id
    ktp_out = ktp[["ktp_digits", "bp_db_row", "bp_id", "sync_id"]]

    logging.info("Building INDEX_KTP_SHARD...")
    if len(ktp):
        idx_ktp = (
            ktp.groupby("ktp_shard", sort=True)
               .agg(row_start=("ktp_index_row", "min"), row_end=("ktp_index_row", "max"), count=("ktp_digits", "count"))
               .reset_index()
        )
        idx_ktp["sync_id"] = sync_id
    else:
        idx_ktp = pd.DataFrame(columns=["ktp_shard", "row_start", "row_end", "count", "sync_id"])

    logging.info("Building EXACT_INDEX and INDEX_EXACT_SHARD...")
    exact = bp[["exact_hash", "bp_db_row", "bp_id"]].copy()
    exact["exact_shard"] = exact["exact_hash"].str.slice(0, 2)
    exact = exact.sort_values(["exact_shard", "exact_hash", "bp_db_row"], kind="mergesort").reset_index(drop=True)
    exact["exact_index_row"] = exact.index + 2
    exact["sync_id"] = sync_id
    exact_out = exact[["exact_hash", "bp_db_row", "bp_id", "sync_id"]]
    idx_exact = (
        exact.groupby("exact_shard", sort=True)
             .agg(row_start=("exact_index_row", "min"), row_end=("exact_index_row", "max"), count=("exact_hash", "count"))
             .reset_index()
    )
    idx_exact["sync_id"] = sync_id

    cell_estimate = len(bp_out) * len(bp_out.columns) + len(ktp_out) * len(ktp_out.columns) + len(exact_out) * len(exact_out.columns) + 10000
    if cell_estimate > int(os.environ.get("GSHEET_MAX_CELL_WARNING", "9500000")):
        logging.warning(
            "Estimated Google Sheet cells %s is close to or above safe limit. Consider reducing columns or moving index to a dedicated database.",
            cell_estimate,
        )

    meta = pd.DataFrame([
        ["sync_id", sync_id],
        ["last_sync_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
        ["total_bp_rows", str(len(bp_out))],
        ["total_ktp_index_rows", str(len(ktp_out))],
        ["len_bucket_count", str(len(idx_len))],
        ["ktp_shard_count", str(len(idx_ktp))],
        ["total_exact_index_rows", str(len(exact_out))],
        ["exact_shard_count", str(len(idx_exact))],
        ["exact_index_version", "1"],
        ["sync_state", "READY"],
        ["source", "PostgreSQL MDG -> Protected Google Sheet"],
        ["schema", "BP_DATABASE:A:H; KTP_INDEX:A:D; INDEX_LEN:A:E; INDEX_KTP_SHARD:A:E"],
    ], columns=["key", "value"])

    return bp_out, ktp_out, idx_len, idx_ktp, exact_out, idx_exact, meta


def load_oauth_credentials() -> Credentials:
    """Load or create OAuth user credentials for Google Sheets.

    This intentionally does not use service accounts. On the first run, it opens a
    browser consent screen and stores oauth_token.json locally. Next BAT runs refresh
    the access token automatically using the refresh token.
    """
    creds = None

    token_file = oauth_token_file()
    client_secret_file = oauth_client_secret_file()

    if os.path.exists(token_file):
        creds = Credentials.from_authorized_user_file(token_file, SCOPES)

    if creds and creds.expired and creds.refresh_token:
        logging.info("Refreshing Google OAuth token...")
        creds.refresh(Request())
        with open(token_file, "w", encoding="utf-8") as f:
            f.write(creds.to_json())

    if not creds or not creds.valid:
        if not os.path.exists(client_secret_file):
            raise FileNotFoundError(
                f"OAuth client secret file not found: {client_secret_file}. "
                "Download OAuth Desktop Client JSON from Google Cloud and save it as client_secret_oauth.json in the project root."
            )

        logging.info("Starting Google OAuth browser authorization...")
        flow = InstalledAppFlow.from_client_secrets_file(client_secret_file, SCOPES)
        oauth_port = int(os.environ.get("OAUTH_LOCAL_PORT", "0"))
        creds = flow.run_local_server(
            host="localhost",
            port=oauth_port,
            access_type="offline",
            prompt="consent",
        )
        with open(token_file, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
        logging.info("Saved OAuth token to %s", token_file)

    return creds


def gsheet_client():
    creds = load_oauth_credentials()
    authorized_user_email = os.environ.get("GOOGLE_AUTHORIZED_USER_EMAIL", "").strip()
    return gspread.authorize(creds), authorized_user_email


def get_or_create_worksheet(sh, title: str, rows: int, cols: int):
    try:
        ws = sh.worksheet(title)
        if ws.row_count < rows or ws.col_count < cols:
            ws.resize(rows=max(ws.row_count, rows), cols=cols)
        return ws
    except gspread.WorksheetNotFound:
        return sh.add_worksheet(title=title, rows=max(rows, 100), cols=cols)


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
    ws = get_or_create_worksheet(sh, title, rows=max(rows, 100), cols=cols)
    logging.info("Writing %s: %s rows x %s cols", title, f"{rows:,}", f"{cols:,}")
    ws.clear()
    # Google Sheets has a 10-million-CELL limit per workbook.  Old code padded
    # every large data tab to 10 columns even when only 4 or 8 were needed.
    # Compact each protected data tab to its actual schema width.
    ws.resize(rows=max(rows, 100), cols=cols)
    values = dataframe_values(df)

    # gspread update can handle a lot, but chunking is safer for very large sheets.
    # Keep column count fixed and use A1 ranges row-by-row chunks.
    for start_idx, chunk in chunks(values, chunk_size):
        row_start = start_idx + 1
        row_end = start_idx + len(chunk)
        col_end = column_letter(cols)
        ws.update(range_name=f"A{row_start}:{col_end}{row_end}", values=chunk, value_input_option="RAW")
        logging.info("%s updated rows %s-%s", title, f"{row_start:,}", f"{row_end:,}")
        time.sleep(float(os.environ.get("GSHEET_WRITE_SLEEP_SECONDS", "0.2")))
    return ws.id


def column_letter(n: int) -> str:
    result = ""
    while n:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result


def protect_and_hide_tabs(sh, authorized_user_email: str, protected_titles: List[str], hidden_titles: List[str]) -> None:
    if os.environ.get("APPLY_SHEET_PROTECTION", "true").lower() != "true":
        logging.info("Skipping sheet protection because APPLY_SHEET_PROTECTION=false")
        return

    sheet_meta = sh.fetch_sheet_metadata()
    title_to_id = {s["properties"]["title"]: s["properties"]["sheetId"] for s in sheet_meta.get("sheets", [])}

    requests = []
    if authorized_user_email:
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
                        "editors": {"users": [authorized_user_email]}
                    }
                }
            })
    else:
        logging.warning(
            "GOOGLE_AUTHORIZED_USER_EMAIL is empty, so protected ranges are skipped to avoid locking out the OAuth user. "
            "Hidden tabs will still be applied."
        )

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


def preflight_sheet_capacity(sh, planned: Dict[str, pd.DataFrame]) -> None:
    """Fail before clearing any tab if the final workbook would exceed cell quota."""
    existing = sh.fetch_sheet_metadata().get("sheets", [])
    other_cells = 0
    for item in existing:
        prop = item.get("properties", {})
        if prop.get("title") in planned:
            continue
        grid = prop.get("gridProperties", {})
        other_cells += int(grid.get("rowCount", 0)) * int(grid.get("columnCount", 0))
    projected = other_cells + sum(max(len(df) + 1, 100) * len(df.columns) for df in planned.values())
    max_cells = int(os.environ.get("GSHEET_MAX_CELLS", "10000000"))
    logging.info("Projected workbook cells after column compaction: %s / %s", f"{projected:,}", f"{max_cells:,}")
    if projected > max_cells:
        raise ValueError(f"Insufficient Google Sheets capacity: projected {projected:,} cells exceeds {max_cells:,}. No tabs were modified.")


@contextmanager
def single_sync_lock():
    """Hold an OS-level nonblocking lock for the entire sync (including DB fetch).

    The lock file may remain on disk after a crash. The operating system releases
    its byte-range lock when the owning process exits. Do not delete it.
    """
    path = os.path.join(LOG_DIR, ".sync_gsheet_indexed.lock")
    with open(path, "a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"0")
            lock_file.flush()
        lock_file.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError(
                    "SYNC ALREADY RUNNING: another scheduled/manual job holds the sync lock. "
                    "This job has NOT written any Sheet data."
                ) from exc
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError(
                    "SYNC ALREADY RUNNING: another job holds the sync lock. "
                    "This job has NOT written any Sheet data."
                ) from exc
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def main():
    read_env()
    sheet_id = os.environ.get("SHEET_ID", DEFAULT_SHEET_ID).strip()
    if not sheet_id:
        raise ValueError("SHEET_ID is empty. Set SHEET_ID in .env.")
    chunk_size = int(os.environ.get("GSHEET_CHUNK_SIZE", "20000"))

    df = fetch_pg_dataframe()
    bp_out, ktp_out, idx_len, idx_ktp, exact_out, idx_exact, meta = prepare_indexes(df)

    gc, authorized_user_email = gsheet_client()
    sh = gc.open_by_key(sheet_id)
    preflight_sheet_capacity(sh, {
        "BP_DATABASE": bp_out, "KTP_INDEX": ktp_out,
        "INDEX_LEN": idx_len, "INDEX_KTP_SHARD": idx_ktp,
        "EXACT_INDEX": exact_out, "INDEX_EXACT_SHARD": idx_exact,
        "META": meta,
    })

    # Publish an in-progress marker BEFORE any tab is cleared.  A reader must not
    # consider an old META a valid completed snapshot while new rows are being written.
    pending_meta = meta.copy()
    pending_meta.loc[pending_meta["key"] == "sync_state", "value"] = "IN_PROGRESS"
    write_dataframe(sh, "META", pending_meta, chunk_size)
    write_dataframe(sh, "BP_DATABASE", bp_out, chunk_size)
    write_dataframe(sh, "KTP_INDEX", ktp_out, chunk_size)
    write_dataframe(sh, "INDEX_LEN", idx_len, chunk_size)
    write_dataframe(sh, "INDEX_KTP_SHARD", idx_ktp, chunk_size)
    write_dataframe(sh, "EXACT_INDEX", exact_out, chunk_size)
    write_dataframe(sh, "INDEX_EXACT_SHARD", idx_exact, chunk_size)
    # META=READY is the commit marker; publish it only after all six data/index tabs.
    write_dataframe(sh, "META", meta, chunk_size)

    protect_and_hide_tabs(
        sh,
        authorized_user_email,
        protected_titles=["BP_DATABASE", "KTP_INDEX", "INDEX_LEN", "INDEX_KTP_SHARD", "EXACT_INDEX", "INDEX_EXACT_SHARD", "META"],
        hidden_titles=["KTP_INDEX", "INDEX_LEN", "INDEX_KTP_SHARD", "EXACT_INDEX", "INDEX_EXACT_SHARD"],
    )

    logging.info("DONE. Sheet synced and indexed successfully.")


if __name__ == "__main__":
    try:
        with single_sync_lock():
            main()
    except RuntimeError as exc:
        logging.error("%s", exc)
        sys.exit(2)
