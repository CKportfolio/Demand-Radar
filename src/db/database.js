const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, '.data');
const DB_PATH = path.join(DATA_DIR, 'market-radar.sqlite');

function initDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return {
    db,
    dbPath: DB_PATH,
    dataDir: DATA_DIR,
  };
}

module.exports = {
  initDatabase,
};
