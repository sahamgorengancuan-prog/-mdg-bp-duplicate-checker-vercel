"""Google Sheets-only A/B keyed sync, proven OAuth, no private PostgreSQL."""
import base64
import gzip
import hashlib
import importlib
import json
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
        self.id=id;self.sheets={};self.batch_requests=[];self.refuse_batch=False
    def worksheet(self,title):
        if title not in self.sheets:raise WorksheetNotFound(title)
        return self.sheets[title]
    def add_worksheet(self,title,rows,cols):
        assert title not in self.sheets
        self.sheets[title]=FakeWS(title,rows,cols)
        return self.sheets[title]
    def fetch_sheet_metadata(self):
        return {"sheets":[{
            "properties":{"title":title,"sheetId":id(sheet),
                "gridProperties":{"rowCount":sheet.row_count,
                                  "columnCount":sheet.col_count}}
            } for title,sheet in self.sheets.items()]}
    def batch_update(self,body):
        if self.refuse_batch:
            raise RuntimeError("APIError: [400]: This document is too large to continue editing.")
        for request in body["requests"]:
            self.batch_requests.append(request)
            if "deleteSheet" in request:
                target=request["deleteSheet"]["sheetId"]
                self.sheets={t:ws for t,ws in self.sheets.items() if id(ws)!=target}
            elif "addSheet" in request:
                props=request["addSheet"]["properties"]
                self.add_worksheet(props["title"],100,2)
            else:
                raise AssertionError(request)

class FakeGC:
    def __init__(self):
        self.books={x:FakeBook(x) for x in ("A","B","A2","B2","CONTROL")}
    def open_by_key(self,key):return self.books[key]

def configured(monkeypatch):
    gc=FakeGC()
    for key,value in {
        "GSHEET_SNAPSHOT_MODE":"dual","SHEET_A_ID":"A","SHEET_B_ID":"B",
        "SHEET_A2_ID":"A2","SHEET_B2_ID":"B2",
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
    monkeypatch.setenv("GSHEET_SNAPSHOT_MODE","legacy")
    with pytest.raises(ValueError,match='GSHEET_SNAPSHOT_MODE=dual'):
        keyed.snapshot_ids()
    monkeypatch.setenv("GSHEET_SNAPSHOT_MODE","dual")
    monkeypatch.setenv("SHEET_ID","LEGACY")
    monkeypatch.setenv("SHEET_A_ID","A")
    monkeypatch.setenv("SHEET_B_ID","A")
    monkeypatch.setenv("SHEET_CONTROL_ID","C")
    with pytest.raises(ValueError,match='SIX DISTINCT'):
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
        assert len(row)==2
        norm,rownum,bp=json.loads(row[1])
        assert bp in records and rownum in (2,17)
        assert norm==records[bp]['norm_text']
        assert row[0]==records[bp]['len_bucket']+':'+str(records[bp]['token_count'])
    assert all(len(row)==2 for row in tabs['EXACT_INDEX'][1:])
    assert all(len(row)==2 for row in tabs['KTP_INDEX'][1:])
    assert {json.loads(row[1])[1] for row in tabs['EXACT_INDEX'][1:]}==set(records)
    assert {json.loads(row[1])[1] for row in tabs['KTP_INDEX'][1:]}==set(records)

def test_initial_then_keyed_update_preserves_active_snapshot(monkeypatch):
    gc=configured(monkeypatch)
    base=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Street 10','1234'],
        ['BP-B','ZB02','Beta','Street 12','5678']]))
    first=keyed.sync_sheet(base,'generation-A')
    assert first['appended']==2
    control=gc.books['CONTROL'].worksheet('ACTIVE')
    assert dict(control.get("A1:B20")[1:])['active_sheet_id']=='A'
    assert dict(control.get("A1:B20")[1:])['active_index_sheet_id']=='A2'
    assert "INDEX_LEN_TOKEN" in gc.books["A2"].sheets
    assert "INDEX_LEN_TOKEN" not in gc.books["A"].sheets
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
    assert dict(control.get("A1:B20")[1:])['active_index_sheet_id']=='B2'
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
    assert dict(control.get("A1:B20")[1:])['active_index_sheet_id']=='A2'
    assert "INDEX_LEN_TOKEN" in gc.books["A2"].sheets
    assert "INDEX_LEN_TOKEN" not in gc.books["A"].sheets
    assert gc.books['B'].worksheet('META').get("A1:B20")[0]==['key','value']
    assert gc.books['B2'].worksheet('META').get("A1:B20")[0]==['key','value']

def test_failed_staging_never_changes_active_pointer(monkeypatch):
    gc=configured(monkeypatch)
    original=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Street 10','1234']]))
    keyed.sync_sheet(original,'original')
    active=gc.books['CONTROL'].worksheet('ACTIVE')
    expected=[row[:] for row in active.rows]
    standby=gc.books['B2']
    standby.add_worksheet("INDEX_LEN_TOKEN",rows=100,cols=2).fail=True
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
    assert 'KEYED_V14_SHARDED' in (ROOT/'scripts'/'sync_bp_keyed.py').read_text()
    code=(ROOT/'scripts'/'sync_bp_keyed.py').read_text()
    assert 'sync_private(' not in code
    assert 'PRIVATE_INDEX_DATABASE_URL' not in code
    assert '.clear(' not in code
    assert 'del_worksheet' not in code
    assert 'append_rows(' not in code

def test_new_A_B_CONTROL_are_distinct_from_legacy_and_first_build_is_A(monkeypatch):
    gc=configured(monkeypatch)
    legacy=keyed.snapshot_ids()
    assert (legacy["SHEET_A_ID"],legacy["SHEET_B_ID"],
            legacy["SHEET_A2_ID"],legacy["SHEET_B2_ID"],
            legacy["SHEET_CONTROL_ID"])==("A","B","A2","B2","CONTROL")
    source=keyed.make_records(data([
        ['BP-X','ZB02','New Person','Street 22','1234']]))
    first=keyed.sync_sheet(source,"first-A")
    assert first["sync_id"]=="first-A"
    assert gc.books["B"].sheets=={}
    assert gc.books["B2"].sheets=={}
    control=dict(gc.books["CONTROL"].worksheet("ACTIVE").get("A1:B20")[1:])
    assert control["active_sheet_id"]=="A"
    assert keyed.sync_sheet(source,"no-changes")["sync_id"]=="first-A"
    updated=keyed.make_records(data([
        ['BP-X','ZB02','New Person Changed','Street 22','1234']]))
    second=keyed.sync_sheet(updated,"second-B")
    assert second["sync_id"]=="second-B"
    assert dict(gc.books["CONTROL"].worksheet("ACTIVE").get("A1:B20")[1:])["active_sheet_id"]=="B"
    assert gc.books["A"].worksheet("BP_DATABASE").row_values(2)[2]=="New Person"


def test_legacy_cannot_equal_any_snapshot_workbook(monkeypatch):
    configured(monkeypatch)
    for legacy in ("A","B","A2","B2","CONTROL"):
        monkeypatch.setenv("SHEET_ID",legacy)
        with pytest.raises(ValueError,match="SIX DISTINCT"):
            keyed.snapshot_ids()
    monkeypatch.delenv("SHEET_ID")
    with pytest.raises(ValueError,match="explicitly identify"):
        keyed.snapshot_ids()


def test_git_snapshot_ids_are_loaded_when_env_does_not_override(monkeypatch):
    for key in ("SHEET_A_ID","SHEET_B_ID","SHEET_A2_ID","SHEET_B2_ID","SHEET_CONTROL_ID"):
        monkeypatch.delenv(key,raising=False)
    monkeypatch.setenv("SHEET_ID","different-legacy-workbook")
    monkeypatch.setenv("GSHEET_SNAPSHOT_MODE","dual")
    ids=keyed.snapshot_ids()
    assert ids=={
        "SHEET_A_ID":"1vll0y7dO4bVTokeLbWctUUKjQvOV33V9TDp9iZfJPhA",
        "SHEET_B_ID":"13yMsb_Vsi6eXDkau1zouaRi2viOefDkVHmIuK9SHLqk",
        "SHEET_A2_ID":"1Qov9_QDbDwwLOOr3z7a2gCtA82dQXfy5bkKdAuwyDoA",
        "SHEET_B2_ID":"1ju8u0vpMTVxIfi9J-VgwpIqj5rvTbmVW83pzHSXi3Sc",
        "SHEET_CONTROL_ID":"1wnRHX84FXNG3zwoxDofr1dzj1vu6UsN3uo907xt3KJ4",
    }

def test_two_book_capacity_guard_and_pair_fail_closed(monkeypatch):
    gc=configured(monkeypatch)
    src=keyed.make_records(data([['BP-1','ZB02','A','B','123']]))
    old=gc.books['A'].add_worksheet('BP_DATABASE',rows=100,cols=8)
    old.rows=[keyed.COLUMNS[:],keyed.sheet_row(src['BP-1'])]
    result=keyed.sync_sheet(src,'first-B')
    assert result['sync_id']=='first-B'
    control=dict(gc.books['CONTROL'].worksheet('ACTIVE').get("A1:B20")[1:])
    assert control['active_sheet_id']=='B'
    assert control['active_index_sheet_id']=='B2'
    assert len(old.rows)==2
    gc.books['A'].add_worksheet('EXCESS',rows=100,cols=2).row_count=8000000
    newer=keyed.make_records(data([['BP-1','ZB02','Changed','B','123']]))
    with pytest.raises(ValueError,match='75% guard'):
        keyed.sync_sheet(newer,'blocked-A')
    assert dict(gc.books['CONTROL'].worksheet('ACTIVE').get("A1:B20")[1:])==control

def test_new_index_book_is_not_published_if_metadata_write_fails(monkeypatch):
    gc=configured(monkeypatch)
    gc.books['A2'].add_worksheet('META',100,2).fail=True
    data0=keyed.make_records(data([['BP-1','ZB02','A','B','123']]))
    with pytest.raises(RuntimeError,match='simulated staging'):
        keyed.sync_sheet(data0,'fail-secondary-meta')
    assert gc.books['CONTROL'].sheets=={}


def unpack(book):
    rows=book.worksheet("PACKED_SNAPSHOT").rows
    assert rows[0]==["part_no","part_count","sync_id","data"]
    text="".join(r[3] for r in rows[1:])
    raw=gzip.decompress(base64.b64decode(text))
    return rows,raw

def control_of(gc):
    return dict(r for r in gc.books["CONTROL"].worksheet("ACTIVE").get("A1:B20")[1:] if r and r[0])

def test_packed_snapshot_round_trip_and_meta(monkeypatch):
    gc=configured(monkeypatch)
    monkeypatch.setattr(keyed,"PACKED_PART_CHARS",50)  # force many parts
    src=keyed.make_records(data([
        ['BP-B','ZB02','Beta\tTab','Street\n12','5678'],
        ['BP-A','ZB03','Alpha','Street 10','']]))
    result=keyed.sync_sheet(src,"gen-packed")
    assert result["packed_parts"]>1
    rows,raw=unpack(gc.books["A2"])
    assert all(r[2]=="gen-packed" and r[1]==str(len(rows)-1) for r in rows[1:])
    assert [r[0] for r in rows[1:]]==[str(n) for n in range(1,len(rows))]
    lines=raw.decode("utf-8").split("\n")
    assert lines[0]=="bp_id\tbp_type_id\tname_1\taddress\tktp_digits"
    assert lines[1:]==["BP-A\tZB03\tAlpha\tStreet 10\t","BP-B\tZB02\tBeta Tab\tStreet 12\t5678"]
    sha=hashlib.sha256(raw).hexdigest()
    for book in ("A","A2"):
        meta=dict(r for r in gc.books[book].worksheet("META").get("A2:B40") if r and r[0])
        assert meta["packed_sha256"]==sha and meta["packed_snapshot_version"]=="1"
        assert meta["packed_records"]=="2" and meta["packed_parts"]==str(len(rows)-1)
    control=control_of(gc)
    assert control["packed_sha256"]==sha and control["active_index_sheet_id"]=="A2"
    assert "PACKED_SNAPSHOT" not in gc.books["A"].sheets

def test_noop_only_when_active_pair_has_current_packed(monkeypatch):
    gc=configured(monkeypatch)
    src=keyed.make_records(data([['BP-1','ZB02','Alpha','Street 10','1234']]))
    monkeypatch.setenv("GSHEET_PACKED_SNAPSHOT","off")
    first=keyed.sync_sheet(src,"v14-style")
    assert first["packed_parts"]==0 and "PACKED_SNAPSHOT" not in gc.books["A2"].sheets
    assert keyed.sync_sheet(src,"still-noop")["sync_id"]=="v14-style"
    monkeypatch.setenv("GSHEET_PACKED_SNAPSHOT","on")
    upgraded=keyed.sync_sheet(src,"with-packed")
    assert upgraded["sync_id"]=="with-packed" and upgraded["packed_parts"]>=1
    assert control_of(gc)["active_sheet_id"]=="B"
    assert "PACKED_SNAPSHOT" in gc.books["B2"].sheets
    assert keyed.sync_sheet(src,"noop-again")["sync_id"]=="with-packed"

def test_meta_block_clears_stale_keys(monkeypatch):
    gc=configured(monkeypatch)
    src=keyed.make_records(data([['BP-1','ZB02','Alpha','Street 10','1234']]))
    keyed.sync_sheet(src,"packed-A")
    changed=keyed.make_records(data([['BP-1','ZB02','Alpha 2','Street 10','1234']]))
    keyed.sync_sheet(changed,"packed-B")
    monkeypatch.setenv("GSHEET_PACKED_SNAPSHOT","off")
    again=keyed.make_records(data([['BP-1','ZB02','Alpha 3','Street 10','1234']]))
    keyed.sync_sheet(again,"plain-A")
    meta=dict(r for r in gc.books["A2"].worksheet("META").get("A2:B40") if r and r[0])
    assert meta["sync_id"]=="plain-A" and "packed_sha256" not in meta
    assert control_of(gc)["packed_sha256"]==""

def test_stale_v13_index_tabs_are_pruned_from_staging_primary_only(monkeypatch):
    gc=configured(monkeypatch)
    old_a=gc.books["A"]
    bp=old_a.add_worksheet("BP_DATABASE",rows=100,cols=8)
    src=keyed.make_records(data([['BP-1','ZB02','A','B','123']]))
    bp.rows=[keyed.COLUMNS[:],keyed.sheet_row(src['BP-1'])]
    for title in ("INDEX_LEN_TOKEN","KTP_INDEX","INDEX_LEN"):
        old_a.add_worksheet(title,rows=100,cols=4).rows=[["stale"]]
    first=keyed.sync_sheet(src,"first-B")        # A has old staging -> B+B2
    assert first["sync_id"]=="first-B" and control_of(gc)["active_sheet_id"]=="B"
    assert "INDEX_LEN_TOKEN" in old_a.sheets    # untouched while not staged
    changed=keyed.make_records(data([['BP-1','ZB02','A changed','B','123']]))
    keyed.sync_sheet(changed,"second-A")
    assert set(old_a.sheets)=={"BP_DATABASE","META"}
    assert old_a.worksheet("BP_DATABASE").row_values(2)[2]=="A changed"
    assert control_of(gc)["active_sheet_id"]=="A"
    assert all("deleteSheet" in r for r in old_a.batch_requests)
    assert gc.books["B"].batch_requests==[]      # active pair never pruned

def test_prune_refusal_keeps_active_pointer(monkeypatch):
    gc=configured(monkeypatch)
    src=keyed.make_records(data([['BP-1','ZB02','A','B','123']]))
    keyed.sync_sheet(src,"live-A")
    before=control_of(gc)
    gc.books["B"].add_worksheet("EXACT_INDEX",rows=100,cols=3)
    gc.books["B"].refuse_batch=True
    changed=keyed.make_records(data([['BP-1','ZB02','A2','B','123']]))
    with pytest.raises(RuntimeError,match="delete those tabs by hand"):
        keyed.sync_sheet(changed,"blocked-B")
    assert control_of(gc)==before

def test_python_packed_payload_is_read_identically_by_node_engine(tmp_path):
    """Cross-language contract: Python writes, the Render engine reads."""
    import shutil,subprocess
    node=shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    records=keyed.make_records(data([
        ['110000001','ZB02','PT. Maju Jaya, Tbk','Jl. Raya No.12 RT 01/02','3171-2345-6789-0001'],
        ['110000002','ZB03','Café Ñandú','Jl.\tMerdeka\n45 Kec. Ciledug',''],
        ['110000003','ZB02','王小明 Store','Gg. Mawar 7',' 3674 0000 1111 2222 '],
        ['110000004','ZB02','','','']]))
    packed=keyed.build_packed(records)
    payload=tmp_path/"packed.json"
    payload.write_text(json.dumps({"parts":packed["parts"],"sha":packed["sha256"]}),encoding="utf-8")
    script=f"""
const fs=await import('node:fs');const zlib=await import('node:zlib');
const crypto=await import('node:crypto');
const m=await import({json.dumps((ROOT/'_lib'/'memory-engine.js').as_uri())});
const d=await import({json.dumps((ROOT/'_lib'/'duplicate.js').as_uri())});
const x=JSON.parse(fs.readFileSync({json.dumps(str(payload))},'utf8'));
const raw=zlib.gunzipSync(Buffer.from(x.parts.join(''),'base64'));
if(crypto.createHash('sha256').update(raw).digest('hex')!==x.sha)throw Error('sha');
const s=await m.buildSnapshotIndex(raw,{{expectedRecords:{len(records)}}});
const out={{}};
for(let i=0;i<s.count;i++){{const r=s.record(i);
  out[r.bp_id]={{norm:r.norm_text,exact:d.exactNameAddressHash(r.name_1,r.address),ktp:r.ktp,
    found:s.findKtp(r.ktp).map(x=>x.bp_id)}};}}
console.log(JSON.stringify(out));
"""
    got=json.loads(subprocess.run([node,"--input-type=module","-e",script],
        capture_output=True,text=True,check=True,cwd=ROOT).stdout)
    assert set(got)==set(records)
    for key,rec in records.items():
        assert got[key]["norm"]==rec["norm_text"]
        assert got[key]["exact"]==rec["exact_hash"]
        assert got[key]["ktp"]==rec["ktp_number"]
        assert got[key]["found"]==([key] if rec["ktp_number"] else [])
