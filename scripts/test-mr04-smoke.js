const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrations } = require('../src/db/migrations');
const {
  createResearchRun,
  createQueryRun,
  saveAdsPageBatch,
  ensureProjectAdRelevanceRows,
  applyMr04Decisions,
  setProjectAdManualRelevance,
  getProjectRelevancePendingCount,
  getProjectMr05PendingCount,
  getProjectAdsForRelevanceReview,
  getProjectAdsForMr05Review,
  applyMr05Decisions,
  getResearchRunAds,
  countResearchRunAds,
  getProjectAdDetails,
  getResearchRunRelevanceSummary,
  getProjectAdsEligibleForDetails,
  getProjectRelevanceResetCount,
  restoreProjectRelevanceBatch,
} = require('../src/db/metaResearchRepository');

function nowIso() {
  return new Date().toISOString();
}

function bootstrapProjectWithQueryPlan(db, projectId) {
  const now = nowIso();
  const versionId = 'ver-1';
  const queryPlanId = 'qp-1';

  db.prepare(`
    INSERT INTO projects (id, name, brief_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    projectId,
    'Test Project',
    JSON.stringify({
      projectName: 'Test Project',
      market: { country: 'PL', language: 'pl' },
      competencies: 'Psychologia',
      qualifications: 'Praktyka',
      availableProductFormats: ['webinar'],
      constraints: [],
      exclusions: [],
    }),
    now,
    now,
  );

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
    1,
    null,
    'LLM_GENERATION',
    'DRAFT',
    JSON.stringify({
      schemaVersion: '1.1',
      capabilityUnderstanding: 'x',
      marketBreadth: 'x',
      seedQueries: [{ id: 's1', query: 'psychoterapia', rationale: 'x', priority: 'high', enabled: true, source: 'LLM_INITIAL' }],
      candidateProductTypes: [],
      initialTaxonomy: [],
      discoveryStrategies: [],
      queryExpansionPolicy: { includeSynonyms: true, includeAudienceAngles: true, includeFormatAngles: true, maxAdditionalQueriesPerSeed: 3 },
      openUnknowns: [],
      constraints: [],
      discoveryLimits: { maxQueriesPerRun: 10, maxAdsPerQuery: 10, maxScrollsPerQuery: 5, stopAfterScrollsWithoutNewAds: 2, maxRuntimeMinutes: 30 },
      saturationCriteria: [],
      changeSummary: 'x',
      warnings: [],
    }),
    now,
  );

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
    versionId,
    'mr03-test',
    'PL',
    'APPROVED',
    now,
    now,
  );

  return { queryPlanId };
}

function buildRawAd({ adArchiveId, pageName, title, bodyText }) {
  return {
    ad_archive_id: adArchiveId,
    page_name: pageName,
    page_id: `${adArchiveId}-page`,
    start_date_formatted: '2026-01-01',
    end_date_formatted: null,
    is_active: true,
    ad_library_url: `https://www.facebook.com/ads/library/?id=${adArchiveId}`,
    snapshot: {
      title,
      body: { text: bodyText },
      page_categories: ['Edukacja'],
      cta_type: 'LEARN_MORE',
      cta_text: 'Dowiedz sie wiecej',
      page_like_count: 5000,
    },
  };
}

function createRunWithAds(db, projectId, queryPlanId, queryText, ads) {
  const run = createResearchRun(db, {
    projectId,
    queryPlanId,
    country: 'PL',
    queriesTotal: 1,
    config: { test: true },
    provider: 'APIFY',
  });

  const queryRun = createQueryRun(db, {
    researchRunId: run.id,
    queryText,
    queryTextNormalized: queryText.toLowerCase(),
    queryTypeSnapshot: ['CORE'],
    queryCategory: 'CORE',
    sourceUrl: 'https://www.facebook.com/ads/library/?q=test',
    prioritySnapshot: 100,
  });

  const observedAt = nowIso();
  const batch = saveAdsPageBatch(db, {
    researchRunId: run.id,
    observedAt,
    ads: ads.map((rawAd, idx) => ({
      rawAd,
      queryRunId: queryRun.id,
      queryText,
      queryCategory: 'CORE',
      sourceUrl: 'https://www.facebook.com/ads/library/?q=test',
      resultPosition: idx + 1,
    })),
  });

  ensureProjectAdRelevanceRows(db, {
    projectId,
    metaAdIds: [...batch.uniqueAdIds],
  });

  return { run, queryRun };
}

function main() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const projectId = 'proj-1';
  const { queryPlanId } = bootstrapProjectWithQueryPlan(db, projectId);

  const adPsych = buildRawAd({
    adArchiveId: 'ad-psych-1',
    pageName: 'Psychoterapia Centrum',
    title: 'Webinar o regulacji emocji',
    bodyText: 'Psychoterapia i praca z lękiem dla rodzicow',
  });

  const adStock = buildRawAd({
    adArchiveId: 'ad-stock-1',
    pageName: 'Trading Master',
    title: 'Szybkie sygnaly gieldowe',
    bodyText: 'Automatyczny trading i sygnaly forex',
  });

  const adAmbiguous = buildRawAd({
    adArchiveId: 'ad-amb-1',
    pageName: 'Rozwoj i motywacja',
    title: 'Jak odzyskac spokoj',
    bodyText: 'Wsparcie emocji, mindset i relacje',
  });

  const firstRun = createRunWithAds(db, projectId, queryPlanId, 'psychoterapia online', [adPsych, adStock, adAmbiguous]);

  const applied1 = applyMr04Decisions(db, {
    projectId,
    filterVersion: 'mr04-test-v1',
    decisions: [
      { adArchiveId: 'ad-psych-1', decision: 'KEEP', confidence: 91, reasonCode: 'PSYCH_DOMAIN', reason: 'Bezposrednio psychologia' },
      { adArchiveId: 'ad-stock-1', decision: 'REJECT', confidence: 95, reasonCode: 'OUTSIDE_MARKET', reason: 'Rynek inwestycyjny' },
      { adArchiveId: 'ad-amb-1', decision: 'REVIEW', confidence: 61, reasonCode: 'AMBIGUOUS', reason: 'Temat graniczny' },
    ],
  });

  assert.equal(applied1.keep, 1, 'A: psychologiczna reklama powinna byc KEEP');
  assert.equal(applied1.reject, 1, 'B: gieldowa reklama powinna byc REJECT');
  assert.equal(applied1.potential, 1, 'C: niejednoznaczna reklama powinna byc POTENTIAL');

  const summaryAfterMr04 = getResearchRunRelevanceSummary(db, firstRun.run.id);
  assert.equal(summaryAfterMr04.keep, 1);
  assert.equal(summaryAfterMr04.reject, 1);
  assert.equal(summaryAfterMr04.potential, 1);

  assert.equal(getProjectMr05PendingCount(db, projectId), 1, 'MR05 powinien zobaczyc nierozstrzygniete POTENCJALNE');
  const mr05Candidates = getProjectAdsForMr05Review(db, projectId, { includeResolved: false });
  assert.equal(mr05Candidates.length, 1, 'MR05 powinien pobrac tylko nierozstrzygniete reklamy');
  assert.equal(mr05Candidates[0].mr04Decision, 'REVIEW');

  const appliedMr05 = applyMr05Decisions(db, {
    projectId,
    filterVersion: 'mr05-test-v1',
    decisions: [
      { adArchiveId: 'ad-amb-1', decision: 'KEEP', confidence: 84, reasonCode: 'ADJACENT_IN_SCOPE', reason: 'Drugi przebieg znalazl sygnal rynku' },
    ],
  });
  assert.equal(appliedMr05.keep, 1, 'MR05 powinien rozstrzygnac reklame jako KEEP');
  assert.equal(getProjectMr05PendingCount(db, projectId), 0, 'Rozstrzygnieta reklama nie moze wracac do MR05 pending');

  const mr05Row = db.prepare(`
    SELECT relevance_status, last_classifier, mr05_decision, mr05_filter_version
    FROM project_ad_relevance
    WHERE project_id = ? AND ad_archive_id = ?
  `).get(projectId, 'ad-amb-1');
  assert.equal(mr05Row.relevance_status, 'KEEP');
  assert.equal(mr05Row.last_classifier, 'MR05');
  assert.equal(mr05Row.mr05_decision, 'KEEP');
  assert.equal(mr05Row.mr05_filter_version, 'mr05-test-v1');

  setProjectAdManualRelevance(db, {
    projectId,
    adArchiveId: 'ad-amb-1',
    relevanceStatus: 'KEEP',
  });

  const applied2 = applyMr04Decisions(db, {
    projectId,
    filterVersion: 'mr04-test-v2',
    decisions: [
      { adArchiveId: 'ad-amb-1', decision: 'REJECT', confidence: 90, reasonCode: 'AUTO_RECHECK', reason: 'Automatyczny rerun' },
    ],
  });

  assert.equal(applied2.skippedManual, 1, 'D: manual override musi blokowac nadpisanie przez kolejne MR04');

  const usefulAds = getResearchRunAds(db, firstRun.run.id, { relevanceScope: 'USEFUL' });
  const usefulIds = new Set(usefulAds.map(ad => ad.adArchiveId));
  assert.ok(usefulIds.has('ad-psych-1'));
  assert.ok(usefulIds.has('ad-amb-1'));
  assert.ok(!usefulIds.has('ad-stock-1'));

  assert.equal(countResearchRunAds(db, firstRun.run.id, { relevanceScope: 'USEFUL' }), 2, 'H: count musi uwzgledniac filtry');
  const usefulPage1 = getResearchRunAds(db, firstRun.run.id, { relevanceScope: 'USEFUL' }, { limit: 1, offset: 0 });
  const usefulPage2 = getResearchRunAds(db, firstRun.run.id, { relevanceScope: 'USEFUL' }, { limit: 1, offset: 1 });
  assert.equal(usefulPage1.length, 1, 'H: pierwsza strona ma zawierac jeden rekord');
  assert.equal(usefulPage2.length, 1, 'H: druga strona ma zawierac jeden rekord');
  assert.notEqual(usefulPage1[0].adArchiveId, usefulPage2[0].adArchiveId, 'H: strony nie moga sie dublowac');
  assert.equal(Object.hasOwn(usefulPage1[0], 'rawJson'), false, 'I: lista nie powinna pobierac ciezkiego rawJson');

  const adDetails = getProjectAdDetails(db, projectId, 'ad-psych-1');
  assert.equal(adDetails.adArchiveId, 'ad-psych-1', 'I: szczegoly maja byc pobierane osobnym odczytem');
  assert.equal(typeof adDetails.rawJson, 'object', 'I: szczegoly powinny zawierac rawJson');

  createRunWithAds(db, projectId, queryPlanId, 'psychoterapia online', [adStock]);

  const rejectRows = db.prepare(`
    SELECT COUNT(*) AS c
    FROM project_ad_relevance
    WHERE project_id = ? AND ad_archive_id = ?
  `).get(projectId, 'ad-stock-1');
  assert.equal(rejectRows.c, 1, 'E: ten sam REJECT ad nie moze tworzyc nowego rekordu');

  const pendingAfterRepeat = getProjectRelevancePendingCount(db, projectId);
  assert.equal(pendingAfterRepeat, 0, 'E: znany REJECT nie powinien wracac do pending MR04');

  const reviewCandidates = getProjectAdsForRelevanceReview(db, projectId, { includeResolved: false });
  assert.equal(reviewCandidates.length, 0, 'E: brak reklam do ponownej analizy MR04 bez force');

  let detailsEligible = getProjectAdsEligibleForDetails(db, projectId, {
    statuses: ['KEEP', 'POTENTIAL'],
    includeFailed: true,
  });
  assert.ok(!detailsEligible.some(row => row.adArchiveId === 'ad-stock-1'), 'F: REJECT nie moze trafic do enrichment');

  db.prepare(`
    UPDATE project_ad_relevance
    SET details_status = 'FETCHED', details_fetched_at = ?, details_provider = 'TEST_PROVIDER'
    WHERE project_id = ? AND ad_archive_id IN ('ad-psych-1', 'ad-amb-1')
  `).run(nowIso(), projectId);

  detailsEligible = getProjectAdsEligibleForDetails(db, projectId, {
    statuses: ['KEEP', 'POTENTIAL'],
    includeFailed: true,
  });
  assert.equal(detailsEligible.length, 0, 'G: KEEP/POTENTIAL z FETCHED nie powinny byc pobierane ponownie');

  const resetBefore = getProjectRelevanceResetCount(db, projectId);
  assert.equal(resetBefore, 3, 'J: reset powinien objac wszystkie decyzje MR04 i manual override');
  assert.equal(restoreProjectRelevanceBatch(db, projectId, 2), 2, 'J: pierwsza paczka resetu powinna wyczyscic 2 rekordy');
  assert.equal(restoreProjectRelevanceBatch(db, projectId, 2), 1, 'J: druga paczka resetu powinna wyczyscic pozostaly rekord');
  assert.equal(getProjectRelevanceResetCount(db, projectId), 0, 'J: po resecie nie moze zostac stan MR04');

  const resetRows = db.prepare(`
    SELECT relevance_status, manual_override, last_classifier,
           mr04_decision, mr04_confidence, mr04_reason_code, mr04_reason, mr04_filter_version, mr04_checked_at,
           mr05_decision, mr05_confidence, mr05_reason_code, mr05_reason, mr05_filter_version, mr05_checked_at
    FROM project_ad_relevance
    WHERE project_id = ?
  `).all(projectId);
  assert.ok(resetRows.every(row => row.relevance_status === 'UNREVIEWED' && row.manual_override === 0), 'K: statusy musza wrocic do UNREVIEWED');
  assert.ok(resetRows.every(row => row.mr04_decision == null && row.mr04_confidence == null && row.mr04_reason == null), 'K: pola decyzji MR04 musza byc puste');
  assert.ok(resetRows.every(row => row.last_classifier === 'MR04' && row.mr05_decision == null && row.mr05_checked_at == null), 'K: reset musi usunac rowniez caly slad MR05');

  console.log('SMOKE MR04 A-K: PASS');
}

try {
  main();
} catch (error) {
  console.error('SMOKE MR04 A-K: FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
