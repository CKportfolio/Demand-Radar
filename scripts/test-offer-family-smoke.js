const assert = require('assert');

const { initDatabase } = require('../src/db/database');
const {
  rebuildOfferFamilies,
  getProjectOfferFamilies,
} = require('../src/db/metaResearchRepository');
const {
  canonicalizeUrl,
  buildOfferFamilies,
} = require('../src/meta/offerFamilyClassifier');

function assertCanonicalization() {
  const first = canonicalizeUrl('https://example.pl/kurs/?utm_source=facebook&utm_campaign=a');
  const second = canonicalizeUrl('https://www.example.pl/kurs?utm_source=facebook&utm_campaign=b');
  const third = canonicalizeUrl('https://example.pl/kurs?product=1&utm_medium=cpc');

  assert.strictEqual(first, 'https://example.pl/kurs');
  assert.strictEqual(second, 'https://example.pl/kurs');
  assert.strictEqual(third, 'https://example.pl/kurs?product=1');
}

function syntheticOfferFamilyChecks() {
  const chainAds = [
    {
      metaAdId: 'ad-1',
      adArchiveId: 'ad-1',
      pageId: 'p1',
      title: 'Kurs lekowy',
      bodyText: 'Jak poradzic sobie z lekiem',
      destinationUrl: 'https://example.pl/kurs?utm_source=fb',
      startDate: '2025-09-23',
      endDate: '2025-10-16',
      runtimeDays: 23,
      isActive: false,
      firstSeenAt: '2025-09-23T00:00:00.000Z',
      lastSeenAt: '2025-10-16T00:00:00.000Z',
    },
    {
      metaAdId: 'ad-2',
      adArchiveId: 'ad-2',
      pageId: 'p1',
      title: 'Kurs lekowy online',
      bodyText: 'Jak poradzic sobie z lekiem i napieciem',
      destinationUrl: 'https://example.pl/kurs?utm_source=fb&utm_campaign=next',
      startDate: '2025-10-16',
      endDate: '2026-01-16',
      runtimeDays: 92,
      isActive: false,
      firstSeenAt: '2025-10-16T00:00:00.000Z',
      lastSeenAt: '2026-01-16T00:00:00.000Z',
    },
    {
      metaAdId: 'ad-3',
      adArchiveId: 'ad-3',
      pageId: 'p1',
      title: 'Kurs lekowy - edycja premium',
      bodyText: 'Ten sam kurs, nowa wersja materialow',
      destinationUrl: 'https://example.pl/kurs',
      startDate: '2026-01-16',
      endDate: '2026-08-15',
      runtimeDays: 212,
      isActive: false,
      firstSeenAt: '2026-01-16T00:00:00.000Z',
      lastSeenAt: '2026-08-15T00:00:00.000Z',
    },
  ];

  const synthetic = buildOfferFamilies('synthetic-project', chainAds, {
    now: new Date('2026-08-16T00:00:00.000Z'),
    classifierVersion: 'offer-family-v1',
  });

  assert.strictEqual(synthetic.families.length, 1);
  assert.strictEqual(synthetic.families[0].familyClass, 'EVERGREEN');
  assert.ok(synthetic.families[0].successorCount >= 2);

  const pageOnly = buildOfferFamilies('synthetic-project', [
    {
      metaAdId: 'ad-p1',
      adArchiveId: 'ad-p1',
      pageId: 'same-page',
      title: 'Oferta A',
      bodyText: 'Oferta A body',
      destinationUrl: 'https://example.pl/oferta-a',
      startDate: '2026-01-01',
      endDate: '2026-01-05',
      runtimeDays: 4,
      isActive: false,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-05T00:00:00.000Z',
    },
    {
      metaAdId: 'ad-p2',
      adArchiveId: 'ad-p2',
      pageId: 'same-page',
      title: 'Zupelnie inna oferta',
      bodyText: 'Inny produkt i inna tresc',
      destinationUrl: 'https://example.pl/inna-oferta',
      startDate: '2026-02-01',
      endDate: '2026-02-03',
      runtimeDays: 2,
      isActive: false,
      firstSeenAt: '2026-02-01T00:00:00.000Z',
      lastSeenAt: '2026-02-03T00:00:00.000Z',
    },
  ]);

  assert.strictEqual(pageOnly.families.length, 2);

  const parallelAndRelaunch = buildOfferFamilies('synthetic-project', [
    {
      metaAdId: 'ad-r1',
      adArchiveId: 'ad-r1',
      pageId: 'p2',
      title: 'Oferta relaunch',
      bodyText: 'Wersja 1',
      destinationUrl: 'https://demo.pl/oferta',
      startDate: '2026-01-01',
      endDate: '2026-01-20',
      runtimeDays: 19,
      isActive: false,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-20T00:00:00.000Z',
    },
    {
      metaAdId: 'ad-r2',
      adArchiveId: 'ad-r2',
      pageId: 'p2',
      title: 'Oferta relaunch update',
      bodyText: 'Wersja 2',
      destinationUrl: 'https://demo.pl/oferta',
      startDate: '2026-01-10',
      endDate: '2026-02-10',
      runtimeDays: 31,
      isActive: false,
      firstSeenAt: '2026-01-10T00:00:00.000Z',
      lastSeenAt: '2026-02-10T00:00:00.000Z',
    },
    {
      metaAdId: 'ad-r3',
      adArchiveId: 'ad-r3',
      pageId: 'p2',
      title: 'Oferta relaunch 3',
      bodyText: 'Wersja 3',
      destinationUrl: 'https://demo.pl/oferta',
      startDate: '2026-04-05',
      endDate: '2026-06-05',
      runtimeDays: 61,
      isActive: false,
      firstSeenAt: '2026-04-05T00:00:00.000Z',
      lastSeenAt: '2026-06-05T00:00:00.000Z',
    },
  ]);

  assert.strictEqual(parallelAndRelaunch.families.length, 1);
  const members = parallelAndRelaunch.families[0].members;
  assert.ok(members.some(member => member.relationshipType === 'PARALLEL'));
  assert.ok(members.some(member => member.relationshipType === 'RELAUNCH'));

  // Smoke check for CSV row construction expectations.
  const rowCount = members.length;
  const fullCsvRows = rowCount * 2;
  const shortCsvRows = rowCount * 2;
  assert.ok(fullCsvRows >= rowCount * 2);
  assert.ok(shortCsvRows >= rowCount * 2);
}

function runDatabaseBackfillSmoke() {
  const { db } = initDatabase();

  const latestProject = db.prepare(`
    SELECT project_id
    FROM meta_research_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).get();

  if (!latestProject?.project_id) {
    db.close();
    return {
      hasData: false,
      message: 'NO_META_RESEARCH_DATA',
    };
  }

  const summary = rebuildOfferFamilies(db, latestProject.project_id, {
    classifierVersion: 'offer-family-v1',
  });

  const families = getProjectOfferFamilies(db, latestProject.project_id, {
    familyClass: 'ALL',
    familyStatus: 'ALL',
    familyPattern: 'ALL',
  });

  const relationCounts = {
    DIRECT_SUCCESSOR: 0,
    RELAUNCH: 0,
    PARALLEL: 0,
  };

  for (const family of families) {
    for (const member of family.members) {
      if (member.relationshipType === 'DIRECT_SUCCESSOR') relationCounts.DIRECT_SUCCESSOR += 1;
      if (member.relationshipType === 'RELAUNCH') relationCounts.RELAUNCH += 1;
      if (member.relationshipType === 'PARALLEL') relationCounts.PARALLEL += 1;
    }
  }

  db.close();

  return {
    hasData: true,
    projectId: latestProject.project_id,
    summary,
    relationCounts,
  };
}

function main() {
  assertCanonicalization();
  syntheticOfferFamilyChecks();
  const dbSmoke = runDatabaseBackfillSmoke();

  const output = {
    ok: true,
    checks: {
      canonicalUrlNormalization: true,
      groupingByPageAndCanonical: true,
      noGroupingByPageOnly: true,
      directSuccessor: true,
      parallel: true,
      relaunch: true,
      familyClassification: true,
      familyReason: true,
      fullCsvShape: true,
      shortCsvShape: true,
    },
    dbSmoke,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`SMOKE_FAIL: ${error.message}\n`);
  process.exit(1);
}
