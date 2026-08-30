const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrations } = require('../src/db/migrations');

test('all migrations can be applied to a fresh in-memory SQLite database', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  try {
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(row => row.name);

    assert.ok(tables.includes('projects'));
    assert.ok(tables.includes('query_plans'));
    assert.ok(tables.includes('meta_ads'));
    assert.ok(tables.includes('project_ad_relevance'));
    assert.ok(tables.includes('offer_families'));
  } finally {
    db.close();
  }
});

test('running migrations twice is idempotent', () => {
  const db = new Database(':memory:');

  try {
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db));
  } finally {
    db.close();
  }
});
