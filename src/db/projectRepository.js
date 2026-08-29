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

function mapProjectRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    brief: JSON.parse(row.brief_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertProject(db, { id, name, brief }) {
  const now = new Date().toISOString();
  const briefJson = JSON.stringify(brief);

  const existing = db
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(id);

  if (existing) {
    db.prepare(`
      UPDATE projects
      SET name = ?, brief_json = ?, updated_at = ?
      WHERE id = ?
    `).run(name, briefJson, now, id);
  } else {
    db.prepare(`
      INSERT INTO projects (id, name, brief_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, briefJson, now, now);
  }

  return getProjectById(db, id);
}

function getProjectById(db, projectId) {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(projectId);

  return mapProjectRow(row);
}

function listProjects(db) {
  const rows = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.updated_at,
      (
        SELECT v.version_number
        FROM discovery_plan_versions v
        WHERE v.project_id = p.id
        ORDER BY v.version_number DESC
        LIMIT 1
      ) AS latest_version_number,
      (
        SELECT v.status
        FROM discovery_plan_versions v
        WHERE v.project_id = p.id
        ORDER BY v.version_number DESC
        LIMIT 1
      ) AS latest_version_status
    FROM projects p
    ORDER BY p.updated_at DESC
  `).all();

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    latestVersionNumber: row.latest_version_number,
    latestVersionStatus: row.latest_version_status,
  }));
}

function getProjectWithVersions(db, projectId) {
  const project = getProjectById(db, projectId);
  if (!project) return null;

  const versionRows = db.prepare(`
    SELECT *
    FROM discovery_plan_versions
    WHERE project_id = ?
    ORDER BY version_number DESC
  `).all(projectId);

  return {
    project,
    versions: versionRows.map(mapVersionRow),
  };
}

module.exports = {
  upsertProject,
  getProjectById,
  listProjects,
  getProjectWithVersions,
};
