import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleCheck, handleHealth } from '../_lib/duplicate.js';

const NAME = 'Wr Santi';
const ADDRESS = 'Kp Cisaat Lebak RT 013 RW 003 Kel Bolang Kec Malingping Stlh Sdn 3 Bolang';
const normalize = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(pt|cv|tbk|ud|toko|tk|jl|jalan|gg|gang|no|nomor)\b/g, ' ').replace(/\s+/g, ' ').trim();
const hash = (n,a) => createHash('sha256').update(`${normalize(n)}\x1f${normalize(a)}`).digest('hex');
const bucket = n => String(Math.floor(n / 5)).padStart(3,'0');
const tokenCount = s => new Set(s.split(' ').filter(x=>x.length>=2)).size;
const baseEnv = { GOOGLE_OAUTH_CLIENT_ID: 'fixture', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture', GOOGLE_OAUTH_REFRESH_TOKEN: 'fixture', MAX_CANDIDATES: '5', MAX_BATCH_ROWS: '10', RANGE_CACHE_SECONDS: '0', RATE_LIMIT_PER_MIN: '0', SHEETS_LOCAL_READ_BUDGET_PER_MINUTE: '0' };
let counter = 0;
const originalFetch = globalThis.fetch;

function fixture(entries, opt={}) {
  const sync = `fixture-sync-${++counter}`;
  const indexed = [...entries].map(e=> ({...e, norm: normalize(`${e.name} ${e.address}`), hash: hash(e.name,e.address)}))
    .sort((a,b) => bucket(a.norm.length).localeCompare(bucket(b.norm.length)) || (opt.tokenIndexed ? tokenCount(a.norm)-tokenCount(b.norm) : 0) || a.norm.length - b.norm.length || a.id.localeCompare(b.id));
  const data = new Map();
  const bp = indexed.map((e,i) => [e.id,'ZB02',e.name,e.address,e.norm,'',String(e.norm.length),sync]);
  const exact = indexed.map((e,i) => [e.hash,i+2,e.id,sync]).sort((a,b)=>a[0].localeCompare(b[0]) || a[1]-b[1]);
  const ktp = indexed.filter(e=>e.ktp).map(e=>[e.ktp, indexed.indexOf(e)+2,e.id,sync]).sort((a,b)=>a[0].slice(-2).localeCompare(b[0].slice(-2)) || a[0].localeCompare(b[0]));
  data.set('BP_DATABASE', bp);
  data.set('EXACT_INDEX',exact);
  data.set('KTP_INDEX',ktp);
  function summarize(rows, grouping) {
    const map = new Map();
    rows.forEach((row,i)=>{
      const key=grouping(row);
      const val=map.get(key)||[key,i+2,i+2,0,sync];
      val[2]=i+2; val[3]++;map.set(key,val);
    });
    return [...map.values()];
  }
  data.set('INDEX_LEN', summarize(bp,row=>bucket(Number(row[6]))));
  if (opt.tokenIndexed) {
    const groups=new Map();
    bp.forEach((entry,i)=>{
      const len=bucket(Number(entry[6])), count=tokenCount(entry[4]);
      const key=len+':'+count;
      const value=groups.get(key)||[len,String(count),i+2,i+2,0,sync];
      value[3]=i+2;value[4]++;groups.set(key,value);
    });
    data.set('INDEX_LEN_TOKEN',[...groups.values()]);
  }
  data.set('INDEX_EXACT_SHARD',summarize(exact,row=>row[0].slice(0,2)));
  data.set('INDEX_KTP_SHARD',summarize(ktp,row=>row[0].slice(-2)));
  const meta = [
    ['sync_id',sync],['total_bp_rows',String(bp.length)],
    ['total_exact_index_rows',String(exact.length)],['total_ktp_index_rows',String(ktp.length)],
    ['exact_index_version',opt.oldVersion ? '' : '1'],['sync_state', opt.inProgress ? 'IN_PROGRESS' : 'READY'],
    ...(opt.tokenIndexed ? [['token_index_version','1'],['token_index_groups',String(data.get('INDEX_LEN_TOKEN').length)]] : [])
  ];
  data.set('META',meta);
  const env={...baseEnv, SHEET_ID:`fixture-${sync}`,...opt.env};
  const requests=[];
  globalThis.fetch=async url=>{
    const u=String(url);
    if (u.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({access_token:'fixture-token',expires_in:3600}),{status:200});
    const range=decodeURIComponent(u.split('/values/')[1].split('?')[0]);
    requests.push(range);
    const m=/^([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!m) throw new Error(`Unexpected range ${range}`);
    const [_,tab,col,start,other,end]=m;
    const maxCols = x=> [...x].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
    let rows=(data.get(tab)||[]).slice(Number(start)-2,Number(end)-1).map(r=>r.slice(maxCols(col)-1,maxCols(other)));
    if (opt.corrupt && range.includes(opt.corrupt)) rows = opt.corruptWith ?? [];
    return new Response(JSON.stringify({values:rows}),{status:200});
  };
  return {env,requests,sync,data};
}
async function run(f, payload={name_1:NAME,address:ADDRESS}) {
  const request = new Request('https://fixture.invalid/api/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const response = await handleCheck({request,env:f.env});
  return { status:response.status, body:await response.json() };
}
const row = (id,name,address,ktp='') => ({id,name,address,ktp});

test('Wr Santi exact text is found by SHA index regardless of fuzzy cap, without KTP', async()=>{
  const f=fixture([
    ...Array.from({length:9},(_,i)=>row(`unrelated-${i}`, `Unrelated ${i}`, 'Different random address of varying length')),
    row('110035698',NAME,ADDRESS,'3602014801820006')
  ],{env:{MAX_CANDIDATES:'1'}});
  const r=await run(f);
  assert.equal(r.status,200);
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_name_address_match?.bp_id,'110035698');
  assert.equal(r.body.exact_name_address_match?.score,100);
  assert.equal(r.body.stats.scanned_candidates,0);
  assert(!f.requests.some(x=>x.includes('BP_DATABASE!A2:H')));
  console.log('WR SANTI:',r.body.decision,r.body.exact_name_address_match?.bp_id,r.body.exact_name_address_match?.score);
});


test('real audit geometry: BP row 295606 found despite 396459 source rows and 60000 fuzzy cap',async()=>{
  const sync=`large-synthetic-${++counter}`;
  const h=hash(NAME,ADDRESS);
  const meta=[['sync_id',sync],['sync_state','READY'],['exact_index_version','1'],
    ['total_bp_rows','396459'],['total_exact_index_rows','396459'],['total_ktp_index_rows','312896']];
  const shardRows=[
    ['00',2,295605,295604,sync],
    [h.slice(0,2),295606,295606,1,sync],
    ['ff',295607,396460,100854,sync]
  ];
  assert.notEqual(h.slice(0,2),'00');assert.notEqual(h.slice(0,2),'ff');
  const reqs=[];
  globalThis.fetch=async url=>{
    const u=String(url);
    if(u.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({access_token:'fixture-token',expires_in:3600}),{status:200});
    const range=decodeURIComponent(u.split('/values/')[1].split('?')[0]);
    reqs.push(range);
    const values=range==='META!A2:B50' ? meta
      : range==='INDEX_EXACT_SHARD!A2:E10000' ? shardRows
      : range==='EXACT_INDEX!A295606:D295606' ? [[h,295606,'110035698',sync]]
      : range==='BP_DATABASE!A295606:H295606' ? [['110035698','ZB02',NAME,ADDRESS,normalize(`${NAME} ${ADDRESS}`),'0130033',82,sync]]
      : [];
    return new Response(JSON.stringify({values}),{status:200});
  };
  const env={...baseEnv,SHEET_ID:sync,MAX_CANDIDATES:'60000'};
  const r=await run({env});
  assert.equal(r.status,200);
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_name_address_match.bp_id,'110035698');
  assert.equal(r.body.exact_name_address_match.score,100);
  assert(reqs.includes('BP_DATABASE!A295606:H295606'));
  assert(!reqs.some(x=>x.startsWith('INDEX_LEN!')));
});

test('two BP records with exact same name/address both stay represented',async()=>{
  const f=fixture([row('110035698',NAME,ADDRESS),row('BP-SECOND',NAME,ADDRESS)]);
  const r=await run(f);
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_match_count,2);
  assert.equal(r.body.top_candidates.length,1);
});

test('exact KTP remains functional and pointer-safe',async()=>{
  const f=fixture([row('110035698',NAME,ADDRESS,'3602014801820006')]);
  const r=await run(f,{ktp_number:'3602014801820006'});
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_ktp_match.bp_id,'110035698');
});

test('exact field boundary is respected, joined strings alone do not cause exact hit',async()=>{
  const f=fixture([row('DIFFERENT', 'a b', 'c')]);
  const r=await run(f,{name_1:'a',address:'b c'});
  assert.equal(r.body.exact_match_count,0);
});

test('fuzzy scan limit without match returns INCONCLUSIVE, never PASS',async()=>{
  const f=fixture([...Array.from({length:9},(_,i)=>row(`BP-${i}`,`Unrelated ${i}`, 'Completely different sample address and another remote place street'))],{env:{MAX_CANDIDATES:'2'}});
  const r=await run(f);
  assert.equal(r.body.decision,'INCONCLUSIVE');
  assert.equal(r.body.stats.coverage_complete,false);
  assert.equal(r.body.stats.scan_limit_reached,true);
  assert.equal(r.body.stats.scanned_candidates,2);
});

test('fuzzy returns FAIL if match found, prioritizes best score over first row',async()=>{
  const f=fixture([
    row('A-WORSE',NAME, ADDRESS.replace('Bolang','Bolong').replace('Malingping','Malingpung')),
    row('Z-BETTER',NAME, ADDRESS.replace('Bolang','Bolong'))
  ],{env:{MAX_CANDIDATES:'10'}});
  const r=await run(f);
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.similarity_match?.bp_id,'Z-BETTER');
  assert.equal(r.body.stats.coverage_complete,true);
});

test('completed search with no match can PASS',async()=>{
  const f=fixture([row('OTHER','Entirely Else', 'A short remote street')],{env:{MAX_CANDIDATES:'100'}});
  const r=await run(f);
  assert.equal(r.body.decision,'PASS');
  assert.equal(r.body.stats.coverage_complete,true);
});

test('old snapshot without exact index blocks name+address search',async()=>{
  const f=fixture([row('110035698',NAME,ADDRESS)],{oldVersion:true});
  const r=await run(f);
  assert.equal(r.status,503);
  assert.match(r.body.error,/Exact name\/address index/);
});

test('sync in progress refuses requests rather than checking a half-written sheet',async()=>{
  const f=fixture([row('110035698',NAME,ADDRESS)],{inProgress:true});
  const r=await run(f);
  assert.equal(r.status,503);
  assert.match(r.body.error,/sync is in progress/);
});

test('incomplete exact shard cannot silently return PASS',async()=>{
  const f=fixture([row('110035698',NAME,ADDRESS)],{corrupt:'EXACT_INDEX!A',corruptWith:[]});
  const r=await run(f);
  assert.equal(r.status,503);
  assert.match(r.body.error,/EXACT_INDEX shard/);
});

test('incomplete INDEX_LEN cannot return PASS',async()=>{
  const f=fixture([row('110035698','Something else', 'Unrelated address')],{corrupt:'INDEX_LEN!A',corruptWith:[]});
  const r=await run(f);
  assert.equal(r.status,503);
});

test('mixed BP row sync IDs cannot return an exact match',async()=>{
  const f=fixture([row('110035698',NAME,ADDRESS)]);
  f.data.get('BP_DATABASE')[0][7]='mismatched-sync';
  const r=await run(f);
  assert.equal(r.status,503);
});

test('health rejects old snapshots and accepts new prepared indexes',async()=>{
  const good=fixture([row('110035698',NAME,ADDRESS)]);
  const ok=await handleHealth({env:good.env});
  assert.equal((await ok.json()).sheet_ok,true);
  const old=fixture([row('OLD',NAME,ADDRESS)],{oldVersion:true});
  const broken=await handleHealth({env:old.env});
  assert.equal((await broken.json()).sheet_ok,false);
});

test.after(()=>{globalThis.fetch=originalFetch;});


test('health and exact response disclose running engine and index readiness without secrets', async()=>{
  const f=fixture([row('TEST-BP','Example Shop','A sample street address')]);
  const health = await handleHealth({env:f.env});
  const hb = await health.json();
  assert.equal(hb.engine_version,'2026-09-23-private-snapshot-v11');
  assert.equal(hb.exact_index_ready,true);
  assert.equal(health.headers.get('x-bp-checker-engine'),'2026-09-23-private-snapshot-v11');
  const r=await run(f,{name_1:'Example Shop',address:'A sample street address'});
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_lookup.attempted,true);
  assert.equal(r.body.exact_lookup.matching_index_rows,1);
  assert.equal(r.body.exact_lookup.verified_matches,1);
});

test('health fails closed when META claims exact index smaller than BP_DATABASE',async()=>{
  const f=fixture([row('TEST-BP','Example Shop','A sample street address')]);
  const exactTotal=f.data.get('META').find(r=>r[0]==='total_exact_index_rows');
  exactTotal[1]='0';
  const r=await run(f,{name_1:'Example Shop',address:'A sample street address'});
  assert.equal(r.status,503);
  const health=await handleHealth({env:f.env});
  assert.equal(health.status,503);
  assert.equal((await health.json()).exact_index_ready,false);
});

test('KTP BP A and exact name+address BP B return FAIL with identity conflict and both records',async()=>{
  const f=fixture([
    row('110347500','Yeni','Goblok','3173085710790001'),
    row('110061496','Tk Adit','Kp Pasir Kalong RT 001 RW 004 Ds Batujajar Kec Cigudeg')
  ]);
  const r=await run(f,{name_1:'Tk Adit',address:'Kp Pasir Kalong RT 001 RW 004 Ds Batujajar Kec Cigudeg',ktp_number:'3173085710790001'});
  assert.equal(r.status,200);
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.identity_conflict,true);
  assert.equal(r.body.exact_ktp_match?.bp_id,'110347500');
  assert.equal(r.body.exact_name_address_match?.bp_id,'110061496');
  assert.equal(r.body.exact_name_address_match?.score,100);
  assert.equal(r.body.stats.scanned_candidates,0);
});

test('KTP match with unrelated free-text is still FAIL by KTP, never PASS',async()=>{
  const f=fixture([row('110347500','Someone else','Some different place','3173085710790001')]);
  const r=await run(f,{name_1:'Yeni',address:'Goblok',ktp_number:'3173085710790001'});
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_ktp_match?.bp_id,'110347500');
  assert.equal(r.body.identity_conflict,false);
});

test('KTP and exact name/address on same BP remain a single FAIL with no conflict',async()=>{
  const f=fixture([row('110347500','Yeni','Goblok','3173085710790001')]);
  const r=await run(f,{name_1:'Yeni',address:'Goblok',ktp_number:'3173085710790001'});
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_ktp_match?.bp_id,'110347500');
  assert.equal(r.body.exact_name_address_match?.bp_id,'110347500');
  assert.equal(r.body.identity_conflict,false);
});

test('health verifies KTP index in addition to exact and length indexes',async()=>{
  const f=fixture([row('110347500','Yeni','Goblok','3173085710790001')],{corrupt:'INDEX_KTP_SHARD!A',corruptWith:[]});
  const res=await handleHealth({env:f.env});
  assert.equal(res.status,503);
  const data=await res.json();
  assert.equal(data.sheet_ok,false);
  assert.match(data.sheet_error,/INDEX_KTP_SHARD/);
});

test('mixed KTP_INDEX snapshot is HTTP 503, never PASS or a stale FAIL',async()=>{
  const f=fixture([row('110347500','Yeni','Goblok','3173085710790001')]);
  f.data.get('KTP_INDEX')[0][3]='previous-sync';
  const r=await run(f,{name_1:'Yeni',address:'Goblok',ktp_number:'3173085710790001'});
  assert.equal(r.status,503);
  assert.equal(r.body.ok,false);
  assert.match(r.body.error,/Mixed or incomplete sheet snapshot/);
});

test('Tk Adit exact name/address without KTP returns BP even when fuzzy cap is one',async()=>{
  const f=fixture([row('110061496','Tk Adit','Kp Pasir Kalong RT 001 RW 004 Ds Batujajar Kec Cigudeg')],{env:{MAX_CANDIDATES:'1'}});
  const r=await run(f,{name_1:'Tk Adit',address:'Kp Pasir Kalong RT 001 RW 004 Ds Batujajar Kec Cigudeg'});
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.exact_name_address_match?.bp_id,'110061496');
  assert.equal(r.body.exact_name_address_match?.score,100);
  assert.equal(r.body.stats.scanned_candidates,0);
});

test('identity conflict beyond five duplicate source rows is detected and previewed',async()=>{
  const address='Kp Pasir Kalong RT 001 RW 004 Ds Batujajar Kec Cigudeg';
  const records=[
    ...Array.from({length:6},(_,i)=>row('BP-A','Tk Adit',address,i===0?'3173085710790001':'')),
    row('BP-B','Tk Adit',address)
  ];
  const f=fixture(records);
  const r=await run(f,{name_1:'Tk Adit',address,ktp_number:'3173085710790001'});
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.identity_conflict,true);
  assert.equal(r.body.exact_match_count,7);
  assert.equal(r.body.exact_ktp_match?.bp_id,'BP-A');
  assert.equal(r.body.exact_name_address_match?.bp_id,'BP-A');
  assert(r.body.top_candidates.some(x=>x.bp_id==='BP-B'));
  assert.equal(r.body.stats.scanned_candidates,0);
});

test('resumable relevant-bucket search avoids normal rescan and finds late match',async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const unrelated=Array.from({length:9},(_,i)=>row('UNRELATED-'+i,'Unrelated '+i,'Completely different sample address and another remote place street abc'));
  const f=fixture([...unrelated,row('BP-LATE',NAME,ADDRESS+' x')],{env:{MAX_CANDIDATES:'1',FULL_SCOPE_CHUNK_ROWS:'1'}});
  const fast=await run(f,input);
  assert.equal(fast.body.decision,'INCONCLUSIVE');
  assert.equal(fast.body.full_scope_available,true);
  let r=fast;
  for(let i=0;i<12 && r.body.full_scope_cursor;i++){
    r=await run(f,{...input,full_scope_cursor:r.body.full_scope_cursor});
    assert.equal(r.status,200,r.body.error);
  }
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.similarity_match.bp_id,'BP-LATE');
});
test('manual relevant-bucket search cannot PASS until all eligible rows checked',async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const f=fixture([
    row('BP-X','Unrelated X','Completely different sample address and another remote place street'),
    row('BP-Y','Unrelated Y','Completely different sample address and another remote place street'),
    row('BP-Z','Unrelated Z','Completely different sample address and another remote place street')
  ],{env:{MAX_CANDIDATES:'1',FULL_SCOPE_CHUNK_ROWS:'1'}});
  let r=await run(f,input);
  assert.equal(r.body.decision,'INCONCLUSIVE');
  assert.equal(r.body.stats.scanned_candidates,1);
  for(let i=2;i<=3;i++){
    r=await run(f,{...input,full_scope_cursor:r.body.full_scope_cursor});
    assert.equal(r.status,200,r.body.error);
    assert.equal(r.body.stats.scanned_candidates,i);
    assert.equal(r.body.decision,i===3?'PASS':'INCONCLUSIVE');
    assert.equal(r.body.stats.resumed_from_normal_scan,i-1);
  }
  assert.equal(r.body.stats.coverage_complete,true);
  assert.equal(r.body.full_scope_cursor,null);
});

test('manual search cursor rejects changed input and changed snapshot',async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const f=fixture([
    row('BP-X','Unrelated X','Completely different sample address and another remote place street'),
    row('BP-Y','Unrelated Y','Completely different sample address and another remote place street')
  ],{env:{MAX_CANDIDATES:'1',FULL_SCOPE_CHUNK_ROWS:'1'}});
  const fast=await run(f,input);
  const token=fast.body.full_scope_cursor;
  assert.equal(typeof token,'string');
  const changed=await run(f,{...input,address:'Other address',full_scope_cursor:token});
  assert.equal(changed.status,409);
  const pieces=token.split('.');
  pieces[1]=pieces[1].slice(0,-3)+'abc';
  const invalid=await run(f,{...input,full_scope_cursor:pieces.join('.')});
  assert.equal(invalid.status,400);
  f.data.get('META').find(r=>r[0]==='sync_id')[1]='later-snapshot';
  const stale=await run(f,{...input,full_scope_cursor:token});
  assert.equal(stale.status,503);
  assert.equal(stale.body.ok,false);
});

test('normal PASS proves every eligible bucket row was visited and scored',async()=>{
  const f=fixture([
    ...Array.from({length:8},(_,i)=>row('BP-'+i,'Zzzzzz','Yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'))
  ],{env:{MAX_CANDIDATES:'20'}});
  const r=await run(f,{name_1:NAME,address:ADDRESS});
  assert.equal(r.status,200);
  assert.equal(r.body.decision,'PASS');
  assert.equal(r.body.stats.coverage_complete,true);
  assert.equal(r.body.stats.pass_basis,'ALL_ELIGIBLE_BUCKET_ROWS_SCORED');
  assert.equal(r.body.stats.scanned_candidates,r.body.stats.candidate_space);
  assert.equal(r.body.stats.completed_buckets,r.body.stats.bucket_count);
  assert.equal(r.body.full_scope_cursor,null);
});

test('large bucket stays INCONCLUSIVE quickly with on-demand continuation',async()=>{
  const f=fixture([
    ...Array.from({length:30},(_,i)=>row('BP-'+i,'Zzzzzz','Yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'))
  ],{env:{MAX_CANDIDATES:'5',OVERSIZED_SCAN_BUDGET:'2'}});
  const r=await run(f,{name_1:NAME,address:ADDRESS});
  assert.equal(r.status,200);
  assert.equal(r.body.decision,'INCONCLUSIVE');
  assert.equal(r.body.stats.oversized_bucket_space,true);
  assert.equal(r.body.stats.scanned_candidates,2);
  assert.equal(r.body.stats.pass_basis,null);
  assert.equal(r.body.full_scope_available,true);
  assert.equal(typeof r.body.full_scope_cursor,'string');
});

test('normal score checks all in-tolerance candidates without quickPrefilter exclusions',async()=>{
  const f=fixture([row('BP-X','Zzzzzz','Yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy')],{env:{MAX_CANDIDATES:'10'}});
  const r=await run(f,{name_1:NAME,address:ADDRESS});
  assert.equal(r.status,200);
  assert.equal(r.body.decision,'PASS');
  assert.equal(r.body.stats.compared_candidates,1);
  assert.equal(r.body.stats.skipped_by_prefilter,0);
});

test('full-scope continuation skips distant buckets and does not reread the normal-scan row',async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const f=fixture([
    row('NEAR-A','Unrelated 1','Completely different sample address and another remote place street'),
    row('NEAR-B','Unrelated 2','Completely different sample address and another remote place street'),
    row('FAR','Distant', 'x'.repeat(270))
  ],{env:{MAX_CANDIDATES:'1',FULL_SCOPE_CHUNK_ROWS:'1'}});
  let r=await run(f,input);
  assert.equal(r.body.decision,'INCONCLUSIVE');
  assert.equal(r.body.stats.candidate_space,2);
  const fastRows=f.requests.filter(x=>x.startsWith('BP_DATABASE!'));
  assert.equal(fastRows.length,1);
  r=await run(f,{...input,full_scope_cursor:r.body.full_scope_cursor});
  assert.equal(r.body.decision,'PASS');
  assert.equal(r.body.stats.scanned_candidates,2);
  assert.equal(r.body.stats.resumed_from_normal_scan,1);
  const allRows=f.requests.filter(x=>x.startsWith('BP_DATABASE!'));
  assert.equal(allRows.length,2);
  assert.notEqual(allRows[0],allRows[1]);
  assert.equal(r.body.stats.search_scope,'CONFIGURED_LENGTH_BUCKETS');
  assert.equal(r.body.stats.pass_basis,'ALL_ELIGIBLE_BUCKET_ROWS_SCORED');
});

test('normal PASS does not mint Full Scope button cursor',async()=>{
  const f=fixture([row('PASS-1','Unrelated 1','Completely different sample address and another remote place street')],{env:{MAX_CANDIDATES:'3'}});
  const r=await run(f,{name_1:NAME,address:ADDRESS});
  assert.equal(r.body.decision,'PASS');
  assert.equal(r.body.full_scope_cursor,null);
  assert.equal(r.body.full_scope_available,false);
});

test('Sheets 429 returns controlled retry and never PASS or raw Google project info',async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const f=fixture([
    row('BP-X','Unrelated X','Completely different sample address and another remote place street'),
    row('BP-Y','Unrelated Y','Completely different sample address and another remote place street')
  ],{env:{MAX_CANDIDATES:'1',FULL_SCOPE_CHUNK_ROWS:'1'}});
  const fast=await run(f,input);
  assert.equal(fast.body.decision,'INCONCLUSIVE');
  const backingFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    const request=String(url);
    if(request.includes('BP_DATABASE!') || decodeURIComponent(request).includes('BP_DATABASE!')) {
      return new Response(JSON.stringify({
        error:{message:'Quota exceeded for consumer project_number:private-id'}
      }),{status:429});
    }
    return backingFetch(url);
  };
  try {
    const r=await run(f,{...input,full_scope_cursor:fast.body.full_scope_cursor});
    assert.equal(r.status,429);
    assert.equal(r.body.ok,false);
    assert.equal(r.body.retry_after_seconds,70);
    assert.equal(r.body.decision,undefined);
    assert.equal(JSON.stringify(r.body).includes('private-id'),false);
  } finally {globalThis.fetch=backingFetch;}
});

test('successful quota-aware continuation reports headroom without changing exhaustive scoring',async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const f=fixture([
    row('BP-X','Unrelated X','Completely different sample address and another remote place street'),
    row('BP-Y','Unrelated Y','Completely different sample address and another remote place street')
  ],{env:{MAX_CANDIDATES:'1',FULL_SCOPE_CHUNK_ROWS:'1'}});
  const first=await run(f,input);
  assert.equal(first.body.decision,'INCONCLUSIVE');
  assert.equal(first.body.quota.local_budget_per_minute,0);
  const second=await run(f,{...input,full_scope_cursor:first.body.full_scope_cursor});
  assert.equal(second.status,200);
  assert.equal(second.body.decision,'PASS');
  assert.equal(second.body.stats.pass_basis,'ALL_ELIGIBLE_BUCKET_ROWS_SCORED');
  assert.equal(second.body.stats.scanned_candidates,2);
  assert.equal(second.body.quota.local_budget_per_minute,0);
  assert(Number.isFinite(second.body.quota.recommended_pause_seconds));
  assert(second.body.quota.recommended_pause_seconds >= 0);
});

test('new token-count index prunes provably unrelated groups without missing a FAIL',async()=>{
  const f=fixture([
    row('OTHER','abc','zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'),
    row('NEAR',NAME,ADDRESS+' x')
  ],{tokenIndexed:true,env:{MAX_CANDIDATES:'20'}});
  const r=await run(f,{name_1:NAME,address:ADDRESS});
  assert.equal(r.status,200,r.body.error);
  assert.equal(r.body.decision,'FAIL');
  assert.equal(r.body.similarity_match?.bp_id,'NEAR');
  assert.equal(r.body.stats.score_bound_index_used,true);
});
test('token index mismatch blocks PASS instead of silently skipping candidates',async()=>{
  const f=fixture([row('BP-X','X','unrelated'.repeat(10))],{tokenIndexed:true});
  f.data.get('INDEX_LEN_TOKEN')[0][4]=999;
  const r=await run(f,{name_1:NAME,address:ADDRESS});
  assert.equal(r.status,503);
  assert.equal(r.body.ok,false);
});

test('score upper bounds provide fast PASS on complete, provably excluded group',async()=>{
  const f=fixture([row('PROVABLY-UNRELATED','x','x'.repeat(103))],
    {tokenIndexed:true,env:{MAX_CANDIDATES:'1'}});
  const r=await run(f,{name_1:NAME,address:ADDRESS});
  assert.equal(r.status,200,r.body.error);
  assert.equal(r.body.decision,'PASS');
  assert.equal(r.body.stats.score_bound_index_used,true);
  assert.equal(r.body.stats.safely_pruned_candidates,1);
  assert.equal(r.body.stats.pass_basis,'ALL_RELEVANT_ROWS_SCORED_OR_SAFELY_PRUNED');
  assert.equal(r.body.stats.candidate_space,0);
  assert.equal(r.body.stats.scanned_candidates,0);
  assert.equal(r.body.stats.coverage_complete,true);
  assert.equal(r.body.full_scope_cursor,null);
});

test('bounded normal check is incomplete, not PASS, and resumes without replay', async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const f=fixture([
    row('A','Unrelated A','Completely different sample address and another remote place street'),
    row('B','Unrelated B','Completely different sample address and another remote place street'),
    row('C','Unrelated C','Completely different sample address and another remote place street'),
    row('D','Unrelated D','Completely different sample address and another remote place street'),
  ],{env:{MAX_CANDIDATES:'20',NORMAL_MAX_ROWS_PER_REQUEST:'2',FULL_SCOPE_CHUNK_ROWS:'2'}});
  let r=await run(f,input);
  assert.equal(r.status,200,r.body.error);
  assert.equal(r.body.decision,'INCONCLUSIVE');
  assert.equal(r.body.stats.scanned_candidates,2);
  assert.equal(r.body.stats.candidate_space,4);
  assert.equal(r.body.stats.normal_row_budget,2);
  assert.equal(r.body.stats.coverage_complete,false);
  assert.equal(typeof r.body.full_scope_cursor,'string');
  const initialRanges=f.requests.filter(x=>x.startsWith('BP_DATABASE!'));
  r=await run(f,{...input,full_scope_cursor:r.body.full_scope_cursor});
  assert.equal(r.status,200,r.body.error);
  assert.equal(r.body.decision,'PASS');
  assert.equal(r.body.stats.scanned_candidates,4);
  assert.equal(r.body.stats.resumed_from_normal_scan,2);
  const allRanges=f.requests.filter(x=>x.startsWith('BP_DATABASE!'));
  assert(allRanges.length>initialRanges.length);
  assert(!initialRanges.includes(allRanges.at(-1)));
});

test('normal scan preserves successful BP work if Sheets quota fails at the next range',async()=>{
  const input={name_1:NAME,address:ADDRESS};
  const f=fixture([
    row('A','Unrelated A','Completely different sample address and another remote place street'),
    row('B','Unrelated B','Completely different sample address and another remote place street'),
    row('C','Unrelated C','Completely different sample address and another remote place street')
  ],{env:{MAX_CANDIDATES:'10',MAX_BATCH_ROWS:'1'}});
  const mock=globalThis.fetch;
  let bpRangeCalls=0;
  globalThis.fetch=async url=>{
    if(decodeURIComponent(String(url)).includes('BP_DATABASE!')) {
      bpRangeCalls++;
      if(bpRangeCalls===2) return new Response('{}',{status:429});
    }
    return mock(url);
  };
  let first;
  try { first=await run(f,input); } finally {globalThis.fetch=mock;}
  assert.equal(first.status,200,first.body.error);
  assert.equal(first.body.decision,'INCONCLUSIVE');
  assert.equal(first.body.stats.scanned_candidates,1);
  assert.equal(first.body.stats.stopped_for_quota,true);
  assert.equal(first.body.stats.coverage_complete,false);
  assert.equal(typeof first.body.full_scope_cursor,'string');
  const continued=await run(f,{...input,full_scope_cursor:first.body.full_scope_cursor});
  // A real backend may retain its 429 cooldown; never claim the interrupted
  // request can PASS without a complete continuation.
  assert([200,429].includes(continued.status));
  if(continued.status===200) assert.equal(continued.body.stats.resumed_from_normal_scan,1);
  else assert.equal(continued.body.ok,false);
});

test('private-only mode rejects absent private DB without reading Sheets or claiming PASS',async()=>{
  const env={...baseEnv,PRIVATE_INDEX_MODE:'required',PRIVATE_INDEX_DATABASE_URL:''};
  const request=new Request('https://fixture.invalid/api/check',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name_1:NAME,address:ADDRESS})});
  const {handleCheck}=await import('../_lib/duplicate.js');
  const response=await handleCheck({request,env});
  const body=await response.json();
  assert.equal(response.status,503);
  assert.equal(body.ok,false);
  assert.equal(body.decision,undefined);
});
