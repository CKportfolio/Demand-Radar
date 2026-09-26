const http = require('http');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const { loadLocalEnv } = require('./src/config/loadEnv');
loadLocalEnv(__dirname);

const { initDatabase } = require('./src/db/database');
const {
  listProjects,
  getProjectWithVersions,
  getProjectById,
  deleteProject,
} = require('./src/db/projectRepository');
const {
  saveProjectPlanVersion,
  getPlanVersionById,
} = require('./src/db/planRepository');
const {
  getLatestDiscoveryPlanForProject,
  getLatestQueryPlanForProject,
  getQueryPlanById,
  saveGeneratedQueryPlan,
  saveDraftQueryPlan,
  approveQueryPlan,
} = require('./src/db/queryPlanRepository');
const {
  getResearchRunById,
  getResearchRunWithQueryRuns,
  getLatestResearchRunWithQueryRuns,
  getResearchRunAds,
  countResearchRunAds,
  getProjectAdDetails,
  getResearchRunRelevanceSummary,
  getResearchRunLifecycleSummary,
  getProjectRelevancePendingCount,
  getProjectMr05PendingCount,
  getProjectAdsForRelevanceReview,
  getProjectAdsForMr05Review,
  applyMr04Decisions,
  applyMr05Decisions,
  setProjectAdManualRelevance,
  restoreProjectAdRelevanceToMr04,
  getProjectRelevanceResetCount,
  restoreProjectRelevanceBatch,
  rebuildOfferFamilies,
  getProjectOfferFamilies,
} = require('./src/db/metaResearchRepository');
const {
  saveRelevanceJobProgress,
  getRelevanceJobProgress,
  clearRelevanceJobProgress,
  markInterruptedRelevanceJobs,
} = require('./src/db/relevanceJobRepository');
const { createMetaAdsHarvester } = require('./src/meta/metaAdsHarvester');
const { runRelevanceWebhook } = require('./src/meta/mr04RelevanceFilter');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7654);
const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'http://127.0.0.1:5678').replace(/\/+$/, '');
const MR03_WEBHOOK_URL = (process.env.MR03_WEBHOOK_URL || `${N8N_BASE_URL}/webhook/mr03-query-planner`).replace(/\/+$/, '');
const MR04_WEBHOOK_URL = (process.env.MR04_WEBHOOK_URL || `${N8N_BASE_URL}/webhook/mr04-filter-ads-paced-v4`).replace(/\/+$/, '');
const MR04_TEST_WEBHOOK_URL = (process.env.MR04_TEST_WEBHOOK_URL || `${N8N_BASE_URL}/webhook-test/mr04-filter-ads-paced-v4`).replace(/\/+$/, '');
const MR05_WEBHOOK_URL = (process.env.MR05_WEBHOOK_URL || `${N8N_BASE_URL}/webhook/mr05-resolve-potential-v1`).replace(/\/+$/, '');
const MR05_TEST_WEBHOOK_URL = (process.env.MR05_TEST_WEBHOOK_URL || `${N8N_BASE_URL}/webhook-test/mr05-resolve-potential-v1`).replace(/\/+$/, '');
const N8N_REQUEST_TIMEOUT_MS = Number(process.env.N8N_REQUEST_TIMEOUT_MS || 120000);
const RELEVANCE_REQUEST_TIMEOUT_MS = Number(process.env.RELEVANCE_REQUEST_TIMEOUT_MS || process.env.MR04_REQUEST_TIMEOUT_MS || 300000);
const RELEVANCE_MAX_BATCH_SIZE = boundedInteger(process.env.RELEVANCE_MAX_BATCH_SIZE, 200, 1, 200);
const RELEVANCE_DEFAULT_BATCH_SIZE = boundedInteger(
  process.env.RELEVANCE_BATCH_SIZE || process.env.MR04_BATCH_SIZE,
  20,
  1,
  RELEVANCE_MAX_BATCH_SIZE,
);
const RELEVANCE_REQUESTS_PER_MINUTE = boundedInteger(process.env.RELEVANCE_REQUESTS_PER_MINUTE || process.env.MR04_REQUESTS_PER_MINUTE, 14, 1, 14);
const RELEVANCE_REQUEST_INTERVAL_MS = Math.ceil(60000 / RELEVANCE_REQUESTS_PER_MINUTE) + 250;
const HEALTH_TIMEOUT_MS = 3000;
const mr04ResetProgressByProject = new Map();
let activeRelevanceJob = null;
let relevanceLastRequestStartedAt = 0;

const INDEX_FILE = path.join(__dirname, 'index.html');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCHEMA_FILE = path.join(__dirname, 'docs', 'architecture', 'DiscoveryPlanV1.schema.json');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, number));
}

const { db, dbPath } = initDatabase();
markInterruptedRelevanceJobs(db);
const metaHarvester = createMetaAdsHarvester(db);

const schemaJson = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateDiscoveryPlanSchema = ajv.compile(schemaJson);

function validateDiscoveryPlan(plan) {
  const valid = validateDiscoveryPlanSchema(plan);
  if (valid) {
    return { ok: true, errors: [] };
  }

  const errors = (validateDiscoveryPlanSchema.errors || []).map(error => {
    const where = error.instancePath || '/';
    return `${where}: ${error.message}`;
  });

  return { ok: false, errors };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function servePublicAsset(res, pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice('/assets/'.length));
  } catch {
    return sendText(res, 400, 'Invalid asset path');
  }

  const resolved = path.resolve(PUBLIC_DIR, relativePath);
  if (!resolved.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) {
    return sendText(res, 403, 'Forbidden');
  }

  const extension = path.extname(resolved).toLowerCase();
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };

  if (!contentTypes[extension] || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendText(res, 404, 'Asset not found');
  }

  return sendText(res, 200, fs.readFileSync(resolved), contentTypes[extension]);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });

    req.on('error', reject);
  });
}

function webhookPath(kind, mode) {
  const prefix = mode === 'production' ? '/webhook' : '/webhook-test';

  if (kind === 'mr01') return `${prefix}/mr01-generate-plan`;
  if (kind === 'mr02') return `${prefix}/mr02-revise-plan`;

  throw new Error(`Unknown workflow kind: ${kind}`);
}

async function proxyToN8n(kind, req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  const mode = body.mode === 'production' ? 'production' : 'test';
  const payload = body.payload;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'payload must be a JSON object',
    });
  }

  const pathname = webhookPath(kind, mode);
  const url = `${N8N_BASE_URL}${pathname}`;
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(N8N_REQUEST_TIMEOUT_MS),
    });

    const durationMs = Date.now() - started;
    const raw = await response.text();

    let data = raw;
    let isJson = false;

    try {
      data = raw ? JSON.parse(raw) : null;
      isJson = true;
    } catch {
      // Keep raw text when upstream returns non-JSON.
    }

    return sendJson(res, 200, {
      ok: response.ok,
      upstreamStatus: response.status,
      durationMs,
      mode,
      webhookPath: pathname,
      targetUrl: url,
      isJson,
      data,
      raw: isJson ? undefined : raw,
    });
  } catch (error) {
    const durationMs = Date.now() - started;
    return sendJson(res, 502, {
      ok: false,
      upstreamStatus: null,
      durationMs,
      mode,
      webhookPath: pathname,
      targetUrl: url,
      error: error.name === 'TimeoutError'
        ? `n8n request timed out after ${Math.floor(N8N_REQUEST_TIMEOUT_MS / 1000)} seconds`
        : error.message,
    });
  }
}

async function checkN8n(res) {
  const started = Date.now();

  try {
    const response = await fetch(`${N8N_BASE_URL}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    sendJson(res, 200, {
      reachable: true,
      status: response.status,
      durationMs: Date.now() - started,
      baseUrl: N8N_BASE_URL,
    });
  } catch (error) {
    sendJson(res, 200, {
      reachable: false,
      durationMs: Date.now() - started,
      baseUrl: N8N_BASE_URL,
      error: error.message,
    });
  }
}

function getDbSizeInfo() {
  const stats = fs.statSync(dbPath);
  const bytes = stats.size;
  const mb = bytes / (1024 * 1024);
  return {
    bytes,
    megabytes: Number(mb.toFixed(2)),
    fileName: path.basename(dbPath),
  };
}

function parseProjectId(pathname, suffix = '') {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^/api/projects/([^/]+)${escapedSuffix}$`);
  const match = pathname.match(pattern);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

function parsePlanVersionId(pathname) {
  const match = pathname.match(/^\/api\/plan-versions\/([^/]+)$/);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

function parseQueryPlanId(pathname, suffix = '') {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^/api/query-plans/([^/]+)${escapedSuffix}$`);
  const match = pathname.match(pattern);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

function parseMetaResearchRunId(pathname, suffix = '') {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^/api/meta-research/([^/]+)${escapedSuffix}$`);
  const match = pathname.match(pattern);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

function parseProjectAdArchive(pathname, suffix = '') {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^/api/projects/([^/]+)/ads/([^/]+)${escapedSuffix}$`);
  const match = pathname.match(pattern);
  if (!match) return null;

  return {
    projectId: decodeURIComponent(match[1]),
    adArchiveId: decodeURIComponent(match[2]),
  };
}

async function handleSaveProject(req, res, projectId) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  const brief = body.brief;
  const plan = body.plan;
  const sourceEvent = body.sourceEvent;
  const parentVersionId = body.parentVersionId || null;

  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'brief must be a JSON object',
    });
  }

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'plan must be a JSON object',
    });
  }

  if (typeof sourceEvent !== 'string') {
    return sendJson(res, 400, {
      ok: false,
      error: 'sourceEvent is required',
    });
  }

  try {
    const result = saveProjectPlanVersion({
      db,
      validatePlan: validateDiscoveryPlan,
      projectId,
      brief,
      plan,
      sourceEvent,
      parentVersionId,
    });

    return sendJson(res, 200, {
      ok: true,
      alreadySaved: result.alreadySaved,
      project: result.project,
      version: result.version,
    });
  } catch (error) {
    if (error.code === 'INVALID_PLAN') {
      return sendJson(res, 400, {
        ok: false,
        error: error.message,
      });
    }

    if (error.code === 'INVALID_PARENT') {
      return sendJson(res, 400, {
        ok: false,
        error: error.message,
      });
    }

    if (error.message === 'Invalid sourceEvent') {
      return sendJson(res, 400, {
        ok: false,
        error: 'sourceEvent must be one of LLM_GENERATION, LLM_REVISION, MANUAL_REVISION',
      });
    }

    return sendJson(res, 500, {
      ok: false,
      error: error.message,
    });
  }
}

function extractPlannerPayload(rawPayload) {
  if (!rawPayload) return null;

  if (Array.isArray(rawPayload) && rawPayload.length === 1 && rawPayload[0] && typeof rawPayload[0] === 'object') {
    return extractPlannerPayload(rawPayload[0]);
  }

  if (rawPayload && typeof rawPayload === 'object') {
    if (Array.isArray(rawPayload.seedPlans)) {
      return rawPayload;
    }

    if (rawPayload.data && typeof rawPayload.data === 'object' && Array.isArray(rawPayload.data.seedPlans)) {
      return rawPayload.data;
    }
  }

  return null;
}

async function handleGetProjectQueryPlanContext(req, res, projectId) {
  const context = getLatestDiscoveryPlanForProject(db, projectId);

  if (!context) {
    return sendJson(res, 404, {
      ok: false,
      error: 'No discovery plan found for this project',
    });
  }

  const latestQueryPlan = getLatestQueryPlanForProject(db, projectId);

  return sendJson(res, 200, {
    ok: true,
    projectId,
    country: context.country,
    sourcePlanVersion: context.sourcePlanVersion,
    seeds: context.seeds,
    queryPlan: latestQueryPlan,
  });
}

async function handleGenerateQueryPlan(req, res, projectId) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  const context = getLatestDiscoveryPlanForProject(db, projectId);
  if (!context) {
    return sendJson(res, 404, {
      ok: false,
      error: 'No discovery plan found for this project',
    });
  }

  const sourceSeeds = context.seeds.filter(seed => seed.enabled);
  let seedsCandidate = sourceSeeds.length ? sourceSeeds : context.seeds;

  if (Array.isArray(body.seedIds) && body.seedIds.length) {
    const wanted = new Set(body.seedIds.map(value => String(value || '').trim()).filter(Boolean));
    seedsCandidate = seedsCandidate.filter(seed => wanted.has(String(seed.seedId)));
  }

  const seedLimitRaw = Number(body.seedLimit);
  const seedLimit = Number.isFinite(seedLimitRaw) && seedLimitRaw > 0
    ? Math.floor(seedLimitRaw)
    : null;
  const seedsForPlanner = seedLimit ? seedsCandidate.slice(0, seedLimit) : seedsCandidate;

  if (!seedsForPlanner.length) {
    return sendJson(res, 400, {
      ok: false,
      error: 'No seeds available in latest discovery plan',
    });
  }

  const maxQueriesPerSeedRaw = Number(body.maxQueriesPerSeed);
  const maxQueriesPerSeed = Number.isFinite(maxQueriesPerSeedRaw) && maxQueriesPerSeedRaw > 0
    ? Math.floor(maxQueriesPerSeedRaw)
    : 6;

  const country = String(body.country || context.country || 'PL').trim() || 'PL';

  const plannerRequest = {
    projectId,
    country,
    maxQueriesPerSeed,
    seeds: seedsForPlanner.map(seed => ({
      seedId: seed.seedId,
      text: seed.text,
      source: seed.source,
    })),
  };

  const started = Date.now();

  try {
    const response = await fetch(MR03_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(plannerRequest),
      signal: AbortSignal.timeout(N8N_REQUEST_TIMEOUT_MS),
    });

    const durationMs = Date.now() - started;
    const raw = await response.text();

    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      return sendJson(res, 502, {
        ok: false,
        upstreamStatus: response.status,
        durationMs,
        targetUrl: MR03_WEBHOOK_URL,
        error: 'Planowanie zapytań (MR03) zwróciło odpowiedź, która nie jest poprawnym JSON-em.',
      });
    }

    if (!response.ok) {
      return sendJson(res, 502, {
        ok: false,
        upstreamStatus: response.status,
        durationMs,
        targetUrl: MR03_WEBHOOK_URL,
        error: 'Planowanie zapytań (MR03) zwróciło błąd webhooka.',
        data: parsed,
      });
    }

    const plannerPayload = extractPlannerPayload(parsed);

    if (!plannerPayload || !Array.isArray(plannerPayload.seedPlans)) {
      return sendJson(res, 502, {
        ok: false,
        upstreamStatus: response.status,
        durationMs,
        targetUrl: MR03_WEBHOOK_URL,
        error: 'Odpowiedź Planowania zapytań (MR03) nie zawiera seedPlans[].',
        data: parsed,
      });
    }

    const seedInfoById = new Map();
    for (const seed of context.seeds) {
      seedInfoById.set(seed.seedId, seed);
    }

    const normalizedSeedPlans = plannerPayload.seedPlans.map(seedPlan => {
      const sourceSeedId = String(seedPlan.seedId || '').trim();
      const sourceSeed = seedInfoById.get(sourceSeedId);

      return {
        sourceSeedId,
        sourceSeedOrigin: sourceSeed ? sourceSeed.source : 'MR02',
        seedText: String(seedPlan.seedText || sourceSeed?.text || '').trim(),
        concept: String(seedPlan.concept || '').trim(),
        audience: Array.isArray(seedPlan.audience) ? seedPlan.audience : [],
        formatHints: Array.isArray(seedPlan.formatHints) ? seedPlan.formatHints : [],
        queries: Array.isArray(seedPlan.queries)
          ? seedPlan.queries.map(query => ({
            text: query.text,
            queryType: query.queryType,
            priority: query.priority,
            rationale: query.rationale,
            enabled: query.enabled !== false,
          }))
          : [],
      };
    });

    const queryPlan = saveGeneratedQueryPlan({
      db,
      projectId,
      sourcePlanVersionId: context.sourcePlanVersion.id,
      plannerVersion: plannerPayload.plannerVersion || 'mr03-query-planner-v1',
      country: plannerPayload.country || country,
      generatedAt: plannerPayload.generatedAt,
      seedPlans: normalizedSeedPlans,
    });

    return sendJson(res, 200, {
      ok: true,
      upstreamStatus: response.status,
      durationMs,
      targetUrl: MR03_WEBHOOK_URL,
      sourcePlanVersion: context.sourcePlanVersion,
      plannerRequest: {
        country,
        maxQueriesPerSeed,
        seedLimit,
        seedCount: plannerRequest.seeds.length,
      },
      plannerSummary: {
        plannerVersion: plannerPayload.plannerVersion || 'mr03-query-planner-v1',
        status: plannerPayload.status || 'DRAFT',
      },
      queryPlan,
    });
  } catch (error) {
    const durationMs = Date.now() - started;

    if (error.code === 'INVALID_QUERY_PLAN') {
      return sendJson(res, 400, {
        ok: false,
        durationMs,
        error: error.message,
      });
    }

    return sendJson(res, 502, {
      ok: false,
      durationMs,
      targetUrl: MR03_WEBHOOK_URL,
      error: error.name === 'TimeoutError'
        ? `Planowanie zapytań (MR03) przekroczyło limit ${Math.floor(N8N_REQUEST_TIMEOUT_MS / 1000)} sekund.`
        : error.message,
    });
  }
}

async function handleGetQueryPlanById(req, res, queryPlanId) {
  const queryPlan = getQueryPlanById(db, queryPlanId);
  if (!queryPlan) {
    return sendJson(res, 404, { ok: false, error: 'Query plan not found' });
  }

  return sendJson(res, 200, {
    ok: true,
    queryPlan,
  });
}

async function handleSaveQueryPlanDraft(req, res, queryPlanId) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  try {
    const queryPlan = saveDraftQueryPlan({
      db,
      queryPlanId,
      seedPlans: body.seedPlans,
    });

    return sendJson(res, 200, {
      ok: true,
      queryPlan,
    });
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return sendJson(res, 404, { ok: false, error: error.message });
    }

    if (error.code === 'INVALID_QUERY_PLAN') {
      return sendJson(res, 400, { ok: false, error: error.message });
    }

    return sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleApproveQueryPlan(req, res, queryPlanId) {
  try {
    const queryPlan = approveQueryPlan({ db, queryPlanId });

    return sendJson(res, 200, {
      ok: true,
      queryPlan,
      message: 'Query Plan zatwierdzony. Gotowy do badania przez Apify.',
    });
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return sendJson(res, 404, { ok: false, error: error.message });
    }

    return sendJson(res, 500, { ok: false, error: error.message });
  }
}

function parseOptionalInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsvList(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  return [...new Set(raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean))];
}

async function handleStartMetaResearch(req, res, projectId) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  try {
    const run = metaHarvester.startResearchRun({
      projectId,
      queryPlanId: body.queryPlanId ? String(body.queryPlanId) : null,
      queryLimit: parseOptionalInt(body.queryLimit),
      maxPagesPerQuery: parseOptionalInt(body.maxPagesPerQuery),
    });

    return sendJson(res, 202, {
      ok: true,
      run,
    });
  } catch (error) {
    if (error.code === 'QUERY_PLAN_NOT_FOUND') {
      return sendJson(res, 404, { ok: false, error: error.message });
    }

    if (error.code === 'QUERY_PLAN_NOT_APPROVED' || error.code === 'NO_ENABLED_QUERIES') {
      return sendJson(res, 400, { ok: false, error: error.message });
    }

    if (error.code === 'APIFY_TOKEN_MISSING') {
      return sendJson(res, 500, {
        ok: false,
        error: 'Apify token is not configured. Set APIFY_API_TOKEN in .env.',
      });
    }

    return sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleGetLatestMetaResearch(req, res, projectId) {
  const run = getLatestResearchRunWithQueryRuns(db, projectId);

  return sendJson(res, 200, {
    ok: true,
    run,
  });
}

async function handleGetMetaResearchRun(req, res, runId) {
  const run = getResearchRunWithQueryRuns(db, runId);
  if (!run) {
    return sendJson(res, 404, { ok: false, error: 'Meta research run not found' });
  }

  return sendJson(res, 200, {
    ok: true,
    run,
  });
}

async function handleGetMetaResearchStats(req, res, runId) {
  const run = getResearchRunWithQueryRuns(db, runId);
  if (!run) {
    return sendJson(res, 404, { ok: false, error: 'Meta research run not found' });
  }

  return sendJson(res, 200, {
    ok: true,
    run,
    relevanceSummary: getResearchRunRelevanceSummary(db, runId),
    lifecycleSummary: getResearchRunLifecycleSummary(db, runId, {}),
    refreshedAt: new Date().toISOString(),
  });
}

async function handleGetMetaResearchAds(req, res, runId, requestUrl) {
  const includeMeta = requestUrl.searchParams.get('includeMeta') !== '0';
  const run = includeMeta
    ? getResearchRunWithQueryRuns(db, runId)
    : getResearchRunById(db, runId);
  if (!run) {
    return sendJson(res, 404, { ok: false, error: 'Meta research run not found' });
  }

  const filters = {
    queryText: requestUrl.searchParams.get('query') || '',
    seedText: requestUrl.searchParams.get('seed') || '',
    relevanceScope: requestUrl.searchParams.get('relevance') || 'ALL',
    pageName: requestUrl.searchParams.get('page') || '',
    activeState: requestUrl.searchParams.get('active') || 'ALL',
    minReach: requestUrl.searchParams.get('minReach') || '',
    startDate: requestUrl.searchParams.get('startDate') || '',
    visibleTextMatch: requestUrl.searchParams.get('visible') || 'ALL',
    lifecycle: requestUrl.searchParams.get('lifecycle') || 'ALL',
    lifecycleValues: parseCsvList(requestUrl.searchParams.get('lifecycles')),
    familyClass: requestUrl.searchParams.get('familyClass') || 'ALL',
    familyStatus: requestUrl.searchParams.get('familyStatus') || 'ALL',
    familyPattern: requestUrl.searchParams.get('familyPattern') || 'ALL',
    sortBy: requestUrl.searchParams.get('sortBy') || 'lastSeen',
    sortDirection: requestUrl.searchParams.get('sortDirection') || 'desc',
  };

  const limit = Math.max(1, Math.min(100, parseOptionalInt(requestUrl.searchParams.get('limit')) || 20));
  const offset = Math.max(0, parseOptionalInt(requestUrl.searchParams.get('offset')) || 0);
  const knownTotal = parseOptionalInt(requestUrl.searchParams.get('knownTotal'));
  const total = !includeMeta && knownTotal != null && knownTotal >= 0
    ? knownTotal
    : countResearchRunAds(db, runId, filters);
  const ads = getResearchRunAds(db, runId, filters, {
    limit,
    offset,
  });

  return sendJson(res, 200, {
    ok: true,
    run: includeMeta ? run : undefined,
    filters,
    ads,
    pagination: {
      limit,
      offset,
      returned: ads.length,
      total,
      nextOffset: offset + ads.length,
      hasMore: offset + ads.length < total,
    },
    relevanceSummary: includeMeta ? getResearchRunRelevanceSummary(db, runId) : undefined,
    lifecycleSummary: includeMeta ? getResearchRunLifecycleSummary(db, runId, filters) : undefined,
  });
}

async function handleGetMetaResearchOfferFamilies(req, res, runId, requestUrl) {
  const run = getResearchRunById(db, runId);
  if (!run) {
    return sendJson(res, 404, { ok: false, error: 'Meta research run not found' });
  }

  const familyClass = requestUrl.searchParams.get('familyClass') || 'ALL';
  const familyStatus = requestUrl.searchParams.get('familyStatus') || 'ALL';
  const familyPattern = requestUrl.searchParams.get('familyPattern') || 'ALL';

  const families = getProjectOfferFamilies(db, run.projectId, {
    familyClass,
    familyStatus,
    familyPattern,
    runId,
  });

  return sendJson(res, 200, {
    ok: true,
    runId,
    projectId: run.projectId,
    familyClass,
    familyStatus,
    familyPattern,
    families,
  });
}

async function handleRebuildProjectOfferFamilies(req, res, projectId) {
  const project = getProjectById(db, projectId);
  if (!project) {
    return sendJson(res, 404, { ok: false, error: 'Project not found' });
  }

  const summary = rebuildOfferFamilies(db, projectId);
  return sendJson(res, 200, {
    ok: true,
    ...summary,
  });
}

function simplifyQueryPlanForRelevance(queryPlan) {
  if (!queryPlan) return null;

  return {
    id: queryPlan.id,
    plannerVersion: queryPlan.plannerVersion,
    country: queryPlan.country,
    status: queryPlan.status,
    updatedAt: queryPlan.updatedAt,
    seedPlans: (queryPlan.seedPlans || []).map(seedPlan => ({
      sourceSeedId: seedPlan.sourceSeedId,
      sourceSeedOrigin: seedPlan.sourceSeedOrigin,
      seedText: seedPlan.seedText,
      concept: seedPlan.concept,
      audience: seedPlan.audience || [],
      formatHints: seedPlan.formatHints || [],
    })),
  };
}

const RELEVANCE_STAGES = {
  MR04: {
    label: 'Filtrowanie danych (MR04)',
    getPendingCount: getProjectRelevancePendingCount,
    getCandidates: getProjectAdsForRelevanceReview,
    applyDecisions: applyMr04Decisions,
    productionUrl: MR04_WEBHOOK_URL,
    testUrl: MR04_TEST_WEBHOOK_URL,
    pendingLabel: 'niezaklasyfikowanych',
  },
  MR05: {
    label: 'Rozstrzyganie wyników niejednoznacznych (MR05)',
    getPendingCount: getProjectMr05PendingCount,
    getCandidates: getProjectAdsForMr05Review,
    applyDecisions: applyMr05Decisions,
    productionUrl: MR05_WEBHOOK_URL,
    testUrl: MR05_TEST_WEBHOOK_URL,
    pendingLabel: 'potencjalnych',
  },
};

function getRelevanceStageConfig(stage) {
  const normalized = String(stage || '').trim().toUpperCase();
  const config = RELEVANCE_STAGES[normalized];
  if (!config) throw new Error(`Unsupported relevance stage: ${stage}`);
  return { stage: normalized, ...config };
}

function idleRelevanceProgress(projectId, stage) {
  return {
    projectId,
    stage,
    status: 'IDLE',
    phase: 'IDLE',
    totalBatches: 0,
    completedBatches: 0,
    totalAds: 0,
    processedAds: 0,
    error: null,
  };
}

function updateRelevanceProgress(projectId, stage, patch) {
  const current = getRelevanceJobProgress(db, projectId, stage)
    || idleRelevanceProgress(projectId, stage);
  return saveRelevanceJobProgress(db, {
    ...current,
    ...patch,
    projectId,
    stage,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  });
}

async function handleGetProjectRelevancePending(req, res, projectId, stage = 'MR04') {
  const project = getProjectById(db, projectId);
  if (!project) {
    return sendJson(res, 404, { ok: false, error: 'Project not found' });
  }

  const config = getRelevanceStageConfig(stage);
  const pending = config.getPendingCount(db, projectId);
  return sendJson(res, 200, {
    ok: true,
    projectId,
    stage: config.stage,
    pending,
  });
}


function waitMs(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

function buildRelevanceErrorDetails(error, stage) {
  return {
    message: error?.message || `Nieznany błąd ${stage}`,
    code: error?.code || null,
    upstreamStatus: error?.upstreamStatus || null,
    data: error?.data || null,
  };
}

async function waitForRelevanceRateLimit(projectId, stage, completedBeforeBatch) {
  const elapsed = Date.now() - relevanceLastRequestStartedAt;
  const waitFor = Math.max(0, RELEVANCE_REQUEST_INTERVAL_MS - elapsed);

  if (waitFor > 0) {
    updateRelevanceProgress(projectId, stage, {
      phase: 'RATE_LIMIT_WAIT',
      currentBatch: completedBeforeBatch + 1,
      nextRequestInMs: waitFor,
    });
    await waitMs(waitFor);
  }

  relevanceLastRequestStartedAt = Date.now();
}

function isRelevanceStopRequested(projectId, stage) {
  return Boolean(
    activeRelevanceJob
    && activeRelevanceJob.projectId === projectId
    && activeRelevanceJob.stage === stage
    && activeRelevanceJob.stopRequested,
  );
}

function savePausedRelevanceProgress({
  projectId,
  stage,
  mode,
  batchSize,
  candidates,
  aggregate,
}) {
  const now = new Date().toISOString();
  const current = getRelevanceJobProgress(db, projectId, stage)
    || idleRelevanceProgress(projectId, stage);
  updateRelevanceProgress(projectId, stage, {
    status: 'PAUSED',
    phase: 'PAUSED',
    stopRequested: false,
    result: {
      ...aggregate,
      projectId,
      stage,
      pendingBefore: candidates.length,
      totalBatches: Number(current.totalBatches || 0),
      batchSize,
      batchesCompleted: Number(current.completedBatches || 0),
      mode,
      paused: true,
    },
    error: null,
    pausedAt: now,
    updatedAt: now,
    finishedAt: now,
  });
}

async function runRelevanceJob({
  stage,
  project,
  mode,
  batchSize,
  webhookUrl,
  candidates,
  batches,
  resumeBaseAds = 0,
  resumeBaseBatches = 0,
  jobTotalAds,
  jobTotalBatches,
  queryPlanPayload,
}) {
  const config = getRelevanceStageConfig(stage);
  const projectId = project.id;
  const aggregate = {
    processed: 0,
    keep: 0,
    potential: 0,
    reject: 0,
    skippedManual: 0,
    missing: 0,
    invalid: 0,
    skippedNotPotential: 0,
    durationMs: 0,
    filterVersion: null,
    upstreamStatus: null,
  };

  try {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      if (isRelevanceStopRequested(projectId, stage)) {
        savePausedRelevanceProgress({ projectId, stage, mode, batchSize, candidates, aggregate });
        return;
      }

      const batchAds = batches[batchIndex];
      await waitForRelevanceRateLimit(projectId, stage, resumeBaseBatches + batchIndex);

      if (isRelevanceStopRequested(projectId, stage)) {
        savePausedRelevanceProgress({ projectId, stage, mode, batchSize, candidates, aggregate });
        return;
      }

      updateRelevanceProgress(projectId, stage, {
        phase: 'MODEL_REQUEST',
        currentBatch: resumeBaseBatches + batchIndex + 1,
        nextRequestInMs: 0,
      });

      const relevanceResult = await runRelevanceWebhook({
        stage,
        webhookUrl,
        timeoutMs: RELEVANCE_REQUEST_TIMEOUT_MS,
        payload: {
          stage,
          mode,
          projectId,
          projectName: project.name,
          projectBrief: String(project.brief || '').slice(0, 2500),
          queryPlan: queryPlanPayload,
          batch: {
            index: resumeBaseBatches + batchIndex + 1,
            total: jobTotalBatches,
            size: batchAds.length,
          },
          ads: batchAds,
        },
      });

      const applied = config.applyDecisions(db, {
        projectId,
        decisions: relevanceResult.decisions,
        filterVersion: relevanceResult.filterVersion,
      });

      aggregate.processed += applied.processed;
      aggregate.keep += applied.keep;
      aggregate.potential += applied.potential;
      aggregate.reject += applied.reject;
      aggregate.skippedManual += applied.skippedManual;
      aggregate.skippedNotPotential += applied.skippedNotPotential || 0;
      aggregate.missing += applied.missing;
      aggregate.invalid += applied.invalid + relevanceResult.invalidDecisions.length;
      aggregate.durationMs += relevanceResult.durationMs;
      aggregate.filterVersion = relevanceResult.filterVersion;
      aggregate.upstreamStatus = relevanceResult.upstreamStatus;

      updateRelevanceProgress(projectId, stage, {
        phase: 'BATCH_APPLIED',
        completedBatches: resumeBaseBatches + batchIndex + 1,
        processedAds: Math.min(jobTotalAds, resumeBaseAds + (batchIndex * batchSize) + batchAds.length),
        result: { ...aggregate },
      });

      if (batchIndex + 1 < batches.length && isRelevanceStopRequested(projectId, stage)) {
        savePausedRelevanceProgress({ projectId, stage, mode, batchSize, candidates, aggregate });
        return;
      }
    }

    const finishedAt = new Date().toISOString();
    const result = {
      ...aggregate,
      projectId,
      stage,
      pendingBefore: candidates.length,
      totalBatches: jobTotalBatches,
      batchSize,
      batchesCompleted: jobTotalBatches,
      mode,
    };

    updateRelevanceProgress(projectId, stage, {
      status: 'COMPLETED',
      phase: 'COMPLETED',
      completedBatches: jobTotalBatches,
      processedAds: jobTotalAds,
      result,
      error: null,
      updatedAt: finishedAt,
      finishedAt,
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    updateRelevanceProgress(projectId, stage, {
      status: 'FAILED',
      phase: 'FAILED',
      error: buildRelevanceErrorDetails(error, stage),
      result: {
        ...aggregate,
        projectId,
        stage,
        pendingBefore: candidates.length,
        totalBatches: jobTotalBatches,
        batchSize,
        mode,
      },
      updatedAt: finishedAt,
      finishedAt,
    });
  } finally {
    if (activeRelevanceJob?.projectId === projectId && activeRelevanceJob?.stage === stage) {
      activeRelevanceJob = null;
    }
  }
}

async function handleRunProjectRelevanceFilter(req, res, projectId, stage = 'MR04') {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  const project = getProjectById(db, projectId);
  if (!project) {
    return sendJson(res, 404, { ok: false, error: 'Project not found' });
  }

  const config = getRelevanceStageConfig(stage);
  if (mr04ResetProgressByProject.get(projectId)?.status === 'RUNNING') {
    return sendJson(res, 409, {
      ok: false,
      error: 'Trwa cofanie segregacji. Poczekaj na zakończenie resetu przed uruchomieniem klasyfikacji.',
    });
  }
  if (activeRelevanceJob) {
    const activeConfig = getRelevanceStageConfig(activeRelevanceJob.stage);
    const progress = getRelevanceJobProgress(
      db,
      activeRelevanceJob.projectId,
      activeRelevanceJob.stage,
    );
    return sendJson(res, 409, {
      ok: false,
      error: `${activeConfig.label} już trwa. Poczekaj na zakończenie albo zatrzymaj bieżący proces.`,
      activeProjectId: activeRelevanceJob.projectId,
      activeStage: activeRelevanceJob.stage,
      progress,
    });
  }

  const mode = body.mode === 'test' ? 'test' : 'production';
  const webhookUrl = mode === 'production' ? config.productionUrl : config.testUrl;
  const batchSize = boundedInteger(
    body.batchSize,
    RELEVANCE_DEFAULT_BATCH_SIZE,
    1,
    RELEVANCE_MAX_BATCH_SIZE,
  );
  const previousProgress = getRelevanceJobProgress(db, projectId, config.stage);
  const continuesProductionRun = mode === 'production'
    && previousProgress?.mode === 'production'
    && ['FAILED', 'PAUSED'].includes(previousProgress?.status);
  const resumeBaseAds = continuesProductionRun
    ? Math.max(0, Number(previousProgress.processedAds || 0))
    : 0;
  const resumeBaseBatches = continuesProductionRun
    ? Math.max(0, Number(previousProgress.completedBatches || 0))
    : 0;
  const includeResolved = body.force === true;
  const pendingCount = config.getPendingCount(db, projectId);
  const requestedLimit = parseOptionalInt(body.limit);
  const normalLimit = Math.max(1, Math.min(10000, requestedLimit || pendingCount || 1500));
  const effectiveLimit = mode === 'test'
    ? Math.min(batchSize, normalLimit)
    : normalLimit;
  const queryPlan = getLatestQueryPlanForProject(db, projectId);
  const candidates = config.getCandidates(db, projectId, {
    includeResolved,
    limit: effectiveLimit,
  });

  if (!candidates.length) {
    return sendJson(res, 200, {
      ok: true,
      started: false,
      projectId,
      stage,
      message: `Brak reklam ${config.pendingLabel} wymagających procesu: ${config.label}.`,
      processed: 0,
      totalBatches: 0,
      totalAds: 0,
    });
  }

  const ads = candidates.map(ad => ({
    adArchiveId: ad.adArchiveId,
    pageName: ad.pageName,
    title: ad.title,
    bodyText: ad.bodyText,
    destinationUrl: ad.destinationUrl,
    adLibraryUrl: ad.adLibraryUrl,
    startDate: ad.startDate,
    endDate: ad.endDate,
    isActive: ad.isActive,
    longevityCategory: ad.longevityCategory,
    runtimeDays: ad.runtimeDays,
    mr04Decision: ad.mr04Decision,
    mr04Confidence: ad.mr04Confidence,
    mr04ReasonCode: ad.mr04ReasonCode,
    mr04Reason: ad.mr04Reason,
    matchedQueries: ad.matchedQueries,
    matchedSeeds: ad.matchedSeeds,
  }));
  const batches = [];
  for (let index = 0; index < ads.length; index += batchSize) {
    batches.push(ads.slice(index, index + batchSize));
  }
  const jobTotalAds = resumeBaseAds + ads.length;
  const jobTotalBatches = resumeBaseBatches + batches.length;

  const startedAt = new Date().toISOString();
  activeRelevanceJob = {
    projectId,
    stage,
    mode,
    stopRequested: false,
    stopRequestedAt: null,
  };
  saveRelevanceJobProgress(db, {
    projectId,
    stage,
    status: 'RUNNING',
    phase: 'QUEUED',
    mode,
    batchSize,
    maxBatchSize: RELEVANCE_MAX_BATCH_SIZE,
    rateLimitRpm: RELEVANCE_REQUESTS_PER_MINUTE,
    totalBatches: jobTotalBatches,
    completedBatches: resumeBaseBatches,
    currentBatch: resumeBaseBatches,
    totalAds: jobTotalAds,
    processedAds: resumeBaseAds,
    resumed: continuesProductionRun,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    error: null,
    result: null,
  });

  setImmediate(() => {
    runRelevanceJob({
      stage,
      project,
      mode,
      batchSize,
      webhookUrl,
      candidates,
      batches,
      resumeBaseAds,
      resumeBaseBatches,
      jobTotalAds,
      jobTotalBatches,
      queryPlanPayload: simplifyQueryPlanForRelevance(queryPlan),
    });
  });

  return sendJson(res, 202, {
    ok: true,
    started: true,
    projectId,
    stage,
    mode,
    batchSize,
    maxBatchSize: RELEVANCE_MAX_BATCH_SIZE,
    rateLimitRpm: RELEVANCE_REQUESTS_PER_MINUTE,
    totalBatches: jobTotalBatches,
    completedBatches: resumeBaseBatches,
    totalAds: jobTotalAds,
    processedAds: resumeBaseAds,
    resumed: continuesProductionRun,
    testSingleBatch: mode === 'test',
    progressUrl: `/api/projects/${encodeURIComponent(projectId)}/ads/relevance/${stage.toLowerCase()}/progress`,
  });
}

async function handleStopProjectRelevanceFilter(req, res, projectId, stage = 'MR04') {
  const config = getRelevanceStageConfig(stage);
  const project = getProjectById(db, projectId);
  if (!project) {
    return sendJson(res, 404, { ok: false, error: 'Project not found' });
  }

  if (
    !activeRelevanceJob
    || activeRelevanceJob.projectId !== projectId
    || activeRelevanceJob.stage !== config.stage
  ) {
    return sendJson(res, 409, {
      ok: false,
      error: `${config.label} nie jest teraz uruchomione.`,
      progress: getRelevanceJobProgress(db, projectId, config.stage),
    });
  }

  if (activeRelevanceJob.mode !== 'production') {
    return sendJson(res, 409, {
      ok: false,
      error: 'Tryb testowy wysyła tylko jedną paczkę i nie wymaga zatrzymywania.',
    });
  }

  const stopRequestedAt = new Date().toISOString();
  activeRelevanceJob.stopRequested = true;
  activeRelevanceJob.stopRequestedAt = stopRequestedAt;
  const progress = updateRelevanceProgress(projectId, config.stage, {
    status: 'RUNNING',
    phase: 'STOP_REQUESTED',
    stopRequested: true,
    stopRequestedAt,
  });

  return sendJson(res, 202, {
    ok: true,
    stopping: true,
    projectId,
    stage: config.stage,
    message: `${config.label} zostanie zatrzymane po zapisaniu bieżącej paczki.`,
    progress,
  });
}

async function handleGetProjectAdDetails(req, res, projectId, adArchiveId) {
  const project = getProjectById(db, projectId);
  if (!project) {
    return sendJson(res, 404, { ok: false, error: 'Project not found' });
  }

  const ad = getProjectAdDetails(db, projectId, adArchiveId);
  if (!ad) {
    return sendJson(res, 404, { ok: false, error: 'Ad not found' });
  }

  return sendJson(res, 200, { ok: true, ad });
}

async function handleSetProjectAdManualRelevance(req, res, projectId, adArchiveId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  try {
    const relevance = setProjectAdManualRelevance(db, {
      projectId,
      adArchiveId,
      relevanceStatus: body.relevanceStatus,
    });

    return sendJson(res, 200, {
      ok: true,
      relevance,
    });
  } catch (error) {
    if (error.code === 'INVALID_RELEVANCE_STATUS' || error.code === 'INVALID_AD_ARCHIVE_ID') {
      return sendJson(res, 400, { ok: false, error: error.message });
    }

    if (error.code === 'AD_NOT_FOUND') {
      return sendJson(res, 404, { ok: false, error: error.message });
    }

    return sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleRestoreProjectAdRelevance(req, res, projectId, adArchiveId) {
  try {
    const relevance = restoreProjectAdRelevanceToMr04(db, {
      projectId,
      adArchiveId,
    });

    return sendJson(res, 200, {
      ok: true,
      relevance,
    });
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return sendJson(res, 404, { ok: false, error: error.message });
    }

    return sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleRestoreProjectRelevance(req, res, projectId) {
  if (activeRelevanceJob) {
    const activeConfig = getRelevanceStageConfig(activeRelevanceJob.stage);
    return sendJson(res, 409, {
      ok: false,
      error: `${activeConfig.label} nadal trwa. Zatrzymaj lub zakończ proces przed cofnięciem segregacji.`,
    });
  }

  const running = mr04ResetProgressByProject.get(projectId);
  if (running?.status === 'RUNNING') {
    return sendJson(res, 409, {
      ok: false,
      error: 'Cofanie automatycznej segregacji (MR04/MR05) już trwa.',
      progress: running,
    });
  }

  const total = getProjectRelevanceResetCount(db, projectId);
  if (!total) {
    clearRelevanceJobProgress(db, projectId);
    return sendJson(res, 200, { ok: true, started: false, restored: 0 });
  }

  const startedAt = new Date().toISOString();
  mr04ResetProgressByProject.set(projectId, {
    projectId,
    status: 'RUNNING',
    total,
    restored: 0,
    percent: 0,
    startedAt,
    finishedAt: null,
    error: null,
  });

  setImmediate(async () => {
    let restored = 0;
    try {
      while (restored < total) {
        const changed = restoreProjectRelevanceBatch(db, projectId, 250);
        if (!changed) break;
        restored += changed;
        mr04ResetProgressByProject.set(projectId, {
          ...mr04ResetProgressByProject.get(projectId),
          restored,
          percent: Math.min(100, Math.round((restored / total) * 100)),
          updatedAt: new Date().toISOString(),
        });
        await waitMs(20);
      }

      const finishedAt = new Date().toISOString();
      mr04ResetProgressByProject.set(projectId, {
        ...mr04ResetProgressByProject.get(projectId),
        status: 'COMPLETED',
        restored,
        percent: 100,
        updatedAt: finishedAt,
        finishedAt,
      });
      clearRelevanceJobProgress(db, projectId);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      mr04ResetProgressByProject.set(projectId, {
        ...mr04ResetProgressByProject.get(projectId),
        status: 'FAILED',
        restored,
        error: error.message,
        updatedAt: finishedAt,
        finishedAt,
      });
    }
  });

  return sendJson(res, 202, {
    ok: true,
    started: true,
    projectId,
    total,
    progressUrl: `/api/projects/${encodeURIComponent(projectId)}/ads/relevance/restore-progress`,
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && requestUrl.pathname === '/') {
    try {
      const html = fs.readFileSync(INDEX_FILE, 'utf8');
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    } catch (error) {
      return sendText(res, 500, `Cannot read index.html: ${error.message}`);
    }
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
    return servePublicAsset(res, requestUrl.pathname);
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
    return checkN8n(res);
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/db-size') {
    try {
      return sendJson(res, 200, {
        ok: true,
        ...getDbSizeInfo(),
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/mr01') {
    return proxyToN8n('mr01', req, res);
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/mr02') {
    return proxyToN8n('mr02', req, res);
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/projects') {
    return sendJson(res, 200, listProjects(db));
  }

  const projectIdForDelete = parseProjectId(requestUrl.pathname);
  if (req.method === 'DELETE' && projectIdForDelete) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message });
    }

    if (body.confirm !== true) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Usunięcie projektu wymaga potwierdzenia confirm=true.',
      });
    }

    try {
      const deleted = deleteProject(db, projectIdForDelete);
      if (!deleted) {
        return sendJson(res, 404, { ok: false, error: 'Projekt nie istnieje.' });
      }
      return sendJson(res, 200, { ok: true, projectId: projectIdForDelete });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `Nie udało się usunąć projektu: ${error.message}` });
    }
  }

  const projectIdForQueryPlan = parseProjectId(requestUrl.pathname, '/query-plan');
  if (req.method === 'GET' && projectIdForQueryPlan) {
    return handleGetProjectQueryPlanContext(req, res, projectIdForQueryPlan);
  }

  const projectIdForQueryPlanGenerate = parseProjectId(requestUrl.pathname, '/query-plan/generate');
  if (req.method === 'POST' && projectIdForQueryPlanGenerate) {
    return handleGenerateQueryPlan(req, res, projectIdForQueryPlanGenerate);
  }

  const queryPlanIdForGet = parseQueryPlanId(requestUrl.pathname);
  if (req.method === 'GET' && queryPlanIdForGet) {
    return handleGetQueryPlanById(req, res, queryPlanIdForGet);
  }

  const queryPlanIdForSave = parseQueryPlanId(requestUrl.pathname, '/save');
  if (req.method === 'POST' && queryPlanIdForSave) {
    return handleSaveQueryPlanDraft(req, res, queryPlanIdForSave);
  }

  const queryPlanIdForApprove = parseQueryPlanId(requestUrl.pathname, '/approve');
  if (req.method === 'POST' && queryPlanIdForApprove) {
    return handleApproveQueryPlan(req, res, queryPlanIdForApprove);
  }

  const projectIdForMetaResearchStart = parseProjectId(requestUrl.pathname, '/meta-research');
  if (req.method === 'POST' && projectIdForMetaResearchStart) {
    return handleStartMetaResearch(req, res, projectIdForMetaResearchStart);
  }

  const projectIdForMetaResearchLatest = parseProjectId(requestUrl.pathname, '/meta-research/latest');
  if (req.method === 'GET' && projectIdForMetaResearchLatest) {
    return handleGetLatestMetaResearch(req, res, projectIdForMetaResearchLatest);
  }

  const projectIdForOfferFamiliesRebuild = parseProjectId(requestUrl.pathname, '/offer-families/rebuild');
  if (req.method === 'POST' && projectIdForOfferFamiliesRebuild) {
    return handleRebuildProjectOfferFamilies(req, res, projectIdForOfferFamiliesRebuild);
  }

  const projectIdForRelevancePending = parseProjectId(requestUrl.pathname, '/ads/relevance/pending-count');
  if (req.method === 'GET' && projectIdForRelevancePending) {
    return handleGetProjectRelevancePending(req, res, projectIdForRelevancePending, 'MR04');
  }

  const projectIdForMr05Pending = parseProjectId(requestUrl.pathname, '/ads/relevance/mr05/pending-count');
  if (req.method === 'GET' && projectIdForMr05Pending) {
    return handleGetProjectRelevancePending(req, res, projectIdForMr05Pending, 'MR05');
  }

  const projectIdForRelevanceProgress = parseProjectId(requestUrl.pathname, '/ads/relevance/progress')
    || parseProjectId(requestUrl.pathname, '/ads/relevance/mr04/progress');
  if (req.method === 'GET' && projectIdForRelevanceProgress) {
    const progress = getRelevanceJobProgress(db, projectIdForRelevanceProgress, 'MR04');
    return sendJson(res, 200, {
      ok: true,
      projectId: projectIdForRelevanceProgress,
      stage: 'MR04',
      progress: progress || idleRelevanceProgress(projectIdForRelevanceProgress, 'MR04'),
    });
  }

  const projectIdForMr05Progress = parseProjectId(requestUrl.pathname, '/ads/relevance/mr05/progress');
  if (req.method === 'GET' && projectIdForMr05Progress) {
    const progress = getRelevanceJobProgress(db, projectIdForMr05Progress, 'MR05');
    return sendJson(res, 200, {
      ok: true,
      projectId: projectIdForMr05Progress,
      stage: 'MR05',
      progress: progress || idleRelevanceProgress(projectIdForMr05Progress, 'MR05'),
    });
  }

  const projectIdForRelevanceStop = parseProjectId(requestUrl.pathname, '/ads/relevance/mr04/stop')
    || parseProjectId(requestUrl.pathname, '/ads/relevance/stop');
  if (req.method === 'POST' && projectIdForRelevanceStop) {
    return handleStopProjectRelevanceFilter(req, res, projectIdForRelevanceStop, 'MR04');
  }

  const projectIdForMr05Stop = parseProjectId(requestUrl.pathname, '/ads/relevance/mr05/stop');
  if (req.method === 'POST' && projectIdForMr05Stop) {
    return handleStopProjectRelevanceFilter(req, res, projectIdForMr05Stop, 'MR05');
  }

  const projectIdForRelevanceRun = parseProjectId(requestUrl.pathname, '/ads/relevance/run');
  if (req.method === 'POST' && projectIdForRelevanceRun) {
    return handleRunProjectRelevanceFilter(req, res, projectIdForRelevanceRun, 'MR04');
  }

  const projectIdForMr05Run = parseProjectId(requestUrl.pathname, '/ads/relevance/mr05/run');
  if (req.method === 'POST' && projectIdForMr05Run) {
    return handleRunProjectRelevanceFilter(req, res, projectIdForMr05Run, 'MR05');
  }

  const projectAdForDetails = parseProjectAdArchive(requestUrl.pathname, '/details');
  if (req.method === 'GET' && projectAdForDetails) {
    return handleGetProjectAdDetails(req, res, projectAdForDetails.projectId, projectAdForDetails.adArchiveId);
  }

  const projectAdForRestore = parseProjectAdArchive(requestUrl.pathname, '/relevance/restore-mr04');
  if (req.method === 'POST' && projectAdForRestore) {
    return handleRestoreProjectAdRelevance(req, res, projectAdForRestore.projectId, projectAdForRestore.adArchiveId);
  }

  const projectForRestore = parseProjectId(requestUrl.pathname, '/ads/relevance/restore-all');
  if (req.method === 'POST' && projectForRestore) {
    return handleRestoreProjectRelevance(req, res, projectForRestore);
  }

  const projectForRestoreProgress = parseProjectId(requestUrl.pathname, '/ads/relevance/restore-progress');
  if (req.method === 'GET' && projectForRestoreProgress) {
    return sendJson(res, 200, {
      ok: true,
      projectId: projectForRestoreProgress,
      progress: mr04ResetProgressByProject.get(projectForRestoreProgress) || {
        projectId: projectForRestoreProgress,
        status: 'IDLE',
        total: 0,
        restored: 0,
        percent: 0,
      },
    });
  }

  const projectAdForManualRelevance = parseProjectAdArchive(requestUrl.pathname, '/relevance');
  if (req.method === 'POST' && projectAdForManualRelevance) {
    return handleSetProjectAdManualRelevance(req, res, projectAdForManualRelevance.projectId, projectAdForManualRelevance.adArchiveId);
  }

  const metaResearchRunIdForStats = parseMetaResearchRunId(requestUrl.pathname, '/stats');
  if (req.method === 'GET' && metaResearchRunIdForStats) {
    return handleGetMetaResearchStats(req, res, metaResearchRunIdForStats);
  }

  const metaResearchRunId = parseMetaResearchRunId(requestUrl.pathname);
  if (req.method === 'GET' && metaResearchRunId) {
    return handleGetMetaResearchRun(req, res, metaResearchRunId);
  }

  const metaResearchRunIdForAds = parseMetaResearchRunId(requestUrl.pathname, '/ads');
  if (req.method === 'GET' && metaResearchRunIdForAds) {
    return handleGetMetaResearchAds(req, res, metaResearchRunIdForAds, requestUrl);
  }

  const metaResearchRunIdForFamilies = parseMetaResearchRunId(requestUrl.pathname, '/offer-families');
  if (req.method === 'GET' && metaResearchRunIdForFamilies) {
    return handleGetMetaResearchOfferFamilies(req, res, metaResearchRunIdForFamilies, requestUrl);
  }

  const projectIdForDetails = parseProjectId(requestUrl.pathname);
  if (req.method === 'GET' && projectIdForDetails) {
    const result = getProjectWithVersions(db, projectIdForDetails);
    if (!result) {
      return sendJson(res, 404, { ok: false, error: 'Project not found' });
    }

    return sendJson(res, 200, result);
  }

  const projectIdForSave = parseProjectId(requestUrl.pathname, '/save');
  if (req.method === 'POST' && projectIdForSave) {
    return handleSaveProject(req, res, projectIdForSave);
  }

  const planVersionId = parsePlanVersionId(requestUrl.pathname);
  if (req.method === 'GET' && planVersionId) {
    const version = getPlanVersionById(db, planVersionId);
    if (!version) {
      return sendJson(res, 404, { ok: false, error: 'Plan version not found' });
    }

    return sendJson(res, 200, version);
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  const metaConfig = metaHarvester.getConfigSnapshot();

  console.log('Market Demand Radar');
  console.log(`App: http://${HOST}:${PORT}`);
  console.log(`SQLite: ${dbPath}`);
  console.log(`n8n: ${N8N_BASE_URL}`);
  console.log(`MR03 planner: ${MR03_WEBHOOK_URL}`);
  console.log(`MR04 relevance (prod): ${MR04_WEBHOOK_URL}`);
  console.log(`MR04 relevance (test): ${MR04_TEST_WEBHOOK_URL}`);
  console.log(`MR05 relevance (prod): ${MR05_WEBHOOK_URL}`);
  console.log(`MR05 relevance (test): ${MR05_TEST_WEBHOOK_URL}`);
  console.log(`Relevance pacing: default ${RELEVANCE_DEFAULT_BATCH_SIZE} ads/batch (UI range 1-${RELEVANCE_MAX_BATCH_SIZE}), max ${RELEVANCE_REQUESTS_PER_MINUTE} requests/min`);
  console.log(`Research provider: ${metaConfig.provider} (${metaConfig.hasToken ? 'token configured' : 'token missing'})`);
  console.log(`Apify actor: ${metaConfig.actorId}`);
  console.log('');
  console.log('TEST mode uses /webhook-test/... and requires the workflow to be listening in n8n.');
  console.log('PRODUCTION mode uses /webhook/... and requires the workflow to be published/active.');
});

function shutdown() {
  try {
    db.close();
  } catch {
    // Ignore shutdown errors.
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
