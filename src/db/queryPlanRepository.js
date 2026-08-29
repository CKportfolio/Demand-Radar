const crypto = require('crypto');

const ALLOWED_QUERY_TYPES = new Set([
  'CORE',
  'PROBLEM',
  'AUDIENCE',
  'FORMAT',
  'SYNONYM',
  'PRECISION',
]);

function normalizeQueryText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function countTerms(queryText) {
  const normalized = normalizeQueryText(queryText);
  if (!normalized) return 0;
  return normalized.split(' ').length;
}

function mapSeedOrigin(seedSource, versionSourceEvent) {
  if (seedSource === 'LLM_INITIAL') return 'MR01';
  if (seedSource === 'LLM_REVISION') return 'MR02';
  if (seedSource === 'USER') return 'USER';
  if (seedSource === 'DISCOVERY_EXPANSION') return 'DISCOVERY_EXPANSION';

  return versionSourceEvent === 'LLM_GENERATION' ? 'MR01' : 'MR02';
}

function mapPlanVersionRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    parentVersionId: row.parent_version_id,
    sourceEvent: row.source_event,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapQueryPlanRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourcePlanVersionId: row.source_plan_version_id,
    plannerVersion: row.planner_version,
    country: row.country,
    status: row.status,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

function getLatestDiscoveryPlanForProject(db, projectId) {
  const versionRow = db.prepare(`
    SELECT *
    FROM discovery_plan_versions
    WHERE project_id = ?
    ORDER BY version_number DESC
    LIMIT 1
  `).get(projectId);

  if (!versionRow) {
    return null;
  }

  const projectRow = db.prepare(`
    SELECT brief_json
    FROM projects
    WHERE id = ?
  `).get(projectId);

  const brief = projectRow ? JSON.parse(projectRow.brief_json) : {};
  const plan = JSON.parse(versionRow.plan_json);
  const seedQueries = Array.isArray(plan.seedQueries) ? plan.seedQueries : [];

  const seeds = seedQueries.map(seed => ({
    seedId: String(seed.id || ''),
    text: String(seed.query || ''),
    source: mapSeedOrigin(seed.source, versionRow.source_event),
    enabled: seed.enabled !== false,
  })).filter(seed => seed.seedId && seed.text);

  return {
    projectId,
    country: brief?.market?.country || 'PL',
    sourcePlanVersion: mapPlanVersionRow(versionRow),
    seeds,
  };
}

function getQueryPlanById(db, queryPlanId) {
  const planRow = db.prepare(`
    SELECT *
    FROM query_plans
    WHERE id = ?
  `).get(queryPlanId);

  if (!planRow) return null;

  const seedRows = db.prepare(`
    SELECT *
    FROM query_plan_seeds
    WHERE query_plan_id = ?
    ORDER BY sort_order ASC
  `).all(planRow.id);

  const queryRowsBySeedId = new Map();
  const allQueryRows = db.prepare(`
    SELECT qv.*, qps.id AS query_plan_seed_id
    FROM query_variants qv
    JOIN query_plan_seeds qps ON qps.id = qv.query_plan_seed_id
    WHERE qps.query_plan_id = ?
    ORDER BY qv.sort_order ASC
  `).all(planRow.id);

  for (const row of allQueryRows) {
    const list = queryRowsBySeedId.get(row.query_plan_seed_id) || [];
    list.push(row);
    queryRowsBySeedId.set(row.query_plan_seed_id, list);
  }

  const seedPlans = seedRows.map(seedRow => {
    const queryRows = queryRowsBySeedId.get(seedRow.id) || [];
    const queries = queryRows.map(queryRow => ({
      id: queryRow.id,
      text: queryRow.query_text,
      termCount: queryRow.term_count,
      queryType: queryRow.query_type,
      priority: queryRow.priority,
      rationale: queryRow.rationale,
      enabled: Boolean(queryRow.enabled),
      sortOrder: queryRow.sort_order,
      createdAt: queryRow.created_at,
      updatedAt: queryRow.updated_at,
    }));

    return {
      id: seedRow.id,
      sourceSeedId: seedRow.source_seed_id,
      sourceSeedOrigin: seedRow.source_seed_origin,
      seedText: seedRow.seed_text,
      concept: seedRow.concept,
      audience: JSON.parse(seedRow.audience_json),
      formatHints: JSON.parse(seedRow.format_hints_json),
      sortOrder: seedRow.sort_order,
      queries,
    };
  });

  return {
    ...mapQueryPlanRow(planRow),
    seedPlans,
  };
}

function getLatestQueryPlanForProject(db, projectId) {
  const row = db.prepare(`
    SELECT id
    FROM query_plans
    WHERE project_id = ?
    ORDER BY updated_at DESC, generated_at DESC
    LIMIT 1
  `).get(projectId);

  if (!row) return null;
  return getQueryPlanById(db, row.id);
}

function normalizeSeedPlans(seedPlans) {
  if (!Array.isArray(seedPlans)) {
    const error = new Error('seedPlans must be an array');
    error.code = 'INVALID_QUERY_PLAN';
    throw error;
  }

  const errors = [];

  const normalized = seedPlans.map((seedPlan, seedIndex) => {
    const sourceSeedId = String(seedPlan.sourceSeedId || seedPlan.seedId || '').trim();
    const sourceSeedOrigin = String(seedPlan.sourceSeedOrigin || seedPlan.source || '').trim() || 'MR02';
    const seedText = String(seedPlan.seedText || seedPlan.text || '').trim();
    const concept = String(seedPlan.concept || '').trim();

    const audienceInput = Array.isArray(seedPlan.audience) ? seedPlan.audience : [];
    const audience = audienceInput.map(item => String(item || '').trim()).filter(Boolean);

    const formatHintsInput = Array.isArray(seedPlan.formatHints) ? seedPlan.formatHints : [];
    const formatHints = formatHintsInput.map(item => String(item || '').trim()).filter(Boolean);

    const rawQueries = Array.isArray(seedPlan.queries) ? seedPlan.queries : [];
    const seen = new Set();

    const queries = rawQueries.map((query, queryIndex) => {
      const text = normalizeQueryText(query.text);
      const normalizedKey = text.toLowerCase();
      const queryType = String(query.queryType || '').toUpperCase();
      const priority = Number.parseInt(String(query.priority), 10);
      const rationale = String(query.rationale || '').trim();
      const enabled = query.enabled !== false;
      const termCount = countTerms(text);

      if (!text) {
        errors.push(`seedPlans[${seedIndex}].queries[${queryIndex}]: query text is required`);
      }

      if (termCount < 2 || termCount > 3) {
        errors.push(`seedPlans[${seedIndex}].queries[${queryIndex}]: query must have 2-3 words`);
      }

      if (text) {
        if (seen.has(normalizedKey)) {
          errors.push(`seedPlans[${seedIndex}]: duplicate query "${text}"`);
        }
        seen.add(normalizedKey);
      }

      if (!ALLOWED_QUERY_TYPES.has(queryType)) {
        errors.push(`seedPlans[${seedIndex}].queries[${queryIndex}]: invalid queryType`);
      }

      if (!Number.isFinite(priority)) {
        errors.push(`seedPlans[${seedIndex}].queries[${queryIndex}]: priority must be a number`);
      }

      return {
        text,
        termCount,
        queryType,
        priority: Number.isFinite(priority) ? priority : 0,
        rationale,
        enabled,
        sortOrder: queryIndex,
      };
    });

    if (!sourceSeedId) {
      errors.push(`seedPlans[${seedIndex}]: sourceSeedId is required`);
    }

    if (!seedText) {
      errors.push(`seedPlans[${seedIndex}]: seedText is required`);
    }

    return {
      sourceSeedId,
      sourceSeedOrigin,
      seedText,
      concept,
      audience,
      formatHints,
      sortOrder: seedIndex,
      queries,
    };
  });

  if (errors.length) {
    const error = new Error(errors.join('; '));
    error.code = 'INVALID_QUERY_PLAN';
    throw error;
  }

  return normalized;
}

function insertSeedPlans(db, queryPlanId, seedPlans, now) {
  const insertSeed = db.prepare(`
    INSERT INTO query_plan_seeds (
      id,
      query_plan_id,
      source_seed_id,
      source_seed_origin,
      seed_text,
      concept,
      audience_json,
      format_hints_json,
      sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertQuery = db.prepare(`
    INSERT INTO query_variants (
      id,
      query_plan_seed_id,
      query_text,
      term_count,
      query_type,
      priority,
      rationale,
      enabled,
      sort_order,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const seedPlan of seedPlans) {
    const queryPlanSeedId = crypto.randomUUID();

    insertSeed.run(
      queryPlanSeedId,
      queryPlanId,
      seedPlan.sourceSeedId,
      seedPlan.sourceSeedOrigin,
      seedPlan.seedText,
      seedPlan.concept,
      JSON.stringify(seedPlan.audience),
      JSON.stringify(seedPlan.formatHints),
      seedPlan.sortOrder,
    );

    for (const query of seedPlan.queries) {
      insertQuery.run(
        crypto.randomUUID(),
        queryPlanSeedId,
        query.text,
        query.termCount,
        query.queryType,
        query.priority,
        query.rationale,
        query.enabled ? 1 : 0,
        query.sortOrder,
        now,
        now,
      );
    }
  }
}

function saveGeneratedQueryPlan({
  db,
  projectId,
  sourcePlanVersionId,
  plannerVersion,
  country,
  generatedAt,
  seedPlans,
}) {
  const normalizedSeedPlans = normalizeSeedPlans(seedPlans);
  const now = new Date().toISOString();
  const queryPlanId = crypto.randomUUID();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO query_plans (
        id,
        project_id,
        source_plan_version_id,
        planner_version,
        country,
        status,
        generated_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queryPlanId,
      projectId,
      sourcePlanVersionId,
      String(plannerVersion || 'mr03-query-planner-v1').trim(),
      String(country || 'PL').trim() || 'PL',
      'DRAFT',
      generatedAt || now,
      now,
    );

    insertSeedPlans(db, queryPlanId, normalizedSeedPlans, now);
  });

  tx();

  return getQueryPlanById(db, queryPlanId);
}

function saveDraftQueryPlan({ db, queryPlanId, seedPlans }) {
  const existing = db.prepare('SELECT id FROM query_plans WHERE id = ?').get(queryPlanId);
  if (!existing) {
    const error = new Error('Query plan not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const normalizedSeedPlans = normalizeSeedPlans(seedPlans);
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM query_plan_seeds WHERE query_plan_id = ?').run(queryPlanId);

    insertSeedPlans(db, queryPlanId, normalizedSeedPlans, now);

    db.prepare(`
      UPDATE query_plans
      SET status = 'DRAFT', updated_at = ?
      WHERE id = ?
    `).run(now, queryPlanId);
  });

  tx();

  return getQueryPlanById(db, queryPlanId);
}

function approveQueryPlan({ db, queryPlanId }) {
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE query_plans
    SET status = 'APPROVED', updated_at = ?
    WHERE id = ?
  `).run(now, queryPlanId);

  if (!result.changes) {
    const error = new Error('Query plan not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  return getQueryPlanById(db, queryPlanId);
}

module.exports = {
  getLatestDiscoveryPlanForProject,
  getLatestQueryPlanForProject,
  getQueryPlanById,
  saveGeneratedQueryPlan,
  saveDraftQueryPlan,
  approveQueryPlan,
};
