"""Keyed incremental path regression: no clear/repopulate of legacy BP tables."""
import importlib
from pathlib import Path
import sys
import types

import pandas as pd
import pytest

for name in ['psycopg2', 'psycopg2.extras', 'gspread', 'dotenv', 'google',
             'google.oauth2','google.oauth2.credentials','google.auth',
             'google.auth.transport','google.auth.transport.requests',
             'google_auth_oauthlib','google_auth_oauthlib.flow']:
    sys.modules.setdefault(name,types.ModuleType(name))
sys.modules['psycopg2.extras'].execute_values=lambda *a,**k:None
sys.modules['dotenv'].load_dotenv=lambda *a,**k:None
sys.modules['google.oauth2.credentials'].Credentials=object
sys.modules['google.auth.transport.requests'].Request=object
sys.modules['google_auth_oauthlib.flow'].InstalledAppFlow=object

ROOT=Path(__file__).parents[1]
sys.path.insert(0,str(ROOT / 'scripts'))
keyed=importlib.import_module('sync_bp_keyed')

def data(rows):
    return pd.DataFrame(rows,columns=[
        'bp_id','bp_type_id','name_1','address','ktp_number'
    ])

def test_source_bp_id_is_stable_unique_identity_and_hash_is_deterministic():
    src=data([['BP-1','ZB02','Wr Santi','RT 001 RW 003','1234']])
    one=keyed.make_records(src)
    two=keyed.make_records(src)
    assert one==two
    row=one['BP-1']
    assert row['bp_id']=='BP-1'
    assert row['row_hash'] and len(row['row_hash'])==64
    assert row['text_len']==len(row['norm_text'])
    assert row['token_count']==len(set(
        token for token in row['norm_text'].split() if len(token)>=2
    ))
    changed=data([['BP-1','ZB02','Wr Santi','RT 001 RW 003','9999']])
    assert keyed.make_records(changed)['BP-1']['row_hash']!=row['row_hash']

def test_duplicate_joined_bp_rows_cannot_silently_merge():
    with pytest.raises(ValueError,match='nonunique bp_id'):
        keyed.make_records(data([
            ['BP-1','ZB02','Alpha','Address A','1111'],
            ['BP-1','ZB02','Beta','Address B','2222'],
        ]))

def test_keyed_delta_mutates_only_changed_rows_and_tombstones_missing():
    rows=keyed.make_records(data([
        ['BP-1','ZB02','Alpha','Address A','1111'],
        ['BP-2','ZB02','Beta','Address B','2222'],
        ['BP-3','ZB02','Gamma','Address C','3333']
    ]))
    current={'BP-1':{'row':8,'hash':rows['BP-1']['row_hash']},
             'BP-2':{'row':9,'hash':'old-hash'},
             'BP-MISSING':{'row':10,'hash':'old-hash'},
             'BP-DELETED':{'row':11,'hash':'DELETED'}}
    changes,creates,tombstones=keyed.keyed_delta(rows,current)
    assert [(n,r['bp_id']) for n,r in changes]==[(9,'BP-2')]
    assert {r['bp_id'] for r in creates}=={'BP-3'}
    assert tombstones==[10]

def test_task_entry_point_is_keyed_only_and_never_calls_legacy_full_sync():
    bat=(ROOT/'bats'/'sync_to_gsheet_now.bat').read_text()
    assert 'sync_bp_keyed.py' in bat
    assert 'sync_gsheet_indexed.py' not in bat
    source=(ROOT/'scripts'/'sync_bp_keyed.py').read_text()
    assert 'ws.clear(' not in source
    assert 'sh.del_worksheet' not in source
    assert 'ws.append_rows' in source
    assert 'PRIVATE_INDEX_MODE=required' in source

def test_private_index_is_mandatory_for_sheet_delta(monkeypatch):
    monkeypatch.delenv('PRIVATE_INDEX_MODE',raising=False)
    with pytest.raises(ValueError,match='PRIVATE_INDEX_MODE=required'):
        keyed.ensure_private_mode()

def test_bootstrap_rewrites_only_hash_column_for_unchanged_keys(monkeypatch):
    fresh=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Address A','1111'],
        ['BP-B','ZB02','Beta New','Address B','2222'],
        ['BP-C','ZB02','Gamma','Address C','3333'],
    ]))
    former=keyed.make_records(data([
        ['BP-A','ZB02','Alpha','Address A','1111'],
        ['BP-B','ZB02','Beta Old','Address B','2222'],
        ['BP-MISSING','ZB02','Gone','Address D','4444'],
    ]))
    class WS:
        row_count=4
        def __init__(self, rows):self.rows=[list(row) for row in rows];self.updates=[]
        def row_values(self,num):return self.rows[num-1]
        def get(self,query):
            import re
            start,end=map(int,re.findall(r'[AH](\d+)',query))
            return [list(x) for x in self.rows[start-1:end]]
        def update(self,range_name,values,value_input_option=None):
            self.updates.append(range_name)
            import re
            m=re.match(r'([A-H])(\d+)(?::[A-H](\d+))?$',range_name)
            assert m,range_name
            col=ord(m.group(1))-65;start=int(m.group(2))
            for i,row in enumerate(values):
                while len(self.rows)<start+i:self.rows.append(['']*8)
                for k,value in enumerate(row):
                    self.rows[start+i-1][col+k]=value
        def batch_update(self,updates,value_input_option=None):
            for update in updates:self.update(update['range'],update['values'])
        def append_rows(self,rows,value_input_option=None):
            self.rows.extend([list(x) for x in rows]);self.row_count=len(self.rows)
    bp=WS([keyed.LEGACY_COLUMNS]+[
        keyed.sheet_row(former[x])[:7]+['old-sync']
        for x in ['BP-A','BP-B','BP-MISSING']
    ])
    meta=WS([['key','value'],['sync_state','READY']])
    meta.row_count=100
    status=WS([['key','value']])
    status.row_count=100
    class FakeSh:
        def worksheet(self,name):
            return {'BP_DATABASE':bp,'META':meta,'KEYED_SYNC_META':status}[name]
        def fetch_sheet_metadata(self):
            return {'sheets':[{'properties':{
                'title':name,'gridProperties':{'rowCount':ws.row_count,'columnCount':8 if name=='BP_DATABASE' else 2}
            }} for name,ws in [('BP_DATABASE',bp),('META',meta),('KEYED_SYNC_META',status)]]}
    monkeypatch.setattr(keyed,'gsheet_client',lambda:(None,None))
    class FakeGC:
        def open_by_key(self,key):return FakeSh()
    monkeypatch.setattr(keyed,'gsheet_client',lambda:(FakeGC(),None))
    monkeypatch.setattr(keyed.time,'sleep',lambda seconds:None)
    keyed.sync_sheet(fresh,'new-generation')
    assert bp.rows[0]==keyed.COLUMNS
    assert bp.rows[1][:7]==keyed.sheet_row(fresh['BP-A'])[:7]
    assert bp.rows[1][7]==fresh['BP-A']['row_hash']
    assert bp.rows[2]==keyed.sheet_row(fresh['BP-B'])
    assert bp.rows[3][7]=='DELETED'
    assert bp.rows[4]==keyed.sheet_row(fresh['BP-C'])
    assert meta.rows[1][1]=='IN_PROGRESS'
    assert status.rows[0][1]=='READY'
    assert all('clear' not in v.lower() for v in bp.updates)
