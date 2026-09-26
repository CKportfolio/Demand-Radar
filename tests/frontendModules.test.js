const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Workbench frontend is split into tab modules', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const lines = index.split(/\r?\n/).length;
  assert.ok(lines < 800, `index.html should stay compact; got ${lines} lines`);

  const assets = [
    'public/css/workbench.css',
    'public/js/core.js',
    'public/js/tabs/workbench.js',
    'public/js/tabs/saved-projects.js',
    'public/js/tabs/query-plan.js',
    'public/js/tabs/results.js',
    'public/js/timeline-modal.js',
    'public/js/system-status.js',
    'public/js/init.js',
  ];
  for (const asset of assets) {
    assert.equal(fs.existsSync(path.join(root, asset)), true, `${asset} is missing`);
  }
});

test('results list wraps long ad text without horizontal scrolling', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/workbench.css'), 'utf8');
  assert.match(css, /\.meta-ads-table\s*\{[^}]*table-layout:\s*fixed/s);
  assert.match(css, /\.meta-ads-table-wrap\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.ad-row-content\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test('MR04 stats refresh stays in the current tab', () => {
  const results = fs.readFileSync(path.join(root, 'public/js/tabs/results.js'), 'utf8');
  const match = results.match(/async function refreshMetaStatsOnly\(\)[\s\S]*?\n\}/);
  assert.ok(match, 'refreshMetaStatsOnly is missing');
  assert.doesNotMatch(match[0], /setActiveTab|location\.reload|scrollTo/);
  assert.match(match[0], /renderMetaResearchSummary/);
  assert.match(match[0], /renderMetaRelevanceSummary/);
});

test('results UI exposes adjustable model batch size plus stop and resume controls', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'public/js/core.js'), 'utf8');
  const results = fs.readFileSync(path.join(root, 'public/js/tabs/results.js'), 'utf8');

  assert.match(index, /id="relevanceBatchSize"[^>]*min="1"[^>]*max="200"[^>]*value="20"/);
  assert.match(core, /marketRadarRelevanceBatchSize/);
  assert.match(results, /body: JSON\.stringify\(\{ force: false, mode, batchSize \}\)/);
  assert.match(results, /data-relevance-stop/);
  assert.match(results, /data-relevance-resume/);
  assert.match(results, /model przetwarza paczkę/);
  assert.doesNotMatch(results, /Gemini przetwarza paczkę/);
});
