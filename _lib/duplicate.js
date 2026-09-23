import { createHash } from 'node:crypto';

/*
  MDG BP Duplicate Checker - shared duplicate-check engine (Vercel Functions, Node.js runtime)
  Ported from the Cloudflare Pages Functions version: same algorithm, same thresholds,
  same defaults, same environment variable names. Only the hosting-platform adapter differs
  (see /api/*.js), because this file only receives a plain { request, env } context object
  and never touches Cloudflare- or Vercel-specific APIs directly.
  Data source remains protected Google Sheet.
  Browser never receives OAuth credential, refresh token, or raw database dump.
*/

export const ENGINE_VERSION = '2026-09-23-identity-v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_TTL_SAFETY_SECONDS = 90;

const DEFAULT_SHEET_ID = '1ZtNDikRHklwQMYxWQ6hkL1clvdH6g_Xfd3ojr5APDjo';
const DEFAULT_SIMILARITY_THRESHOLD = 92;
const DEFAULT_SIMILARITY_DIRECT_REJECT_THRESHOLD = 80;
const DEFAULT_MAX_CANDIDATES = 60000;
const DEFAULT_RANGE_CACHE_SECONDS = 300;
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

function getMaxLenDiff(env, textLen) {
  const pct = Number(env.LENGTH_TOLERANCE_PERCENT || DEFAULT_LENGTH_TOLERANCE_PERCENT);
  const minChars = Number(env.LENGTH_TOLERANCE_MIN_CHARS || DEFAULT_LENGTH_TOLERANCE_MIN_CHARS);
  const safePct = Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_LENGTH_TOLERANCE_PERCENT;
  const safeMin = Number.isFinite(minChars) && minChars >= 0 ? minChars : DEFAULT_LENGTH_TOLERANCE_MIN_CHARS;
  return Math.max(safeMin, Math.round(textLen * (safePct / 100)));
}

const memoryCache = new Map();
const rateBucket = new Map();
let tokenCache = { token: null, exp: 0 };

export async function handleCheck(context) {
  try {
    await enforceRateLimit(context.request, context.env);
    await enforceOptionalAccessCode(context.request, context.env);
    const payload = await safeJson(context.request);
    const result = await duplicateCheck(payload, context.env);
    return json(result);
  } catch (err) {
    return json({
      ok: false,
      error: err?.message || 'Unexpected error',
      hint: configHint(err?.message),
      requestId: crypto.randomUUID()
    }, err?.status || 500);
  }
}

export async function handleHealth(context) {
  const cfg = configStatus(context.env);
  let meta = {};
  let sheet_ok = false;
  let sheet_error = '';

  if (cfg.sheet_id_configured && cfg.oauth_configured) {
    try {
      meta = await getMeta(context.env);
      requireReadyExactIndex(meta);
      await getIndexMap(context.env, 'INDEX_LEN', 'len', meta);
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
    similarity_threshold: Number(env.SIMILARITY_THRESHOLD || DEFAULT_SIMILARITY_THRESHOLD),
    similarity_direct_reject_threshold: getSimilarityDirectRejectThreshold(env),
    max_candidates: Number(env.MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES),
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
function getSimilarityWeights(env) {
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
function getSimilarityDirectRejectThreshold(env) {
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
  const batchRows = Math.max(1, Number(env.MAX_BATCH_ROWS || DEFAULT_MAX_BATCH_ROWS));
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
    top_candidates: [],
    stats: {
      scanned_candidates: 0, compared_candidates: 0, skipped_by_prefilter: 0,
      batches_processed: 0, candidate_space: 0, coverage_complete: false,
      scan_limit_reached: false, elapsed_ms: 0
    }
  };

  // Independent authoritative signals: KTP is not allowed to hide an exact
  // name+address match on a DIFFERENT BP. Surface both to human reviewers.
  // Neither exact path consumes MAX_CANDIDATES or invokes fuzzy scanning.
  const ktpMatch = ktpInput ? await findExactKtp(ktpInput, env, meta) : null;
  if (ktpMatch) {
    result.exact_ktp_match = sanitizeBpRow(ktpMatch, 100, { reason: 'KTP Exact Match' });
  }

  let nameAddressExact = { matches: [], count: 0, diagnostics: result.exact_lookup };
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
    result.identity_conflict = Boolean(ktpBpId && nameAddressExact.matches.some(
      m => String(m.bp_id) !== ktpBpId));
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
  const maxLenDiff = getMaxLenDiff(env, textLen);
  const bucketIds = bucketRange(textLen, maxLenDiff);
  const ordered = bucketIds.sort((a, b) =>
    (Math.abs(Number(a) - Math.floor(textLen / 5)) - Math.abs(Number(b) - Math.floor(textLen / 5)))
    || (Number(a) - Number(b)));
  const candidateSpace = ordered.reduce((sum, bucket) => sum + (lenIndex.get(bucket)?.count || 0), 0);
  result.stats.candidate_space = candidateSpace;

  const best = [];
  let found = null;
  let scanned = 0;
  let compared = 0;
  let skipped = 0;
  let batches = 0;

  for (const bucket of ordered) {
    const info = lenIndex.get(String(bucket));
    if (!info) continue;
    let rowStart = info.row_start;
    while (rowStart <= info.row_end && scanned < maxCandidates) {
      const chunkEnd = Math.min(rowStart + batchRows - 1, info.row_end, rowStart + maxCandidates - scanned - 1);
      const rows = await getSheetRange(env, `BP_DATABASE!A${rowStart}:H${chunkEnd}`, meta.sync_id);
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
        if (candidate.norm_text !== queryText && !quickPrefilter(queryText, candidate.norm_text).pass) {
          skipped += 1;
          continue;
        }
        compared += 1;
        const score = computeSimilarity(queryText, candidate.norm_text, weights, directRejectThreshold);
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
    if (scanned >= maxCandidates) break;
  }

  const complete = scanned === candidateSpace;
  result.stats = {
    scanned_candidates: scanned, compared_candidates: compared,
    skipped_by_prefilter: skipped, batches_processed: batches,
    candidate_space: candidateSpace, coverage_complete: complete,
    scan_limit_reached: !complete, elapsed_ms: Date.now() - started
  };
  result.top_candidates = best;
  if (found) {
    result.decision = 'FAIL';
    result.similarity_match = found;
    result.reason = complete
      ? `Name 1 + Address similarity match found (score ${found.score}%).`
      : `Name 1 + Address similarity match found (score ${found.score}%). Search cap reached; additional candidates were not checked.`;
  } else if (complete) {
    result.decision = 'PASS';
    result.reason = 'No exact or fuzzy duplicate found in the completed configured search space.';
  } else {
    result.decision = 'INCONCLUSIVE';
    result.reason = `No match in ${scanned} of ${candidateSpace} indexed candidates; scan limit reached. This is NOT a PASS.`;
  }
  return result;
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

function exactNameAddressHash(name, address) {
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
  if (!info) return { matches: [], count: 0, diagnostics: { attempted: true, index_version: meta.exact_index_version, shard_present: false, shard_rows: 0, matching_index_rows: 0, verified_matches: 0 } };
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
  // Bound row lookups if many BP share the same name and address.  The index
  // supplies the total number of identical keys; five previews are sufficient.
  for (const pointer of pointers.slice(0, 5)) {
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
  return { matches, count: pointers.length, diagnostics: { attempted: true, index_version: meta.exact_index_version, shard_present: true, shard_rows: rows.length, matching_index_rows: pointers.length, verified_matches: matches.length } }; 
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

async function getIndexMap(env, tabName, type, meta) {
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
  setCached(cacheKey, map, Number(env.RANGE_CACHE_SECONDS || DEFAULT_RANGE_CACHE_SECONDS));
  return map;
}

async function getSheetRange(env, rangeA1, syncId = '', fresh = false) {
  const cacheSeconds = Number(env.RANGE_CACHE_SECONDS || DEFAULT_RANGE_CACHE_SECONDS);
  const sheetId = getSheetId(env);
  if (!sheetId) throw httpError(500, 'SHEET_ID is not configured.');
  const cacheKey = `range:${sheetId}:${syncId}:${rangeA1}`;
  const cached = fresh ? null : getCached(cacheKey);
  if (cached) return cached;
  const token = await getGoogleAccessToken(env);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(rangeA1)}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw httpError(502, `Google Sheets API error ${res.status}: ${txt.slice(0, 600)}`);
  }
  const data = await res.json();
  const values = data.values || [];
  if (!fresh) setCached(cacheKey, values, cacheSeconds);
  return values;
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

function sanitizeBpRow(row, score, extra = {}) {
  return {
    bp_id: row.bp_id,
    bp_type_id: row.bp_type_id,
    name_1: row.name_1,
    address_preview: preview(row.address, 120),
    score: round2(score),
    ...extra
  };
}

function computeSimilarity(a, b, weights, directRejectThreshold = DEFAULT_SIMILARITY_DIRECT_REJECT_THRESHOLD) {
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

  const jac = round2(jaccardSimilarity(tokens(a), tokens(b)));
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

  const num = round2(numericWeightedSimilarity(numericTokens(a), numericTokens(b)));
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

function tokens(s) {
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
function numericTokens(normText) {
  return String(normText || '').match(/\d+/g) || [];
}

function firstUsefulToken(set) {
  for (const t of set) {
    if (t.length >= 3 && !['jl', 'jalan', 'rt', 'rw', 'no'].includes(t)) return t;
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(pt|cv|tbk|ud|toko|tk|jl|jalan|gg|gang|no|nomor)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDigits(value) {
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

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function maskKtp(ktp) {
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
