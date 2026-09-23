// Benchmark the v15 in-memory full-scan engine on synthetic BP data.
//   node tools/bench_memory_engine.mjs [bpCount=400000] [queries=60]
// Uses deterministic synthetic records only (never company data).
import {buildSnapshotIndex} from '../_lib/memory-engine.js';
import {normalizeText,getSimilarityWeights,getSimilarityDirectRejectThreshold,
  getMaxLenDiff} from '../_lib/duplicate.js';
import {makeTsv,perturb,rng,makeRecord} from './synthetic_bp.mjs';

const count=Number(process.argv[2]||400000),queries=Number(process.argv[3]||60);
const {tsv,records}=makeTsv(count);
let started=Date.now();
const snap=await buildSnapshotIndex(tsv);
const buildMs=Date.now()-started;
const env={},weights=getSimilarityWeights(env);
const direct=getSimilarityDirectRejectThreshold(env),threshold=92;
const r=rng(99),times=[];
let fails=0;
for(let q=0;q<queries;q++){
  const input=q%2?perturb(r,records[Math.floor(r()*count)]):makeRecord(r,count+q);
  const qtext=normalizeText(input.name_1+' '+input.address);
  started=Date.now();
  const res=snap.scan(qtext,{weights,direct,threshold,
    maxLenDiff:getMaxLenDiff(env,qtext.length),deadline:Date.now()+60000});
  times.push(Date.now()-started);
  if(res.top.length)fails++;
}
times.sort((a,b)=>a-b);
const at=p=>times[Math.min(times.length-1,Math.floor(p*times.length))];
console.log(JSON.stringify({bp:snap.count,dictionary_tokens:snap.dict.length,
  build_ms:buildMs,queries,fail_decisions:fails,p50_ms:at(0.5),p95_ms:at(0.95),
  max_ms:times.at(-1),rss_mb:Math.round(process.memoryUsage().rss/1048576)},null,2));
