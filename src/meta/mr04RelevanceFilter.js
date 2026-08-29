function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('```')) return trimmed;

  const lines = trimmed.split(/\r?\n/);
  if (!lines.length) return trimmed;

  if (lines[0].startsWith('```')) lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
  return lines.join('\n').trim();
}

function tryParseJsonValue(value) {
  if (typeof value !== 'string') return null;
  const cleaned = stripCodeFence(value);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function looksLikeDecisionItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;

  const adArchiveId = item.adArchiveId || item.ad_archive_id || item.archiveId || item.adId || item.id;
  const decision = item.decision || item.status || item.classification || item.relevanceStatus || item.relevance_status;

  return Boolean(adArchiveId && decision);
}

function extractDecisionArray(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    if (payload.some(looksLikeDecisionItem)) {
      return payload;
    }

    if (payload.length === 1 && payload[0] && typeof payload[0] === 'object' && !Array.isArray(payload[0])) {
      const nested = extractDecisionArray(payload[0]);
      if (nested.length) return nested;
    }

    return payload;
  }

  if (typeof payload !== 'object') {
    return [];
  }

  const candidates = [
    payload.decisions,
    payload.items,
    payload.results,
    payload.data,
    payload.output,
    payload.response,
    payload.result,
    payload.body,
    payload.payload,
    payload.message,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const parsedCandidate = tryParseJsonValue(candidate);
      if (parsedCandidate != null) {
        const nested = extractDecisionArray(parsedCandidate);
        if (nested.length) return nested;
      }
    }

    if (Array.isArray(candidate)) {
      if (candidate.some(looksLikeDecisionItem)) {
        return candidate;
      }

      for (const item of candidate) {
        const nested = extractDecisionArray(item);
        if (nested.length) return nested;
      }
    }

    if (candidate && typeof candidate === 'object') {
      const nested = extractDecisionArray(candidate);
      if (nested.length) return nested;
    }
  }

  for (const value of Object.values(payload)) {
    if (typeof value === 'string') {
      const parsed = tryParseJsonValue(value);
      if (parsed != null) {
        const nested = extractDecisionArray(parsed);
        if (nested.length) return nested;
      }
      continue;
    }

    if (value && typeof value === 'object') {
      const nested = extractDecisionArray(value);
      if (nested.length) return nested;
    }
  }

  return [];
}

function normalizeDecisionValue(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (raw === 'KEEP' || raw === 'ACCEPT' || raw === 'USEFUL' || raw === 'RELEVANT') {
    return 'KEEP';
  }

  if (raw === 'REVIEW' || raw === 'POTENTIAL' || raw === 'MAYBE' || raw === 'UNCERTAIN') {
    return 'REVIEW';
  }

  if (raw === 'REJECT' || raw === 'TRASH' || raw === 'SPAM' || raw === 'IRRELEVANT' || raw === 'SMIEC' || raw === 'ŚMIEĆ' || raw === 'SMIECI') {
    return 'REJECT';
  }

  return raw;
}

function normalizeDecisionItem(item) {
  const adArchiveId = String(item?.adArchiveId || item?.ad_archive_id || item?.archiveId || item?.adId || item?.id || '').trim();
  const decision = normalizeDecisionValue(item?.decision || item?.status || item?.classification || item?.relevanceStatus || item?.relevance_status || '');

  const confidenceRaw = Number(item?.confidence ?? item?.score ?? item?.relevanceConfidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
    : null;

  return {
    adArchiveId,
    decision,
    confidence,
    reasonCode: item?.reasonCode ? String(item.reasonCode) : (item?.reason_code ? String(item.reason_code) : (item?.code ? String(item.code) : null)),
    reason: item?.reason ? String(item.reason) : (item?.explanation ? String(item.explanation) : null),
  };
}

function normalizeDecisionItems(rawItems) {
  const normalized = [];
  const invalid = [];

  for (const rawItem of rawItems || []) {
    const item = normalizeDecisionItem(rawItem);
    const validDecision = item.decision === 'KEEP' || item.decision === 'REVIEW' || item.decision === 'REJECT';

    if (!item.adArchiveId || !validDecision) {
      invalid.push(item);
      continue;
    }

    normalized.push(item);
  }

  return { normalized, invalid };
}

function extractFilterVersion(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'mr04';
  }

  const candidate = payload.filterVersion || payload.modelVersion || payload.version || payload.workflowVersion;
  if (!candidate) return 'mr04';
  return String(candidate);
}

async function runMr04Webhook({ webhookUrl, timeoutMs, payload }) {
  const started = Date.now();

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const wrapped = new Error(
      error.name === 'TimeoutError'
        ? `MR04 request timed out after ${Math.floor(timeoutMs / 1000)} seconds`
        : error.message,
    );
    wrapped.code = 'MR04_REQUEST_FAILED';
    throw wrapped;
  }

  const durationMs = Date.now() - started;
  const rawText = await response.text();

  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    const error = new Error('MR04 response is not valid JSON');
    error.code = 'MR04_INVALID_JSON';
    error.upstreamStatus = response.status;
    throw error;
  }

  if (parsed && typeof parsed === 'object' && parsed.errorMessage && parsed.n8nDetails) {
    const error = new Error(String(parsed.errorMessage));
    error.code = 'MR04_WORKFLOW_ERROR';
    error.upstreamStatus = response.status;
    error.data = parsed;
    throw error;
  }

  if (!response.ok) {
    const error = new Error('MR04 webhook returned non-2xx response');
    error.code = 'MR04_NON_2XX';
    error.upstreamStatus = response.status;
    error.data = parsed;
    throw error;
  }

  const rawItems = extractDecisionArray(parsed);
  const { normalized, invalid } = normalizeDecisionItems(rawItems);

  if (!normalized.length) {
    const error = new Error('MR04 response does not contain valid decisions');
    error.code = 'MR04_INVALID_SHAPE';
    error.upstreamStatus = response.status;
    error.data = parsed;
    throw error;
  }

  return {
    durationMs,
    upstreamStatus: response.status,
    filterVersion: extractFilterVersion(parsed),
    decisions: normalized,
    invalidDecisions: invalid,
    raw: parsed,
  };
}

module.exports = {
  runMr04Webhook,
};
