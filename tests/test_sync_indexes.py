import importlib.util
from pathlib import Path
import sys
import types

import pandas as pd

# prepare_indexes is pure; stub optional runtime-only integrations for unit import.
for name in ['psycopg2', 'gspread', 'dotenv', 'google', 'google.oauth2', 'google.oauth2.credentials', 'google.auth', 'google.auth.transport', 'google.auth.transport.requests', 'google_auth_oauthlib', 'google_auth_oauthlib.flow']:
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['dotenv'].load_dotenv = lambda *a, **k: None
sys.modules['google.oauth2.credentials'].Credentials = object
sys.modules['google.auth.transport.requests'].Request = object
sys.modules['google_auth_oauthlib.flow'].InstalledAppFlow = object

MODULE_PATH = Path(__file__).parents[1] / 'scripts' / 'sync_gsheet_indexed.py'
spec = importlib.util.spec_from_file_location('sync_gsheet_indexed', MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def _df(rows):
    return pd.DataFrame(rows, columns=['bp_id', 'bp_type_id', 'name_1', 'address', 'ktp_number'])


def test_ktp_index_maps_each_source_row_not_first_duplicate_bp_id():
    src = _df([
        ['BP-DUP', 'ZB02', 'Alpha', 'A very short address', '3673011202760004'],
        ['BP-DUP', 'ZB02', 'Beta', 'A substantially much longer address than alpha', '3204063011820001'],
    ])

    bp_out, ktp_out, *_ = mod.prepare_indexes(src)

    expected = {}
    for sheet_row, row in enumerate(bp_out.itertuples(index=False), start=2):
        expected[row.name_1] = sheet_row

    ktp_to_row = dict(zip(ktp_out['ktp_digits'], ktp_out['bp_db_row']))
    assert ktp_to_row['3673011202760004'] == expected['Alpha']
    assert ktp_to_row['3204063011820001'] == expected['Beta']
    assert ktp_to_row['3673011202760004'] != ktp_to_row['3204063011820001']


def test_indexes_carry_snapshot_identity_for_cross_tab_consistency():
    src = _df([
        ['110645467', 'ZB02', 'Tk Madura Abel', 'Perum Puspa No 1', '3204063011820001'],
        ['110646122', 'ZB02', 'Target BP', 'Some address', '3673011202760004'],
    ])

    bp_out, ktp_out, idx_len, idx_ktp, exact_out, idx_exact, idx_token, meta = mod.prepare_indexes(src)

    assert 'sync_id' in bp_out.columns
    assert {'bp_id', 'sync_id'}.issubset(ktp_out.columns)
    assert 'sync_id' in idx_len.columns
    assert 'sync_id' in idx_ktp.columns
    meta_map = dict(zip(meta['key'], meta['value']))
    assert meta_map.get('sync_id')
    assert set(bp_out['sync_id']) == {meta_map['sync_id']}
    assert set(ktp_out['sync_id']) == {meta_map['sync_id']}
    assert set(idx_len['sync_id']) == {meta_map['sync_id']}
    assert set(idx_ktp['sync_id']) == {meta_map['sync_id']}


def test_exact_index_is_complete_and_points_to_original_bp_rows():
    src = _df([
        ['110035698', 'ZB02', 'Wr Santi', 'Kp Cisaat Lebak RT 013 RW 003 Kel Bolang Kec Malingping Stlh Sdn 3 Bolang', '3602014801820006'],
        ['DIFFERENT', 'ZB02', 'Wr Santi', 'Different address', ''],
        ['SAME', 'ZB02', 'Wr Santi', 'Kp Cisaat Lebak RT 013 RW 003 Kel Bolang Kec Malingping Stlh Sdn 3 Bolang', ''],
    ])
    bp, ktp, ilen, iktp, exact, shards, idx_token, meta = mod.prepare_indexes(src)
    assert len(exact) == len(bp) == 3
    assert sum(shards['count']) == len(bp)
    assert dict(zip(meta['key'], meta['value']))['exact_index_version'] == '1'
    by_row = {n: row for n, row in enumerate(bp.itertuples(index=False), 2)}
    for row in exact.itertuples(index=False):
        original = by_row[int(row.bp_db_row)]
        assert row.bp_id == original.bp_id
        assert row.exact_hash == mod.exact_hash(original.name_1, original.address)
        assert row.sync_id == original.sync_id
    same = exact[exact['exact_hash'] == mod.exact_hash(src.loc[0, 'name_1'], src.loc[0, 'address'])]
    assert set(same['bp_id']) == {'110035698', 'SAME'}


def test_name_address_boundary_and_unicode_normalization():
    assert mod.exact_hash('a b', 'c') != mod.exact_hash('a', 'b c')
    assert mod.normalize_text('Café Résumé') == 'cafe resume'


def test_capacity_preflight_accounts_for_actual_columns_and_unrelated_tabs(monkeypatch):
    class FakeSpreadsheet:
        def fetch_sheet_metadata(self):
            return {'sheets': [
                {'properties': {'title': 'BP_DATABASE', 'gridProperties': {'rowCount': 400000, 'columnCount': 10}}},
                {'properties': {'title': 'Unrelated Report', 'gridProperties': {'rowCount': 500, 'columnCount': 10}}},
            ]}
    small = {'BP_DATABASE': pd.DataFrame({'a': ['1'], 'b': ['2']}),
             'EXACT_INDEX': pd.DataFrame({'a': ['h'], 'b': ['2']})}
    mod.preflight_sheet_capacity(FakeSpreadsheet(), small)
    monkeypatch.setenv('GSHEET_MAX_CELLS', '100')
    import pytest
    with pytest.raises(ValueError, match='No tabs were modified'):
        mod.preflight_sheet_capacity(FakeSpreadsheet(), small)


def test_full_12000_row_fixture_all_exact_hashes_and_row_pointers_complete():
    src = _df([[str(i).zfill(9), 'ZB02', f'Customer {i}',
                f'Jl Sudirman No {i % 1000} Jakarta', ''] for i in range(12000)])
    bp, _, _, _, exact, shards, idx_token, meta = mod.prepare_indexes(src)
    assert len(bp) == len(exact) == 12000
    assert sum(shards['count']) == 12000
    assert all(int(a) + int(c) - 1 == int(b)
               for a, b, c in zip(shards['row_start'], shards['row_end'], shards['count']))
    assert list(shards['row_start'])[0] == 2
    assert list(shards['row_end'])[-1] == 12001
    for e in exact.itertuples(index=False):
        record = bp.iloc[int(e.bp_db_row) - 2]
        assert e.bp_id == record.bp_id
        assert e.exact_hash == mod.exact_hash(record.name_1, record.address)


def test_sync_lock_rejects_overlapping_jobs_and_releases_on_exit(tmp_path, monkeypatch):
    import pytest
    monkeypatch.setattr(mod, "LOG_DIR", str(tmp_path))
    with mod.single_sync_lock():
        with pytest.raises(RuntimeError, match="SYNC ALREADY RUNNING"):
            with mod.single_sync_lock():
                pass
    with mod.single_sync_lock():
        pass


def test_sync_logging_has_no_unsupported_thousands_separator():
    source = MODULE_PATH.read_text(encoding="utf-8")
    assert 'logging.info("Fetched %,d' not in source
    assert 'logging.info("Writing %s: %,d' not in source
    assert "ws.update(range_name=" in source


def test_token_groups_cover_every_bp_once_and_match_node_tokenization():
    src = _df([
        ['BP1', 'ZB02', 'Tk Adit', 'RT 001 RW 002 RT 001', ''],
        ['BP2', 'ZB02', 'Tk Adit', 'RT 001 RW 002 RT 001', ''],
        ['BP3', 'ZB02', 'S', 'A 1 B', ''],
        ['BP4', 'ZB02', 'A B', 'CV Jalan 1', ''],
    ])
    bp, _, idx_len, _, _, _, idx_token, meta = mod.prepare_indexes(src)
    assert dict(zip(meta['key'], meta['value']))['token_index_version'] == '1'
    assert sum(idx_token['count']) == len(bp)
    assert list(idx_token['row_start'])[0] == 2
    assert list(idx_token['row_end'])[-1] == len(bp) + 1
    for row in idx_token.itertuples(index=False):
        segment = bp.iloc[int(row.row_start)-2:int(row.row_end)-1]
        counts = segment['norm_text'].map(
            lambda text: len({x for x in text.split(' ') if len(x) >= 2})
        )
        assert len(segment) == int(row.count)
        assert set(counts) == {int(row.token_count)}
        assert set(segment['sync_id']) == {row.sync_id}
        assert set(segment['text_len'].map(mod.len_bucket)) == {row.len_bucket}
    assert list(idx_token['row_start'])[1:] == [
        int(x) + 1 for x in list(idx_token['row_end'])[:-1]
    ]
