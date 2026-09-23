// v15 in-memory full-scan engine: loader integrity, decisions, fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {handleCheck,handleHealth,normalizeText,computeSimilarity,
  getSimilarityWeights,getMaxLenDiff,tokens,numericTokens} from '../_lib/duplicate.js';
import {buildSnapshotIndex,_resetMemoryEngineForTests} from '../_lib/memory-engine.js';
import {makeTsv,perturb,rng,makeRecord} from '../tools/synthetic_bp.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const HEADER='bp_id\tbp_type_id\tname_1\taddress\tktp_digits';

function packedBook(records,sync,{partChars=64}={}){
  const lines=[HEADER,...[...records].sort((a,b)=>a.id.localeCompare(b.id))
    .map(r=>[r.id,'ZB02',r.name,r.address,r.ktp||''].join('\t'))];
  const raw=Buffer.from(lines.join('\n'),'utf8');
  const text=gzipSync(raw).toString('base64');
  const parts=[];
  for(let i=0;i<text.length;i+=partChars)parts.push(text.slice(i,i+partChars));
  return {hash:sha(raw),rows:[['part_no','part_count','sync_id','data'],
    ...parts.map((p,n)=>[String(n+1),String(parts.length),sync,p])]};
}
let n=0;
function generation(records,{packed=true}={}){
  const sync='mem-fixture-'+(++n);
  const source=[...records].sort((a,b)=>a.id.localeCompare(b.id));
  const digest=sha(sync);
  const bp=[['bp_id','bp_type_id','name_1','address','norm_text','norm_digits','text_len','row_hash']];
  for(const r of source){
    const norm=normalizeText(r.name+' '+r.address);
    bp.push([r.id,'ZB02',r.name,r.address,norm,'',String(norm.length),
      sha(JSON.stringify([r.id,'ZB02',r.name,r.address,r.ktp||'']))]);
  }
  // v14 packed index tabs (used by the keyed fallback engine).
  const at=new Map(source.map((r,i)=>[r.id,i+2]));
  const fuzzy=source.map(r=>{
    const norm=normalizeText(r.name+' '+r.address);
    return [String(Math.floor(norm.length/5)).padStart(3,'0')+':'+tokens(norm).size,
      JSON.stringify([norm,at.get(r.id),r.id])];
  }).sort((x,y)=>x[0].localeCompare(y[0])||x[1].localeCompare(y[1]));
  const shards=(rows,key)=>{
    const out=[];
    rows.forEach((row,i)=>{const k=key(row),last=out.at(-1);
      if(last&&last[0]===k){last[2]=String(i+2);last[3]=String(Number(last[3])+1);}
      else out.push([k,String(i+2),String(i+2),'1',sync]);});
    return out;
  };
  const exact=source.map(r=>[sha(normalizeText(r.name)+'\x1f'+normalizeText(r.address)),
    JSON.stringify([at.get(r.id),r.id])]).sort((x,y)=>x[0].localeCompare(y[0]));
  const ktp=source.filter(r=>r.ktp).map(r=>[r.ktp,JSON.stringify([at.get(r.id),r.id])])
    .sort((x,y)=>x[0].slice(-2).localeCompare(y[0].slice(-2))||x[0].localeCompare(y[0]));
  const groups=shards(fuzzy,r=>r[0]);
  const meta={sync_id:sync,sync_state:'READY',keyed_index_version:'14',
    exact_index_version:'1',token_index_version:'1',total_bp_rows:String(source.length),
    total_exact_index_rows:String(source.length),total_ktp_index_rows:String(ktp.length),
    token_index_groups:String(groups.length),source_digest:digest,last_sync_at:'2026-09-24 10:00:00'};
  const pk=packedBook(source,sync);
  if(packed)Object.assign(meta,{packed_snapshot_version:'1',
    packed_parts:String(pk.rows.length-1),packed_records:String(source.length),
    packed_sha256:pk.hash});
  const metaRows=[['key','value'],...Object.entries(meta)];
  return {sync,digest,meta,packed:pk,
    primary:new Map([['META',metaRows],['BP_DATABASE',bp]]),
    index:new Map([['META',metaRows],...(packed?[['PACKED_SNAPSHOT',pk.rows]]:[]),
      ['INDEX_LEN_TOKEN',[['len_token_key','posting_json'],...fuzzy]],
      ['INDEX_LEN',[['len_token_key','row_start','row_end','count','sync_id'],...groups]],
      ['EXACT_INDEX',[['exact_hash','posting_json'],...exact]],
      ['INDEX_EXACT_SHARD',[['exact_shard','row_start','row_end','count','sync_id'],...shards(exact,r=>r[0].slice(0,2))]],
      ['KTP_INDEX',[['ktp_digits','posting_json'],...ktp]],
      ['INDEX_KTP_SHARD',[['ktp_shard','row_start','row_end','count','sync_id'],...shards(ktp,r=>r[0].slice(-2).padStart(2,'0'))]]])};
}
const RECORDS=[
  {id:'BP-A',name:'Toko Alpha Jaya',address:'Jl Mawar No 10 RT 001 RW 002 Kel Sukamaju',ktp:'3171234567890001'},
  {id:'BP-B',name:'Warung Beta',address:'Jl Rindu 8 RT 003 RW 004 Kel Cibubur'},
  {id:'BP-C',name:'CV Gamma Sentosa',address:'Jl Kenanga 77 Kec Ciledug Kota Tangerang',ktp:'3671000000000077'}
];

async function withSheets(fn,{gens=null,env:extra={}}={}){
  _resetMemoryEngineForTests();
  const before=globalThis.fetch;
  const books={A:gens?.a??generation(RECORDS),B:gens?.b??generation(RECORDS)};
  let active='A';
  const reads=[];
  let delay=0;
  const env={GOOGLE_OAUTH_CLIENT_ID:'x',GOOGLE_OAUTH_CLIENT_SECRET:'x',
    GOOGLE_OAUTH_REFRESH_TOKEN:'fixture-refresh-token-long-enough',
    GSHEET_SNAPSHOT_MODE:'dual',SHEET_A_ID:'TA',SHEET_B_ID:'TB',
    SHEET_A2_ID:'TA2',SHEET_B2_ID:'TB2',SHEET_CONTROL_ID:'TC',SHEET_ID:'TL',
    RATE_LIMIT_PER_MIN:'0',SHEETS_LOCAL_READ_BUDGET_PER_MINUTE:'0',
    RANGE_CACHE_SECONDS:'0',...extra};
  const col=x=>[...x].reduce((v,c)=>v*26+c.charCodeAt(0)-64,0)-1;
  function read(book,range){
    reads.push({book,range});
    const [tab,where]=range.split('!');
    const m=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(where);
    let sheet;
    if(book==='TC'){
      const g=books[active];
      sheet=[['key','value'],['active_sheet_id','T'+active],
        ['active_index_sheet_id','T'+active+'2'],['sync_id',g.sync],
        ['total_bp_rows',g.meta.total_bp_rows],['source_digest',g.digest],
        ['sync_state','READY'],['last_sync_at','x'],
        ['packed_snapshot_version',g.meta.packed_snapshot_version||''],
        ['packed_sha256',g.meta.packed_sha256||'']];
    }else{
      const g=books[book[1]];
      sheet=(book.length===3?g.index:g.primary).get(tab);
      if(!sheet)throw new Error('missing tab '+book+' '+tab);
    }
    return sheet.slice(Number(m[2])-1,Number(m[4])).map(r=>r.slice(col(m[1]),col(m[3])+1));
  }
  globalThis.fetch=async input=>{
    const uri=String(input);
    if(uri.includes('oauth2.googleapis.com/token'))
      return new Response(JSON.stringify({access_token:'t',expires_in:3600}));
    const bookOf=/spreadsheets\/([^/]+)\//.exec(uri)?.[1];
    const wait=typeof delay==='function'?delay(bookOf):delay;
    if(wait)await new Promise(r=>setTimeout(r,wait));
    const batch=/spreadsheets\/([^/]+)\/values:batchGet\?/.exec(uri);
    if(batch){
      const book=decodeURIComponent(batch[1]);
      const ranges=new URL(uri).searchParams.getAll('ranges');
      return new Response(JSON.stringify({valueRanges:ranges.map(range=>({range,values:read(book,range)}))}));
    }
    const m=/spreadsheets\/([^/]+)\/values\/([^?]+)/.exec(uri);
    return new Response(JSON.stringify({values:read(decodeURIComponent(m[1]),decodeURIComponent(m[2]))}));
  };
  async function check(payload,e=env){
    const response=await handleCheck({env:e,request:new Request('https://x/api/check',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})});
    return {status:response.status,body:await response.json()};
  }
  try{
    await fn({env,books,reads,check,switchTo:x=>{active=x;},setDelay:x=>{delay=x;}});
  }finally{globalThis.fetch=before;_resetMemoryEngineForTests();}
}

test('memory engine: health, exact KTP, exact name, fuzzy FAIL and full-scan PASS',async()=>{
  await withSheets(async f=>{
    const health=await handleHealth({env:f.env});
    const hb=await health.json();
    assert.equal(health.status,200,JSON.stringify(hb));
    assert.equal(hb.search_backend,'MEMORY_FULL_SCAN');
    assert.equal(hb.memory.records,3);
    assert.equal(hb.meta.exact_index_version,'1');
    const readsAfterLoad=f.reads.length;
    const ktp=await f.check({ktp_number:'3171-2345-6789-0001'});
    assert.equal(ktp.body.decision,'FAIL');
    assert.equal(ktp.body.exact_ktp_match.bp_id,'BP-A');
    const exact=await f.check({name_1:'WARUNG BETA',address:'jl. rindu 8 rt 003 rw 004 kel cibubur'});
    assert.equal(exact.body.decision,'FAIL');
    assert.equal(exact.body.exact_name_address_match.bp_id,'BP-B');
    const fuzzy=await f.check({name_1:'Toko Alfa Jaya',address:'Jl Mawar No 10 RT 001 RW 002 Kel Sukamaju'});
    assert.equal(fuzzy.body.decision,'FAIL');
    assert.equal(fuzzy.body.similarity_match.bp_id,'BP-A');
    assert.equal(fuzzy.body.similarity_match.decision_rule,'DIRECT_REJECT');
    const pass=await f.check({name_1:'Apotek Sehat Selalu',address:'Jl Veteran 400 Kota Medan Sumatera'});
    assert.equal(pass.body.decision,'PASS',JSON.stringify(pass.body));
    assert.equal(pass.body.stats.coverage_complete,true);
    assert.equal(pass.body.stats.pass_basis,'ALL_BP_RECORDS_EVALUATED_IN_MEMORY');
    assert.equal(pass.body.stats.snapshot_records,3);
    assert.equal(pass.body.full_scope_cursor,null);
    assert.equal(pass.body.search_backend,'MEMORY_FULL_SCAN');
    assert.equal(f.reads.length,readsAfterLoad,'checks must not read Google Sheets');
    assert(!f.reads.some(r=>r.book==='TB'||r.book==='TB2'),'standby pair never read');
    const conflict=await f.check({name_1:'Warung Beta',
      address:'Jl Rindu 8 RT 003 RW 004 Kel Cibubur',ktp_number:'3171234567890001'});
    assert.equal(conflict.body.identity_conflict,true);
  });
});

test('memory engine: follows CONTROL to the new generation',async()=>{
  const b=generation([...RECORDS,{id:'BP-D',name:'Depot Delta',address:'Jl Anggrek 5 Kota Depok'}]);
  await withSheets(async f=>{
    const first=await f.check({name_1:'Depot Delta',address:'Jl Anggrek 5 Kota Depok'});
    assert.equal(first.body.decision,'PASS');
    f.switchTo('B');
    const second=await f.check({name_1:'Depot Delta',address:'Jl Anggrek 5 Kota Depok'});
    assert.equal(second.body.decision,'FAIL');
    assert.equal(second.body.stats.snapshot_sync_id,b.sync);
  },{gens:{b},env:{SNAPSHOT_VERIFY_MAX_AGE_SECONDS:'0'}});
});

test('memory engine: missing PACKED_SNAPSHOT falls back to the keyed v14 engine',async()=>{
  const a=generation(RECORDS,{packed:false});
  await withSheets(async f=>{
    const health=await handleHealth({env:f.env});
    const body=await health.json();
    assert.equal(body.memory.fallback_reason,'PACKED_SNAPSHOT_MISSING');
    assert.equal(body.search_backend,'KEYED_GOOGLE_SHEETS_DUAL');
    assert.equal(health.status,200,JSON.stringify(body));
    const got=await f.check({ktp_number:'3671000000000077'});
    assert.equal(got.body.decision,'FAIL',JSON.stringify(got.body));
    assert.equal(got.body.exact_ktp_match.bp_id,'BP-C');
    assert.equal(got.body.search_backend,'KEYED_GOOGLE_SHEETS_DUAL');
    assert.equal(got.body.memory_fallback_reason,'PACKED_SNAPSHOT_MISSING');
  },{gens:{a}});
});

for(const [label,corrupt] of [
  ['SHA-256 mismatch',g=>{g.meta.packed_sha256='0'.repeat(64);
    g.index.get('META').find(r=>r[0]==='packed_sha256')[1]='0'.repeat(64);
    g.primary.get('META').find(r=>r[0]==='packed_sha256')[1]='0'.repeat(64);}],
  ['torn part from another generation',g=>{g.packed.rows[2][2]='other-sync';}],
  ['missing part',g=>{g.packed.rows.splice(2,1);}]
]){
  test('memory engine: '+label+' never yields an in-memory PASS',async()=>{
    const a=generation(RECORDS);
    corrupt(a);
    await withSheets(async f=>{
      const got=await f.check({name_1:'Apotek Sehat Selalu',address:'Jl Veteran 400 Kota Medan'});
      assert.equal(got.status,200,JSON.stringify(got.body));
      assert.equal(got.body.search_backend,'KEYED_GOOGLE_SHEETS_DUAL');
      assert.match(got.body.memory_fallback_reason||'',/PACKED_SNAPSHOT_UNAVAILABLE/);
    },{gens:{a}});
  });
}

test('memory engine: slow load answers 503 warming, never a decision',async()=>{
  await withSheets(async f=>{
    f.setDelay(300);
    const got=await f.check({name_1:'Apotek',address:'Jl Veteran 400'},
      {...f.env,SNAPSHOT_LOAD_WAIT_MS:'50'});
    assert.equal(got.status,503);
    assert.equal(got.body.warming,true);
    assert.equal(got.body.decision,undefined);
    assert(got.body.retry_after_seconds>=1);
    f.setDelay(0);
    await new Promise(r=>setTimeout(r,1500));
    const later=await f.check({name_1:'Apotek',address:'Jl Veteran 400'});
    assert.equal(later.body.search_backend,'MEMORY_FULL_SCAN');
  });
});

test('memory engine scan equals brute-force computeSimilarity on every BP',async()=>{
  const {tsv,records}=makeTsv(3000,21);
  const snap=await buildSnapshotIndex(tsv);
  const r=rng(77);
  for(const cfg of [{env:{},direct:80,threshold:92},{env:{},direct:70,threshold:60},
    {env:{SIMILARITY_WEIGHT_NUMERIC:'60'},direct:85,threshold:55}]){
    const weights=getSimilarityWeights(cfg.env);
    for(let q=0;q<25;q++){
      const input=q%2?perturb(r,records[Math.floor(r()*records.length)]):makeRecord(r,5000+q);
      const qt=normalizeText(input.name_1+' '+input.address);
      const diff=getMaxLenDiff(cfg.env,qt.length);
      const got=snap.scan(qt,{weights,direct:cfg.direct,threshold:cfg.threshold,
        maxLenDiff:diff,deadline:Date.now()+60000});
      const feats={tokens:tokens(qt),numeric:numericTokens(qt)};
      const all=[];
      for(let i=0;i<snap.count;i++){
        const c=snap.normText(i);
        if(!c||Math.abs(c.length-qt.length)>diff)continue;
        const s=computeSimilarity(qt,c,weights,cfg.direct,feats);
        if(s.direct_reject||s.combined>=cfg.threshold)
          all.push({i,score:s.direct_reject?s.trigger_score:s.combined});
      }
      all.sort((a,b)=>b.score-a.score||a.i-b.i);
      assert.equal(got.stats.matches,all.length);
      assert.deepEqual(got.top.map(x=>[x.i,x.score]),all.slice(0,5).map(x=>[x.i,x.score]));
    }
  }
});

test('packed loader rejects malformed rows and wrong record counts',async()=>{
  await assert.rejects(buildSnapshotIndex(Buffer.from('bad header\nx')),/header/);
  await assert.rejects(buildSnapshotIndex(Buffer.from(HEADER+'\nBP-1\tZB02\tonly three')),/malformed/);
  await assert.rejects(buildSnapshotIndex(Buffer.from(HEADER+'\nBP-1\tZB02\tA\tB\t'),
    {expectedRecords:2}),/expects 2/);
  const one=await buildSnapshotIndex(Buffer.from(HEADER+'\nBP-1\tZB02\tA\tB\t12'));
  assert.equal(one.findKtp('12')[0].bp_id,'BP-1');
  assert.deepEqual(one.findKtp('13'),[]);
});

test('index normalization and exact keys equal the query-side functions for every BP',async()=>{
  const {tsv,records}=makeTsv(2000,5);
  const tricky=[['T-1','ZB02','ΑΣ ΣΑΣ İstanbul','ﬁnal ½ Ⅻ é PT.'],['T-2','ZB02','',"Jl. O'Neil_No 5"],
    ['T-3','ZB02','Toko','Gg'],['T-4','ZB02','王小明 😀','ｶﾞ ① ǅ']];
  const raw=Buffer.concat([tsv,Buffer.from('\n'+tricky.map(r=>[...r,''].join('\t')).join('\n'))]);
  const snap=await buildSnapshotIndex(raw);
  const all=[...records.map(r=>[r.bp_id,r.name_1,r.address]),...tricky.map(r=>[r[0],r[2],r[3]])];
  assert.equal(snap.count,all.length);
  for(let i=0;i<snap.count;i++){
    const r=snap.record(i);
    assert.equal(r.norm_text,normalizeText(r.name_1+' '+r.address),r.bp_id);
    assert.deepEqual([...new Set(r.norm_text.split(' ').filter(t=>t.length>=2))],
      [...snap.tokIds.subarray(snap.tokStart[i],snap.tokStart[i+1])].map(id=>snap.dict[id]));
    assert(snap.findExact(r.name_1,r.address).some(x=>x.bp_id===r.bp_id),r.bp_id);
  }
});

test('a load that finishes after a newer generation was requested is discarded',async()=>{
  const b=generation([...RECORDS,{id:'BP-E',name:'Kios Epsilon',address:'Jl Cempaka 9 Kota Bogor'}]);
  await withSheets(async f=>{
    // Every read of workbook A (TA/TA2) stays slow; B and CONTROL are fast.
    f.setDelay(book=>book==='TA'||book==='TA2'?400:0);
    const env={...f.env,SNAPSHOT_VERIFY_MAX_AGE_SECONDS:'0',SNAPSHOT_LOAD_WAIT_MS:'20'};
    const early=await f.check({name_1:'Kios Epsilon',address:'Jl Cempaka 9 Kota Bogor'},env);
    assert.equal(early.status,503);               // A is loading slowly
    f.switchTo('B');                               // CONTROL moves while A loads
    let got;
    for(let i=0;i<50;i++){
      got=await f.check({name_1:'Kios Epsilon',address:'Jl Cempaka 9 Kota Bogor'},
        {...env,SNAPSHOT_LOAD_WAIT_MS:'5000'});
      if(got.status===200)break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(got.body.stats.snapshot_sync_id,b.sync,'must serve the NEW generation');
    assert.equal(got.body.decision,'FAIL');
    await new Promise(r=>setTimeout(r,2500));      // let the stale A load finish
    const after=await f.check({name_1:'Kios Epsilon',address:'Jl Cempaka 9 Kota Bogor'},
      {...f.env,SNAPSHOT_VERIFY_MAX_AGE_SECONDS:'600'});
    assert.equal(after.body.stats.snapshot_sync_id,b.sync,'stale A load was not installed');
  },{gens:{b}});
});
