const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowPath = path.join(root, 'n8n', 'workflows', 'MR04 - Ad Relevance Filter.json');
const mr05WorkflowPath = path.join(root, 'n8n', 'workflows', 'MR05 - Resolve Potential Ads.json');

function assertPacedGeminiWorkflow(workflow, expectedPath) {
  const byName = new Map(workflow.nodes.map(node => [node.name, node]));
  const model = byName.get('Google Gemini Chat Model');
  const webhook = workflow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');

  assert.ok(model);
  assert.equal(model.type, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini');
  assert.equal(model.retryOnFail, true);
  assert.equal(model.maxTries, 3);
  assert.equal(model.waitBetweenTries, 10000);
  assert.equal(webhook.parameters.path, expectedPath);
  assert.equal(byName.has('Create Batches'), false, 'n8n nie moze ponownie dzielic paczki z backendu');
  assert.notEqual(byName.get('Structured Output Parser').parameters.autoFix, true, 'auto-fix moglby wykonac dodatkowy request do Gemini');
  assert.match(byName.get('Normalize Input').parameters.jsCode, /rawAds\.length > 200/);

  const mainTargets = workflow.connections['Normalize Input'].main[0].map(connection => connection.node);
  assert.deepEqual(mainTargets, ['Classify Relevance']);
}

test('MR04 uses one paced Gemini request per server batch with controlled retry', () => {
  assertPacedGeminiWorkflow(
    JSON.parse(fs.readFileSync(workflowPath, 'utf8')),
    'mr04-filter-ads-paced-v4',
  );
});

test('MR05 rechecks only one server batch and uses the same retry guard', () => {
  const workflow = JSON.parse(fs.readFileSync(mr05WorkflowPath, 'utf8'));
  assertPacedGeminiWorkflow(workflow, 'mr05-resolve-potential-v1');
  assert.match(workflow.nodes.find(node => node.name === 'Normalize Input').parameters.jsCode, /mr04Reason/);
});

test('server owns adjustable MR04/MR05 batching, test single-batch mode and persisted progress', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(server, /RELEVANCE_DEFAULT_BATCH_SIZE/);
  assert.match(server, /RELEVANCE_MAX_BATCH_SIZE[^\n]*200/);
  assert.match(server, /body\.batchSize/);
  assert.match(server, /mode === 'test'[\s\S]*Math\.min\(batchSize, normalLimit\)/);
  assert.match(server, /RELEVANCE_REQUESTS_PER_MINUTE[^\n]*14/);
  assert.match(server, /completedBatches: resumeBaseBatches \+ batchIndex \+ 1/);
  assert.match(server, /processedAds: resumeBaseAds/);
  assert.match(server, /saveRelevanceJobProgress/);
  assert.match(server, /getRelevanceJobProgress/);
  assert.match(server, /status: 'COMPLETED'/);
  assert.match(server, /status: 'PAUSED'/);
  assert.match(server, /handleStopProjectRelevanceFilter/);
});
