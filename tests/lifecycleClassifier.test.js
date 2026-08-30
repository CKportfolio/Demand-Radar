const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LONGEVITY_CATEGORIES,
  classifyAdLifecycle,
  calculateRuntimeDays,
} = require('../src/meta/lifecycleClassifier');

test('calculateRuntimeDays uses now for an active ad', () => {
  const runtimeDays = calculateRuntimeDays({
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: null,
    isActive: true,
    now: new Date('2026-01-11T00:00:00.000Z'),
  });

  assert.equal(runtimeDays, 10);
});

test('lifecycle classification respects all configured boundaries', () => {
  const now = new Date('2026-08-30T00:00:00.000Z');
  const cases = [
    [7, LONGEVITY_CATEGORIES.BALON_PROBNY],
    [8, LONGEVITY_CATEGORIES.TEST_W_TOKU],
    [30, LONGEVITY_CATEGORIES.TEST_W_TOKU],
    [31, LONGEVITY_CATEGORIES.ROKUJACA],
    [90, LONGEVITY_CATEGORIES.ROKUJACA],
    [91, LONGEVITY_CATEGORIES.MOCNA],
    [180, LONGEVITY_CATEGORIES.MOCNA],
    [181, LONGEVITY_CATEGORIES.EVERGREEN],
  ];

  for (const [days, expected] of cases) {
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const result = classifyAdLifecycle({
      startDate: start.toISOString(),
      isActive: true,
      now,
    });

    assert.equal(result.runtimeDays, days);
    assert.equal(result.lifecycleClass, expected);
  }
});

test('invalid start date falls back to conservative classification', () => {
  const result = classifyAdLifecycle({
    startDate: 'not-a-date',
    isActive: true,
    now: new Date('2026-08-30T00:00:00.000Z'),
  });

  assert.equal(result.runtimeDays, null);
  assert.equal(result.lifecycleClass, LONGEVITY_CATEGORIES.BALON_PROBNY);
  assert.equal(result.lifecycleConfidence, 45);
});
