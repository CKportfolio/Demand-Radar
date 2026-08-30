const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeUrl,
  jaccardSimilarity,
  buildOfferFamilies,
} = require('../src/meta/offerFamilyClassifier');

test('canonicalizeUrl removes tracking params but keeps business params', () => {
  const result = canonicalizeUrl(
    'https://www.example.com/oferta/?utm_source=meta&fbclid=abc&variant=pro#sekcja',
  );

  assert.equal(result, 'https://example.com/oferta?variant=pro');
});

test('canonicalizeUrl produces stable ordering of query parameters', () => {
  const left = canonicalizeUrl('https://example.com/product?b=2&a=1&utm_campaign=x');
  const right = canonicalizeUrl('https://www.example.com/product?a=1&b=2');

  assert.equal(left, right);
});

test('jaccardSimilarity is deterministic for repeated terms and punctuation', () => {
  const score = jaccardSimilarity(
    'Webinar: regulacja emocji dla rodziców',
    'Regulacja emocji dla rodziców — webinar!',
  );

  assert.equal(score, 1);
});

test('ads from the same advertiser and canonical destination form one family', () => {
  const ads = [
    {
      metaAdId: 'ad-1',
      pageId: 'page-1',
      title: 'Kurs regulacji emocji',
      bodyText: 'Program online dla rodziców',
      destinationUrl: 'https://example.com/kurs?utm_source=meta',
      startDate: '2026-01-01',
      endDate: '2026-01-10',
      isActive: false,
    },
    {
      metaAdId: 'ad-2',
      pageId: 'page-1',
      title: 'Kurs regulacji emocji',
      bodyText: 'Program online dla rodziców',
      destinationUrl: 'https://www.example.com/kurs?fbclid=123',
      startDate: '2026-01-11',
      endDate: null,
      isActive: true,
    },
  ];

  const result = buildOfferFamilies('project-test', ads, {
    now: new Date('2026-02-01T00:00:00.000Z'),
    classifierVersion: 'test-v1',
  });

  assert.equal(result.families.length, 1);
  assert.equal(result.families[0].adsCount, 2);
  assert.deepEqual(
    Object.values(result.canonicalDestinationByAdId),
    ['https://example.com/kurs', 'https://example.com/kurs'],
  );
});
