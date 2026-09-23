// Private, transactional BP search. Enabled ONLY with PRIVATE_INDEX_MODE=required.
// This code never reads Google Sheets, exposes DSNs or embeds BP data in static files.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ENGINE_VERSION, normalizeText, normalizeDigits, tokens, numericTokens,
  exactNameAddressHash, computeSimilarity, sanitizeBpRow, maskKtp,
  scoreBoundCanMatch, getMaxLenDiff, getSimilarityWeights,
  getSimilarityDirectRejectThreshold
} from './duplicate.js';

let pooled = null;
const now = () => Date.now();
const err = (status, message) => Object.assign(new Error(message), {status});
const cap = (n, max, fallback) => Number.isSafeInteger(Number(n)) && Number(n)>0
  ? Math.min(max,Number(n)) : fallback;
const digest = x => createHash('sha256').update(x).digest('hex');
function secret(env, name) {
  const value=String(env[name]||'');
  if(value.length<32) throw err(503, name+' is not configured securely.');
  return value;
}
function ktpHash(digits,env) {
  return createHmac('sha256',secret(env,'PRIVATE_INDEX_KTP_HMAC_KEY'))
    .update(digits).digest('hex');
}
async function poolFor(env) {
  const url=String(env.PRIVATE_INDEX_DATABASE_URL||'');
  if(!/^postgres(?:ql)?:\/\//.test(url)) throw err(503,'Private index database is not configured.');
  const target=new URL(url);
  const mode=target.searchParams.get('sslmode');
  if(mode && mode!=='verify-full')
    throw err(503,'Private database URL must use sslmode=verify-full or omit sslmode.');
  // pg-connection-string may override the explicit TLS options when a URL
  // contains sslmode. Remove it after verification and use strict TLS below.
  target.searchParams.delete('sslmode');
  secret(env,'PRIVATE_INDEX_KTP_HMAC_KEY');
  secret(env,'PRIVATE_INDEX_CURSOR_SECRET');
  if(pooled && pooled.url===url) return pooled.pool;
  if(pooled) { await pooled.pool.end(); pooled=null; }
  const { Pool } = await import('pg');
  const pool=new Pool({
    connectionString:target.toString(),max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
    ssl: {rejectUnauthorized:true,...(env.PRIVATE_INDEX_DB_CA_PEM?{ca:env.PRIVATE_INDEX_DB_CA_PEM}:{})}
  });
  pooled={url,pool};
  return pool;
}
async function withSnapshot(env,work) {
  const pool=await poolFor(env);
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const x=await client.query('SELECT sync_id,sync_state,total_bp_rows,last_sync_at FROM bp_search_meta WHERE id=1');
    const m=x.rows[0];
    if(!m || m.sync_state!=='READY' || Number(m.total_bp_rows)<1)
      throw err(503,'Private index has no committed READY snapshot. Run the authorized Windows sync.');
    const meta={
      sync_id:m.sync_id,sync_state:'READY',total_bp_rows:Number(m.total_bp_rows),
      last_sync_at:m.last_sync_at,token_index_version:'1',exact_index_version:'1',
      total_exact_index_rows:Number(m.total_bp_rows)
    };
    const value=await work(client,meta);
    await client.query('COMMIT');
    return value;
  } catch(e) {
    try{await client.query('ROLLBACK');}catch(_){}
    if(e.status)throw e;
    throw err(503,'Private index query failed; no PASS issued. Check private database health.');
  } finally {client.release();}
}
export async function privateIndexHealth(env) {
  return withSnapshot(env,async(client,meta)=>{
    const x=await client.query('SELECT coalesce(sum(count),0)::bigint AS total FROM bp_search_group');
    if(Number(x.rows[0].total)!==meta.total_bp_rows)
      throw err(503,'Private index groups are incomplete; no PASS issued.');
    return meta;
  });
}
function fingerprint(q) {
  return digest(JSON.stringify(q));
}
function sign(state,env) {
  const raw=Buffer.from(JSON.stringify(state)).toString('base64url');
  const signature=createHmac('sha256',secret(env,'PRIVATE_INDEX_CURSOR_SECRET'))
    .update(raw).digest('base64url');
  return raw+'.'+signature;
}
function verify(cursor,env,meta,fp,plan) {
  if(typeof cursor!=='string'||cursor.length>12000)throw err(400,'Invalid continuation.');
  const pieces=cursor.split('.');
  if(pieces.length!==2)throw err(400,'Invalid continuation.');
  const expected=createHmac('sha256',secret(env,'PRIVATE_INDEX_CURSOR_SECRET'))
    .update(pieces[0]).digest();
  const actual=Buffer.from(pieces[1],'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
    throw err(400,'Invalid continuation signature.');
  let state;
  try{state=JSON.parse(Buffer.from(pieces[0],'base64url').toString('utf8'));}
  catch(_){throw err(400,'Invalid continuation payload.');}
  if(state.version!==1||state.engine!==ENGINE_VERSION||state.sync!==meta.sync_id||
    state.fingerprint!==fp||state.plan!==plan.signature||
    !Number.isSafeInteger(state.created)||now()-state.created>3600000||
    state.created>now()+30000) throw err(409,'Input, index snapshot, or session changed. Run a new check.');
  const g=plan.groups[state.pos];
  if(!g||!Number.isSafeInteger(state.scanned)||state.scanned<0||
    !Number.isSafeInteger(state.compared)||state.compared<0||
    state.compared>state.scanned||typeof state.after!=='string')
    throw err(400,'Invalid continuation position.');
  return state;
}
function planGroups(rows,textLen,queryTokenCount,weights,threshold,direct,env) {
  const diff=getMaxLenDiff(env,textLen);
  let pruned=0;
  const groups=rows.filter(row=>{
    const group={bucket:row.len_bucket,token_count:Number(row.token_count),
      count:Number(row.count)};
    if(Number(group.bucket)*5>textLen+diff||
      Number(group.bucket)*5+4<textLen-diff)return false;
    if(scoreBoundCanMatch(group,textLen,queryTokenCount,threshold,direct,weights)) return true;
    pruned+=group.count;return false;
  }).map(x=>({bucket:x.len_bucket,token:Number(x.token_count),count:Number(x.count)}));
  groups.sort((a,b)=>a.count-b.count||
    Math.abs(Number(a.bucket)*5-textLen)-Math.abs(Number(b.bucket)*5-textLen)||
    a.bucket.localeCompare(b.bucket)||a.token-b.token);
  const candidateSpace=groups.reduce((a,b)=>a+b.count,0);
  const signature=digest(JSON.stringify([diff,threshold,direct,weights,groups]));
  return {groups,candidateSpace,pruned,diff,signature};
}
const preview = r=>sanitizeBpRow(r,100,{reason:'Precomputed Exact Index'});
const publicRow = (r,score,extra={}) => sanitizeBpRow(r,score,extra);
export async function checkPrivateIndex(payload,env) {
  return withSnapshot(env,async(client,meta)=>{
    const name1=String(payload?.name_1||payload?.name1||'').trim();
    const address=String(payload?.address||'').trim();
    const ktp=normalizeDigits(payload?.ktp_number||payload?.ktp||'');
    const qtext=normalizeText(name1+' '+address);
    if(!name1&&!address&&!ktp)throw err(400,'Provide Name 1, Address, or KTP Number.');
    const threshold=Number(env.SIMILARITY_THRESHOLD||92);
    const direct=getSimilarityDirectRejectThreshold(env);
    const weights=getSimilarityWeights(env);
    const input={name1:normalizeText(name1),address:normalizeText(address),ktp,threshold,direct,weights};
    const fp=fingerprint(input);
    if(payload?.full_scope_cursor && qtext.length<3)throw err(400,'Full Scope requires name/address.');
    const exact=(name1&&address)?(await client.query(
      'SELECT bp_id,bp_type_id,name_1,address,norm_text,text_len FROM bp_search WHERE active AND exact_hash=$1 ORDER BY source_key LIMIT 5',
      [exactNameAddressHash(name1,address)]
    )).rows:[];
    const exactCount=(name1&&address)?Number((await client.query(
      'SELECT count(*)::bigint AS n FROM bp_search WHERE active AND exact_hash=$1',
      [exactNameAddressHash(name1,address)]
    )).rows[0].n):0;
    const ktpMatch=ktp?(await client.query(
      'SELECT bp_id,bp_type_id,name_1,address,norm_text,text_len FROM bp_search WHERE active AND ktp_hash=$1 ORDER BY source_key LIMIT 1',
      [ktpHash(ktp,env)]
    )).rows[0]:null;
    // Exact and KTP are independent: display identity conflict, never silently hide it.
    if(!payload?.full_scope_cursor && (exactCount||ktpMatch)){
      const conflict=Boolean(ktpMatch&&exactCount&&Number((await client.query(
        'SELECT count(*)::bigint AS n FROM bp_search WHERE active AND exact_hash=$1 AND bp_id<>$2',
        [exactNameAddressHash(name1,address),ktpMatch.bp_id]
      )).rows[0].n)>0);
      return {ok:true,decision:'FAIL',reason:conflict?'IDENTITY CONFLICT: KTP and exact Name+Address identify different BP IDs.':'Precomputed exact duplicate found.',
        identity_conflict:conflict,exact_ktp_match:ktpMatch?preview(ktpMatch):null,
        exact_name_address_match:exact[0]?preview(exact[0]):null,
        exact_match_count:exactCount,similarity_match:null,top_candidates:exact.slice(1).map(preview),
        full_scope_available:false,full_scope_cursor:null,meta,threshold,direct_reject_threshold:direct,
        stats:{coverage_complete:true,scanned_candidates:0,compared_candidates:0,search_scope:'PRIVATE_PRECOMPUTED_INDEX'}};
    }
    if(qtext.length<3){
      return {ok:true,decision:ktp?'PASS':'INCONCLUSIVE',
        reason:ktp?'No exact KTP duplicate; insufficient name/address for fuzzy matching.':'Provide more Name 1 or Address information.',
        meta,threshold,direct_reject_threshold:direct,full_scope_available:false,full_scope_cursor:null,
        stats:{coverage_complete:Boolean(ktp),scanned_candidates:0,search_scope:'PRIVATE_PRECOMPUTED_INDEX'}};
    }
    const groupRows=(await client.query('SELECT len_bucket,token_count,count FROM bp_search_group')).rows;
    const plan=planGroups(groupRows,qtext.length,tokens(qtext).size,weights,threshold,direct,env);
    let state={version:1,engine:ENGINE_VERSION,sync:meta.sync_id,fingerprint:fp,
      plan:plan.signature,pos:0,after:'',scanned:0,compared:0,created:now()};
    if(payload?.full_scope_cursor)state=verify(payload.full_scope_cursor,env,meta,fp,plan);
    const started=now();
    const perRequest=payload?.full_scope_cursor?3000:6000;
    const features={tokens:tokens(qtext),numeric:numericTokens(qtext)};
    let consumed=0,found=null;
    while(state.pos<plan.groups.length&&consumed<perRequest&&now()-started<20000&&!found){
      const group=plan.groups[state.pos];
      const limit=Math.min(250,perRequest-consumed);
      const query=await client.query(
        'SELECT source_key,bp_id,bp_type_id,name_1,address,norm_text,text_len FROM bp_search WHERE active AND len_bucket=$1 AND token_count=$2 AND source_key>$3 ORDER BY source_key LIMIT $4',
        [group.bucket,group.token,state.after,limit]
      );
      if(!query.rows.length){
        state.pos++;state.after='';continue;
      }
      for(const row of query.rows) {
        state.after=row.source_key;state.scanned++;consumed++;
        if(!row.norm_text||Math.abs(row.text_len-qtext.length)>plan.diff)continue;
        state.compared++;
        const score=computeSimilarity(qtext,row.norm_text,weights,direct,features);
        if(score.direct_reject||score.combined>=threshold){
          found=publicRow(row,score.direct_reject?score.trigger_score:score.combined,{
            levenshtein:score.levenshtein,jaccard:score.jaccard,
            numeric_weighted:score.numeric,combined_weighted:score.combined,
            decision_rule:score.direct_reject?'DIRECT_REJECT':'WEIGHTED',
            direct_reject_metric:score.direct_reject_metric});
          break;
        }
      }
      if(!found&&query.rows.length<limit){state.pos++;state.after='';}
    }
    const complete=!found&&state.pos>=plan.groups.length;
    const stats={scanned_candidates:state.scanned,compared_candidates:state.compared,
      candidate_space:plan.candidateSpace,safely_pruned_candidates:plan.pruned,
      search_scope:'PRIVATE_PRECOMPUTED_INDEX',
      coverage_complete:complete,
      pass_basis:complete?'ALL_RELEVANT_ROWS_SCORED_OR_SAFELY_PRUNED':null,
      elapsed_ms:now()-started,group_count:plan.groups.length};
    if(found)return {ok:true,decision:'FAIL',reason:'Private-index fuzzy duplicate verified.',
      meta,threshold,direct_reject_threshold:direct,similarity_match:found,stats,
      full_scope_available:false,full_scope_cursor:null};
    if(complete)return {ok:true,decision:'PASS',
      reason:'No match within configured length scope. All relevant private-index groups scored or safely excluded.',
      meta,threshold,direct_reject_threshold:direct,stats,full_scope_available:false,full_scope_cursor:null};
    return {ok:true,decision:'INCONCLUSIVE',reason:'Bounded search paused; continue without rescanning prior keys. NOT PASS.',
      meta,threshold,direct_reject_threshold:direct,stats,
      full_scope_active:Boolean(payload?.full_scope_cursor),full_scope_available:true,
      full_scope_cursor:sign(state,env)};
  });
}
