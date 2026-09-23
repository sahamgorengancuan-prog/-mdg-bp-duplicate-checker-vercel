// Google Sheets-only keyed snapshot verifier.
// Compact candidate postings carry stable BP ID and row position.
// BP row identity, normalized text and hash format verified on matching candidates.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {
  ENGINE_VERSION,getMeta,getIndexMap,getSheetRange,getSheetRanges,
  normalizeText,normalizeDigits,tokens,numericTokens,
  exactNameAddressHash,computeSimilarity,sanitizeBpRow,
  getMaxLenDiff,getSimilarityWeights,getSimilarityDirectRejectThreshold,
  scoreBoundCanMatch
} from './duplicate.js';

const fail=(status,message)=>Object.assign(new Error(message),{status});
// A single signed continuation previously scanned only 3,000 BPs while
// consuming fresh CONTROL + 2 META reads on every request. For 280k candidates
// that caused ~94 HTTP continuations before quota pauses. Pack up to twelve
// thousand A2/B2 postings into one bounded Google values.batchGet request;
// no extra Google read per indexed group. Keep a 20s server work ceiling.
const MAX_NORMAL=12000,MAX_FULL=12000,MAX_BATCH=1500,MAX_RANGES=8,
  MAX_WORK_MS=20000;
const sha=x=>createHash('sha256').update(x).digest('hex');
const int=x=>Number.isSafeInteger(Number(x))&&Number(x)>=0?Number(x):NaN;

function ready(m){
  const bp=int(m.total_bp_rows),exact=int(m.total_exact_index_rows);
  if(m.sync_state!=='READY'||m.keyed_index_version!=='14'||
     m.exact_index_version!=='1'||!m.sync_id||bp<1||exact!==bp)
    throw fail(503,'Keyed Google Sheets v14 paired snapshot is not READY or index counts differ. No PASS.');
  return m;
}
function hashKey(env){
  const secret=String(env.GOOGLE_OAUTH_REFRESH_TOKEN||'');
  if(secret.length<16)throw fail(503,'Configured server OAuth required for signed resume.');
  return createHmac('sha256',secret).update('bp-keyed-gsheet-v14/cursor').digest();
}
function sign(state,env){
  const body=Buffer.from(JSON.stringify(state)).toString('base64url');
  const sig=createHmac('sha256',hashKey(env)).update(body).digest('base64url');
  return body+'.'+sig;
}
function restore(token,env,meta,queryHash,plan){
  if(typeof token!=='string'||token.length>9000)throw fail(400,'Invalid keyed cursor.');
  const pair=token.split('.');
  if(pair.length!==2)throw fail(400,'Invalid keyed cursor.');
  const expected=createHmac('sha256',hashKey(env)).update(pair[0]).digest();
  const got=Buffer.from(pair[1],'base64url');
  if(got.length!==expected.length||!timingSafeEqual(expected,got))
    throw fail(400,'Invalid keyed cursor signature.');
  let state;
  try{state=JSON.parse(Buffer.from(pair[0],'base64url').toString('utf8'));}
  catch(_){throw fail(400,'Invalid keyed cursor payload.');}
  if(state.v!==14||state.engine!==ENGINE_VERSION||state.sync!==meta.sync_id||
     state.queryHash!==queryHash||state.plan!==plan.signature||
     !Number.isSafeInteger(state.issuedAt)||state.issuedAt>Date.now()+30000||
     Date.now()-state.issuedAt>7200000)
    throw fail(409,'Search or Google Sheets generation changed; repeat Normal Check.');
  if(!Number.isSafeInteger(state.pos)||state.pos<0||
     state.pos>=plan.ordered.length||
     !Number.isSafeInteger(state.scanned)||state.scanned<0||
     !Number.isSafeInteger(state.compared)||state.compared<0||
     state.compared>state.scanned)
    throw fail(400,'Invalid resume position.');
  const info=plan.map.get(plan.ordered[state.pos]);
  const preceding=plan.ordered.slice(0,state.pos).reduce((n,k)=>n+plan.map.get(k).count,0);
  if(!Number.isSafeInteger(state.next)||state.next<info.row_start||
     state.next>info.row_end||
     state.scanned!==preceding+state.next-info.row_start)
    throw fail(400,'Cursor would skip or repeat BP candidates.');
  return state;
}
function packed(row,size,label){
  if(row.length!==2)throw fail(503,'Incomplete packed '+label+' row. No PASS.');
  let a;
  try{a=JSON.parse(String(row[1]||''));}
  catch{throw fail(503,'Invalid packed '+label+' JSON. No PASS.');}
  if(!Array.isArray(a)||a.length!==size)
    throw fail(503,'Invalid packed '+label+' array. No PASS.');
  return a;
}
function ensureIndexedPosting(row,info) {
  const [norm,position,bp]=packed(row,3,'fuzzy');
  const rowNo=Number(position);
  if(String(row[0])!==info.bucket+':'+info.token_count||
     typeof norm!=='string'||Math.floor(norm.length/5)!==Number(info.bucket)||
     tokens(norm).size!==info.token_count||
     !bp||typeof bp!=='string'||!Number.isSafeInteger(rowNo)||rowNo<2)
    throw fail(503,'Keyed packed posting integrity mismatch. No PASS.');
  return {bpRow:rowNo,norm,bp};
}
async function verifiedBp(env,meta,posting) {
  const rows=await getSheetRange(env,
    'BP_DATABASE!A'+posting.bpRow+':H'+posting.bpRow,meta.sync_id);
  const row=rows[0];
  if(!row||String(row[0])!==posting.bp||
     !/^[a-f0-9]{64}$/.test(String(row[7]||''))||
     String(row[4]||'')!==posting.norm||
     Number(row[6])!==posting.norm.length||
     normalizeText(String(row[2]||'')+' '+String(row[3]||''))!==posting.norm)
    throw fail(503,'Keyed pointer does not match source BP key/hash/text. No PASS.');
  return {bp_id:String(row[0]),bp_type_id:String(row[1]||''),
    name_1:String(row[2]||''),address:String(row[3]||''),
    norm_text:String(row[4]||''),text_len:Number(row[6])};
}
async function readExactBp(env,meta,row,expectedHash){
  const [pointer,bp]=packed(row,2,'exact');
  const bpRow=int(pointer);
  if(!Number.isSafeInteger(bpRow)||bpRow<2||typeof bp!=='string'||!bp)
    throw fail(503,'Invalid exact keyed posting. NO PASS.');
  const rows=await getSheetRange(env,'BP_DATABASE!A'+bpRow+':H'+bpRow,meta.sync_id);
  const source=rows[0];
  if(!source||String(source[0])!==bp||
     !/^[a-f0-9]{64}$/.test(String(source[7]||''))||
     exactNameAddressHash(source[2],source[3])!==expectedHash||
     normalizeText(String(source[2]||'')+' '+String(source[3]||''))!==String(source[4]||''))
    throw fail(503,'Exact keyed pointer/hash mismatch. NO PASS.');
  return {bp_id:String(source[0]),bp_type_id:String(source[1]||''),
    name_1:String(source[2]||''),address:String(source[3]||''),
    norm_text:String(source[4]||''),text_len:Number(source[6])};
}
async function findExact(name,address,env,meta){
  const empty={matches:[],count:0,bpIds:[],diagnostics:{
    attempted:Boolean(name&&address),index_version:'1',shard_present:false,
    shard_rows:0,matching_index_rows:0,verified_matches:0}};
  if(!name||!address)return empty;
  const hash=exactNameAddressHash(name,address);
  const map=await getIndexMap(env,'INDEX_EXACT_SHARD','exact',meta);
  const shard=map.get(hash.slice(0,2));
  if(!shard)return empty;
  const rows=await getSheetRange(env,
    'EXACT_INDEX!A'+shard.row_start+':B'+shard.row_end,meta.sync_id);
  if(rows.length!==shard.count)throw fail(503,'Exact shard range incomplete.');
  const pointer=[];
  for(const row of rows){
    if(String(row[0]||'').slice(0,2)!==hash.slice(0,2))
      throw fail(503,'Exact shard sorting inconsistent.');
    if(String(row[0])===hash)pointer.push(row);
  }
  const matches=[],ids=new Set();
  for(const row of pointer){
    const [,bp]=packed(row,2,'exact');
    if(typeof bp!=='string'||!bp)throw fail(503,'Invalid packed exact BP ID.');
    ids.add(bp);
    if(matches.length<5&&!matches.some(m=>m.bp_id===bp))
      matches.push(await readExactBp(env,meta,row,hash));
  }
  return {matches,count:pointer.length,bpIds:[...ids],diagnostics:{
    attempted:true,index_version:'1',shard_present:true,shard_rows:rows.length,
    matching_index_rows:pointer.length,verified_matches:matches.length}};
}
async function findKtp(ktp,env,meta){
  if(!ktp)return null;
  const shards=await getIndexMap(env,'INDEX_KTP_SHARD','ktp',meta);
  const shard=shards.get(ktp.slice(-2).padStart(2,'0'));
  if(!shard)return null;
  const rows=await getSheetRange(env,
    'KTP_INDEX!A'+shard.row_start+':B'+shard.row_end,meta.sync_id);
  if(rows.length!==shard.count)throw fail(503,'KTP shard incomplete.');
  for(const row of rows){
    if(String(row[0]||'').slice(-2).padStart(2,'0')!==
       ktp.slice(-2).padStart(2,'0'))
      throw fail(503,'KTP shard sorting invalid.');
    if(normalizeDigits(row[0])===ktp){
      const [pointer,bp]=packed(row,2,'KTP');
      const bpRow=int(pointer);
      if(!Number.isSafeInteger(bpRow)||bpRow<2||typeof bp!=='string'||!bp)
        throw fail(503,'Invalid KTP keyed posting.');
      const result=await getSheetRange(env,
        'BP_DATABASE!A'+bpRow+':H'+bpRow,meta.sync_id);
      const source=result[0];
      const expectedRowHash=sha(JSON.stringify([
        String(source?.[0]||''),String(source?.[1]||''),
        String(source?.[2]||''),String(source?.[3]||''),ktp]));
      if(!source||String(source[0])!==bp||
         String(source[7]||'')!==expectedRowHash||
         normalizeText(String(source[2]||'')+' '+String(source[3]||''))!==String(source[4]||''))
        throw fail(503,'KTP posting not bound to authoritative BP row/hash. NO PASS.');
      return {bp_id:bp,bp_type_id:String(source[1]||''),
        name_1:String(source[2]||''),address:String(source[3]||''),
        norm_text:String(source[4]||''),text_len:Number(source[6])};
    }
  }
  return null;
}
async function keyedGroups(env,meta) {
  const rows=await getSheetRange(env,'INDEX_LEN!A2:E10000',meta.sync_id);
  const map=new Map();
  let rowStart=2,total=0;
  for(const row of rows) {
    const key=String(row[0]||'');
    if(!key) continue;
    const lo=Number(row[1]),hi=Number(row[2]),n=Number(row[3]);
    if(map.has(key)||!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi)||
       !Number.isSafeInteger(n)||n<1||lo!==rowStart||hi-lo+1!==n||
       String(row[4]||'')!==meta.sync_id)
      throw fail(503,'Keyed fuzzy index is not contiguous/consistent. No PASS.');
    map.set(key,{row_start:lo,row_end:hi,count:n});
    total+=n;rowStart=hi+1;
  }
  if(total!==int(meta.total_bp_rows)||
     map.size!==int(meta.token_index_groups))
    throw fail(503,'Keyed fuzzy index coverage is incomplete. No PASS.');
  return map;
}
async function makePlan(env,meta,qtext,threshold,direct,weights){
  const map=await keyedGroups(env,meta);
  if(map.size!==int(meta.token_index_groups))
    throw fail(503,'Keyed fuzzy group count differs from META.');
  const queryTokens=tokens(qtext).size;
  const diff=getMaxLenDiff(env,qtext.length);
  let pruned=0,eligible=0;
  const active=new Map();
  for(const [key,base] of map){
    const parts=key.split(':');
    if(parts.length!==2||!/^\d+$/.test(parts[0])||
       !/^\d+$/.test(parts[1]))
      throw fail(503,'Unexpected keyed group name.');
    const bucket=parts[0],token_count=Number(parts[1]);
    if(bucket!==String(bucket).padStart(3,'0')||
       !Number.isSafeInteger(token_count)||token_count<0)
      throw fail(503,'Unexpected group format.');
    const lo=Number(bucket)*5,hi=lo+4;
    if(lo>qtext.length+diff||hi<qtext.length-diff)continue;
    eligible+=base.count;
    const group={...base,bucket,token_count};
    if(scoreBoundCanMatch(group,qtext.length,queryTokens,threshold,direct,weights))
      active.set(key,group);
    else pruned+=base.count;
  }
  const ordered=[...active.keys()].sort((a,b)=>
    active.get(a).count-active.get(b).count||
    Math.abs(Number(active.get(a).bucket)*5-qtext.length)-
    Math.abs(Number(active.get(b).bucket)*5-qtext.length)||a.localeCompare(b));
  const candidateSpace=ordered.reduce((n,k)=>n+active.get(k).count,0);
  return {map:active,ordered,candidateSpace,pruned,diff,
    signature:sha(JSON.stringify([meta.sync_id,threshold,direct,weights,
      diff,ordered.map(k=>[k,active.get(k).row_start,active.get(k).count])])),
    eligible};
}
export async function keyedHealth(env,meta=null){
  const m=ready(meta||await getMeta(env));
  const groups=await keyedGroups(env,m);
  if(groups.size!==int(m.token_index_groups))
    throw fail(503,'Keyed fuzzy group count is incomplete.');
  await getIndexMap(env,'INDEX_EXACT_SHARD','exact',m);
  await getIndexMap(env,'INDEX_KTP_SHARD','ktp',m);
  return m;
}
export async function keyedCheck(payload,env,providedMeta=null){
  const started=Date.now();
  const m=ready(providedMeta||await getMeta(env));
  const name=String(payload?.name_1||payload?.name1||'').trim();
  const address=String(payload?.address||'').trim();
  const ktp=normalizeDigits(payload?.ktp_number||payload?.ktp||'');
  if(!name&&!address&&!ktp)throw fail(400,'Provide Name 1, Address or KTP.');
  const qtext=normalizeText(name+' '+address);
  const threshold=Number(env.SIMILARITY_THRESHOLD||92);
  const direct=getSimilarityDirectRejectThreshold(env);
  const weights=getSimilarityWeights(env);
  const fp=sha(JSON.stringify([normalizeText(name),normalizeText(address),
    ktp,threshold,direct,weights]));
  let exact={matches:[],count:0,bpIds:[],diagnostics:{
    attempted:false,index_version:'1',shard_present:null,
    shard_rows:0,matching_index_rows:0,verified_matches:0}};
  let exactKtp=null;
  if(!payload?.full_scope_cursor){
    exactKtp=await findKtp(ktp,env,m);
    exact=await findExact(name,address,env,m);
    if(exactKtp||exact.count){
      const conflict=Boolean(exactKtp&&exact.bpIds.some(x=>x!==exactKtp.bp_id));
      const fin=ready(await getMeta(env));
      if(fin.sync_id!==m.sync_id)throw fail(503,'Snapshot changed during exact search.');
      return {ok:true,decision:'FAIL',reason:conflict
        ?'IDENTITY CONFLICT: KTP and exact name/address identify different BP IDs.'
        :'Precomputed exact duplicate found.',
        threshold,direct_reject_threshold:direct,meta:m,identity_conflict:conflict,
        exact_ktp_match:exactKtp?sanitizeBpRow(exactKtp,100,{reason:'KTP Exact Match'}):null,
        exact_name_address_match:exact.matches[0]?
          sanitizeBpRow(exact.matches[0],100,{reason:'Exact Name 1 + Address'}):null,
        exact_match_count:exact.count,exact_lookup:exact.diagnostics,
        top_candidates:exact.matches.slice(1).map(x=>sanitizeBpRow(x,100)),
        full_scope_available:false,full_scope_cursor:null,
        stats:{coverage_complete:true,scanned_candidates:0,
          search_scope:'KEYED_GOOGLE_SHEETS_V14',elapsed_ms:Date.now()-started}};
    }
    if(qtext.length<3){
      return {ok:true,decision:ktp?'PASS':'INCONCLUSIVE',
        reason:ktp?'No exact KTP match; insufficient text to check fuzzy.':
          'Provide more name/address for fuzzy search.',
        threshold,direct_reject_threshold:direct,meta:m,
        exact_lookup:exact.diagnostics,full_scope_cursor:null,
        full_scope_available:false,top_candidates:[],
        stats:{coverage_complete:Boolean(ktp),scanned_candidates:0,
          search_scope:'KEYED_GOOGLE_SHEETS_V14',elapsed_ms:Date.now()-started}};
    }
  }
  if(qtext.length<3)throw fail(400,'Full Scope needs sufficient text.');
  const plan=await makePlan(env,m,qtext,threshold,direct,weights);
  const state=payload?.full_scope_cursor
    ?restore(payload.full_scope_cursor,env,m,fp,plan)
    :{v:14,engine:ENGINE_VERSION,sync:m.sync_id,queryHash:fp,
       plan:plan.signature,pos:0,next:plan.ordered.length
         ?plan.map.get(plan.ordered[0]).row_start:0,
       scanned:0,compared:0,issuedAt:Date.now()};
  const allowed=payload?.full_scope_cursor?MAX_FULL:MAX_NORMAL;
  const features={tokens:tokens(qtext),numeric:numericTokens(qtext)};
  let processed=0,matched=null,scored=null;
  // Instead of one Google read per bucket, batch up to eight bounded,
  // non-overlapping ranges in ONE values.batchGet quota request.
  // Each range belongs to exactly one planned eligible group; skipped groups
  // are never silently counted, and the signed cursor advances only after
  // a COMPLETE verified response. A 429 preserves the current cursor.
  while(state.pos<plan.ordered.length&&processed<allowed&&
        Date.now()-started<MAX_WORK_MS&&!matched){
    const slices=[];
    let p=state.pos,n=state.next,remaining=allowed-processed;
    while(p<plan.ordered.length&&remaining>0&&slices.length<MAX_RANGES){
      const g=plan.map.get(plan.ordered[p]);
      const end=Math.min(g.row_end,n+MAX_BATCH-1,n+remaining-1);
      slices.push({pos:p,begin:n,end,group:g,
        range:'INDEX_LEN_TOKEN!A'+n+':B'+end});
      remaining-=end-n+1;
      if(end===g.row_end){
        p++;
        if(p<plan.ordered.length)n=plan.map.get(plan.ordered[p]).row_start;
      }else n=end+1;
    }
    let blocks;
    try{
      blocks=await getSheetRanges(env,slices.map(x=>x.range),m.sync_id);
    }catch(e){
      if(e?.status!==429||processed===0)throw e;
      break;
    }
    if(blocks.length!==slices.length)
      throw fail(503,'Incomplete batch response; NO PASS.');
    for(let i=0;i<slices.length&&!matched;i++){
      const slice=slices[i],rows=blocks[i];
      if(rows.length!==slice.end-slice.begin+1)
        throw fail(503,'Incomplete fuzzy posting range; NO PASS.');
      for(const row of rows){
        const candidate=ensureIndexedPosting(row,slice.group);
        state.scanned++;processed++;
        if(Math.abs(candidate.norm.length-qtext.length)>plan.diff)continue;
        state.compared++;
        const sim=computeSimilarity(qtext,candidate.norm,weights,direct,features);
        if(sim.direct_reject||sim.combined>=threshold){
          matched=candidate;scored=sim;break;
        }
      }
      if(matched)break;
      state.pos=slice.pos;
      state.next=slice.end+1;
      if(state.next>slice.group.row_end){
        state.pos++;
        state.next=state.pos<plan.ordered.length
          ?plan.map.get(plan.ordered[state.pos]).row_start:0;
      }
    }
  }
  const complete=plan.ordered.length===0||
    (state.pos===plan.ordered.length&&state.scanned===plan.candidateSpace);
  const stats={scanned_candidates:state.scanned,
    compared_candidates:state.compared,candidate_space:plan.candidateSpace,
    safely_pruned_candidates:plan.pruned,
    coverage_complete:complete,score_bound_index_used:true,
    search_scope:'KEYED_GOOGLE_SHEETS_V14',
    pass_basis:complete?'ALL_RELEVANT_INDEXED_BP_ROWS_SCORED_OR_SAFELY_PRUNED':null,
    elapsed_ms:Date.now()-started};
  if(matched){
    const record=await verifiedBp(env,m,matched);
    const score=scored.direct_reject?scored.trigger_score:scored.combined;
    const fin=ready(await getMeta(env));
    if(fin.sync_id!==m.sync_id)throw fail(503,'Snapshot changed during fuzzy match.');
    return {ok:true,decision:'FAIL',reason:'Name/address similarity match verified.',
      meta:m,threshold,direct_reject_threshold:direct,
      similarity_match:sanitizeBpRow(record,score,{
        levenshtein:scored.levenshtein,jaccard:scored.jaccard,
        numeric_weighted:scored.numeric,combined_weighted:scored.combined,
        direct_reject_metric:scored.direct_reject_metric,
        decision_rule:scored.direct_reject?'DIRECT_REJECT':'WEIGHTED',
        reason:'Keyed fuzzy index verified'}),
      exact_lookup:exact.diagnostics,top_candidates:[],stats,
      full_scope_cursor:null,full_scope_available:false};
  }
  if(complete){
    const fin=ready(await getMeta(env));
    if(fin.sync_id!==m.sync_id)throw fail(503,'Snapshot changed during check.');
    return {ok:true,decision:'PASS',
      reason:'No duplicate within configured scope: all relevant keyed postings checked or safely pruned.',
      meta:m,threshold,direct_reject_threshold:direct,
      top_candidates:[],exact_lookup:exact.diagnostics,stats,
      full_scope_cursor:null,full_scope_available:false};
  }
  if(state.pos>=plan.ordered.length)throw fail(503,'Incomplete fuzzy coverage; no valid continuation.');
  return {ok:true,decision:'INCONCLUSIVE',
    reason:'Keyed Google Sheets search paused with coverage incomplete; continue same cursor. NOT PASS.',
    meta:m,threshold,direct_reject_threshold:direct,top_candidates:[],
    exact_lookup:exact.diagnostics,stats,
    full_scope_cursor:sign(state,env),full_scope_available:true,
    full_scope_active:Boolean(payload?.full_scope_cursor)};
}
