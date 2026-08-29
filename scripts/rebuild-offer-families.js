const { initDatabase } = require('../src/db/database');
const { rebuildOfferFamilies } = require('../src/db/metaResearchRepository');

function main() {
  const { db } = initDatabase();

  const projects = db.prepare(`
    SELECT DISTINCT mrr.project_id
    FROM meta_research_runs mrr
    ORDER BY mrr.started_at DESC
  `).all();

  if (!projects.length) {
    db.close();
    process.stdout.write(`${JSON.stringify({ ok: true, projects: 0, summaries: [] }, null, 2)}\n`);
    return;
  }

  const summaries = [];
  for (const row of projects) {
    const summary = rebuildOfferFamilies(db, row.project_id, {
      classifierVersion: 'offer-family-v1',
    });
    summaries.push(summary);
  }

  db.close();

  process.stdout.write(`${JSON.stringify({ ok: true, projects: projects.length, summaries }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`REBUILD_FAIL: ${error.message}\n`);
  process.exit(1);
}
