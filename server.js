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
  getResearchRunWithQueryRuns,
  getLatestResearchRunWithQueryRuns,
  getResearchRunAds,
  getResearchRunRelevanceSummary,
  getResearchRunLifecycleSummary,
  getProjectRelevancePendingCount,
  getProjectAdsForRelevanceReview,
  applyMr04Decisions,
  setProjectAdManualRelevance,
  restoreProjectAdRelevanceToMr04,
  rebuildOfferFamilies,
  getProjectOfferFamilies,
} = require('./src/db/metaResearchRepository');
const { createMetaAdsHarvester } = require('./src/meta/metaAdsHarvester');
const { runMr04Webhook } = require('./src/meta/mr04RelevanceFilter');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7654);
const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'http://127.0.0.1:5678').replace(/\/+$/, '');
const MR03_WEBHOOK_URL = (process.env.MR03_WEBHOOK_URL || `${N8N_BASE_URL}/webhook/mr03-query-planner`).replace(/\/+$/, '');
const MR04_WEBHOOK_URL = (process.env.MR04_WEBHOOK_URL || `${N8N_BASE_URL}/webhook/mr04-filter-ads`).replace(/\/+$/, '');
const MR04_TEST_WEBHOOK_URL = (process.env.MR04_TEST_WEBHOOK_URL || `${N8N_BASE_URL}/webhook-test/mr04-filter-ads`).replace(/\/+$/, '');
const N8N_REQUEST_TIMEOUT_MS = Number(process.env.N8N_REQUEST_TIMEOUT_MS || 120000);
const MR04_REQUEST_TIMEOUT_MS = Number(process.env.MR04_REQUEST_TIMEOUT_MS || 300000);
const HEALTH_TIMEOUT_MS = 3000;

const INDEX_FILE = path.join(__dirname, 'index.html');
const SCHEMA_FILE = path.join(__dirname, 'docs', 'architecture', 'DiscoveryPlanV1.schema.json');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const { db, dbPath } = initDatabase();
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
        error: 'MR03 response is not valid JSON',
      });
    }

    if (!response.ok) {
      return sendJson(res, 502, {
        ok: false,
        upstreamStatus: response.status,
        durationMs,
        targetUrl: MR03_WEBHOOK_URL,
        error: 'MR03 webhook returned non-2xx response',
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
        error: 'MR03 response does not contain seedPlans[]',
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
        ? `MR03 request timed out after ${Math.floor(N8N_REQUEST_TIMEOUT_MS / 1000)} seconds`
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

async function handleGetMetaResearchAds(req, res, runId, requestUrl) {
  const run = getResearchRunWithQueryRuns(db, runId);
  if (!run) {
    return sendJson(res, 404, { ok: false, error: 'Meta research run not found' });
  }

  const rebuildSummary = rebuildOfferFamilies(db, run.projectId);

  const filters = {
    queryText: requestUrl.searchParams.get('query') || '',
    seedText: requestUrl.searchParams.get('seed') || '',
    relevanceScope: requestUrl.searchParams.get('relevance') || 'USEFUL',
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

  const ads = getResearchRunAds(db, runId, filters);
  const relevanceSummary = getResearchRunRelevanceSummary(db, runId);
  const lifecycleSummary = getResearchRunLifecycleSummary(db, runId, filters);
  const familyClass = requestUrl.searchParams.get('familyClass') || 'ALL';
  const familyStatus = requestUrl.searchParams.get('familyStatus') || 'ALL';
  const familyPattern = requestUrl.searchParams.get('familyPattern') || 'ALL';

  const offerFamilies = getProjectOfferFamilies(db, run.projectId, {
    familyClass,
    familyStatus,
    familyPattern,
    runId,
  });

  return sendJson(res, 200, {
    ok: true,
    run,
    filters,
    rebuildSummary,
    relevanceSummary,
    lifecycleSummary,
    offerFamilies,
    ads,
  });
}

async function handleGetMetaResearchOfferFamilies(req, res, runId, requestUrl) {
  const run = getResearchRunWithQueryRuns(db, runId);
  if (!run) {
    return sendJson(res, 404, { ok: false, error: 'Meta research run not found' });
  }

  const summary = rebuildOfferFamilies(db, run.projectId);
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
    summary,
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

function simplifyQueryPlanForMr04(queryPlan) {
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
      queries: (seedPlan.queries || []).map(query => ({
        text: query.text,
        queryType: query.queryType,
        priority: query.priority,
        enabled: query.enabled !== false,
      })),
    })),
  };
}

async function handleGetProjectRelevancePending(req, res, projectId) {
  const project = getProjectById(db, projectId);
  if (!project) {
    return sendJson(res, 404, { ok: false, error: 'Project not found' });
  }

  const pending = getProjectRelevancePendingCount(db, projectId);
  return sendJson(res, 200, {
    ok: true,
    projectId,
    pending,
  });
}

async function handleRunProjectRelevanceFilter(req, res, projectId) {
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

  const mode = body.mode === 'production' ? 'production' : 'test';
  const mr04WebhookUrl = mode === 'production' ? MR04_WEBHOOK_URL : MR04_TEST_WEBHOOK_URL;
  const productionBatchSize = 500;
  const minFallbackBatchSize = 50;

  const queryPlan = getLatestQueryPlanForProject(db, projectId);
  const includeResolved = body.force === true;
  const pendingCount = getProjectRelevancePendingCount(db, projectId);
  const limit = parseOptionalInt(body.limit);

  let effectiveLimit = limit || 1500;
  if (mode === 'production' && !includeResolved) {
    effectiveLimit = limit || pendingCount || 1500;
  }

  const candidates = getProjectAdsForRelevanceReview(db, projectId, {
    includeResolved,
    limit: effectiveLimit,
  });

  if (!candidates.length) {
    return sendJson(res, 200, {
      ok: true,
      projectId,
      pendingBefore: 0,
      processed: 0,
      keep: 0,
      potential: 0,
      reject: 0,
      skippedManual: 0,
      missing: 0,
      invalid: 0,
      message: 'Brak reklam wymagajacych analizy relevance.',
    });
  }

  const queryPlanPayload = simplifyQueryPlanForMr04(queryPlan);
  const baseAds = candidates.map(ad => ({
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
    matchedQueries: ad.matchedQueries,
    matchedSeeds: ad.matchedSeeds,
  }));

  const batches = [];
  if (mode === 'production') {
    for (let index = 0; index < baseAds.length; index += productionBatchSize) {
      batches.push(baseAds.slice(index, index + productionBatchSize));
    }
  } else {
    batches.push(baseAds);
  }

  try {
    const aggregate = {
      processed: 0,
      keep: 0,
      potential: 0,
      reject: 0,
      skippedManual: 0,
      missing: 0,
      invalid: 0,
      durationMs: 0,
      filterVersion: null,
      upstreamStatus: null,
      batchesCompleted: 0,
      fallbackSplits: 0,
    };

    const isRetryableBatchError = error => (
      error && (
        error.code === 'MR04_INVALID_SHAPE'
        || error.code === 'MR04_INVALID_JSON'
        || error.code === 'MR04_WORKFLOW_ERROR'
      )
    );

    const runBatchWithFallback = async batchAds => {
      const payload = {
        projectId,
        projectName: project.name,
        projectBrief: project.brief,
        queryPlan: queryPlanPayload,
        ads: batchAds,
      };

      try {
        const mr04Result = await runMr04Webhook({
          webhookUrl: mr04WebhookUrl,
          timeoutMs: MR04_REQUEST_TIMEOUT_MS,
          payload,
        });

        const applied = applyMr04Decisions(db, {
          projectId,
          decisions: mr04Result.decisions,
          filterVersion: mr04Result.filterVersion,
        });

        aggregate.processed += applied.processed;
        aggregate.keep += applied.keep;
        aggregate.potential += applied.potential;
        aggregate.reject += applied.reject;
        aggregate.skippedManual += applied.skippedManual;
        aggregate.missing += applied.missing;
        aggregate.invalid += applied.invalid + mr04Result.invalidDecisions.length;
        aggregate.durationMs += mr04Result.durationMs;
        aggregate.filterVersion = mr04Result.filterVersion;
        aggregate.upstreamStatus = mr04Result.upstreamStatus;
        aggregate.batchesCompleted += 1;
        return;
      } catch (error) {
        if (
          mode === 'production'
          && batchAds.length > minFallbackBatchSize
          && isRetryableBatchError(error)
        ) {
          const middle = Math.ceil(batchAds.length / 2);
          const left = batchAds.slice(0, middle);
          const right = batchAds.slice(middle);
          aggregate.fallbackSplits += 1;

          await runBatchWithFallback(left);
          await runBatchWithFallback(right);
          return;
        }

        throw error;
      }
    };

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batchAds = batches[batchIndex];

      try {
        await runBatchWithFallback(batchAds);
      } catch (error) {
        const basePayload = {
          ok: false,
          projectId,
          error: error.message,
          mode,
          targetUrl: mr04WebhookUrl,
          pendingBefore: candidates.length,
          batchSize: mode === 'production' ? productionBatchSize : baseAds.length,
          totalBatches: batches.length,
          failedBatchIndex: batchIndex + 1,
          batchesCompleted: aggregate.batchesCompleted,
          fallbackSplits: aggregate.fallbackSplits,
          partial: {
            processed: aggregate.processed,
            keep: aggregate.keep,
            potential: aggregate.potential,
            reject: aggregate.reject,
            skippedManual: aggregate.skippedManual,
            missing: aggregate.missing,
            invalid: aggregate.invalid,
            durationMs: aggregate.durationMs,
            filterVersion: aggregate.filterVersion,
          },
        };

        if (error.code === 'MR04_NON_2XX') {
          return sendJson(res, 502, {
            ...basePayload,
            upstreamStatus: error.upstreamStatus || null,
            data: error.data || null,
          });
        }

        if (error.code === 'MR04_INVALID_JSON' || error.code === 'MR04_INVALID_SHAPE' || error.code === 'MR04_WORKFLOW_ERROR') {
          return sendJson(res, 502, {
            ...basePayload,
            upstreamStatus: error.upstreamStatus || null,
            data: error.data || null,
          });
        }

        if (error.code === 'MR04_REQUEST_FAILED') {
          return sendJson(res, 502, basePayload);
        }

        return sendJson(res, 500, basePayload);
      }
    }

    return sendJson(res, 200, {
      ok: true,
      projectId,
      pendingBefore: candidates.length,
      processed: aggregate.processed,
      keep: aggregate.keep,
      potential: aggregate.potential,
      reject: aggregate.reject,
      skippedManual: aggregate.skippedManual,
      missing: aggregate.missing,
      invalid: aggregate.invalid,
      upstreamStatus: aggregate.upstreamStatus,
      durationMs: aggregate.durationMs,
      filterVersion: aggregate.filterVersion,
      totalBatches: batches.length,
      batchSize: mode === 'production' ? productionBatchSize : baseAds.length,
      batchesCompleted: aggregate.batchesCompleted,
      fallbackSplits: aggregate.fallbackSplits,
      mode,
      targetUrl: mr04WebhookUrl,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      projectId,
      error: error.message,
      mode,
      targetUrl: mr04WebhookUrl,
    });
  }
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
    return handleGetProjectRelevancePending(req, res, projectIdForRelevancePending);
  }

  const projectIdForRelevanceRun = parseProjectId(requestUrl.pathname, '/ads/relevance/run');
  if (req.method === 'POST' && projectIdForRelevanceRun) {
    return handleRunProjectRelevanceFilter(req, res, projectIdForRelevanceRun);
  }

  const projectAdForRestore = parseProjectAdArchive(requestUrl.pathname, '/relevance/restore-mr04');
  if (req.method === 'POST' && projectAdForRestore) {
    return handleRestoreProjectAdRelevance(req, res, projectAdForRestore.projectId, projectAdForRestore.adArchiveId);
  }

  const projectAdForManualRelevance = parseProjectAdArchive(requestUrl.pathname, '/relevance');
  if (req.method === 'POST' && projectAdForManualRelevance) {
    return handleSetProjectAdManualRelevance(req, res, projectAdForManualRelevance.projectId, projectAdForManualRelevance.adArchiveId);
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
