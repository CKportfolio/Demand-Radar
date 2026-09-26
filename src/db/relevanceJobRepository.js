function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeStage(stage) {
  const normalized = String(stage || '').trim().toUpperCase();
  if (normalized !== 'MR04' && normalized !== 'MR05') {
    const error = new Error('Invalid relevance stage. Allowed: MR04, MR05');
    error.code = 'INVALID_RELEVANCE_STAGE';
    throw error;
  }
  return normalized;
}

function saveRelevanceJobProgress(db, progress) {
  const stage = normalizeStage(progress?.stage);
  const projectId = String(progress?.projectId || '').trim();
  if (!projectId) throw new Error('projectId is required for relevance progress');

  const normalized = {
    ...progress,
    projectId,
    stage,
    updatedAt: progress.updatedAt || new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO relevance_job_progress (project_id, stage, progress_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, stage) DO UPDATE SET
      progress_json = excluded.progress_json,
      updated_at = excluded.updated_at
  `).run(projectId, stage, JSON.stringify(normalized), normalized.updatedAt);

  return normalized;
}

function getRelevanceJobProgress(db, projectId, stage) {
  const normalizedStage = normalizeStage(stage);
  const row = db.prepare(`
    SELECT progress_json
    FROM relevance_job_progress
    WHERE project_id = ? AND stage = ?
    LIMIT 1
  `).get(String(projectId || ''), normalizedStage);

  return safeJsonParse(row?.progress_json, null);
}

function clearRelevanceJobProgress(db, projectId, stage = null) {
  if (stage) {
    const normalizedStage = normalizeStage(stage);
    return db.prepare(`
      DELETE FROM relevance_job_progress
      WHERE project_id = ? AND stage = ?
    `).run(String(projectId || ''), normalizedStage).changes;
  }

  return db.prepare(`
    DELETE FROM relevance_job_progress
    WHERE project_id = ?
  `).run(String(projectId || '')).changes;
}

function markInterruptedRelevanceJobs(db) {
  const rows = db.prepare(`
    SELECT project_id, stage, progress_json
    FROM relevance_job_progress
  `).all();
  const now = new Date().toISOString();
  let interrupted = 0;

  const update = db.prepare(`
    UPDATE relevance_job_progress
    SET progress_json = ?, updated_at = ?
    WHERE project_id = ? AND stage = ?
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const progress = safeJsonParse(row.progress_json, null);
      if (!progress || progress.status !== 'RUNNING') continue;

      const next = {
        ...progress,
        status: 'FAILED',
        phase: 'INTERRUPTED',
        error: {
          code: 'PROCESS_INTERRUPTED',
          message: `${row.stage === 'MR05' ? 'Rozstrzyganie wyników niejednoznacznych (MR05)' : 'Filtrowanie danych (MR04)'} przerwano przez zatrzymanie aplikacji. Zapisane paczki pozostały w bazie; użyj przycisku WZNÓW, aby kontynuować.`,
        },
        updatedAt: now,
        finishedAt: now,
      };

      update.run(JSON.stringify(next), now, row.project_id, row.stage);
      interrupted += 1;
    }
  });

  tx();
  return interrupted;
}

module.exports = {
  saveRelevanceJobProgress,
  getRelevanceJobProgress,
  clearRelevanceJobProgress,
  markInterruptedRelevanceJobs,
};
