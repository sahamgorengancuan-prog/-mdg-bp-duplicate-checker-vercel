"""Google Sheets-only A/B keyed sync, proven OAuth, no private PostgreSQL."""
import importlib
from pathlib import Path
import re
import sys
import types

import pandas as pd
import pytest

for name in ['psycopg2','gspread','dotenv','google','google.oauth2',
             'google.oauth2.credentials','google.auth','google.auth.transport',
             'google.auth.transport.requests','google_auth_oauthlib',
             'google_auth_oauthlib.flow']:
    sys.modules.setdefault(name,types.ModuleType(name))
sys.modules['dotenv'].load_dotenv=lambda *a,**k:None
sys.modules['google.oauth2.credentials'].Credentials=object
sys.modules['google.auth.transport.requests'].Request=object
sys.modules['google_auth_oauthlib.flow'].InstalledAppFlow=object
ROOT=Path(__file__).parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
keyed=importlib.import_module('sync_bp_keyed')

def data(rows):
    return pd.DataFrame(rows,columns=[
        'bp_id','bp_type_id','name_1','address','ktp_number'])

class WorksheetNotFound(Exception):
    pass

class FakeWS:
    def __init__(self,title,rows=100,cols=2):
        self.title=title
        self.row_count=rows
        self.col_count=cols
        self.rows=[]
        self.writes=[]
        self.fail=False
    def row_values(self,num):
        return self.rows[num-1][:] if num<=len(self.rows) else []
    def get(self,range_name):
        m=re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)',range_name)
        assert m,range_name
        left,start,right,end=m.groups()
        a=ord(left)-65
        b=ord(right)-64
        return [row[a:b] for row in self.rows[int(start)-1:int(end)]]
    def update(self,range_name,values,value_input_option=None):
        if self.fail:raise RuntimeError("simulated staging index failure")
        m=re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)',range_name)
        assert m,range_name
        col=ord(m[1])-65
        start=int(m[2])
        for offset,values_row in enumerate(values):
            number=start+offset
            while len(self.rows)<number:self.rows.append([])
            target=self.rows[number-1]
            while len(target)<col+len(values_row):target.append('')
            for idx,value in enumerate(values_row):
                target[col+idx]=str(value)
        self.writes.append(range_name)
    def batch_update(self,requests,value_input_option=None):
        for item in requests:self.update(item["range"],item["values"])
    def resize(self,rows,cols):
        self.row_count=rows
        self.col_count=cols
        self.rows=self.rows[:rows]
    def append_rows(self,rows,value_input_option=None):
        raise AssertionError("append_rows should not be needed for deterministic keys")

class FakeBook:
    def __init__(self,id):
        self.id=id;self.sheets={}
    def worksheet(self,title):
        if title not in self.sheets:raise WorksheetNotFound(title)
        return self.sheets[title]
    def add_worksheet(self,title,rows,cols):
        assert title not in self.sheets
        self.sheets[title]=FakeWS(title,rows,cols)
        return self.sheets[title]
    def fetch_sheet_metadata(self):
        return {"sheets":[{
            "properties":{"title":title,
                "gridProperties":{"rowCount":sheet.row_count,
                                  "columnCount":sheet.col_count}}
            } for title,sheet in self.sheets.items()]}

class FakeGC:
    def __init__(self):
        self.books={x:FakeBook(x) for x in ("A","B","CONTROL")}
    def open_by_key(self,key):return self.books[key]

def configured(monkeypatch):
    gc=FakeGC()
    for key,value in {
        "GSHEET_SNAPSHOT_MODE":"dual","SHEET_A_ID":"A","SHEET_B_ID":"B",
        "SHEET_CONTROL_ID":"CONTROL","SHEET_ID":"LEGACY",
        "PRIVATE_INDEX_MODE":"off","GSHEET_WRITE_SLEEP_SECONDS":"0",
        "GSHEET_READ_BATCH_SLEEP_SECONDS":"0"}.items():
        monkeypatch.setenv(key,value)
    monkeypatch.setattr(keyed,'gsheet_client',lambda:(gc,""))
    monkeypatch.setattr(keyed.time,'sleep',lambda _:None)
    return gc

def test_source_keys_and_change_hash():
    src=data([['BP-1','ZB02','Alpha','Address A','1111']])
    first=keyed.make_records(src)
    assert first==keyed.make_records(src)
    assert first['BP-1']['text_len']==len(first['BP-1']['norm_text'])
    new=keyed.make_records(data([['BP-1','ZB02','Alpha','Address A','2222']]))
    assert first['BP-1']['row_hash']!=new['BP-1']['row_hash']
    with pytest.raises(ValueError,match='nonunique bp_id'):
        keyed.make_records(data([
            ['BP-1','ZB02','Alpha','Address A','1111'],
            ['BP-1','ZB02','Beta','Address B','2222']]))

def test_dual_ids_fails_before_writing(monkeypatch):
    monkeypatch.delenv("GSHEET_SNAPSHOT_MODE",raising=False)
    with pytest.raises(ValueError,match='GSHEET_SNAPSHOT_MODE=dual'):
        keyed.snapshot_ids()
    monkeypatch.setenv("GSHEET_SNAPSHOT_MODE","dual")
    monkeypatch.setenv("SHEET_A_ID","A")
    monkeypatch.setenv("SHEET_B_ID","A")
    monkeypatch.setenv("SHEET_CONTROL_ID","C")
    with pytest.raises(ValueError,match='distinct'):
        keyed.snapshot_ids()

def test_index_postings_use_stable_bp_key_and_source_hash():
    records=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Street 10','1234'],
        ['BP-B','ZB02','Beta','Street 12','5678']]))
    tabs,n_ktp,n_groups=keyed.build_index_rows(
        records,{'BP-A':17,'BP-B':2},'test-sync')
    assert n_ktp==2 and n_groups>=1
    assert len(tabs['INDEX_LEN_TOKEN'])==3
    for row in tabs['INDEX_LEN_TOKEN'][1:]:
        assert row[4] in records
        assert row[5]==records[row[4]]['row_hash']
    assert {row[2] for row in tabs['EXACT_INDEX'][1:]}==set(records)
    assert {row[2] for row in tabs['KTP_INDEX'][1:]}==set(records)

def test_initial_then_keyed_update_preserves_active_snapshot(monkeypatch):
    gc=configured(monkeypatch)
    base=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Street 10','1234'],
        ['BP-B','ZB02','Beta','Street 12','5678']]))
    first=keyed.sync_sheet(base,'generation-A')
    assert first['appended']==2
    control=gc.books['CONTROL'].worksheet('ACTIVE')
    assert dict(control.get("A1:B20")[1:])['active_sheet_id']=='A'
    initial_a=[r[:] for r in gc.books['A'].worksheet('BP_DATABASE').rows]
    noop=keyed.sync_sheet(base,'unused-generation')
    assert noop['sync_id']=='generation-A'
    revised=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Street 10','1234'],
        ['BP-B','ZB02','Beta New','Street 12','5678'],
        ['BP-C','ZB02','Gamma','Street 13','9999']]))
    second=keyed.sync_sheet(revised,'generation-B')
    assert second['appended']==3  # B is an empty standby for its first build
    assert gc.books['A'].worksheet('BP_DATABASE').rows==initial_a
    assert dict(control.get("A1:B20")[1:])['active_sheet_id']=='B'
    latest=keyed.make_records(data([
        ['BP-A','ZB02','Alpha New','Street 10','1234'],
        ['BP-B','ZB02','Beta New','Street 12','5678'],
        ['BP-C','ZB02','Gamma','Street 13','9999']]))
    third=keyed.sync_sheet(latest,'generation-C')
    assert third['updated']==2  # A last had old Alpha and Beta
    assert third['appended']==1
    ws_a=gc.books['A'].worksheet('BP_DATABASE')
    assert 'A2:H2' in ws_a.writes and 'A3:H3' in ws_a.writes
    assert dict(control.get("A1:B20")[1:])['sync_id']=='generation-C'
    assert dict(control.get("A1:B20")[1:])['active_sheet_id']=='A'
    assert gc.books['B'].worksheet('META').get("A1:B20")[0]==['key','value']

def test_failed_staging_never_changes_active_pointer(monkeypatch):
    gc=configured(monkeypatch)
    original=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Street 10','1234']]))
    keyed.sync_sheet(original,'original')
    active=gc.books['CONTROL'].worksheet('ACTIVE')
    expected=[row[:] for row in active.rows]
    standby=gc.books['B']
    standby.add_worksheet("INDEX_LEN_TOKEN",rows=100,cols=6).fail=True
    revised=keyed.make_records(data([
        ['BP-A','ZB02','Alpha changed','Street 10','1234']]))
    with pytest.raises(RuntimeError,match='simulated staging'):
        keyed.sync_sheet(revised,'failed')
    assert active.rows==expected
    assert gc.books['A'].worksheet('BP_DATABASE').row_values(2)[2]=='Alpha'

def test_proven_oauth_bat_and_no_private_database():
    bat=(ROOT/'bats'/'sync_to_gsheet_now.bat').read_text()
    assert 'call ".venv\\Scripts\\activate.bat"' in bat
    assert 'python -u "scripts\\sync_bp_keyed.py"' in bat
    assert 'pause' in bat.lower()
    assert 'taskkill' not in bat.lower()
    assert 'private PostgreSQL search index' not in bat
    code=(ROOT/'scripts'/'sync_bp_keyed.py').read_text()
    assert 'sync_private(' not in code
    assert 'PRIVATE_INDEX_DATABASE_URL' not in code
    assert '.clear(' not in code
    assert 'del_worksheet' not in code
    assert 'append_rows(' not in code

def test_legacy_A_is_preserved_during_first_B_build_and_second_run_is_gated(monkeypatch):
    gc=configured(monkeypatch)
    monkeypatch.setenv("SHEET_ID","A")
    # Existing live workbook is *also* A, served by legacy Render.
    old=gc.books["A"].add_worksheet("BP_DATABASE",rows=100,cols=8)
    old.rows=[
        keyed.LEGACY_COLUMNS[:],
        ['BP-OLD','ZB02','Legacy Name','Legacy Address',
         'legacy name legacy address','',str(len('legacy name legacy address')),
         'old-sync-id']]
    old_meta=gc.books["A"].add_worksheet("META",rows=100,cols=2)
    old_meta.rows=[["key","value"],["sync_state","READY"]]
    original_bp=[row[:] for row in old.rows]
    original_meta=[row[:] for row in old_meta.rows]
    first=keyed.make_records(data([
        ['BP-X','ZB02','New Person','Street 22','1234']]))
    assert keyed.snapshot_ids()["SHEET_A_ID"]=="A"
    published=keyed.sync_sheet(first,"first-B")
    assert published["sync_id"]=="first-B"
    assert old.rows==original_bp
    assert old_meta.rows==original_meta
    control=dict(gc.books["CONTROL"].worksheet("ACTIVE").get("A1:B20")[1:])
    assert control["active_sheet_id"]=="B"
    changed=keyed.make_records(data([
        ['BP-X','ZB02','New Person Changed','Street 22','1234']]))
    with pytest.raises(ValueError,match="Refusing to modify original legacy A"):
        keyed.sync_sheet(changed,"second-A")
    assert old.rows==original_bp
    assert old_meta.rows==original_meta
    assert dict(gc.books["CONTROL"].worksheet("ACTIVE").get("A1:B20")[1:])==control
    monkeypatch.setenv("ALLOW_LEGACY_A_STAGING","1")
    second=keyed.sync_sheet(changed,"second-A")
    assert second["sync_id"]=="second-A"
    assert dict(gc.books["CONTROL"].worksheet("ACTIVE").get("A1:B20")[1:])["active_sheet_id"]=="A"

def test_legacy_B_or_control_must_be_rejected(monkeypatch):
    configured(monkeypatch)
    for legacy in ("B","CONTROL"):
        monkeypatch.setenv("SHEET_ID",legacy)
        with pytest.raises(ValueError,match="never B or CONTROL"):
            keyed.snapshot_ids()
