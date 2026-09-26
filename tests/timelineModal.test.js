const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTimelineModel,
  lifecycleConfig,
} = require('../public/js/timeline-modal');

test('builds a one-block TEST_ONLY timeline', () => {
  const family = {
    id: 'family-test-only',
    familyClass: 'TEST_ONLY',
    firstAdStart: '2026-01-03',
    latestAdEnd: '2026-01-07',
    members: [
      {
        adArchiveId: 'ad-one',
        title: 'Jednorazowy test',
        bodyText: 'Treść reklamy testowej.',
        pageId: 'page-one',
        canonicalUrl: 'https://example.com/test',
        startDate: '2026-01-03',
        endDate: '2026-01-07',
        runtimeDays: 5,
        longevityCategory: 'BALON_PROBNY',
        isActive: false,
      },
    ],
  };

  const model = buildTimelineModel(family);

  assert.equal(model.blocks.length, 1);
  assert.equal(model.laneCount, 1);
  assert.equal(model.totalDays, 5);
  assert.equal(model.blocks[0].daysActive, 5);
  assert.equal(model.blocks[0].lifecycle, 'BALON_PROBNY');
  assert.equal(model.blocks[0].adArchiveId, 'ad-one');
  assert.equal(model.blocks[0].pageId, 'page-one');
  assert.equal(model.blocks[0].leftPercent, 0);
  assert.equal(model.blocks[0].widthPercent, 100);
});

test('handles an empty offer family without a timeline range', () => {
  const model = buildTimelineModel({ id: 'family-empty', familyClass: 'TEST_ONLY', members: [] });

  assert.equal(model.sourceAdsCount, 0);
  assert.equal(model.blocks.length, 0);
  assert.equal(model.totalDays, 0);
  assert.equal(model.laneCount, 1);
});

test('builds an eight-block EVERGREEN timeline with chronological gaps', () => {
  const starts = [
    ['2024-03-01', '2024-03-05', 'BALON_PROBNY'],
    ['2024-03-14', '2024-03-20', 'BALON_PROBNY'],
    ['2024-04-02', '2024-04-16', 'TEST_W_TOKU'],
    ['2024-05-01', '2024-05-28', 'TEST_W_TOKU'],
    ['2024-06-10', '2024-07-18', 'ROKUJACA'],
    ['2024-07-29', '2024-09-06', 'ROKUJACA'],
    ['2024-09-15', '2024-09-24', 'TEST_W_TOKU'],
    ['2024-09-27', '2024-10-01', 'BALON_PROBNY'],
  ];

  const family = {
    family_id: 'family-evergreen',
    classification: 'EVERGREEN',
    first_seen: '2024-03-01',
    last_seen: '2024-10-01',
    total_active_days: 159,
    ads: starts.map(([start, end, lifecycle], index) => ({
      ad_archive_id: `ad-${index + 1}`,
      title: `Kreacja ${index + 1}`,
      start_date: start,
      end_date: end,
      lifecycle,
      is_active: false,
    })),
  };

  const model = buildTimelineModel(family);

  assert.equal(model.blocks.length, 8);
  assert.equal(model.undatedAdsCount, 0);
  assert.equal(model.timelineStart.toISOString().slice(0, 10), '2024-03-01');
  assert.equal(model.timelineEnd.toISOString().slice(0, 10), '2024-10-01');
  assert.ok(model.totalDays > 200);
  assert.ok(model.canvasMinWidth >= 1000);

  for (let index = 1; index < model.blocks.length; index += 1) {
    assert.ok(model.blocks[index].startOffset > model.blocks[index - 1].startOffset);
  }

  assert.ok(model.blocks[1].startOffset > model.blocks[0].endOffset + 1);
  assert.ok(model.blocks.every(block => block.widthPercent > 0));

  const colors = new Map(lifecycleConfig.map(item => [item.key, item.color]));
  assert.equal(colors.get('BALON_PROBNY'), '#9CA3AF');
  assert.equal(colors.get('TEST_W_TOKU'), '#FBBF24');
  assert.equal(colors.get('ROKUJACA'), '#FB923C');
  assert.equal(colors.get('MOCNA'), '#EF4444');
  assert.equal(colors.get('EVERGREEN'), '#10B981');
});

