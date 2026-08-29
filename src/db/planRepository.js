const crypto = require('crypto');
const { upsertProject } = require('./projectRepository');

const SOURCE_EVENTS = new Set(['LLM_GENERATION', 'LLM_REVISION', 'MANUAL_REVISION']);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${pairs.join(',')}}`;
}

function mapVersionRow(row) {
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

function saveProjectPlanVersion({
  db,
  validatePlan,
  projectId,
  brief,
  plan,
  sourceEvent,
  parentVersionId,
}) {
  if (!SOURCE_EVENTS.has(sourceEvent)) {
    throw new Error('Invalid sourceEvent');
  }

  const planValidation = validatePlan(plan);
  if (!planValidation.ok) {
    const message = planValidation.errors.length
      ? planValidation.errors.join('; ')
      : 'Invalid DiscoveryPlanV1';
    const error = new Error(message);
    error.code = 'INVALID_PLAN';
    throw error;
  }

  const projectName = (brief?.projectName || '').trim() || 'Untitled project';
  const normalizedPlanJson = stableStringify(plan);

  const tx = db.transaction(() => {
    const project = upsertProject(db, {
      id: projectId,
      name: projectName,
      brief,
    });

    const latestVersionRow = db.prepare(`
      SELECT *
      FROM discovery_plan_versions
      WHERE project_id = ?
      ORDER BY version_number DESC
      LIMIT 1
    `).get(projectId);

    if (latestVersionRow && latestVersionRow.plan_json === normalizedPlanJson) {
      return {
        alreadySaved: true,
        project,
        version: mapVersionRow(latestVersionRow),
      };
    }

    if (parentVersionId) {
      const parent = db.prepare(`
        SELECT id
        FROM discovery_plan_versions
        WHERE id = ? AND project_id = ?
      `).get(parentVersionId, projectId);

      if (!parent) {
        const error = new Error('parentVersionId does not exist for this project');
        error.code = 'INVALID_PARENT';
        throw error;
      }
    }

    const nextVersionNumber = latestVersionRow ? latestVersionRow.version_number + 1 : 1;
    const versionId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO discovery_plan_versions (
        id,
        project_id,
        version_number,
        parent_version_id,
        source_event,
        status,
        plan_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      projectId,
      nextVersionNumber,
      parentVersionId || null,
      sourceEvent,
      'DRAFT',
      normalizedPlanJson,
      now,
    );

    const inserted = db.prepare(`
      SELECT *
      FROM discovery_plan_versions
      WHERE id = ?
    `).get(versionId);

    return {
      alreadySaved: false,
      project,
      version: mapVersionRow(inserted),
    };
  });

  return tx();
}

function getPlanVersionById(db, versionId) {
  const row = db.prepare(`
    SELECT *
    FROM discovery_plan_versions
    WHERE id = ?
  `).get(versionId);

  if (!row) return null;

  return {
    version: mapVersionRow(row),
    plan: JSON.parse(row.plan_json),
  };
}

module.exports = {
  saveProjectPlanVersion,
  getPlanVersionById,
  stableStringify,
};
