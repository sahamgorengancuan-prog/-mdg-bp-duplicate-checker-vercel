// In-memory full-scan duplicate engine (v15).
//
// The Windows sync writes every BP of a generation into ONE compact tab,
// PACKED_SNAPSHOT (gzip + base64 TSV, ~400 cells) in the paired A2/B2 index
// workbook. This engine loads that tab ONCE per committed sync_id, verifies
// it against CONTROL + both META markers + SHA-256, and then answers every
// check from RAM: no MAX_CANDIDATES, no per-check Google Sheets reads, no
// INCONCLUSIVE because of scan budgets.
//
// Decisions are identical to the Sheets engines: the final verdict for any
// candidate is always computeSimilarity() from duplicate.js. Candidates are
// only skipped when a proven UPPER BOUND shows no rule can reach FAIL:
//   - Levenshtein: bag distance <= edit distance (multiset lower bound), then
//     an exact banded Levenshtein for the direct-reject distance.
//   - soft Jaccard: matched pairs <= candidate tokens that are "near" (same
//     rule as tokenPairSimilarity >= 75) to at least one query token.
//   - Numeric weighted <= 100.
import {createHash} from 'node:crypto';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {
  ENGINE_VERSION,getGoogleAccessToken,readDualControl,readDualSnapshot,
  normalizeText,normalizeDigits,tokens,numericTokens,exactNameAddressHash,
  computeSimilarity,sanitizeBpRow,getMaxLenDiff,getSimilarityWeights,
  getSimilarityDirectRejectThreshold,maskKtp
} from './duplicate.js';

const gunzipAsync=promisify(gunzip);
const PACKED_TAB='PACKED_SNAPSHOT';
const PACKED_HEADER='bp_id\tbp_type_id\tname_1\taddress\tktp_digits';
const PACKED_VERSION='1';
const PART_READ_ROWS=60;          // ~2.4 MB per Google Sheets range
const MAX_PART_CHARS=50000;       // Google Sheets hard cell limit
const BUILD_YIELD_EVERY=4000;     // keep the event loop responsive while indexing
const EPS=0.01;                   // round2() can raise a score by <= 0.005
const NEAR_TOKEN_SIM=75;          // jaccardSimilarity() fuzzy pair threshold
const NEAR_CACHE_LIMIT=20000;
const KEYED_READ_ROWS=20000;      // v14 tab fallback: ~2.6 MB per range

const fail=(status,message,extra={})=>Object.assign(new Error(message),{status},extra);
const sha256=buf=>createHash('sha256').update(buf).digest('hex');
const key52=hex=>parseInt(hex.slice(0,13),16);
const ktpKey=digits=>key52(createHash('sha1').update(digits).digest('hex'));
const normKey=text=>key52(createHash('sha1').update(text).digest('hex'));
const yieldLoop=()=>new Promise(resolve=>setImmediate(resolve));
const envNumber=(env,name,fallback,min=0)=>{
  const value=Number(env?.[name]);
  return Number.isFinite(value)&&value>=min?value:fallback;
};

// a-z -> 0..25, 0-9 -> 26..35, space -> 36 (normalizeText output alphabet).
const ALPHABET=37;
const CODE=new Int8Array(128).fill(-1);
for(let c=97;c<=122;c++)CODE[c]=c-97;
for(let c=48;c<=57;c++)CODE[c]=c-48+26;
CODE[32]=36;
const BIGRAM_BUCKETS=256;
const bigramBucket=(a,b)=>Math.imul(a*131+b,2654435761)>>>24;

class GrowU32 {
  constructor(size=1<<16){this.a=new Uint32Array(size);this.n=0;}
  push(v){
    if(this.n===this.a.length){const b=new Uint32Array(this.a.length*2);b.set(this.a);this.a=b;}
    this.a[this.n++]=v;
  }
  done(){return this.a.slice(0,this.n);}
}

// Exact Levenshtein distance if <= k, else k+1 (Ukkonen band). Byte arrays.
function bandedDistance(a,a0,la,b,b0,lb,k,prev,curr){
  const big=k+1;
  if(Math.abs(la-lb)>k)return big;
  if(la===0)return lb<=k?lb:big;
  if(lb===0)return la<=k?la:big;
  for(let j=0;j<=lb;j++)prev[j]=j<=k?j:big;
  for(let i=1;i<=la;i++){
    const lo=i-k>1?i-k:1,hi=i+k<lb?i+k:lb;
    curr[lo-1]=lo===1?(i<=k?i:big):big;
    let rowMin=curr[lo-1];
    const ca=a[a0+i-1];
    for(let j=lo;j<=hi;j++){
      let v=prev[j-1]+(ca===b[b0+j-1]?0:1);
      const del=prev[j]+1;if(del<v)v=del;
      const ins=curr[j-1]+1;if(ins<v)v=ins;
      if(v>big)v=big;
      curr[j]=v;if(v<rowMin)rowMin=v;
    }
    if(hi<lb)curr[hi+1]=big;
    if(rowMin>k)return big;
    const t=prev;prev=curr;curr=t;
  }
  return prev[lb]<=k?prev[lb]:big;
}

// Same as bandedDistance for short JS strings (dictionary tokens).
function bandedStringDistance(a,b,k,prev,curr){
  const la=a.length,lb=b.length,big=k+1;
  if(Math.abs(la-lb)>k)return big;
  for(let j=0;j<=lb;j++)prev[j]=j<=k?j:big;
  for(let i=1;i<=la;i++){
    const lo=i-k>1?i-k:1,hi=i+k<lb?i+k:lb;
    curr[lo-1]=lo===1?(i<=k?i:big):big;
    let rowMin=curr[lo-1];
    const ca=a.charCodeAt(i-1);
    for(let j=lo;j<=hi;j++){
      let v=prev[j-1]+(ca===b.charCodeAt(j-1)?0:1);
      const del=prev[j]+1;if(del<v)v=del;
      const ins=curr[j-1]+1;if(ins<v)v=ins;
      if(v>big)v=big;
      curr[j]=v;if(v<rowMin)rowMin=v;
    }
    if(hi<lb)curr[hi+1]=big;
    if(rowMin>k)return big;
    const t=prev;prev=curr;curr=t;
  }
  return prev[lb]<=k?prev[lb]:big;
}

function sortedLookup(keys,idx,key){
  let lo=0,hi=keys.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(keys[mid]<key)lo=mid+1;else hi=mid;}
  const out=[];
  for(let p=lo;p<keys.length&&keys[p]===key;p++)out.push(idx[p]);
  return out;
}
function sortByKey(keys,count){
  const idx=new Uint32Array(count);
  for(let i=0;i<count;i++)idx[i]=i;
  idx.sort((a,b)=>keys[a]-keys[b]||a-b);
  const sorted=new Float64Array(count);
  for(let i=0;i<count;i++)sorted[i]=keys[idx[i]];
  return {keys:sorted,idx};
}

export class SnapshotIndex {
  normText(i){return this.norm.toString('latin1',this.normStart[i],this.normStart[i+1]);}
  packedRecord(i){
    const f=this.raw.toString('utf8',this.lineStart[i],this.lineEnd[i]).split('\t');
    return {bp_id:f[0],bp_type_id:f[1],name_1:f[2],address:f[3],ktp:f[4],
      norm_text:this.normText(i)};
  }
  // Packed snapshots hold every source field. v14-tab snapshots hold only the
  // normalized text, so the few rows a FAIL needs are read from BP_DATABASE in
  // one batch and verified exactly like the v14 engine (key, hash, text).
  async records(indices,fetchRows){
    if(this.kind==='packed')return indices.map(i=>this.packedRecord(i));
    if(!indices.length)return [];
    const rows=await fetchRows(indices.map(i=>this.bpRows[i]));
    return indices.map((i,n)=>{
      const row=rows[n]||[];
      const rec={bp_id:String(row[0]??''),bp_type_id:String(row[1]??''),
        name_1:String(row[2]??''),address:String(row[3]??''),
        norm_text:this.normText(i),row_hash:String(row[7]??'')};
      if(rec.bp_id!==this.bpIds[i]||!/^[a-f0-9]{64}$/.test(rec.row_hash)||
         normalizeText(rec.name_1+' '+rec.address)!==rec.norm_text)
        throw fail(503,'Keyed pointer does not match source BP key/hash/text. No PASS.');
      return rec;
    });
  }
  async findKtp(ktp,fetchRows){
    if(!ktp)return [];
    const found=sortedLookup(this.ktpKeys,this.ktpIdx,ktpKey(ktp));
    if(this.kind==='packed')
      return found.map(i=>this.packedRecord(i)).filter(r=>r.ktp===ktp);
    const recs=await this.records(found,fetchRows);
    for(const r of recs){
      if(r.row_hash!==sha256(JSON.stringify([r.bp_id,r.bp_type_id,r.name_1,r.address,ktp])))
        throw fail(503,'KTP posting not bound to authoritative BP row/hash. NO PASS.');
    }
    return recs;
  }
  async findExact(name,address,fetchRows){
    const hash=exactNameAddressHash(name,address);
    if(this.kind==='packed'){
      return sortedLookup(this.exactKeys,this.exactIdx,key52(hash))
        .map(i=>this.packedRecord(i))
        .filter(r=>exactNameAddressHash(r.name_1,r.address)===hash);
    }
    // An exact Name 1 + Address match always has the identical normalized
    // text (normalize(name+' '+address) is the join of both normalized
    // fields), so candidates are the records sharing that text.
    const qnorm=normalizeText(name+' '+address);
    const found=sortedLookup(this.normKeys,this.normIdx,normKey(qnorm))
      .filter(i=>this.normText(i)===qnorm);
    const recs=await this.records(found,fetchRows);
    return recs.filter(r=>exactNameAddressHash(r.name_1,r.address)===hash);
  }

  nearTokenIds(token){
    const cached=this.nearCache.get(token);
    if(cached)return cached;
    const out=[];
    const same=this.dictIndex.get(token);
    if(same!==undefined)out.push(same);
    const m=token.length;
    if(m>=4){
      const lo=Math.max(4,Math.floor(m*0.75)-1);
      const hi=Math.min(this.dictByLen.length-1,Math.ceil(m/0.75)+1);
      for(let n=lo;n<=hi;n++){
        const ids=this.dictByLen[n];
        if(!ids)continue;
        const L=Math.max(m,n),k=Math.floor(L*(100-NEAR_TOKEN_SIM)/100+1e-9);
        if(Math.abs(m-n)>k)continue;
        for(let p=0;p<ids.length;p++){
          const id=ids[p];
          if(id===same)continue;
          const d=bandedStringDistance(token,this.dict[id],k,this.rowA,this.rowB);
          // Slightly inclusive on purpose: extra "near" tokens only loosen the bound.
          if(d<=k&&(1-d/L)*100>=NEAR_TOKEN_SIM-1e-6)out.push(id);
        }
      }
    }
    const ids=Uint32Array.from(out);
    if(this.nearCache.size>=NEAR_CACHE_LIMIT)
      this.nearCache.delete(this.nearCache.keys().next().value);
    this.nearCache.set(token,ids);
    return ids;
  }

  // Full scan of every BP inside the configured length-tolerance rule.
  scan(qtext,{weights,direct,threshold,maxLenDiff,deadline}){
    const ql=qtext.length;
    const q=Buffer.from(qtext,'latin1');
    const qTokens=tokens(qtext),nA=qTokens.size;
    const features={tokens:qTokens,numeric:numericTokens(qtext)};
    const qHist=new Int32Array(ALPHABET);
    for(let p=0;p<ql;p++){const c=CODE[q[p]];if(c>=0&&qHist[c]<255)qHist[c]++;}
    const boundable=[weights.levenshtein,weights.jaccard,weights.numeric]
      .every(w=>Number.isFinite(w)&&w>=0);
    const flags=this.nearFlags,touched=[];
    for(const t of qTokens){
      for(const id of this.nearTokenIds(t))
        if(!flags[id]){flags[id]=1;touched.push(id);}
    }
    const qBig=new Int32Array(BIGRAM_BUCKETS),cBig=new Int32Array(BIGRAM_BUCKETS);
    for(let p=1;p<ql;p++)qBig[bigramBucket(q[p-1],q[p])]++;
    const lo=Math.max(1,ql-maxLenDiff),hi=Math.min(this.maxLen,ql+maxLenDiff);
    const stats={eligible:0,prunedByBound:0,bandedChecked:0,exactScored:0,matches:0};
    const top=[];
    let scanned=0;
    try{
      for(let len=lo;len<=hi;len++){
        for(let p=this.lenStart[len],end=this.lenStart[len+1];p<end;p++){
          const i=this.order[p];
          stats.eligible++;
          if((++scanned&4095)===0&&Date.now()>deadline)
            throw fail(503,'In-memory scan exceeded its compute budget; NO PASS issued. Retry.');
          // Soft-Jaccard upper bound from near-token membership.
          const t0=this.tokStart[i],t1=this.tokStart[i+1],nB=t1-t0;
          let near=0;
          for(let t=t0;t<t1;t++)near+=flags[this.tokIds[t]];
          const m=near<nA?near:nA;
          const uJac=nA===0&&nB===0?100:nA===0||nB===0?0:100*m/(nA+nB-m);
          const jacPossible=uJac>=direct-EPS;
          let uLev=100,levPossible=true,weightedPossible=true;
          if(!jacPossible){
            // Bag distance is a lower bound of the edit distance.
            // Counts are capped at 255 on both sides, which can only shrink it.
            const s=this.normStart[i],e=this.normStart[i+1],L=Math.max(ql,e-s);
            let pos=0,neg=0;
            for(let c=0,h=i*ALPHABET;c<ALPHABET;c++,h++){
              const d=qHist[c]-this.hist[h];if(d>0)pos+=d;else neg-=d;
            }
            uLev=100*(1-(pos>neg?pos:neg)/L);
            levPossible=uLev>=direct-EPS;
            weightedPossible=!boundable||
              weights.levenshtein*Math.min(uLev,direct)+
              weights.jaccard*Math.min(uJac,direct)+weights.numeric*100>=threshold-EPS;
            if(!levPossible&&!weightedPossible){stats.prunedByBound++;continue;}
            if(!weightedPossible){
              // Only the Levenshtein direct-reject rule can still fire.
              const k=Math.floor(L*(1-(direct-EPS)/100)+1e-9);
              // One edit changes at most 4 bigrams, so ed >= L1(bigram profile)/4.
              // Hash buckets merge bigrams, which can only lower L1 (still a bound).
              cBig.fill(0);
              for(let x=s+1;x<e;x++)cBig[bigramBucket(this.norm[x-1],this.norm[x])]++;
              let l1=0;
              for(let b=0;b<BIGRAM_BUCKETS;b++){const d=qBig[b]-cBig[b];l1+=d>0?d:-d;}
              if(l1>4*k){stats.prunedByBound++;continue;}
              stats.bandedChecked++;
              if(bandedDistance(q,0,ql,this.norm,s,e-s,k,this.bandA,this.bandB)>k){
                stats.prunedByBound++;continue;
              }
            }else if(boundable&&weights.jaccard*Math.min(uJac,direct)+
                     weights.numeric*100<threshold-EPS){
              // Weighted rule reachable (non-default thresholds): use the EXACT
              // Levenshtein before paying for soft Jaccard / numeric matching.
              stats.bandedChecked++;
              const d=bandedDistance(q,0,ql,this.norm,s,e-s,L,this.bandA,this.bandB);
              const lev=d===0?100:Math.max(0,(1-d/L)*100);
              if(lev<direct-EPS&&weights.levenshtein*lev+
                 weights.jaccard*Math.min(uJac,direct)+weights.numeric*100<threshold-EPS){
                stats.prunedByBound++;continue;
              }
            }
          }
          stats.exactScored++;
          const sim=computeSimilarity(qtext,this.normText(i),weights,direct,features);
          if(!(sim.direct_reject||sim.combined>=threshold))continue;
          stats.matches++;
          const score=sim.direct_reject?sim.trigger_score:sim.combined;
          const last=top[top.length-1];
          if(top.length<5||score>last.score||(score===last.score&&i<last.i)){
            top.push({i,sim,score});
            top.sort((a,b)=>b.score-a.score||a.i-b.i);
            if(top.length>5)top.pop();
          }
        }
      }
    }finally{
      for(const id of touched)flags[id]=0;
    }
    stats.excludedByLength=this.count-stats.eligible;
    return {top,stats};
  }
}

// Incremental index shared by both snapshot sources.
class IndexBuilder {
  constructor(estimatedChars,{exactByNorm=false}={}){
    this.normStart=new GrowU32();this.tokStart=new GrowU32();this.tokIds=new GrowU32(1<<20);
    this.norm=Buffer.allocUnsafe(Math.max(1024,estimatedChars));
    this.normLen=0;this.maxLen=0;this.count=0;
    this.dictIndex=new Map();this.dict=[];
    this.hist=new Uint8Array(ALPHABET*65536);
    this.lengths=[];this.keys=[];this.ktpKeys=[];this.ktpOwners=[];
    this.exactByNorm=exactByNorm;
  }
  // text: normalizeText() output. exactKey: 52-bit exact Name+Address hash key
  // (packed) or null to key records by their normalized text (v14 tabs).
  add(text,exactKey=null){
    const i=this.count;
    if(this.normLen+text.length>this.norm.length){
      const grown=Buffer.allocUnsafe(Math.max(this.norm.length*2,this.normLen+text.length));
      this.norm.copy(grown,0,0,this.normLen);this.norm=grown;
    }
    this.normStart.push(this.normLen);
    this.normLen+=this.norm.write(text,this.normLen,'latin1');
    this.lengths.push(text.length);
    if(text.length>this.maxLen)this.maxLen=text.length;
    if((i+1)*ALPHABET>this.hist.length){
      const grown=new Uint8Array(this.hist.length*2);grown.set(this.hist);this.hist=grown;
    }
    for(let x=0,h=i*ALPHABET;x<text.length;x++){
      const c=CODE[text.charCodeAt(x)];
      if(c>=0&&this.hist[h+c]<255)this.hist[h+c]++;
    }
    // Same token rule as tokens(): unique space-separated words of length >= 2.
    const tokIds=this.tokIds,first=tokIds.n;
    this.tokStart.push(first);
    for(const t of text.split(' ')){
      if(t.length<2)continue;
      let id=this.dictIndex.get(t);
      if(id===undefined){id=this.dict.length;this.dict.push(t);this.dictIndex.set(t,id);}
      let seen=false;
      for(let x=first;x<tokIds.n;x++)if(tokIds.a[x]===id){seen=true;break;}
      if(!seen)tokIds.push(id);
    }
    this.keys.push(this.exactByNorm?normKey(text):exactKey);
    this.count++;
    return i;
  }
  addKtp(ktp,owner){this.ktpKeys.push(ktpKey(ktp));this.ktpOwners.push(owner);}
  async finish(snap){
    const count=this.count,maxLen=this.maxLen,dict=this.dict;
    this.normStart.push(this.normLen);this.tokStart.push(this.tokIds.n);
    snap.count=count;
    snap.norm=Buffer.from(this.norm.subarray(0,this.normLen));this.norm=null;  // exact size
    snap.normStart=this.normStart.done();
    snap.tokStart=this.tokStart.done();snap.tokIds=this.tokIds.done();
    snap.hist=this.hist.slice(0,count*ALPHABET);this.hist=null;
    snap.dict=dict;snap.dictIndex=this.dictIndex;
    const byLen=[];
    for(let id=0;id<dict.length;id++)(byLen[dict[id].length]??=[]).push(id);
    snap.dictByLen=Array.from(byLen,ids=>ids?Uint32Array.from(ids):null);
    snap.nearFlags=new Uint8Array(dict.length);
    snap.nearCache=new Map();
    // Records grouped by normalized length (counting sort) for the tolerance window.
    snap.maxLen=maxLen;
    const lenStart=new Uint32Array(maxLen+2);
    for(const n of this.lengths)lenStart[n+1]++;
    for(let n=1;n<lenStart.length;n++)lenStart[n]+=lenStart[n-1];
    const fill=lenStart.slice(),order=new Uint32Array(count);
    for(let i=0;i<count;i++)order[fill[this.lengths[i]]++]=i;
    snap.order=order;snap.lenStart=lenStart;
    await yieldLoop();
    const keyed=sortByKey(Float64Array.from(this.keys),count);
    if(this.exactByNorm){snap.normKeys=keyed.keys;snap.normIdx=keyed.idx;}
    else{snap.exactKeys=keyed.keys;snap.exactIdx=keyed.idx;}
    const kKeys=Float64Array.from(this.ktpKeys),kSort=sortByKey(kKeys,kKeys.length);
    const owners=this.ktpOwners;
    snap.ktpKeys=kSort.keys;
    snap.ktpIdx=Uint32Array.from(kSort.idx,p=>owners[p]);
    snap.ktpCount=kKeys.length;
    snap.bandA=new Int32Array(maxLen+2);snap.bandB=new Int32Array(maxLen+2);
    const longestToken=dict.reduce((n,t)=>t.length>n?t.length:n,0);
    snap.rowA=new Int32Array(longestToken+2);snap.rowB=new Int32Array(longestToken+2);
    return snap;
  }
}

// Parse + index the decompressed PACKED_SNAPSHOT TSV.
export async function buildSnapshotIndex(raw,{expectedRecords=null}={}){
  if(!Buffer.isBuffer(raw))raw=Buffer.from(raw);
  let pos=raw.indexOf(10);
  const header=raw.toString('utf8',0,pos<0?raw.length:pos).replace(/\r$/,'');
  if(header!==PACKED_HEADER)throw fail(503,'PACKED_SNAPSHOT header/schema mismatch. No PASS.');
  const builder=new IndexBuilder(Math.floor(raw.length*0.8));
  const lineStart=new GrowU32(),lineEnd=new GrowU32();
  while(pos>=0&&pos<raw.length){
    const start=pos+1;
    let end=raw.indexOf(10,start);
    if(end<0)end=raw.length;
    pos=end<raw.length?end:-1;
    if(end===start)continue;
    const fields=raw.toString('utf8',start,end).split('\t');
    if(fields.length!==5||!fields[0])
      throw fail(503,'PACKED_SNAPSHOT row '+(builder.count+1)+' is malformed. No PASS.');
    const [,,name,address,ktp]=fields;
    // normalizeText() is local per character/word and the joining space breaks
    // every context, so normalize(name+' '+address) equals the join below
    // (fuzz-verified; tests re-check it). Saves one normalization per BP.
    const nName=normalizeText(name),nAddress=normalizeText(address);
    const text=nName&&nAddress?nName+' '+nAddress:nName||nAddress;
    lineStart.push(start);lineEnd.push(end);
    // Identical to exactNameAddressHash(name,address), without re-normalizing.
    const i=builder.add(text,key52(createHash('sha256')
      .update(nName+'\x1f'+nAddress,'utf8').digest('hex')));
    if(ktp){
      if(normalizeDigits(ktp)!==ktp)throw fail(503,'PACKED_SNAPSHOT KTP is not normalized. No PASS.');
      builder.addKtp(ktp,i);
    }
    if(builder.count%BUILD_YIELD_EVERY===0)await yieldLoop();
  }
  if(!builder.count)throw fail(503,'PACKED_SNAPSHOT is empty. No PASS.');
  if(expectedRecords!==null&&builder.count!==expectedRecords)
    throw fail(503,`PACKED_SNAPSHOT has ${builder.count} BP rows, META expects ${expectedRecords}. No PASS.`);
  const snap=new SnapshotIndex();
  snap.kind='packed';snap.raw=raw;
  snap.lineStart=lineStart.done();snap.lineEnd=lineEnd.done();
  return builder.finish(snap);
}

// Build the same index from the v14 tabs every published pair already has:
// INDEX_LEN_TOKEN postings [norm, BP_DATABASE row, BP ID] and KTP_INDEX
// [KTP digits, [row, BP ID]]. Used when PACKED_SNAPSHOT is absent/unusable.
export async function buildKeyedTabsIndex(postingBlocks,ktpBlocks,{bpRows,ktpRows}){
  const builder=new IndexBuilder(bpRows*96,{exactByNorm:true});
  const bpIds=[],rows=new GrowU32(),rowToIdx=new Map();
  for await(const block of postingBlocks){
    for(const row of block){
      if(!Array.isArray(row)||row.length!==2)
        throw fail(503,'Incomplete INDEX_LEN_TOKEN row. No PASS.');
      let posting;
      try{posting=JSON.parse(String(row[1]));}catch{posting=null;}
      const [norm,rowNo,bp]=Array.isArray(posting)?posting:[];
      const [bucket,tokenCount]=String(row[0]).split(':');
      if(typeof norm!=='string'||typeof bp!=='string'||!bp||
         !Number.isSafeInteger(rowNo)||rowNo<2||rowToIdx.has(rowNo)||
         String(Math.floor(norm.length/5)).padStart(3,'0')!==bucket||
         tokens(norm).size!==Number(tokenCount)||/[^a-z0-9 ]/.test(norm))
        throw fail(503,'INDEX_LEN_TOKEN posting integrity mismatch. No PASS.');
      const i=builder.add(norm);
      bpIds.push(bp);rows.push(rowNo);rowToIdx.set(rowNo,i);
      if(builder.count%BUILD_YIELD_EVERY===0)await yieldLoop();
    }
  }
  if(builder.count!==bpRows)
    throw fail(503,`INDEX_LEN_TOKEN has ${builder.count} postings, META expects ${bpRows}. No PASS.`);
  let ktpSeen=0;
  for await(const block of ktpBlocks){
    for(const row of block){
      let posting;
      try{posting=JSON.parse(String(row?.[1]));}catch{posting=null;}
      const [rowNo,bp]=Array.isArray(posting)?posting:[];
      const digits=normalizeDigits(row?.[0]);
      const i=rowToIdx.get(rowNo);
      if(!digits||i===undefined||bpIds[i]!==bp)
        throw fail(503,'KTP_INDEX posting does not match INDEX_LEN_TOKEN. No PASS.');
      builder.addKtp(digits,i);
      ktpSeen++;
    }
  }
  if(ktpSeen!==ktpRows)
    throw fail(503,`KTP_INDEX has ${ktpSeen} rows, META expects ${ktpRows}. No PASS.`);
  const snap=new SnapshotIndex();
  snap.kind='v14_tabs';snap.bpIds=bpIds;snap.bpRows=rows.done();
  return builder.finish(snap);
}

// ---------------------------------------------------------------- loading ---

async function sheetsBatchGet(env,sheetId,ranges,{attempts=5}={}){
  for(let attempt=0;;attempt++){
    const token=await getGoogleAccessToken(env);
    const query=new URLSearchParams({majorDimension:'ROWS'});
    for(const range of ranges)query.append('ranges',range);
    const res=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${
      encodeURIComponent(sheetId)}/values:batchGet?${query}`,
      {headers:{Authorization:`Bearer ${token}`}});
    if((res.status===429||res.status>=500)&&attempt<attempts-1){
      const retry=Number(res.headers.get('retry-after'));
      await new Promise(r=>setTimeout(r,
        (Number.isFinite(retry)&&retry>0?retry:5*2**attempt)*1000));
      continue;
    }
    if(!res.ok)throw fail(res.status===429?429:502,
      `Google Sheets snapshot read failed (HTTP ${res.status}). No PASS.`);
    const body=await res.json();
    if(!Array.isArray(body.valueRanges)||body.valueRanges.length!==ranges.length)
      throw fail(503,'Incomplete Google Sheets batch response. No PASS.');
    return body.valueRanges.map(x=>x.values||[]);
  }
}

export function packedInfo(indexMeta,primaryMeta,control){
  if(indexMeta.packed_snapshot_version!==PACKED_VERSION)return null;
  const parts=Number(indexMeta.packed_parts),records=Number(indexMeta.packed_records);
  const hash=String(indexMeta.packed_sha256||'');
  if(!Number.isSafeInteger(parts)||parts<1||!Number.isSafeInteger(records)||records<1||
     !/^[a-f0-9]{64}$/.test(hash)||primaryMeta.packed_sha256!==hash||
     (control.packed_sha256&&control.packed_sha256!==hash)||
     String(records)!==String(indexMeta.total_bp_rows))
    throw fail(503,'PACKED_SNAPSHOT META differs between CONTROL, primary and index. No PASS.');
  return {parts,records,hash};
}

async function loadPacked(env,control,info){
  const ranges=[];
  for(let a=2;a<=info.parts+1;a+=PART_READ_ROWS)
    ranges.push(`${PACKED_TAB}!A${a}:D${Math.min(info.parts+1,a+PART_READ_ROWS-1)}`);
  const blocks=[];
  // Two ranges per request, three requests at a time: few quota units, bounded payload.
  for(let r=0;r<ranges.length;r+=6){
    const group=ranges.slice(r,r+6),calls=[];
    for(let g=0;g<group.length;g+=2)
      calls.push(sheetsBatchGet(env,control.active_index_sheet_id,group.slice(g,g+2)));
    for(const got of await Promise.all(calls))blocks.push(...got);
  }
  const rows=blocks.flat();
  if(rows.length!==info.parts)throw fail(503,'PACKED_SNAPSHOT part count differs from META. No PASS.');
  // Decode part by part (each part is a multiple of 4 base64 chars except the
  // last) so no second 17 MB joined string is ever built.
  let size=0;
  rows.forEach((row,n)=>{
    if(row.length<4||String(row[0])!==String(n+1)||String(row[1])!==String(info.parts)||
       String(row[2])!==control.sync_id||typeof row[3]!=='string'||!row[3]||
       row[3].length>MAX_PART_CHARS||(n<info.parts-1&&row[3].length%4!==0))
      throw fail(503,'PACKED_SNAPSHOT part '+(n+1)+' is torn or from another generation. No PASS.');
    size+=row[3].length;
  });
  const gz=Buffer.allocUnsafe(Math.ceil(size*3/4));
  let used=0;
  for(const row of rows){used+=gz.write(row[3],used,'base64');row[3]='';}
  const raw=await gunzipAsync(gz.subarray(0,used));
  if(sha256(raw)!==info.hash)throw fail(503,'PACKED_SNAPSHOT SHA-256 mismatch. No PASS.');
  return {raw,index:await buildSnapshotIndex(raw,{expectedRecords:info.records})};
}

// Stream a big two-column tab in ordered blocks (two ranges per request).
async function* tabBlocks(env,sheetId,tab,count){
  const ranges=[];
  for(let a=2;a<=count+1;a+=KEYED_READ_ROWS)
    ranges.push(`${tab}!A${a}:B${Math.min(count+1,a+KEYED_READ_ROWS-1)}`);
  for(let r=0;r<ranges.length;r+=2){
    const got=await sheetsBatchGet(env,sheetId,ranges.slice(r,r+2));
    for(let g=0;g<got.length;g++){
      const [,lo,hi]=/!A(\d+):B(\d+)$/.exec(ranges[r+g]).map(Number);
      if(got[g].length!==hi-lo+1)throw fail(503,`${tab} range ${lo}:${hi} is incomplete. No PASS.`);
      yield got[g];
    }
  }
}

async function loadKeyedTabs(env,control,meta){
  const bpRows=Number(meta.total_bp_rows),ktpRows=Number(meta.total_ktp_index_rows);
  if(!Number.isSafeInteger(bpRows)||bpRows<1||!Number.isSafeInteger(ktpRows)||ktpRows<0)
    throw fail(503,'v14 META row counts are invalid. No PASS.');
  const book=control.active_index_sheet_id;
  const index=await buildKeyedTabsIndex(
    tabBlocks(env,book,'INDEX_LEN_TOKEN',bpRows),
    tabBlocks(env,book,'KTP_INDEX',ktpRows),{bpRows,ktpRows});
  // The tabs carry no per-row sync_id: the pair must still be the committed
  // generation after reading them (a sync only ever rewrites the STANDBY pair).
  const after=await readDualControl(env);
  if(after.sync_id!==control.sync_id||after.active_index_sheet_id!==book)
    throw fail(503,'CONTROL changed while loading the v14 tabs; reloading the new generation.');
  return index;
}

async function loadGeneration(env){
  const t0=Date.now();
  const {control,scopedEnv,meta:primaryMeta,indexMeta:meta}=await readDualSnapshot(env);
  let packedError='';
  try{
    const info=packedInfo(meta,primaryMeta,control);
    if(info){
      const {raw,index}=await loadPacked(env,control,info);
      return {loaded:true,source:'packed',control,meta,scopedEnv,index,
        packedBytes:raw.length,timings:{load_ms:Date.now()-t0}};
    }
    packedError='PACKED_SNAPSHOT_MISSING';
  }catch(error){
    if(error?.status===429)throw error;
    packedError='PACKED_SNAPSHOT_UNAVAILABLE: '+(error?.message||error);
  }
  if(String(env.SNAPSHOT_V14_TABS||'on').toLowerCase()==='off')
    return {loaded:false,reason:packedError,control,meta,scopedEnv};
  console.log(`[memory-engine] ${packedError}; loading v14 tabs of ${control.sync_id} instead`);
  const index=await loadKeyedTabs(env,control,meta);
  return {loaded:true,source:'v14_tabs',packedError,control,meta,scopedEnv,index,
    packedBytes:null,timings:{load_ms:Date.now()-t0}};
}

// ------------------------------------------------------ generation state ---

const state={current:null,loading:null,loadingSync:'',wantedSync:'',lastError:'',epoch:0,
  noPacked:null,failed:null,verifiedAt:0,controlSync:'',poller:null,checking:null};
const LOAD_RETRY_MS=60000;
const failedRecently=syncId=>state.failed?.sync_id===syncId&&
  Date.now()-state.failed.at<LOAD_RETRY_MS;

export function _resetMemoryEngineForTests(){
  if(state.poller)clearInterval(state.poller);
  Object.assign(state,{current:null,loading:null,loadingSync:'',wantedSync:'',lastError:'',
    epoch:state.epoch+1,noPacked:null,failed:null,verifiedAt:0,controlSync:'',
    poller:null,checking:null});
}

function startLoad(env,syncId){
  if(state.loading&&state.loadingSync===syncId)return state.loading;
  // Checks never use a superseded generation, so release it BEFORE building
  // the new one: only one BP snapshot is ever resident (fits 512 MB hosts).
  if(state.current&&state.current.control.sync_id!==syncId)state.current=null;
  state.loadingSync=syncId;
  state.wantedSync=syncId;
  const epoch=state.epoch;
  // A load that finishes after a NEWER generation was requested is discarded:
  // it must never be installed as current or rewind controlSync.
  const superseded=()=>epoch!==state.epoch||state.wantedSync!==syncId;
  const job=loadGeneration(env).then(result=>{
    if(superseded())return {...result,superseded:true};
    if(!result.loaded){
      state.noPacked={sync_id:result.control.sync_id,at:Date.now(),reason:result.reason};
      state.controlSync=result.control.sync_id;
      state.verifiedAt=Date.now();
      return result;
    }
    if(state.current&&state.current.control.sync_id===result.control.sync_id)return result;
    const mem=process.memoryUsage();
    state.current={...result,loadedAt:Date.now(),
      rss_mb:Math.round(mem.rss/1048576),heap_mb:Math.round(mem.heapUsed/1048576)};
    state.noPacked=null;state.failed=null;state.lastError='';
    state.controlSync=result.control.sync_id;
    state.verifiedAt=Date.now();
    console.log(`[memory-engine] loaded ${result.control.sync_id} from ${result.source}: `+
      `${result.index.count} BP in ${result.timings.load_ms}ms, rss ${state.current.rss_mb}MB`);
    return result;
  },error=>{
    if(superseded())throw error;
    state.lastError=error?.message||String(error);
    state.failed={sync_id:syncId,at:Date.now()};
    console.error('[memory-engine] load failed:',state.lastError);
    throw error;
  }).finally(()=>{if(state.loading===job){state.loading=null;state.loadingSync='';}});
  state.loading=job;
  return job;
}

async function verifyControl(env){
  if(!state.checking){
    const epoch=state.epoch;
    state.checking=readDualControl(env).then(control=>{
      if(epoch!==state.epoch)return control;
      state.controlSync=control.sync_id;
      if(state.current?.control.sync_id===control.sync_id||
         state.noPacked?.sync_id===control.sync_id)state.verifiedAt=Date.now();
      return control;
    }).finally(()=>{state.checking=null;});
  }
  return state.checking;
}

// Resolve what a check should use RIGHT NOW:
//   {index,...}        in-memory snapshot of the committed generation
//   {fallback:reason}  no usable in-memory source for the generation -> keyed engine
// Throws 503 with retry_after_seconds while a generation is still loading.
export async function acquireSnapshot(env,{waitMs}={}){
  const wait=waitMs??envNumber(env,'SNAPSHOT_LOAD_WAIT_MS',20000);
  const maxAge=envNumber(env,'SNAPSHOT_VERIFY_MAX_AGE_SECONDS',180)*1000;
  // Strict: SNAPSHOT_VERIFY_MAX_AGE_SECONDS=0 must re-verify CONTROL on every
  // check, even within the same millisecond as the last verification.
  const fresh=maxAge>0&&Date.now()-state.verifiedAt<maxAge;
  if(fresh&&state.current&&state.current.control.sync_id===state.controlSync)return state.current;
  if(fresh&&state.noPacked&&state.noPacked.sync_id===state.controlSync)
    return {fallback:state.noPacked.reason};
  const control=await verifyControl(env);
  if(state.current?.control.sync_id===control.sync_id)return state.current;
  if(state.noPacked?.sync_id===control.sync_id)return {fallback:state.noPacked.reason};
  if(failedRecently(control.sync_id))
    return {fallback:'MEMORY_SNAPSHOT_UNAVAILABLE: '+state.lastError};
  const job=startLoad(env,control.sync_id);
  let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),wait);});
  try{
    const result=await Promise.race([job,timeout]);
    if(result==='timeout'||result.superseded)throw fail(503,
      'Loading the latest BP snapshot into memory. No decision issued yet; retrying shortly.',
      {retry_after_seconds:5,warming:true});
    if(!result.loaded)return {fallback:result.reason};
    return state.current?.control.sync_id===result.control.sync_id?state.current:result;
  }catch(error){
    if(error?.warming)throw error;
    // An unreadable/corrupt generation must never produce PASS from memory:
    // use the keyed Sheets engine, which verifies every read it makes.
    return {fallback:'MEMORY_SNAPSHOT_UNAVAILABLE: '+(error?.message||error)};
  }finally{clearTimeout(timer);}
}

// Render: warm at boot and follow CONTROL in the background so checks never
// wait for Google. Vercel has no background timers; acquireSnapshot covers it.
export function startSnapshotRefresher(env){
  if(state.poller)return;
  const every=envNumber(env,'SNAPSHOT_POLL_SECONDS',60,10)*1000;
  const tick=()=>verifyControl(env).then(control=>{
    if(state.current?.control.sync_id!==control.sync_id&&
       state.noPacked?.sync_id!==control.sync_id&&!failedRecently(control.sync_id))
      return startLoad(env,control.sync_id);
  }).catch(error=>{state.lastError=error?.message||String(error);});
  tick();
  state.poller=setInterval(tick,every);
  state.poller.unref?.();
}

export function memorySnapshotStatus(){
  const c=state.current;
  return {
    loaded:Boolean(c),
    source:c?.source||null,
    packed_error:c?.packedError||null,
    sync_id:c?.control.sync_id||null,
    active_control_sync_id:state.controlSync||null,
    records:c?.index.count??0,
    ktp_records:c?.index.ktpCount??0,
    dictionary_tokens:c?.index.dict.length??0,
    loaded_at:c?new Date(c.loadedAt).toISOString():null,
    verified_age_seconds:state.verifiedAt?Math.round((Date.now()-state.verifiedAt)/1000):null,
    load_ms:c?.timings.load_ms??null,
    packed_bytes:c?.packedBytes??null,rss_mb:c?.rss_mb??null,
    loading:Boolean(state.loading),packed_missing:Boolean(state.noPacked),
    last_error:state.lastError||null
  };
}

// ------------------------------------------------------------------ check ---

export async function memoryCheck(payload,env,snapshot){
  const started=Date.now();
  const snap=snapshot.index,meta=snapshot.meta;
  const name=String(payload?.name_1||payload?.name1||'').trim();
  const address=String(payload?.address||'').trim();
  const ktp=normalizeDigits(payload?.ktp_number||payload?.ktp||'');
  if(!name&&!address&&!ktp)throw fail(400,'Provide Name 1, Address or KTP.');
  const qtext=normalizeText(name+' '+address);
  const threshold=Number(env.SIMILARITY_THRESHOLD||92);
  const direct=getSimilarityDirectRejectThreshold(env);
  const weights=getSimilarityWeights(env);
  // Step timings, returned to the browser log (no BP data in here).
  const trace=[];
  let mark=Date.now();
  const step=(name,extra={})=>{const now=Date.now();trace.push({step:name,ms:now-mark,...extra});mark=now;};
  const base={ok:true,threshold,direct_reject_threshold:direct,meta,
    input:{name_1:name,address,ktp_masked:maskKtp(ktp),normalized_length:qtext.length},
    exact_ktp_match:null,exact_name_address_match:null,exact_match_count:0,
    identity_conflict:false,similarity_match:null,top_candidates:[],
    full_scope_cursor:null,full_scope_available:false,full_scope_active:false,
    search_backend:'MEMORY_FULL_SCAN',memory_source:snapshot.source,trace};
  const stats=extra=>({scanned_candidates:snap.count,compared_candidates:0,
    candidate_space:snap.count,coverage_complete:true,
    search_scope:'MEMORY_FULL_SCAN_V15',snapshot_records:snap.count,
    snapshot_sync_id:snapshot.control.sync_id,...extra,
    elapsed_ms:Date.now()-started});

  // v14-tab snapshots read the matched BP rows (one batch, only on a hit).
  const fetchRows=async rowNumbers=>{
    const out=[];
    for(let i=0;i<rowNumbers.length;i+=50){
      const got=await sheetsBatchGet(env,snapshot.control.active_sheet_id,
        rowNumbers.slice(i,i+50).map(r=>`BP_DATABASE!A${r}:H${r}`),{attempts:2});
      out.push(...got.map(values=>values[0]||[]));
    }
    return out;
  };
  const ktpHits=await snap.findKtp(ktp,fetchRows);
  step('exact_ktp',{attempted:Boolean(ktp),hits:ktpHits.length});
  const exactHits=name&&address?await snap.findExact(name,address,fetchRows):[];
  step('exact_name_address',{attempted:Boolean(name&&address),hits:exactHits.length});
  const exactLookup={attempted:Boolean(name&&address),index_version:'1',
    shard_present:Boolean(name&&address),shard_rows:snap.count,
    matching_index_rows:exactHits.length,verified_matches:exactHits.length};
  if(ktpHits.length||exactHits.length){
    const conflict=Boolean(ktpHits.length&&exactHits.some(x=>x.bp_id!==ktpHits[0].bp_id));
    return {...base,decision:'FAIL',identity_conflict:conflict,
      reason:conflict
        ?'IDENTITY CONFLICT: the KTP and exact Name 1 + Address match different BP IDs. Review both records; do not auto-approve.'
        :ktpHits.length&&exactHits.length?'KTP and Name 1 + Address exact matches found.'
        :ktpHits.length?'KTP exact match found in protected database.'
        :`Exact Name 1 + Address match found (${exactHits.length} BP record(s)).`,
      exact_ktp_match:ktpHits.length?sanitizeBpRow(ktpHits[0],100,{reason:'KTP Exact Match'}):null,
      exact_name_address_match:exactHits.length?
        sanitizeBpRow(exactHits[0],100,{reason:'Exact Name 1 + Address Match'}):null,
      exact_match_count:exactHits.length,exact_lookup:exactLookup,
      top_candidates:[...ktpHits.slice(1),...exactHits.slice(1)].slice(0,5)
        .map(x=>sanitizeBpRow(x,100,{reason:'Exact match'})),
      stats:stats({pass_basis:null})};
  }
  if(qtext.length<3){
    return {...base,decision:ktp?'PASS':'INCONCLUSIVE',exact_lookup:exactLookup,
      reason:ktp?'No matching KTP; insufficient text for a text similarity check.'
        :'Provide more Name 1 / Address information to check text similarity.',
      stats:stats({coverage_complete:Boolean(ktp),
        pass_basis:ktp?'KTP_EXACT_INDEX_COMPLETE':null})};
  }
  const maxLenDiff=getMaxLenDiff(env,qtext.length);
  const budget=envNumber(env,'SNAPSHOT_MAX_CHECK_MS',25000,1000);
  const {top,stats:scan}=snap.scan(qtext,{weights,direct,threshold,maxLenDiff,
    deadline:started+budget});
  step('full_scan',{records:snap.count,within_length:scan.eligible,
    pruned_by_bound:scan.prunedByBound,scored:scan.exactScored,matches:scan.matches});
  const scanStats=stats({compared_candidates:scan.eligible,
    length_tolerance_chars:maxLenDiff,excluded_by_length_rule:scan.excludedByLength,
    safely_pruned_candidates:scan.prunedByBound,banded_levenshtein_checked:scan.bandedChecked,
    exact_scored:scan.exactScored,match_count:scan.matches,score_bound_index_used:true,
    pass_basis:top.length?null:'ALL_BP_RECORDS_EVALUATED_IN_MEMORY'});
  if(top.length){
    const records=await snap.records(top.map(x=>x.i),fetchRows);
    step('match_rows',{rows:records.length,source:snapshot.source});
    const rows=top.map(({sim,score},n)=>sanitizeBpRow(records[n],score,{
      levenshtein:sim.levenshtein,jaccard:sim.jaccard,numeric_weighted:sim.numeric,
      combined_weighted:sim.combined,direct_reject_metric:sim.direct_reject_metric,
      decision_rule:sim.direct_reject?'DIRECT_REJECT':'WEIGHTED',
      weighted_skipped:sim.weighted_skipped,
      reason:sim.direct_reject?`${sim.direct_reject_metric} Direct Reject`
        :'Name 1 + Address Weighted Similarity'}));
    return {...base,decision:'FAIL',exact_lookup:exactLookup,
      reason:`Name 1 + Address similarity match found (score ${rows[0].score}%). `+
        `${scan.matches} BP record(s) matched after a full in-memory scan.`,
      similarity_match:rows[0],top_candidates:rows.slice(1),stats:scanStats};
  }
  return {...base,decision:'PASS',exact_lookup:exactLookup,
    reason:`No duplicate: all ${snap.count.toLocaleString('en-US')} BP records evaluated `+
      `(${scan.eligible.toLocaleString('en-US')} within length tolerance, every one scored or `+
      'excluded by a proven score upper bound). Exact KTP and Name 1 + Address indexes checked.',
    stats:scanStats};
}

export {ENGINE_VERSION};
