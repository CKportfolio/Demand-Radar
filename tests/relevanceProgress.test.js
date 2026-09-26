const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrations } = require('../src/db/migrations');
const {
  saveRelevanceJobProgress,
  getRelevanceJobProgress,
  clearRelevanceJobProgress,
  markInterruptedRelevanceJobs,
} = require('../src/db/relevanceJobRepository');

function createDbWithProject() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects (id, name, brief_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('project-1', 'Project', '{}', now, now);
  return db;
}

test('relevance progress survives failures and application restart', () => {
  const db = createDbWithProject();
  saveRelevanceJobProgress(db, {
    projectId: 'project-1',
    stage: 'MR04',
    status: 'RUNNING',
    totalBatches: 75,
    completedBatches: 6,
    totalAds: 1500,
    processedAds: 120,
  });

  assert.equal(markInterruptedRelevanceJobs(db), 1);
  const saved = getRelevanceJobProgress(db, 'project-1', 'MR04');
  assert.equal(saved.status, 'FAILED');
  assert.equal(saved.completedBatches, 6);
  assert.equal(saved.processedAds, 120);
  assert.equal(saved.error.code, 'PROCESS_INTERRUPTED');

  assert.equal(clearRelevanceJobProgress(db, 'project-1'), 1);
  assert.equal(getRelevanceJobProgress(db, 'project-1', 'MR04'), null);
  db.close();
});

test('a user-paused relevance job remains resumable after restart', () => {
  const db = createDbWithProject();
  saveRelevanceJobProgress(db, {
    projectId: 'project-1',
    stage: 'MR04',
    status: 'PAUSED',
    phase: 'PAUSED',
    mode: 'production',
    batchSize: 20,
    totalBatches: 75,
    completedBatches: 8,
    totalAds: 1500,
    processedAds: 160,
  });

  assert.equal(markInterruptedRelevanceJobs(db), 0);
  const saved = getRelevanceJobProgress(db, 'project-1', 'MR04');
  assert.equal(saved.status, 'PAUSED');
  assert.equal(saved.completedBatches, 8);
  assert.equal(saved.processedAds, 160);
  db.close();
});
