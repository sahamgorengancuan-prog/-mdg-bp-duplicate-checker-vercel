import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handleCheck,handleHealth,normalizeText} from '../_lib/duplicate.js';

const hash=(x)=>createHash('sha256').update(x).digest('hex');
const exact=(name,address)=>hash(normalizeText(name)+'\x1f'+normalizeText(address));
const row=(id,name,address,ktp='')=>{
  const norm=normalizeText(name+' '+address);
  const digest=hash(JSON.stringify([id,name,address,ktp]));
  return {id,name,address,ktp,norm,digest,
    bucket:String(Math.floor(norm.length/5)).padStart(3,'0'),
    tokens:new Set(norm.split(' ').filter(x=>x.length>=2)).size};
};
let fixtureNum=0;
function makeFixture(records){
  const sync='keyed-dual-fixture-'+(++fixtureNum);
  const source=[...records].sort((a,b)=>a.id.localeCompare(b.id));
  const bp=[['bp_id','bp_type_id','name_1','address','norm_text','norm_digits','text_len','row_hash']];
  for(const r of source) bp.push([r.id,'ZB02',r.name,r.address,r.norm,'',
    String(r.norm.length),r.digest]);
  const at=new Map(source.map((r,i)=>[r.id,i+2]));
  const fuzzy=source.map(r=>[r.bucket+':'+r.tokens,
      JSON.stringify([r.norm,at.get(r.id),r.id])])
    .sort((a,b)=>a[0].localeCompare(b[0])||
      JSON.parse(a[1])[2].localeCompare(JSON.parse(b[1])[2]));
  const groups=[],index=[['len_token_key','posting_json'],...fuzzy];
  for(let i=0;i<fuzzy.length;i++){
    const r=fuzzy[i],key=r[0],last=groups.at(-1);
    if(last&&last[0]===key){last[2]=String(i+2);last[3]=String(Number(last[3])+1);}
    else groups.push([key,String(i+2),String(i+2),'1',sync]);
  }
  const e=source.map(r=>[exact(r.name,r.address),JSON.stringify([at.get(r.id),r.id])])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  const k=source.filter(r=>r.ktp).map(r=>[r.ktp,JSON.stringify([at.get(r.id),r.id])])
    .sort((a,b)=>a[0].slice(-2).localeCompare(b[0].slice(-2))||a[0].localeCompare(b[0]));
  const shards=(rows,key)=>{
    const out=[];
    for(let i=0;i<rows.length;i++){
      const value=key(rows[i]),last=out.at(-1);
      if(last&&last[0]===value){last[2]=String(i+2);last[3]=String(Number(last[3])+1);}
      else out.push([value,String(i+2),String(i+2),'1',sync]);
    }
    return out;
  };
  const metadata={
    sync_id:sync,sync_state:'READY',keyed_index_version:'14',
    exact_index_version:'1',token_index_version:'1',
    total_bp_rows:String(source.length),
    total_exact_index_rows:String(e.length),
    total_ktp_index_rows:String(k.length),
    token_index_groups:String(groups.length),source_digest:hash(sync)
  };
  const meta=[['key','value'],...Object.entries(metadata)];
  return {sync,metadata,data:new Map([
    ['META',meta],['BP_DATABASE',bp],['INDEX_LEN_TOKEN',index],
    ['INDEX_LEN',[['len_token_key','row_start','row_end','count','sync_id'],...groups]],
    ['EXACT_INDEX',[['exact_hash','posting_json'],...e]],
    ['KTP_INDEX',[['ktp_digits','posting_json'],...k]],
    ['INDEX_EXACT_SHARD',[['exact_shard','row_start','row_end','count','sync_id'],
      ...shards(e,r=>r[0].slice(0,2))]],
    ['INDEX_KTP_SHARD',[['ktp_shard','row_start','row_end','count','sync_id'],
      ...shards(k,r=>r[0].slice(-2).padStart(2,'0'))]]
  ])};
}
async function withSheets(t,fn){
  const before=globalThis.fetch;
  const env={
    GOOGLE_OAUTH_CLIENT_ID:'fixture',GOOGLE_OAUTH_CLIENT_SECRET:'fixture',
    GOOGLE_OAUTH_REFRESH_TOKEN:'fixture-very-long-backend-refresh-token',
    GSHEET_SNAPSHOT_MODE:'dual',SHEET_A_ID:'TEST_A',SHEET_B_ID:'TEST_B',
    SHEET_A2_ID:'TEST_A2',SHEET_B2_ID:'TEST_B2',
    SHEET_CONTROL_ID:'TEST_CONTROL',SHEET_ID:'TEST_LEGACY',
    RATE_LIMIT_PER_MIN:'0',SHEETS_LOCAL_READ_BUDGET_PER_MINUTE:'0',
    RANGE_CACHE_SECONDS:'0'
  };
  const a=makeFixture([row('BP-A','Alpha Shop','Mawar Street 10','1234567890'),
                       row('BP-B','Beta Mart','Rindu Street 8')]);
  const b=makeFixture([row('BP-A','Alpha Changed','Mawar Street 10','1234567890'),
                       row('BP-B','Beta Mart','Rindu Street 8')]);
  let pointer='TEST_A';
  let changedOnFinal=false;
  let controlReads=0;
  const readRequests=[];
  globalThis.fetch=async input=>{
    const uri=String(input);
    if(uri.includes('oauth2.googleapis.com/token'))return new Response(
      JSON.stringify({access_token:'fixture',expires_in:3600}),{status:200});
    const m=/spreadsheets\/([^/]+)\/values\/([^?]+)/.exec(uri);
    assert(m,'Unexpected URL '+uri);
    const book=decodeURIComponent(m[1]),range=decodeURIComponent(m[2]);
    readRequests.push({book,range});
    const [tab,where]=range.split('!');
    const a1=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(where);
    assert(a1,'Unexpected range '+range);
    const col=x=>[...x].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
    let sheet;
    if(book==='TEST_CONTROL') {
      controlReads++;
      if(changedOnFinal&&controlReads>=2)pointer='TEST_B';
      const active=pointer==='TEST_A'?a:b;
      sheet=[['key','value'],['active_sheet_id',pointer],
        ['active_index_sheet_id',pointer==='TEST_A'?'TEST_A2':'TEST_B2'],
        ['sync_id',active.sync],
        ['total_bp_rows',active.metadata.total_bp_rows],
        ['source_digest',active.metadata.source_digest],['sync_state','READY']];
    } else {
      sheet=(book==='TEST_A'||book==='TEST_A2'?a.data:b.data).get(tab);
      if(book==='TEST_A'||book==='TEST_B')
        assert(tab==='BP_DATABASE'||tab==='META','Indexes belong to paired A2/B2');
      if(book==='TEST_A2'||book==='TEST_B2')
        assert(tab!=='BP_DATABASE','Primary BP cannot be read from paired index book');
      assert(sheet, 'Unexpected tab '+book+'/'+tab);
    }
    const rows=sheet.slice(Number(a1[2])-1,Number(a1[4]))
      .map(r=>r.slice(col(a1[1]),col(a1[3])+1));
    return new Response(JSON.stringify({values:rows}),{status:200});
  };
  async function check(payload){
    const request=new Request('https://fixture.invalid/api/check',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(payload)});
    const response=await handleCheck({request,env});
    return {status:response.status,body:await response.json()};
  }
  try{
    await fn({a,b,env,check,readRequests,
      switchToB:()=>{pointer='TEST_B';},
      changeDuringCheck:()=>{changedOnFinal=true;controlReads=0;}});
  }finally {globalThis.fetch=before;}
}
test('dual mode: exact KTP/name lookup and fuzzy matching stay in active snapshot',async t=>{
  await withSheets(t,async f=>{
    const health=await handleHealth({env:f.env});
    assert.equal(health.status,200);
    const identity=await f.check({name_1:'Alpha Shop',address:'Mawar Street 10',ktp_number:'1234567890'});
    assert.equal(identity.status,200,JSON.stringify(identity.body));
    assert.equal(identity.body.decision,'FAIL');
    assert.equal(identity.body.exact_ktp_match.bp_id,'BP-A');
    const approx=await f.check({name_1:'Alpha Shoppe',address:'Mawar Street 10'});
    assert.equal(approx.status,200,JSON.stringify(approx.body));
    assert.equal(approx.body.decision,'FAIL');
    assert.equal(approx.body.similarity_match.bp_id,'BP-A');
    assert(f.readRequests.some(x=>x.book==='TEST_A2'&&x.range.startsWith('INDEX_LEN_TOKEN!')));
    assert(!f.readRequests.some(x=>x.book==='TEST_B'||x.book==='TEST_B2'));
  });
});
test('dual mode: standby is ignored until control pointer published',async t=>{
  await withSheets(t,async f=>{
    const before=await f.check({name_1:'Alpha Shop',address:'Mawar Street 10'});
    assert.equal(before.body.decision,'FAIL');
    assert.equal(before.body.exact_name_address_match.bp_id,'BP-A');
    f.switchToB();
    const after=await f.check({name_1:'Alpha Changed',address:'Mawar Street 10'});
    assert.equal(after.body.decision,'FAIL');
    assert.equal(after.body.exact_name_address_match.bp_id,'BP-A');
  });
});
test('dual mode: control switch during check cannot issue a stale PASS',async t=>{
  await withSheets(t,async f=>{
    f.changeDuringCheck();
    const result=await f.check({name_1:'Unrelated Stranger',address:'Distant Highway 987'});
    assert.equal(result.status,503);
    assert.equal(result.body.decision,undefined);
    assert.match(result.body.error,/generation changed/);
  });
});

test('dual mode: corrupt keyed posting refuses a false FAIL or PASS',async t=>{
  await withSheets(t,async f=>{
    // Corrupt every packed BP ID without modifying source BP.
    for(const posting of f.a.data.get('INDEX_LEN_TOKEN').slice(1)){
      const payload=JSON.parse(posting[1]);payload[2]='WRONG_BP_ID';
      posting[1]=JSON.stringify(payload);
    }
    const result=await f.check({name_1:'Alpha Shoppe',address:'Mawar Street 10'});
    assert.equal(result.status,503);
    assert.equal(result.body.decision,undefined);
    assert.match(result.body.error,/Keyed pointer|integrity/);
  });
});

test('dual mode: invalid primary/index CONTROL pair cannot pass',async t=>{
  await withSheets(t,async f=>{
    // Explicitly remove the currently authorized A2 sheet ID.
    const env={...f.env,SHEET_A2_ID:'TEST_B2'};
    const request=new Request('https://fixture.invalid/api/check',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({name_1:'No Matching BP',address:'Unknown Road 11'})});
    const response=await handleCheck({request,env});
    assert.equal(response.status,503);
  });
});
