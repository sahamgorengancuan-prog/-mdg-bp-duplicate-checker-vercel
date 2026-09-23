import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/*
  MDG BP Duplicate Checker - shared duplicate-check engine (Vercel Functions, Node.js runtime)
  Ported from the Cloudflare Pages Functions version: same algorithm, same thresholds,
  same defaults, same environment variable names. Only the hosting-platform adapter differs
  (see /api/*.js), because this file only receives a plain { request, env } context object
  and never touches Cloudflare- or Vercel-specific APIs directly.
  Data source remains protected Google Sheet.
  Browser never receives OAuth credential, refresh token, or raw database dump.
*/

export const ENGINE_VERSION = '2026-09-23-gsheet-dual-v12';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_TTL_SAFETY_SECONDS = 90;

const DEFAULT_SHEET_ID = '1ZtNDikRHklwQMYxWQ6hkL1clvdH6g_Xfd3ojr5APDjo';
const DEFAULT_SIMILARITY_THRESHOLD = 92;
const DEFAULT_SIMILARITY_DIRECT_REJECT_THRESHOLD = 80;
const DEFAULT_MAX_CANDIDATES = 60000;
// Bound per-request normal fuzzy work. Incomplete coverage => signed continuation.
const NORMAL_MAX_ROWS_PER_REQUEST = 6000;
const NORMAL_MAX_PROCESSING_MS = 20000;
const NORMAL_MAX_BATCH_ROWS = 1000;
// When the eligible bucket union exceeds the normal cap, cap the exploratory
// work too: report INCONCLUSIVE quickly rather than wasting 60,000 reads.
const DEFAULT_OVERSIZED_SCAN_BUDGET = 6000;
const FULL_SCOPE_MAX_ROWS_PER_REQUEST = 3000;
const FULL_SCOPE_CURSOR_TTL_MS = 60 * 60 * 1000;
const DEFAULT_RANGE_CACHE_SECONDS = 300;
// Quota is shared by the OAuth user across all workers and local sync jobs.
// This per-process ceiling is deliberately BELOW Google's per-user quota.
const SHEETS_LOCAL_READ_BUDGET_PER_MINUTE = 36;
const SHEETS_UPSTREAM_RETRY_SECONDS = 70;
const DEFAULT_MAX_BATCH_ROWS = 10000;
const DEFAULT_RATE_LIMIT_PER_MIN = 60;

// Combined-score weighting for Name 1 + Address similarity. Any ratio works (60/30/10,
// 6/3/1, 0.6/0.3/0.1, ...) because the three values are normalized by their own sum below —
// they do not need to add up to 100.
const DEFAULT_WEIGHT_LEVENSHTEIN = 60;
const DEFAULT_WEIGHT_JACCARD = 30;
const DEFAULT_WEIGHT_NUMERIC = 10;
const DEFAULT_WEIGHT_TOTAL = DEFAULT_WEIGHT_LEVENSHTEIN + DEFAULT_WEIGHT_JACCARD + DEFAULT_WEIGHT_NUMERIC;
// Safety fallback only (e.g. if computeSimilarity is ever called without resolving env first) -
// the real, env-aware value always comes from getSimilarityWeights(env) below.
const DEFAULT_NORMALIZED_WEIGHTS = {
  levenshtein: DEFAULT_WEIGHT_LEVENSHTEIN / DEFAULT_WEIGHT_TOTAL,
  jaccard: DEFAULT_WEIGHT_JACCARD / DEFAULT_WEIGHT_TOTAL,
  numeric: DEFAULT_WEIGHT_NUMERIC / DEFAULT_WEIGHT_TOTAL
};

// How much difference in normalized-text length between the query and a candidate is
// still tolerated before we bail out early. This used to be a flat 5 characters, which
// meant simply dropping or adding ONE ordinary word (e.g. a block/building name, or a
// trailing "Kec ...") pushed a genuine near-duplicate out of consideration entirely.
// Tolerance now scales with the query length (percent-based) with a minimum floor, and
// is configurable since the right trade-off (recall vs. Google Sheets read volume) can
// differ by database size.
const DEFAULT_LENGTH_TOLERANCE_PERCENT = 30;
const DEFAULT_LENGTH_TOLERANCE_MIN_CHARS = 12;

export function getMaxLenDiff(env, textLen) {
  const pct = Number(env.LENGTH_TOLERANCE_PERCENT || DEFAULT_LENGTH_TOLERANCE_PERCENT);
  const minChars = Number(env.LENGTH_TOLERANCE_MIN_CHARS || DEFAULT_LENGTH_TOLERANCE_MIN_CHARS);
  const safePct = Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_LENGTH_TOLERANCE_PERCENT;
  const safeMin = Number.isFinite(minChars) && minChars >= 0 ? minChars : DEFAULT_LENGTH_TOLERANCE_MIN_CHARS;
  return Math.max(safeMin, Math.round(textLen * (safePct / 100)));
}

const memoryCache = new Map();
const inFlightReads = new Map();
const sheetsReadTimes = [];
let sheetsCooldownUntil = 0;
const rateBucket = new Map();
let tokenCache = { token: null, exp: 0 };

function dualIds(env) {
  const a=String(env.SHEET_A_ID||'').trim();
  const b=String(env.SHEET_B_ID||'').trim();
  const c=String(env.SHEET_CONTROL_ID||'').trim();
  const legacy=getSheetId(env);
  if(!a||!b||!c||new Set([a,b,c,legacy]).size!==4)
    throw httpError(503,'Configure separate SHEET_A_ID, SHEET_B_ID and SHEET_CONTROL_ID; each must differ from legacy SHEET_ID.');
  return {a,b,c};
}
async function readDualControl(env) {
  const ids=dualIds(env);
  const rows=await getSheetRange({...env,SHEET_ID:ids.c},'ACTIVE!A1:B20','',true);
  const out={};
  for(const row of rows) if(row[0])out[String(row[0])]=String(row[1]||'');
  if(out.sync_state!=='READY'||!out.sync_id||
      ![ids.a,ids.b].includes(out.active_sheet_id)||
      !/^[a-f0-9]{64}$/.test(out.source_digest||'')||
      !Number.isSafeInteger(Number(out.total_bp_rows))||Number(out.total_bp_rows)<1)
    throw httpError(503,'Dual control ACTIVE pointer is not READY. Keep legacy mode until first staging sync is published.');
  return out;
}
async function readDualSnapshot(env) {
  const control=await readDualControl(env);
  const scopedEnv={...env,SHEET_ID:control.active_sheet_id};
  const meta=await getMeta(scopedEnv);
  if(meta.sync_state!=='READY'||meta.sync_id!==control.sync_id||
      meta.source_digest!==control.source_digest||
      meta.total_bp_rows!==control.total_bp_rows||
      meta.keyed_index_version!=='12')
    throw httpError(503,'Active Google Sheets snapshot META/control mismatch. No PASS.');
  return {control,scopedEnv,meta};
}

export async function handleCheck(context) {
  try {
    await enforceRateLimit(context.request, context.env);
    await enforceOptionalAccessCode(context.request, context.env);
    const payload = await safeJson(context.request);
    const mode = String(context.env.GSHEET_SNAPSHOT_MODE || 'legacy').toLowerCase();
    if (String(context.env.PRIVATE_INDEX_MODE || 'off').toLowerCase()==='required')
      throw httpError(503,'Private PostgreSQL mode is retired. Use Google Sheets dual snapshots.');
    let result;
    if (mode==='dual') {
      const {control,scopedEnv,meta}=await readDualSnapshot(context.env);
      result=await (await import('./keyed-sheets.js')).keyedCheck(payload,scopedEnv,meta);
      const current=await readDualControl(context.env);
      if(current.active_sheet_id!==control.active_sheet_id||
         current.sync_id!==control.sync_id||
         current.source_digest!==control.source_digest)
        throw httpError(503,'Active Google Sheets generation changed during check. No decision issued; retry.');
    } else if(mode==='legacy') {
      result=payload?.full_scope_cursor
        ? await fullScopeCheck(payload,context.env)
        : await duplicateCheck(payload,context.env);
      result.quota=currentSheetsQuotaState(context.env);
    } else throw httpError(503,'GSHEET_SNAPSHOT_MODE must be dual or legacy.');
    return json(result);
  } catch (err) {
    return json({
      ok: false,
      error: err?.message || 'Unexpected error',
      hint: configHint(err?.message),
      ...(err?.status === 429 ? { retry_after_seconds: Math.max(1, Number(err.retry_after_seconds || SHEETS_UPSTREAM_RETRY_SECONDS)) } : {}),
      requestId: crypto.randomUUID()
    }, err?.status || 500);
  }
}

export async function handleHealth(context) {
  const mode=String(context.env.GSHEET_SNAPSHOT_MODE || 'legacy').toLowerCase();
  if (mode==='dual') {
    try {
      const {control,scopedEnv,meta}=await readDualSnapshot(context.env);
      await (await import('./keyed-sheets.js')).keyedHealth(scopedEnv,meta);
      return json({ok:true,engine_version:ENGINE_VERSION,exact_index_ready:true,
        sheet_ok:true,search_backend:'KEYED_GOOGLE_SHEETS_DUAL',
        config:configStatus(context.env),meta:{
          ...meta,active_generation:control.sync_id
        }});
    } catch (error) {
      return json({ok:false,engine_version:ENGINE_VERSION,
        exact_index_ready:false,sheet_ok:false,
        search_backend:'KEYED_GOOGLE_SHEETS_DUAL',
        sheet_error:error?.message||'Snapshot unavailable',
        config:configStatus(context.env)},503);
    }
  }
  if(mode!=='legacy'||String(context.env.PRIVATE_INDEX_MODE||'off').toLowerCase()==='required')
    return json({ok:false,sheet_ok:false,sheet_error:'Unsupported snapshot mode.'},503);
  const cfg = configStatus(context.env);
  let meta = {};
  let sheet_ok = false;
  let sheet_error = '';

  if (cfg.sheet_id_configured && cfg.oauth_configured) {
    try {
      meta = await getMeta(context.env);
      requireReadyExactIndex(meta);
      await getIndexMap(context.env, 'INDEX_LEN', 'len', meta);
      // Verify the precomputed score-bound index before reporting readiness.
      const lenForHealth = await getIndexMap(context.env, 'INDEX_LEN', 'len', meta);
      await getSearchIndexMap(context.env, meta, lenForHealth);
      await getIndexMap(context.env, 'INDEX_EXACT_SHARD', 'exact', meta);
      await getIndexMap(context.env, 'INDEX_KTP_SHARD', 'ktp', meta);
      sheet_ok = true;
    } catch (err) {
      sheet_error = err?.message || String(err);
    }
  }

  return json({
    ok: cfg.sheet_id_configured && cfg.oauth_configured && sheet_ok,
    engine_version: ENGINE_VERSION,
    exact_index_ready: sheet_ok,
    service: 'MDG BP Duplicate Checker API',
    config: cfg,
    sheet_ok,
    sheet_error,
    meta
  }, !(cfg.sheet_id_configured && cfg.oauth_configured) ? 500 : sheet_ok ? 200 : 503);
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify({ engine_version: ENGINE_VERSION, ...data }), {
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-bp-checker-engine': ENGINE_VERSION
    }
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-access-code',
    'access-control-max-age': '86400'
  };
}

export function configStatus(env) {
  return {
    sheet_id_configured: Boolean(getSheetId(env)),
    oauth_configured: Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN),
    auth_mode: 'oauth_user_refresh_token',
    using_default_sheet_id: !Boolean(env.SHEET_ID),
    snapshot_mode: String(env.GSHEET_SNAPSHOT_MODE || 'legacy').toLowerCase(),
    dual_snapshot_configured: Boolean(env.SHEET_A_ID && env.SHEET_B_ID && env.SHEET_CONTROL_ID),
    similarity_threshold: Number(env.SIMILARITY_THRESHOLD || DEFAULT_SIMILARITY_THRESHOLD),
    similarity_direct_reject_threshold: getSimilarityDirectRejectThreshold(env),
    max_candidates: Number(env.MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES),
    normal_max_rows_per_request: NORMAL_MAX_ROWS_PER_REQUEST,
    normal_max_processing_ms: NORMAL_MAX_PROCESSING_MS,
    normal_batch_rows: NORMAL_MAX_BATCH_ROWS,
    oversized_scan_budget: Number(env.OVERSIZED_SCAN_BUDGET || DEFAULT_OVERSIZED_SCAN_BUDGET),
    full_scope_chunk_rows: FULL_SCOPE_MAX_ROWS_PER_REQUEST,
    full_scope_strategy: 'RESUME_ALL_ELIGIBLE_LENGTH_BUCKETS',
    sheets_local_read_budget_per_minute: SHEETS_LOCAL_READ_BUDGET_PER_MINUTE,
    full_scope_pacing: 'ADAPTIVE_QUOTA_HEADROOM',
    score_bound_index: 'INDEX_LEN_TOKEN/v1',
    max_batch_rows: Number(env.MAX_BATCH_ROWS || DEFAULT_MAX_BATCH_ROWS),
    range_cache_seconds: Number(env.RANGE_CACHE_SECONDS || DEFAULT_RANGE_CACHE_SECONDS),
    rate_limit_per_min: Number(env.RATE_LIMIT_PER_MIN || DEFAULT_RATE_LIMIT_PER_MIN),
    access_code_enabled: String(env.REQUIRE_API_ACCESS_CODE || '').toLowerCase() === 'true' && Boolean(env.API_ACCESS_CODE),
    similarity_weights: similarityWeightsForDisplay(env),
    length_tolerance_percent: Number(env.LENGTH_TOLERANCE_PERCENT || DEFAULT_LENGTH_TOLERANCE_PERCENT),
    length_tolerance_min_chars: Number(env.LENGTH_TOLERANCE_MIN_CHARS || DEFAULT_LENGTH_TOLERANCE_MIN_CHARS),
    same_origin_frontend: true
  };
}

// Resolves SIMILARITY_WEIGHT_LEVENSHTEIN / SIMILARITY_WEIGHT_JACCARD / SIMILARITY_WEIGHT_NUMERIC
// from env (default 60/30/10) and normalizes them by their own sum, so any ratio the user sets
// (percentages, plain ratios like 6/3/1, fractions like 0.6/0.3/0.1, ...) works out the same way
// and the combined score always stays on a comparable 0-100 scale.
export function getSimilarityWeights(env) {
  const lev = Number(env.SIMILARITY_WEIGHT_LEVENSHTEIN || DEFAULT_WEIGHT_LEVENSHTEIN);
  const jac = Number(env.SIMILARITY_WEIGHT_JACCARD || DEFAULT_WEIGHT_JACCARD);
  const num = Number(env.SIMILARITY_WEIGHT_NUMERIC || DEFAULT_WEIGHT_NUMERIC);

  const total = lev + jac + num;
  if (!total || !Number.isFinite(total)) {
    // Zero, negative-cancelling, or invalid (NaN from garbage input) - fall back to
    // defaults rather than divide by zero or return NaN/garbage weights.
    return DEFAULT_NORMALIZED_WEIGHTS;
  }
  return { levenshtein: lev / total, jaccard: jac / total, numeric: num / total };
}

function similarityWeightsForDisplay(env) {
  const w = getSimilarityWeights(env);
  return {
    levenshtein_percent: round2(w.levenshtein * 100),
    jaccard_percent: round2(w.jaccard * 100),
    numeric_percent: round2(w.numeric * 100)
  };
}

// A candidate is rejected immediately when either Levenshtein or Jaccard reaches
// this threshold. Numeric similarity and the combined weighted score are only used
// when both direct metrics remain below the threshold.
export function getSimilarityDirectRejectThreshold(env) {
  const raw = String(env?.SIMILARITY_DIRECT_REJECT_THRESHOLD ?? '').trim();
  const value = raw === '' ? DEFAULT_SIMILARITY_DIRECT_REJECT_THRESHOLD : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : DEFAULT_SIMILARITY_DIRECT_REJECT_THRESHOLD;
}

function configHint(message = '') {
  const m = String(message).toLowerCase();
  if (m.includes('oauth') || m.includes('refresh token')) return 'Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN in Vercel Project > Settings > Environment Variables. Authorize with a @wingscorp.com account that has access to the Google Sheet.';
  if (m.includes('sheet_id')) return 'Set SHEET_ID in Vercel Environment Variables if you want to override it (optional — the Wings company Sheet ID is already baked into this file). Redeploy after adding it.';
  if (m.includes('google sheets api')) return 'Check OAuth account permission, company Google Sheet access, tab names, and whether the sync already created BP_DATABASE/KTP_INDEX/INDEX_LEN/INDEX_KTP_SHARD/META.';
  return 'Check Vercel Environment Variables, OAuth consent/refresh token, Google Sheet access, Google Sheet tab/index readiness, or Vercel Deployment Protection.';
}

async function duplicateCheck(payload, env) {
  const started = Date.now();
  const name1 = String(payload?.name_1 || payload?.name1 || '').trim();
  const address = String(payload?.address || '').trim();
  const ktpInput = normalizeDigits(payload?.ktp_number || payload?.ktp || '');
  const queryText = normalizeText(`${name1} ${address}`);
  const textLen = queryText.length;
  if (!name1 && !address && !ktpInput) {
    throw httpError(400, 'Input minimal Name 1, Address, atau KTP Number.');
  }

  const threshold = Number(env.SIMILARITY_THRESHOLD || DEFAULT_SIMILARITY_THRESHOLD);
  const directRejectThreshold = getSimilarityDirectRejectThreshold(env);
  const maxCandidates = Math.max(1, Number(env.MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES));
  const batchRows = Math.max(1, Math.min(NORMAL_MAX_BATCH_ROWS, Number(env.MAX_BATCH_ROWS || DEFAULT_MAX_BATCH_ROWS)));
  const weights = getSimilarityWeights(env);
  const meta = await getMeta(env);
  requireReadyExactIndex(meta);
  const result = {
    ok: true,
    decision: 'INCONCLUSIVE',
    reason: 'The check has not completed.',
    threshold,
    direct_reject_threshold: directRejectThreshold,
    input: { name_1: name1, address, ktp_masked: maskKtp(ktpInput), normalized_length: textLen },
    meta,
    exact_ktp_match: null,
    exact_name_address_match: null,
    exact_match_count: 0,
    identity_conflict: false,
    exact_lookup: { attempted: false, index_version: meta.exact_index_version, shard_present: null, shard_rows: 0, matching_index_rows: 0, verified_matches: 0 },
    similarity_match: null,
    full_scope_cursor: null,
    full_scope_available: false,
    full_scope_active: false,
    top_candidates: [],
    stats: {
      scanned_candidates: 0, compared_candidates: 0, skipped_by_prefilter: 0,
      batches_processed: 0, candidate_space: 0, coverage_complete: false,
      scan_limit_reached: false, elapsed_ms: 0,
      bucket_count: 0, completed_buckets: 0,
      search_scope: meta.token_index_version === '1' ? 'SCORE_BOUND_INDEXED_LENGTH_BUCKETS' : 'CONFIGURED_LENGTH_BUCKETS',
      pass_basis: null
    }
  };

  // Independent authoritative signals: KTP is not allowed to hide an exact
  // name+address match on a DIFFERENT BP. Surface both to human reviewers.
  // Neither exact path consumes MAX_CANDIDATES or invokes fuzzy scanning.
  const ktpMatch = ktpInput ? await findExactKtp(ktpInput, env, meta) : null;
  if (ktpMatch) {
    result.exact_ktp_match = sanitizeBpRow(ktpMatch, 100, { reason: 'KTP Exact Match' });
  }

  let nameAddressExact = { matches: [], count: 0, bpIds: [], diagnostics: result.exact_lookup };
  if (name1 && address) {
    nameAddressExact = await findExactNameAddress(name1, address, env, meta);
    result.exact_lookup = nameAddressExact.diagnostics;
    result.exact_match_count = nameAddressExact.count;
    if (nameAddressExact.matches.length) {
      result.exact_name_address_match = sanitizeBpRow(nameAddressExact.matches[0], 100, {
        reason: 'Exact Name 1 + Address Match'
      });
    }
    result.top_candidates = nameAddressExact.matches.slice(1).map(m =>
      sanitizeBpRow(m, 100, { reason: 'Exact Name 1 + Address Match' }));
  }

  if (ktpMatch || nameAddressExact.count) {
    const ktpBpId = String(ktpMatch?.bp_id || '');
    result.identity_conflict = Boolean(ktpBpId && nameAddressExact.bpIds.some(
      id => String(id) !== ktpBpId));
    result.decision = 'FAIL';
    result.reason = result.identity_conflict
      ? 'IDENTITY CONFLICT: the KTP and exact Name 1 + Address match different BP IDs. Review both records; do not auto-approve.'
      : ktpMatch && nameAddressExact.count
        ? 'KTP and Name 1 + Address exact matches found.'
        : ktpMatch
          ? 'KTP exact match found in protected database.'
          : `Exact Name 1 + Address match found (${nameAddressExact.count} BP record(s)).`;
    result.stats.coverage_complete = true; // Both requested exact paths completed.
    result.stats.elapsed_ms = Date.now() - started;
    return result;
  }

  if (!queryText || queryText.length < 3) {
    result.decision = ktpInput ? 'PASS' : 'INCONCLUSIVE';
    result.reason = ktpInput
      ? 'No matching KTP; insufficient text for a text similarity check.'
      : 'Provide more Name 1 / Address information to check text similarity.';
    result.stats.coverage_complete = Boolean(ktpInput);
    result.stats.elapsed_ms = Date.now() - started;
    return result;
  }

  const lenIndex = await getIndexMap(env, 'INDEX_LEN', 'len', meta);
  const searchIndex = await getSearchIndexMap(env, meta, lenIndex);
  const plan = buildBucketPlan(env, searchIndex, textLen, maxCandidates, threshold, directRejectThreshold, weights, tokens(queryText).size);
  const {maxLenDiff, ordered, candidateSpace, oversized} = plan;
  const entries = ordered;
  const requestedOversizedBudget = Number(env.OVERSIZED_SCAN_BUDGET || DEFAULT_OVERSIZED_SCAN_BUDGET);
  const oversizedBudget = Number.isSafeInteger(requestedOversizedBudget) && requestedOversizedBudget > 0
    ? requestedOversizedBudget : DEFAULT_OVERSIZED_SCAN_BUDGET;
  // An operator may REDUCE, never raise, the per-request cap. This is useful
  // for a slow Render instance or a deterministic regression fixture.
  const configuredNormalRows = Number(env.NORMAL_MAX_ROWS_PER_REQUEST ?? NORMAL_MAX_ROWS_PER_REQUEST);
  const normalRows = Number.isSafeInteger(configuredNormalRows) && configuredNormalRows > 0
    ? Math.min(NORMAL_MAX_ROWS_PER_REQUEST, configuredNormalRows)
    : NORMAL_MAX_ROWS_PER_REQUEST;
  const scanBudget = Math.min(normalRows,
    oversized ? Math.min(maxCandidates, oversizedBudget) : maxCandidates);
  result.stats.candidate_space = candidateSpace;
  result.stats.bucket_count = entries.length;
  result.stats.oversized_bucket_space = oversized;
  result.stats.scan_budget = scanBudget;

  const best = [];
  // Reuse query-side token lists instead of parsing them for each BP.
  const queryFeatures = { tokens: tokens(queryText), numeric: numericTokens(queryText) };
  let found = null;
  let scanned = 0;
  let compared = 0;
  let skipped = 0;
  let batches = 0;
  let completedBuckets = 0;
  let nextBucketPos = 0;
  let nextBucketRow = ordered.length ? searchIndex.get(ordered[0]).row_start : 0;
  let stoppedForTime = false;
  let stoppedForQuota = false;

  for (let pos = 0; pos < ordered.length; pos++) {
    const bucket = ordered[pos];
    const info = searchIndex.get(String(bucket));
    if (!info) continue;
    let rowStart = info.row_start;
    while (rowStart <= info.row_end && scanned < scanBudget) {
      if (Date.now() - started >= NORMAL_MAX_PROCESSING_MS) {
        stoppedForTime = true;
        break;
      }
      const chunkEnd = Math.min(rowStart + batchRows - 1, info.row_end, rowStart + scanBudget - scanned - 1);
      let rows;
      try {
        rows = await getSheetRange(env, `BP_DATABASE!A${rowStart}:H${chunkEnd}`, meta.sync_id);
      } catch (error) {
        // Preserve completed normal rows instead of throwing away progress and
        // resubmitting the entire 60k-candidate request after a quota error.
        // Exact checks and the verified search plan already completed.
        if (error?.status !== 429) throw error;
        stoppedForQuota = true;
        break;
      }
      batches += 1;
      if (rows.length !== chunkEnd - rowStart + 1) {
        throw httpError(503, `Incomplete BP_DATABASE range ${rowStart}:${chunkEnd}; refusing a false PASS. Run a full sync.`);
      }
      for (const row of rows) {
        assertSnapshotConsistency(meta.sync_id, String(row[7] || ''), 'INDEX_LEN -> BP_DATABASE');
        scanned += 1;
        const candidate = bpRowFromSheet(row);
        if (!candidate.norm_text || Math.abs(candidate.text_len - textLen) > maxLenDiff) {
          skipped += 1;
          continue;
        }
        // No heuristic quickPrefilter exclusions: a high Levenshtein score can
        // reject directly even when token overlap/prefix appears weak. Every
        // in-tolerance candidate must reach the actual scoring decision.
        compared += 1;
        const score = computeSimilarity(queryText, candidate.norm_text, weights, directRejectThreshold, queryFeatures);
        const displayedScore = score.direct_reject ? score.trigger_score : score.combined;
        const entry = sanitizeBpRow(candidate, displayedScore, {
          levenshtein: score.levenshtein,
          jaccard: score.jaccard,
          numeric_weighted: score.numeric,
          combined_weighted: score.combined,
          decision_rule: score.direct_reject ? 'DIRECT_REJECT' : 'WEIGHTED',
          direct_reject_metric: score.direct_reject_metric,
          weighted_skipped: score.weighted_skipped,
          reason: score.direct_reject
            ? `${score.direct_reject_metric} Direct Reject`
            : 'Name 1 + Address Weighted Similarity'
        });
        pushTop(best, entry, 5);
        if (score.direct_reject || score.combined >= threshold) {
          // Retain the highest score, not whichever BP happened to be stored first.
          if (!found || entry.score > found.score) found = entry;
        }
      }
      rowStart = chunkEnd + 1;
    }
    if (rowStart > info.row_end) {
      completedBuckets++;
      nextBucketPos = pos + 1;
      nextBucketRow = nextBucketPos < ordered.length
        ? searchIndex.get(ordered[nextBucketPos]).row_start : 0;
    } else {
      nextBucketPos = pos;
      nextBucketRow = rowStart;
    }
    if (scanned >= scanBudget || stoppedForTime || stoppedForQuota) break;
  }

  const complete = scanned === candidateSpace;
  result.stats = {
    scanned_candidates: scanned, compared_candidates: compared,
    skipped_by_prefilter: skipped, batches_processed: batches,
    candidate_space: candidateSpace, coverage_complete: complete,
    scan_limit_reached: !complete, elapsed_ms: Date.now() - started,
    bucket_count: entries.length, completed_buckets: completedBuckets,
    oversized_bucket_space: oversized, scan_budget: scanBudget,
    search_scope: meta.token_index_version === '1' ? 'SCORE_BOUND_INDEXED_LENGTH_BUCKETS' : 'CONFIGURED_LENGTH_BUCKETS',
    pass_basis: complete ? (meta.token_index_version === '1' ? 'ALL_RELEVANT_ROWS_SCORED_OR_SAFELY_PRUNED' : 'ALL_ELIGIBLE_BUCKET_ROWS_SCORED') : null,
    safely_pruned_candidates: plan.safelyPruned,
    score_bound_index_used: meta.token_index_version === '1',
    stopped_for_time_budget: stoppedForTime,
    stopped_for_quota: stoppedForQuota,
    normal_row_budget: normalRows
  };
  result.top_candidates = best;
  if (found) {
    result.decision = 'FAIL';
    result.similarity_match = found;
    result.reason = complete
      ? `Name 1 + Address similarity match found (score ${found.score}%).`
      : `Name 1 + Address similarity match found (score ${found.score}%). Search cap reached; additional candidates were not checked.`;
  } else if (complete) {
    // A PASS is evidence-backed only when EVERY row of EVERY eligible bucket
    // was visited and the Sheet's READY snapshot is still the same generation.
    const finalMeta = await getMeta(env);
    requireReadyExactIndex(finalMeta);
    if (finalMeta.sync_id !== meta.sync_id) {
      throw httpError(503, 'Sheet generation changed before PASS; run a new duplicate check.');
    }
    result.decision = 'PASS';
    result.reason = `No duplicate under configured rules: scored ${scanned} rows in ${entries.length} search groups; safely eliminated ${plan.safelyPruned} additional rows using conservative score upper bounds. Exact indexes checked. This is a scoped PASS, not a full-database scan.`;
  } else {
    result.decision = 'INCONCLUSIVE';
    result.reason = `Normal scan stopped safely after ${scanned} of ${candidateSpace} eligible rows (${stoppedForQuota ? 'Sheets read quota' : stoppedForTime ? 'processing-time budget' : 'bounded row budget'}). ${plan.safelyPruned} rows were excluded by safe score bounds. Continue remaining work with the manual Full Scope button; this is NOT a PASS.`;
    result.full_scope_available = true;
    result.full_scope_cursor = createFullScopeCursor({
      env, meta, name1, address, ktpInput, threshold, directRejectThreshold, weights,
      plan, bucketPos: nextBucketPos, nextRow: nextBucketRow,
      scanned, compared, batches, completedBuckets
    });
  }
  return result;
}

// One deterministic plan is shared by the fast check AND the manual continuation.
// INDEX_LEN is cached per Sheets sync_id; no additional Google Sheets index is needed.
// A bucket is only read if it intersects the configured length tolerance.
// Optimistic upper bounds; never remove a group unless NO scoring path can
// reach FAIL. Safe for the current Levenshtein, soft-Jaccard and numeric rules.
export function scoreBoundCanMatch(group, textLen, queryTokenCount, threshold, rejectThreshold, weights) {
  if (!Number.isSafeInteger(group.token_count)) return true; // legacy index
  const bucket = Number(group.bucket);
  const minLen = bucket * 5;
  const maxLen = minLen + 4;
  const levenshteinUpper = textLen < minLen ? (100 * textLen / Math.max(1, minLen))
    : textLen > maxLen ? (100 * maxLen / Math.max(1, textLen)) : 100;
  const n = group.token_count;
  // Even perfect fuzzy token matching cannot exceed min(|A|,|B|)/max.
  const jaccardUpper = queryTokenCount === 0 && n === 0 ? 100
    : queryTokenCount === 0 || n === 0 ? 0
      : 100 * Math.min(queryTokenCount, n) / Math.max(queryTokenCount, n);
  const epsilon = 0.025; // preserve decisions near round2 thresholds
  if (levenshteinUpper + epsilon >= rejectThreshold
      || jaccardUpper + epsilon >= rejectThreshold) return true;
  // Custom negative/nonfinite weights cannot be bounded this way: scan them.
  if (![weights.levenshtein, weights.jaccard, weights.numeric].every(
    w => Number.isFinite(w) && w >= 0)) return true;
  const upperCombined = levenshteinUpper * weights.levenshtein
    + jaccardUpper * weights.jaccard + 100 * weights.numeric;
  return upperCombined + epsilon >= threshold;
}
function buildBucketPlan(env, searchIndex, textLen, maxCandidates, threshold, rejectThreshold, weights, queryTokenCount) {
  const maxLenDiff = getMaxLenDiff(env, textLen);
  const eligibleBuckets = new Set(bucketRange(textLen, maxLenDiff));
  const allEligible = [...searchIndex.keys()].filter(key => eligibleBuckets.has(searchIndex.get(key).bucket || key));
  let safelyPruned = 0;
  const eligible = allEligible.filter(key => {
    const group = searchIndex.get(key);
    if (scoreBoundCanMatch(group, textLen, queryTokenCount, threshold, rejectThreshold, weights)) return true;
    safelyPruned += group.count;
    return false;
  });
  const candidateSpace = eligible.reduce((sum, key) => sum + searchIndex.get(key).count, 0);
  const oversized = candidateSpace > maxCandidates;
  const distance = key => Math.abs(Number(searchIndex.get(key).bucket || key) - Math.floor(textLen / 5));
  const ordered = eligible.sort((a, b) =>
    (oversized ? searchIndex.get(a).count - searchIndex.get(b).count : 0)
    || distance(a) - distance(b) || searchIndex.get(a).row_start - searchIndex.get(b).row_start);
  const signature = createHash('sha256').update(JSON.stringify({
    maxLenDiff, maxCandidates, threshold, rejectThreshold, weights, queryTokenCount,
    ordered: ordered.map(key => {
      const info = searchIndex.get(key);
      return [key, info.row_start, info.row_end, info.count];
    })
  })).digest('hex');
  return {ordered, candidateSpace, oversized, maxLenDiff, signature, safelyPruned};
}

function fullScopeFingerprint({name1, address, ktpInput, threshold, directRejectThreshold, weights}) {
  return createHash('sha256').update(JSON.stringify({
    name: normalizeText(name1), address: normalizeText(address),
    ktp: ktpInput, threshold, directRejectThreshold, weights
  })).digest('hex');
}

function fullScopeKey(env) {
  const secret = String(env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim();
  if (!secret) throw httpError(503, 'Full scope requires configured backend OAuth.');
  return createHmac('sha256', secret).update('bp-duplicate-checker/relevant-buckets/v2').digest();
}

function createFullScopeCursor({env, meta, name1, address, ktpInput, threshold, directRejectThreshold, weights,
  plan, bucketPos, nextRow, scanned, compared, batches, completedBuckets}) {
  const state = {
    v: 2, engine: ENGINE_VERSION, sync: meta.sync_id,
    fingerprint: fullScopeFingerprint({name1, address, ktpInput, threshold, directRejectThreshold, weights}),
    scope: plan.signature, total: plan.candidateSpace,
    bucketPos, nextRow, scanned, compared, batches, completedBuckets,
    issuedAt: Date.now()
  };
  const raw = base64urlJson(state);
  const signature = createHmac('sha256', fullScopeKey(env)).update(raw).digest('base64url');
  return raw + '.' + signature;
}

function readFullScopeCursor(token, env, meta, query, plan, searchIndex) {
  if (typeof token !== 'string' || token.length > 4096) throw httpError(400, 'Invalid full-scope cursor.');
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces.every(Boolean)) throw httpError(400, 'Invalid full-scope cursor.');
  const [raw, signature] = pieces;
  const expected = createHmac('sha256', fullScopeKey(env)).update(raw).digest();
  let got;
  try { got = Buffer.from(signature, 'base64url'); } catch (_) {
    throw httpError(400, 'Invalid full-scope cursor.');
  }
  if (got.length !== expected.length || !timingSafeEqual(expected, got)) {
    throw httpError(400, 'Invalid full-scope cursor signature.');
  }
  let state;
  try { state = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch (_) {
    throw httpError(400, 'Invalid full-scope cursor.');
  }
  if (state?.v !== 2 || state?.engine !== ENGINE_VERSION ||
      state?.fingerprint !== fullScopeFingerprint(query)) {
    throw httpError(409, 'Full-scope inputs or engine changed. Run a new normal check.');
  }
  if (state.sync !== meta.sync_id || state.scope !== plan.signature ||
      state.total !== plan.candidateSpace) {
    throw httpError(409, 'Sheet snapshot, bucket index or search configuration changed. Restart normal check.');
  }
  if (!Number.isSafeInteger(state.issuedAt) || state.issuedAt > Date.now() + 30000 ||
      Date.now() - state.issuedAt > FULL_SCOPE_CURSOR_TTL_MS) {
    throw httpError(409, 'Full-scope session expired. Run a new normal check.');
  }
  const pos = state.bucketPos;
  if (!Number.isSafeInteger(pos) || pos < 0 || pos >= plan.ordered.length ||
      !Number.isSafeInteger(state.scanned) || state.scanned < 0 ||
      !Number.isSafeInteger(state.compared) || state.compared < 0 || state.compared > state.scanned ||
      !Number.isSafeInteger(state.batches) || state.batches < 0 || state.batches > state.scanned ||
      !Number.isSafeInteger(state.completedBuckets) || state.completedBuckets !== pos) {
    throw httpError(400, 'Invalid or completed full-scope cursor.');
  }
  const info = searchIndex.get(plan.ordered[pos]);
  if (!Number.isSafeInteger(state.nextRow) ||
      state.nextRow < info.row_start || state.nextRow > info.row_end) {
    throw httpError(400, 'Invalid full-scope row pointer.');
  }
  const preceding = plan.ordered.slice(0, pos).reduce(
    (n, bucket) => n + searchIndex.get(bucket).count, 0);
  if (state.scanned !== preceding + state.nextRow - info.row_start) {
    throw httpError(400, 'Invalid full-scope scan count.');
  }
  return state;
}

async function fullScopeCheck(payload, env) {
  const started = Date.now();
  const name1 = String(payload?.name_1 || payload?.name1 || '').trim();
  const address = String(payload?.address || '').trim();
  const ktpInput = normalizeDigits(payload?.ktp_number || payload?.ktp || '');
  const queryText = normalizeText(name1 + ' ' + address);
  if (queryText.length < 3) throw httpError(400, 'Full scope requires sufficient Name 1 or Address text.');
  const threshold = Number(env.SIMILARITY_THRESHOLD || DEFAULT_SIMILARITY_THRESHOLD);
  const directRejectThreshold = getSimilarityDirectRejectThreshold(env);
  const weights = getSimilarityWeights(env);
  const meta = await getMeta(env);
  requireReadyExactIndex(meta);
  const lenIndex = await getIndexMap(env, 'INDEX_LEN', 'len', meta);
  const maxCandidates = Math.max(1, Number(env.MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES));
  const searchIndex = await getSearchIndexMap(env, meta, lenIndex);
  const plan = buildBucketPlan(env, searchIndex, queryText.length, maxCandidates, threshold, directRejectThreshold, weights, tokens(queryText).size);
  const query = {name1, address, ktpInput, threshold, directRejectThreshold, weights};
  const state = readFullScopeCursor(payload.full_scope_cursor, env, meta, query, plan, searchIndex);
  const configuredRows = Number(env.FULL_SCOPE_CHUNK_ROWS || FULL_SCOPE_MAX_ROWS_PER_REQUEST);
  const rowsPerRequest = Number.isFinite(configuredRows)
    ? Math.max(1, Math.min(FULL_SCOPE_MAX_ROWS_PER_REQUEST, Math.floor(configuredRows)))
    : FULL_SCOPE_MAX_ROWS_PER_REQUEST;
  let budget = rowsPerRequest;
  let scanned = state.scanned;
  let compared = state.compared;
  let batches = state.batches;
  let pos = state.bucketPos;
  let nextRow = state.nextRow;
  let completedBuckets = state.completedBuckets;
  let found = null;
  const queryFeatures = { tokens: tokens(queryText), numeric: numericTokens(queryText) };

  while (pos < plan.ordered.length && budget > 0 && !found) {
    const info = searchIndex.get(plan.ordered[pos]);
    const endRow = Math.min(info.row_end, nextRow + budget - 1);
    const rows = await getSheetRange(env, 'BP_DATABASE!A' + nextRow + ':H' + endRow, meta.sync_id);
    if (rows.length !== endRow - nextRow + 1) {
      throw httpError(503, 'Relevant-bucket range incomplete. No PASS can be issued.');
    }
    batches++;
    for (const row of rows) {
      assertSnapshotConsistency(meta.sync_id, String(row[7] || ''), 'FULL_SCOPE -> BP_DATABASE');
      scanned++;
      const candidate = bpRowFromSheet(row);
      // Bucket boundaries span 5 characters; ignore boundary rows outside
      // exact tolerance, but NEVER use heuristic token exclusions.
      if (!candidate.norm_text ||
          Math.abs(candidate.text_len - queryText.length) > plan.maxLenDiff) continue;
      compared++;
      const score = computeSimilarity(queryText, candidate.norm_text, weights, directRejectThreshold, queryFeatures);
      if (score.direct_reject || score.combined >= threshold) {
        found = sanitizeBpRow(candidate, score.direct_reject ? score.trigger_score : score.combined, {
          levenshtein: score.levenshtein, jaccard: score.jaccard,
          numeric_weighted: score.numeric, combined_weighted: score.combined,
          decision_rule: score.direct_reject ? 'DIRECT_REJECT' : 'WEIGHTED',
          direct_reject_metric: score.direct_reject_metric,
          weighted_skipped: score.weighted_skipped,
          reason: score.direct_reject ? score.direct_reject_metric + ' Direct Reject' : 'Relevant-Bucket Weighted Similarity'
        });
        break;
      }
    }
    const consumed = endRow - nextRow + 1;
    budget -= consumed;
    nextRow = endRow + 1;
    if (nextRow > info.row_end) {
      completedBuckets++;
      pos++;
      nextRow = pos < plan.ordered.length ? searchIndex.get(plan.ordered[pos]).row_start : 0;
    }
  }

  // The next chunk verifies META afresh. Only decisive FAIL/PASS needs
  // a second uncached META read before returning a final decision.
  if (found || pos === plan.ordered.length) {
    const finalMeta = await getMeta(env);
    requireReadyExactIndex(finalMeta);
    if (finalMeta.sync_id !== meta.sync_id) {
      throw httpError(503, 'Sheet generation changed during full-scope search; restart normal check.');
    }
  }
  const finished = !found && pos === plan.ordered.length && scanned === plan.candidateSpace;
  const stats = {
    scanned_candidates: scanned, compared_candidates: compared,
    candidate_space: plan.candidateSpace, batches_processed: batches,
    skipped_by_prefilter: 0, coverage_complete: finished,
    scan_limit_reached: !finished && !found,
    elapsed_ms: Date.now() - started, bucket_count: plan.ordered.length,
    completed_buckets: completedBuckets,
    search_scope: meta.token_index_version === '1' ? 'SCORE_BOUND_INDEXED_LENGTH_BUCKETS' : 'CONFIGURED_LENGTH_BUCKETS',
    pass_basis: finished ? (meta.token_index_version === '1' ? 'ALL_RELEVANT_ROWS_SCORED_OR_SAFELY_PRUNED' : 'ALL_ELIGIBLE_BUCKET_ROWS_SCORED') : null,
    safely_pruned_candidates: plan.safelyPruned,
    score_bound_index_used: meta.token_index_version === '1',
    resumed_from_normal_scan: state.scanned, full_scope_batch_rows: rowsPerRequest
  };
  if (found) {
    return {
      ok: true, decision: 'FAIL', reason: 'Relevant-bucket duplicate found; continuation stopped.',
      meta, threshold, direct_reject_threshold: directRejectThreshold,
      similarity_match: found, full_scope_active: true, full_scope_available: false,
      full_scope_cursor: null, stats
    };
  }
  if (finished) {
    return {
      ok: true, decision: 'PASS',
      reason: 'No duplicate in the fully checked configured length buckets. Exact KTP/name+address were checked in the initial normal request. This is a scoped PASS, not a full-database scan.',
      meta, threshold, direct_reject_threshold: directRejectThreshold,
      full_scope_active: true, full_scope_available: false, full_scope_cursor: null, stats
    };
  }
  return {
    ok: true, decision: 'INCONCLUSIVE',
    reason: 'Continuing relevant buckets without rescanning completed rows; no PASS until all eligible buckets finish.',
    meta, threshold, direct_reject_threshold: directRejectThreshold,
    full_scope_active: true, full_scope_available: true,
    full_scope_cursor: createFullScopeCursor({
      env, meta, ...query, plan, bucketPos: pos, nextRow,
      scanned, compared, batches, completedBuckets
    }),
    stats
  };
}

function requireReadyExactIndex(meta) {
  const bp = Number(meta.total_bp_rows);
  const exact = Number(meta.total_exact_index_rows);
  if (meta.sync_state === 'IN_PROGRESS') {
    throw httpError(503, 'META sync is in progress: wait until the patched full sync has completed.');
  }
  if (!meta.sync_id || meta.sync_state !== 'READY'
      || meta.exact_index_version !== '1'
      || !Number.isSafeInteger(bp) || bp <= 0
      || !Number.isSafeInteger(exact) || exact !== bp) {
    throw httpError(503, 'Exact name/address index not ready: run the patched full sync and verify META sync_state=READY, exact_index_version=1, total_exact_index_rows=total_bp_rows.');
  }
}

export function exactNameAddressHash(name, address) {
  return createHash('sha256')
    .update(`${normalizeText(name)}\x1f${normalizeText(address)}`, 'utf8')
    .digest('hex');
}

async function findExactNameAddress(name, address, env, meta) {
  if (meta.exact_index_version !== '1' || Number(meta.total_exact_index_rows) !== Number(meta.total_bp_rows)) {
    throw httpError(503, 'Exact name/address index not synchronized; update sync script and run full sync before deploying the new API.');
  }
  const shardMap = await getIndexMap(env, 'INDEX_EXACT_SHARD', 'exact', meta);
  const hash = exactNameAddressHash(name, address);
  const info = shardMap.get(hash.slice(0, 2));
  if (!info) return { matches: [], count: 0, bpIds: [], diagnostics: { attempted: true, index_version: meta.exact_index_version, shard_present: false, shard_rows: 0, matching_index_rows: 0, verified_matches: 0 } };
  const rows = await getSheetRange(env, `EXACT_INDEX!A${info.row_start}:D${info.row_end}`, meta.sync_id);
  if (rows.length !== info.count) {
    throw httpError(503, 'EXACT_INDEX shard contains fewer rows than advertised. Run a full sync.');
  }
  const pointers = [];
  for (const row of rows) {
    assertSnapshotConsistency(meta.sync_id, String(row[3] || ''), 'INDEX_EXACT_SHARD -> EXACT_INDEX');
    if (String(row[0]).slice(0, 2) !== hash.slice(0, 2)) {
      throw httpError(503, 'EXACT_INDEX shard integrity mismatch. Run a full sync.');
    }
    if (String(row[0]) === hash) pointers.push(row);
  }
  const matches = [];
  // Inspect all pointer IDs but fetch at most five BP rows; select distinct
  // BP IDs first so conflicting identities do not hide beyond preview five.
  const bpIds = [...new Set(pointers.map(p => String(p[2])))];
  const chosen = [];
  const seen = new Set();
  for (const pointer of pointers) {
    if (!seen.has(String(pointer[2]))) {
      chosen.push(pointer);
      seen.add(String(pointer[2]));
      if (chosen.length >= 5) break;
    }
  }
  if (chosen.length < 5) {
    for (const pointer of pointers) {
      if (!chosen.includes(pointer)) chosen.push(pointer);
      if (chosen.length >= 5) break;
    }
  }
  for (const pointer of chosen) {
    const rowNo = Number(pointer[1]);
    if (!Number.isSafeInteger(rowNo) || rowNo < 2 || rowNo > Number(meta.total_bp_rows) + 1) {
      throw httpError(503, 'Invalid EXACT_INDEX BP pointer. Run a full sync.');
    }
    const bpRows = await getSheetRange(env, `BP_DATABASE!A${rowNo}:H${rowNo}`, meta.sync_id);
    const row = bpRows[0];
    if (!row || String(row[0]) !== String(pointer[2])) {
      throw httpError(503, 'EXACT_INDEX BP pointer does not match BP_DATABASE. Run a full sync.');
    }
    assertSnapshotConsistency(meta.sync_id, String(row[7] || ''), 'EXACT_INDEX -> BP_DATABASE');
    const candidate = bpRowFromSheet(row);
    if (exactNameAddressHash(candidate.name_1, candidate.address) !== hash) {
      throw httpError(503, 'EXACT_INDEX hash differs from BP_DATABASE data. Run a full sync.');
    }
    if (normalizeText(candidate.name_1) === normalizeText(name)
        && normalizeText(candidate.address) === normalizeText(address)) {
      if (matches.length < 5) matches.push(candidate);
    }
  }
  return { matches, count: pointers.length, bpIds, diagnostics: { attempted: true, index_version: meta.exact_index_version, shard_present: true, shard_rows: rows.length, matching_index_rows: pointers.length, verified_matches: matches.length } }; 
}

async function findExactKtp(ktpDigits, env, activeMeta) {
  const activeSyncId = activeMeta.sync_id;
  const ktpShardMap = await getIndexMap(env, 'INDEX_KTP_SHARD', 'ktp', activeMeta);
  const shard = ktpDigits.slice(-2).padStart(2, '0');
  const info = ktpShardMap.get(shard);
  if (!info) return null;

  assertSnapshotConsistency(activeSyncId, info.sync_id, 'META -> INDEX_KTP_SHARD');
  const rows = await getSheetRange(env, `KTP_INDEX!A${info.row_start}:D${info.row_end}`, activeSyncId);
  if (rows.length !== info.count) {
    throw httpError(503, `INDEX_KTP_SHARD points to an empty KTP_INDEX range ${info.row_start}:${info.row_end}. Run a full sync.`);
  }
  for (const row of rows) {
    const candidateSyncId = String(row[3] || '');
    assertSnapshotConsistency(activeSyncId, candidateSyncId, 'META -> KTP_INDEX');
    const candidateKtp = normalizeDigits(row[0] || '');
    if (candidateKtp === ktpDigits) {
      const bpDbRow = Number(row[1] || 0);
      const expectedBpId = String(row[2] || '').trim();
      if (!bpDbRow) throw httpError(503, 'KTP index contains an invalid BP_DATABASE row pointer. Run a full sync.');
      const bpRows = await getSheetRange(env, `BP_DATABASE!A${bpDbRow}:H${bpDbRow}`, activeSyncId);
      if (!bpRows?.[0]) throw httpError(503, 'KTP index points to a missing BP_DATABASE row. Run a full sync.');
      const bpRow = bpRows[0];
      assertSnapshotConsistency(activeSyncId, String(bpRow[7] || ''), 'KTP_INDEX -> BP_DATABASE');
      const actualBpId = String(bpRow[0] || '').trim();
      if (expectedBpId && actualBpId !== expectedBpId) {
        throw httpError(503, `KTP index integrity mismatch: expected BP ${expectedBpId}, found ${actualBpId || '(blank)'}. Run a full sync.`);
      }
      return bpRowFromSheet(bpRow);
    }
  }
  return null;
}

export function assertSnapshotConsistency(expectedSyncId, actualSyncId, boundary = 'indexed sheet read') {
  const expected = String(expectedSyncId || '').trim();
  const actual = String(actualSyncId || '').trim();
  // Legacy sheets without sync_id must be rebuilt before using pointer-based indexes.
  if (!expected || !actual || expected !== actual) {
    throw httpError(503, `Mixed or incomplete sheet snapshot detected at ${boundary}. Expected sync ${expected || '(missing)'}, got ${actual || '(missing)'}. Run sync_gsheet_indexed.py fully before retrying.`);
  }
}

export async function getMeta(env) {
  // META is the sync commit marker; never reuse stale META across a full sync.
  const rows = await getSheetRange(env, 'META!A2:B50', '', true);
  const out = {};
  for (const r of rows) if (r[0]) out[String(r[0])] = r[1] || '';
  return out;
}

export async function getIndexMap(env, tabName, type, meta) {
  const sync = String(meta.sync_id || '');
  if (!sync) throw httpError(503, 'META sync_id missing. Run a full sync.');
  const cacheKey = `index:${getSheetId(env)}:${sync}:${tabName}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const rows = await getSheetRange(env, `${tabName}!A2:E10000`, sync);
  const map = new Map();
  let total = 0;
  let expectedStart = 2;
  for (const r of rows) {
    const key = String(r[0] ?? '').trim();
    if (!key) continue;
    const info = {
      key, row_start: Number(r[1]), row_end: Number(r[2]),
      count: Number(r[3]), sync_id: String(r[4] || ''), type
    };
    assertSnapshotConsistency(sync, info.sync_id, `META -> ${tabName}`);
    if (map.has(key) || !Number.isSafeInteger(info.count) || info.count < 1
        || !Number.isSafeInteger(info.row_start) || !Number.isSafeInteger(info.row_end)
        || info.row_start !== expectedStart || info.row_end - info.row_start + 1 !== info.count) {
      throw httpError(503, `${tabName} has an incomplete, overlapping or invalid index range. Run a full sync.`);
    }
    expectedStart = info.row_end + 1;
    total += info.count;
    map.set(key, info);
  }
  const expectedKey = type === 'len' ? 'total_bp_rows'
    : type === 'ktp' ? 'total_ktp_index_rows' : 'total_exact_index_rows';
  const expected = Number(meta[expectedKey]);
  if (!Number.isSafeInteger(expected) || total !== expected) {
    throw httpError(503, `${tabName} row count ${total} differs from META ${expectedKey} ${meta[expectedKey]}. Run a full sync.`);
  }
  // Indexed rows are immutable within one sync_id; keep the index map cached
  // through long manual continuations without caching META itself.
  setCached(cacheKey, map, 1800);
  return map;
}

// Reserve a local read slot before issuing a Google Sheets request. This is a
// fail-fast limiter (no server-side 60-second sleep that times out on Render).
// It is per-process, not distributed; all instances/Windows sync share the
// actual upstream user quota, so upstream 429 is still handled independently.
function currentSheetsQuotaState(env) {
  const requested = Number(env.SHEETS_LOCAL_READ_BUDGET_PER_MINUTE ?? SHEETS_LOCAL_READ_BUDGET_PER_MINUTE);
  const budget = requested === 0 ? 0
    : Number.isFinite(requested) && requested > 0
      ? Math.min(SHEETS_LOCAL_READ_BUDGET_PER_MINUTE, Math.floor(requested))
      : SHEETS_LOCAL_READ_BUDGET_PER_MINUTE;
  const now = Date.now();
  while (sheetsReadTimes.length && sheetsReadTimes[0] <= now - 60000) sheetsReadTimes.shift();
  const used = sheetsReadTimes.length;
  const cooldown = Math.max(0, Math.ceil((sheetsCooldownUntil - now) / 1000));
  // Keep three slots of headroom for a chunk's fresh META + range reads.
  const nextAvailable = budget > 0 && used >= Math.max(1, budget - 3)
    ? Math.max(1, Math.ceil((sheetsReadTimes[0] + 60000 - now) / 1000) + 2) : 0;
  return {
    local_budget_per_minute: budget, local_reads_in_window: used,
    local_remaining: budget > 0 ? Math.max(0, budget - used) : null,
    recommended_pause_seconds: Math.max(cooldown, nextAvailable)
  };
}

function reserveSheetsReadSlot(env) {
  // Explicit zero is only useful for controlled fixture tests; keep the
  // default production ceiling conservative and clamp positive overrides.
  const requested = Number(env.SHEETS_LOCAL_READ_BUDGET_PER_MINUTE ?? SHEETS_LOCAL_READ_BUDGET_PER_MINUTE);
  if (requested === 0) return;
  const budget = Number.isFinite(requested) && requested > 0
    ? Math.min(SHEETS_LOCAL_READ_BUDGET_PER_MINUTE, Math.floor(requested))
    : SHEETS_LOCAL_READ_BUDGET_PER_MINUTE;
  const now = Date.now();
  if (now < sheetsCooldownUntil) {
    const err = httpError(429, 'Google Sheets read quota is cooling down. The duplicate check has not completed.');
    err.retry_after_seconds = Math.ceil((sheetsCooldownUntil - now) / 1000);
    throw err;
  }
  while (sheetsReadTimes.length && sheetsReadTimes[0] <= now - 60000) sheetsReadTimes.shift();
  if (sheetsReadTimes.length >= budget) {
    const wait = Math.ceil((sheetsReadTimes[0] + 60000 - now) / 1000) + 2;
    const err = httpError(429, 'Local Google Sheets read budget reached; retry the same request after the indicated delay.');
    err.retry_after_seconds = Math.max(2, wait);
    throw err;
  }
  sheetsReadTimes.push(now);
}

// The new compact search index contains ONLY length bucket, unique-token
// count and BP_DATABASE range pointers. It never copies raw names/KTP to a
// public deployment. Legacy sheets use the original complete length buckets
// until the patched Windows sync publishes token_index_version=1.
async function getSearchIndexMap(env, meta, lenIndex) {
  if (meta.token_index_version !== '1') {
    return new Map([...lenIndex].map(([key, info]) => [
      key, {...info, bucket: key, token_count: null}
    ]));
  }
  const sync = String(meta.sync_id || '');
  const cacheKey = 'tokenIndex:' + getSheetId(env) + ':' + sync;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const rows = await getSheetRange(env, 'INDEX_LEN_TOKEN!A2:F100000', sync);
  const map = new Map();
  const bucketTotals = new Map();
  let rowPointer = 2;
  for (const row of rows) {
    if (!row[0]) continue;
    const bucket = String(row[0]);
    const tokenCount = Number(row[1]);
    const start = Number(row[2]);
    const end = Number(row[3]);
    const count = Number(row[4]);
    assertSnapshotConsistency(sync, String(row[5] || ''), 'INDEX_LEN_TOKEN -> META');
    if (!lenIndex.has(bucket) || !Number.isSafeInteger(tokenCount) || tokenCount < 0
        || !Number.isSafeInteger(start) || start !== rowPointer
        || !Number.isSafeInteger(end) || !Number.isSafeInteger(count) || count < 1
        || end - start + 1 !== count
        || start < lenIndex.get(bucket).row_start || end > lenIndex.get(bucket).row_end) {
      throw httpError(503, 'INDEX_LEN_TOKEN incomplete or unsorted. Run patched full sync.');
    }
    const key = bucket + ':' + tokenCount;
    if (map.has(key)) throw httpError(503, 'INDEX_LEN_TOKEN duplicate group. Run patched full sync.');
    map.set(key, {bucket, token_count: tokenCount, row_start: start, row_end: end, count, sync_id: sync});
    bucketTotals.set(bucket, (bucketTotals.get(bucket) || 0) + count);
    rowPointer = end + 1;
  }
  if (map.size !== Number(meta.token_index_groups)
      || rowPointer !== Number(meta.total_bp_rows) + 2
      || [...lenIndex].some(([bucket, info]) => bucketTotals.get(bucket) !== info.count)) {
    throw httpError(503, 'INDEX_LEN_TOKEN row coverage does not match INDEX_LEN/META. No PASS allowed.');
  }
  setCached(cacheKey, map, 1800);
  return map;
}

export async function getSheetRange(env, rangeA1, syncId = '', fresh = false) {
  const cacheSeconds = Number(env.RANGE_CACHE_SECONDS || DEFAULT_RANGE_CACHE_SECONDS);
  const sheetId = getSheetId(env);
  if (!sheetId) throw httpError(500, 'SHEET_ID is not configured.');
  const cacheKey = `range:${sheetId}:${syncId}:${rangeA1}`;
  const cached = fresh ? null : getCached(cacheKey);
  if (cached) return cached;
  // Coalesce concurrent identical ranges so independent checks do not
  // amplify the Google quota. Fresh META is coalesced only while in-flight.
  if (inFlightReads.has(cacheKey)) return inFlightReads.get(cacheKey);
  const pending = (async () => {
    const token = await getGoogleAccessToken(env);
    reserveSheetsReadSlot(env);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(rangeA1)}?majorDimension=ROWS`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      // Do not expose Google's full error payload (user/project identifiers).
      const retryHeader = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryHeader) && retryHeader > 0
        ? Math.max(SHEETS_UPSTREAM_RETRY_SECONDS, Math.ceil(retryHeader))
        : SHEETS_UPSTREAM_RETRY_SECONDS;
      sheetsCooldownUntil = Math.max(sheetsCooldownUntil, Date.now() + wait * 1000);
      const err = httpError(429, 'Google Sheets per-user read quota exceeded. Search paused without PASS; retry the SAME cursor.');
      err.retry_after_seconds = wait;
      throw err;
    }
    if (!res.ok) {
      throw httpError(502, `Google Sheets read failed (HTTP ${res.status}); the check is not complete.`);
    }
    const data = await res.json();
    const values = data.values || [];
    if (!fresh) setCached(cacheKey, values, cacheSeconds);
    return values;
  })();
  inFlightReads.set(cacheKey, pending);
  try { return await pending; } finally {
    if (inFlightReads.get(cacheKey) === pending) inFlightReads.delete(cacheKey);
  }
}

function getSheetId(env) {
  return String(env.SHEET_ID || DEFAULT_SHEET_ID || '').trim();
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - TOKEN_TTL_SAFETY_SECONDS > now) return tokenCache.token;

  const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const refreshToken = String(env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim();
  const tokenUrl = String(env.GOOGLE_OAUTH_TOKEN_URL || GOOGLE_TOKEN_URL).trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw httpError(500, 'Google OAuth user refresh token is not configured. Required: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!res.ok) {
    const txt = await res.text();
    throw httpError(502, `Google OAuth refresh error ${res.status}: ${txt.slice(0, 600)}`);
  }

  const data = await res.json();
  tokenCache = { token: data.access_token, exp: now + Number(data.expires_in || 3600) };
  return tokenCache.token;
}

function bpRowFromSheet(row) {
  const norm = String(row[4] || '');
  const len = Number(row[6] || norm.length || 0);
  return {
    bp_id: String(row[0] || ''),
    bp_type_id: String(row[1] || ''),
    name_1: String(row[2] || ''),
    address: String(row[3] || ''),
    norm_text: norm,
    norm_digits: String(row[5] || ''),
    text_len: len
  };
}

export function sanitizeBpRow(row, score, extra = {}) {
  return {
    bp_id: row.bp_id,
    bp_type_id: row.bp_type_id,
    name_1: row.name_1,
    address_preview: preview(row.address, 120),
    score: round2(score),
    ...extra
  };
}

export function computeSimilarity(a, b, weights, directRejectThreshold = DEFAULT_SIMILARITY_DIRECT_REJECT_THRESHOLD, queryFeatures = null) {
  const w = weights || DEFAULT_NORMALIZED_WEIGHTS;
  const lev = round2(levenshteinSimilarity(a, b));

  // Evaluate direct-reject metrics first. Do not calculate Numeric Weighted or the
  // combined weighted score when either metric already reaches the hard threshold.
  if (lev >= directRejectThreshold) {
    return {
      levenshtein: lev,
      jaccard: null,
      numeric: null,
      combined: null,
      direct_reject: true,
      direct_reject_metric: 'Levenshtein',
      trigger_score: lev,
      weighted_skipped: true
    };
  }

  const jac = round2(jaccardSimilarity(queryFeatures?.tokens || tokens(a), tokens(b)));
  if (jac >= directRejectThreshold) {
    return {
      levenshtein: lev,
      jaccard: jac,
      numeric: null,
      combined: null,
      direct_reject: true,
      direct_reject_metric: 'Jaccard',
      trigger_score: jac,
      weighted_skipped: true
    };
  }

  const num = round2(numericWeightedSimilarity(queryFeatures?.numeric || numericTokens(a), numericTokens(b)));
  const combined = round2((lev * w.levenshtein) + (jac * w.jaccard) + (num * w.numeric));
  return {
    levenshtein: lev,
    jaccard: jac,
    numeric: num,
    combined,
    direct_reject: false,
    direct_reject_metric: null,
    trigger_score: null,
    weighted_skipped: false
  };
}

function quickPrefilter(a, b) {
  const tA = tokens(a);
  const tB = tokens(b);
  const jac = jaccardSimilarity(tA, tB);
  const numA = numericTokens(a);
  const numB = numericTokens(b);
  const numeric = numericWeightedSimilarity(numA, numB);
  const first = firstUsefulToken(tA);
  const prefixHit = first && tB.has(first);

  if (jac >= 28) return { pass: true };
  if (numeric >= 70 && numA.join('').length >= 3) return { pass: true };
  if (prefixHit && jac >= 18) return { pass: true };
  return { pass: false };
}

function levenshteinSimilarity(a, b) {
  if (a === b) return 100;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[b.length];
  return Math.max(0, (1 - distance / maxLen) * 100);
}

// Generic best-effort 1:1 matching between two lists of items. Greedily pairs the
// highest-similarity items first (simFn returns 0..100), skipping any pair scoring
// below minSim so two genuinely unrelated items never contribute partial credit just
// because some pairing has to be picked. weightFn controls how much each item counts.
function bestFuzzyMatch(listA, listB, simFn, weightFn, minSim) {
  const candidates = [];
  for (let i = 0; i < listA.length; i++) {
    for (let j = 0; j < listB.length; j++) {
      const sim = simFn(listA[i], listB[j]);
      if (sim >= minSim) candidates.push({ i, j, sim });
    }
  }
  candidates.sort((p, q) => q.sim - p.sim);

  const usedA = new Set();
  const usedB = new Set();
  let matchedWeight = 0;
  let matchedPairs = 0;
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    matchedWeight += Math.min(weightFn(listA[c.i]), weightFn(listB[c.j])) * (c.sim / 100);
    matchedPairs += 1;
  }
  const totalWeightA = listA.reduce((s, x) => s + weightFn(x), 0);
  return { matchedWeight, totalWeightA, matchedPairs };
}

// Fuzzy/soft Jaccard: identical token sets still score 100 (same as classic Jaccard),
// but a token that is only a 1-2 character typo away from its counterpart (e.g.
// "sembako" vs "sembayo") now earns partial credit instead of counting as a total
// non-match. Short tokens (<4 chars - rt/rw/gg/km admin codes) still require an EXACT
// match, so short-code coincidences never get fuzzy-matched to each other.
function jaccardSimilarity(setA, setB) {
  const a = [...setA];
  const b = [...setB];
  if (!a.length && !b.length) return 100;
  if (!a.length || !b.length) return 0;

  const { matchedWeight, matchedPairs } = bestFuzzyMatch(a, b, tokenPairSimilarity, () => 1, 75);
  const union = a.length + b.length - matchedPairs;
  return union ? (matchedWeight / union) * 100 : 0;
}

function tokenPairSimilarity(a, b) {
  if (a === b) return 100;
  if (Math.min(a.length, b.length) < 4) return 0;
  return levenshteinSimilarity(a, b);
}

// Compares individually-extracted number chunks (house number, RT, RW, postal code, ...)
// instead of one big concatenated digit blob. Concatenating everything first (the old
// behavior, via normalizeDigits on the whole name+address) silently destroyed the
// boundaries between adjacent numbers: "No 105 RT 001 RW 002" became "105001002", so a
// single-digit change to the house number ("105" -> "104") changed the entire blob and
// scored 0% even though RT/RW were still an exact match. Chunks now come from
// numericTokens(), which reads straight off norm_text - still space-separated, so each
// number's original boundaries are preserved. Denominator is anchored on aChunks (the
// query side), matching the original design: "how much of what the query specified is
// present in this candidate" rather than a fully symmetric measure.
function numericWeightedSimilarity(aChunks, bChunks) {
  if (!aChunks.length && !bChunks.length) return 100;
  if (!aChunks.length || !bChunks.length) return 0;

  const weightFn = (c) => Math.min(10, Math.max(1, c.length));
  const { matchedWeight, totalWeightA } = bestFuzzyMatch(aChunks, bChunks, numericChunkSimilarity, weightFn, 50);
  return totalWeightA ? (matchedWeight / totalWeightA) * 100 : 0;
}

function numericChunkSimilarity(a, b) {
  if (a === b) return 100;
  const minLen = Math.min(a.length, b.length);
  const containScore = (minLen >= 3 && (a.includes(b) || b.includes(a))) ? 65 : 0;
  return Math.max(containScore, levenshteinSimilarity(a, b));
}

export function tokens(s) {
  const out = new Set();
  for (const t of String(s || '').split(' ')) {
    if (t.length >= 2) out.add(t);
  }
  return out;
}

// Digit-only runs read straight off already-normalized text (norm_text), which still has
// the ORIGINAL spacing between fields - e.g. "... no 105 rt 001 rw 002 ..." yields
// ["105", "001", "002"] as three separate chunks. This preserves field boundaries that
// would otherwise be lost if digits were extracted after every separator was stripped
// away first (see the comment on numericWeightedSimilarity above).
export function numericTokens(normText) {
  return String(normText || '').match(/\d+/g) || [];
}

function firstUsefulToken(set) {
  for (const t of set) {
    if (t.length >= 3 && !['jl', 'jalan', 'rt', 'rw', 'no'].includes(t)) return t;
  }
  return '';
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(pt|cv|tbk|ud|toko|tk|jl|jalan|gg|gang|no|nomor)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function lenBucket(len) {
  return String(Math.floor(Number(len || 0) / 5)).padStart(3, '0');
}

// Every INDEX_LEN bucket id whose range falls within [centerLen - maxDiff, centerLen + maxDiff].
// Buckets are 5-characters wide (see lenBucket), so step in 5s across the tolerance window -
// this replaces the old fixed 3-point (textLen-5, textLen, textLen+5) lookup, which only ever
// covered a ±5 window no matter how wide callers actually wanted to search.
function bucketRange(centerLen, maxDiff) {
  const lo = Math.floor(Math.max(0, centerLen - maxDiff) / 5);
  const hi = Math.floor((centerLen + maxDiff) / 5);
  const ids = [];
  for (let bucket = lo; bucket <= hi; bucket++) ids.push(String(bucket).padStart(3, '0'));
  return ids;
}

function pushTop(arr, entry, max) {
  arr.push(entry);
  arr.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  if (arr.length > max) arr.pop();
}

function preview(s, n) {
  const value = String(s || '');
  return value.length > n ? `${value.slice(0, n)}...` : value;
}

export function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

export function maskKtp(ktp) {
  if (!ktp) return '';
  if (ktp.length <= 6) return '*'.repeat(ktp.length);
  return `${ktp.slice(0, 4)}${'*'.repeat(Math.max(0, ktp.length - 8))}${ktp.slice(-4)}`;
}

function getCached(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) {
    memoryCache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value, seconds) {
  memoryCache.set(key, { value, exp: Date.now() + Number(seconds || 0) * 1000 });
}

async function enforceOptionalAccessCode(request, env) {
  // Frontend is same-origin and no longer asks users for an Access Code.
  // Keep API_ACCESS_CODE available only for optional server-to-server hardening.
  // To activate it intentionally, set REQUIRE_API_ACCESS_CODE=true and send x-access-code from a trusted caller.
  const required = String(env.REQUIRE_API_ACCESS_CODE || '').toLowerCase() === 'true';
  if (!required) return;
  const expected = String(env.API_ACCESS_CODE || '').trim();
  if (!expected) return;
  const got = String(request.headers.get('x-access-code') || '').trim();
  if (got !== expected) throw httpError(401, 'Invalid access code.');
}

async function enforceRateLimit(request, env) {
  const limit = Number(env.RATE_LIMIT_PER_MIN || DEFAULT_RATE_LIMIT_PER_MIN);
  if (!limit || limit <= 0) return;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const key = `${ip}:${Math.floor(Date.now() / 60000)}`;
  const used = (rateBucket.get(key) || 0) + 1;
  rateBucket.set(key, used);

  // Soft cleanup.
  if (rateBucket.size > 5000) {
    const currentMinute = Math.floor(Date.now() / 60000);
    for (const k of rateBucket.keys()) {
      const minute = Number(k.split(':').pop());
      if (Number.isFinite(minute) && currentMinute - minute > 3) rateBucket.delete(k);
    }
  }

  if (used > limit) throw httpError(429, 'Too many requests. Please retry later.');
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch (_err) {
    throw httpError(400, 'Invalid JSON body.');
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function base64urlJson(obj) {
  return base64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function base64urlBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
