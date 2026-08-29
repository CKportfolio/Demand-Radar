const crypto = require('crypto');
const { classifyAdLifecycle } = require('../meta/lifecycleClassifier');
const {
  buildOfferFamilies,
  canonicalizeUrl,
  FAMILY_CLASS_ORDER,
} = require('../meta/offerFamilyClassifier');

const RUN_STATUSES = new Set(['PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED']);
const QUERY_RUN_STATUSES = new Set(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);

const LONGEVITY_ORDER = {
  BALON_PROBNY: 1,
  TEST_W_TOKU: 2,
  ROKUJACA: 3,
  MOCNA: 4,
  EVERGREEN: 5,
};

const RELEVANCE_STATUSES = new Set(['UNREVIEWED', 'KEEP', 'POTENTIAL', 'REJECT']);
const MR04_DECISIONS = new Set(['KEEP', 'REVIEW', 'REJECT']);
const DETAILS_STATUSES = new Set(['NOT_FETCHED', 'FETCHING', 'FETCHED', 'FAILED']);
const LIFECYCLE_VALUES = ['BALON_PROBNY', 'TEST_W_TOKU', 'ROKUJACA', 'MOCNA', 'EVERGREEN'];
const LIFECYCLE_SET = new Set(LIFECYCLE_VALUES);

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapLegacyLifecycle(longgevityCategory) {
  switch (longgevityCategory) {
    case 'BALON_PROBNY':
      return 'TEST_BALLOON';
    case 'TEST_W_TOKU':
      return 'PROMISING';
    case 'ROKUJACA':
      return 'ESTABLISHED';
    case 'MOCNA':
      return 'ESTABLISHED';
    case 'EVERGREEN':
      return 'EVERGREEN';
    default:
      return 'UNCLASSIFIED';
  }
}

function normalizeQueryTextForGrouping(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeQueryTextPreserveCase(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function mapMr04DecisionToStatus(decision) {
  if (decision === 'KEEP') return 'KEEP';
  if (decision === 'REVIEW') return 'POTENTIAL';
  if (decision === 'REJECT') return 'REJECT';
  return 'UNREVIEWED';
}

function normalizeRelevanceStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!RELEVANCE_STATUSES.has(normalized)) {
    return 'UNREVIEWED';
  }
  return normalized;
}

function normalizeDetailsStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!DETAILS_STATUSES.has(normalized)) {
    return 'NOT_FETCHED';
  }
  return normalized;
}

function mapRunRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    projectId: row.project_id,
    queryPlanId: row.query_plan_id,
    provider: row.provider || 'APIFY',
    providerRunId: row.provider_run_id || null,
    providerDatasetId: row.provider_dataset_id || null,
    status: row.status,
    progressStage: row.progress_stage || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at || row.started_at,
    country: row.country,
    queriesTotal: row.queries_total,
    queriesCompleted: row.queries_completed,
    apiHitsTotal: row.api_hits_total,
    fetchedCount: row.fetched_count || 0,
    uniqueAdsTotal: row.unique_ads_total,
    duplicatesCount: row.duplicates_count || 0,
    errorsTotal: row.errors_total,
    config: safeJsonParse(row.config_json, {}),
    errorMessage: row.error_message,
  };
}

function mapQueryRunRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    researchRunId: row.research_run_id,
    queryText: row.query_text,
    queryTextNormalized: row.query_text_normalized,
    queryTypeSnapshot: safeJsonParse(row.query_type_snapshot_json, []),
    queryCategory: row.query_category || null,
    sourceUrl: row.source_url || null,
    prioritySnapshot: row.priority_snapshot,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    pagesFetched: row.pages_fetched,
    hitsCount: row.hits_count,
    uniqueAdsCount: row.unique_ads_count,
    apiHitsCount: row.api_hits_count,
    errorMessage: row.error_message,
  };
}

function getResearchRunById(db, runId) {
  const row = db.prepare(`
    SELECT *
    FROM meta_research_runs
    WHERE id = ?
  `).get(runId);

  return mapRunRow(row);
}

function getLatestResearchRunForProject(db, projectId) {
  const row = db.prepare(`
    SELECT *
    FROM meta_research_runs
    WHERE project_id = ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(projectId);

  return mapRunRow(row);
}

function extractApprovedPlanAndGroups(db, projectId, queryPlanId = null) {
  const queryPlanRow = queryPlanId
    ? db.prepare(`
      SELECT *
      FROM query_plans
      WHERE id = ? AND project_id = ?
      LIMIT 1
    `).get(queryPlanId, projectId)
    : db.prepare(`
      SELECT *
      FROM query_plans
      WHERE project_id = ? AND status = 'APPROVED'
      ORDER BY updated_at DESC, generated_at DESC
      LIMIT 1
    `).get(projectId);

  if (!queryPlanRow) {
    return { queryPlan: null, queryGroups: [] };
  }

  if (queryPlanRow.status !== 'APPROVED') {
    return {
      queryPlan: {
        id: queryPlanRow.id,
        status: queryPlanRow.status,
      },
      queryGroups: [],
      notApproved: true,
    };
  }

  const seedRows = db.prepare(`
    SELECT *
    FROM query_plan_seeds
    WHERE query_plan_id = ?
    ORDER BY sort_order ASC
  `).all(queryPlanRow.id);

  const variantRows = db.prepare(`
    SELECT qv.*, qps.id AS query_plan_seed_id, qps.source_seed_id, qps.seed_text, qps.source_seed_origin
    FROM query_variants qv
    JOIN query_plan_seeds qps ON qps.id = qv.query_plan_seed_id
    WHERE qps.query_plan_id = ?
    ORDER BY qps.sort_order ASC, qv.sort_order ASC
  `).all(queryPlanRow.id);

  const groupByNormalized = new Map();

  for (const variant of variantRows) {
    if (!variant.enabled) continue;

    const normalized = normalizeQueryTextForGrouping(variant.query_text);
    const preserved = normalizeQueryTextPreserveCase(variant.query_text);
    if (!normalized || !preserved) continue;

    const existing = groupByNormalized.get(normalized) || {
      normalizedText: normalized,
      queryText: preserved,
      queryTypes: new Set(),
      maxPriority: variant.priority,
      variants: [],
    };

    existing.queryTypes.add(variant.query_type);
    existing.maxPriority = Math.max(existing.maxPriority, variant.priority);
    existing.variants.push({
      queryVariantId: variant.id,
      queryPlanSeedId: variant.query_plan_seed_id,
      sourceSeedId: variant.source_seed_id,
      seedText: variant.seed_text,
      sourceSeedOrigin: variant.source_seed_origin,
      queryText: preserved,
      queryType: variant.query_type,
      priority: variant.priority,
      sortOrder: variant.sort_order,
    });

    groupByNormalized.set(normalized, existing);
  }

  const queryGroups = [...groupByNormalized.values()].map(group => ({
    normalizedText: group.normalizedText,
    queryText: group.queryText,
    queryTypeSnapshot: [...group.queryTypes],
    queryCategory: [...group.queryTypes][0] || 'CORE',
    prioritySnapshot: group.maxPriority,
    variants: group.variants,
  }));

  return {
    queryPlan: {
      id: queryPlanRow.id,
      projectId: queryPlanRow.project_id,
      plannerVersion: queryPlanRow.planner_version,
      country: queryPlanRow.country,
      status: queryPlanRow.status,
      updatedAt: queryPlanRow.updated_at,
    },
    queryGroups,
    seedCount: seedRows.length,
    enabledVariantCount: variantRows.filter(v => v.enabled).length,
  };
}

function createResearchRun(db, {
  projectId,
  queryPlanId,
  country,
  queriesTotal,
  config,
  provider = 'APIFY',
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO meta_research_runs (
      id,
      project_id,
      query_plan_id,
      provider,
      provider_run_id,
      provider_dataset_id,
      status,
      progress_stage,
      started_at,
      finished_at,
      created_at,
      country,
      queries_total,
      queries_completed,
      api_hits_total,
      fetched_count,
      unique_ads_total,
      duplicates_count,
      errors_total,
      config_json,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    queryPlanId,
    provider,
    null,
    null,
    'PENDING',
    'Przygotowuje query...',
    now,
    null,
    now,
    country,
    queriesTotal,
    0,
    0,
    0,
    0,
    0,
    0,
    JSON.stringify(config || {}),
    null,
  );

  return getResearchRunById(db, id);
}

function updateResearchRunProgress(db, runId, patch) {
  const updates = [];
  const values = [];

  const fields = {
    providerRunId: 'provider_run_id',
    providerDatasetId: 'provider_dataset_id',
    status: 'status',
    progressStage: 'progress_stage',
    queriesCompleted: 'queries_completed',
    apiHitsTotal: 'api_hits_total',
    fetchedCount: 'fetched_count',
    uniqueAdsTotal: 'unique_ads_total',
    duplicatesCount: 'duplicates_count',
    errorsTotal: 'errors_total',
    finishedAt: 'finished_at',
    errorMessage: 'error_message',
  };

  for (const [key, column] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;

    if (key === 'status' && patch[key] != null && !RUN_STATUSES.has(patch[key])) {
      throw new Error(`Invalid run status: ${patch[key]}`);
    }

    updates.push(`${column} = ?`);
    values.push(patch[key]);
  }

  if (!updates.length) return;

  values.push(runId);

  db.prepare(`
    UPDATE meta_research_runs
    SET ${updates.join(', ')}
    WHERE id = ?
  `).run(...values);
}

function createQueryRun(db, {
  researchRunId,
  queryText,
  queryTextNormalized,
  queryTypeSnapshot,
  queryCategory,
  sourceUrl,
  prioritySnapshot,
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO meta_query_runs (
      id,
      research_run_id,
      query_text,
      query_text_normalized,
      query_type_snapshot_json,
      query_category,
      source_url,
      priority_snapshot,
      started_at,
      finished_at,
      status,
      pages_fetched,
      hits_count,
      unique_ads_count,
      api_hits_count,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    researchRunId,
    queryText,
    queryTextNormalized,
    JSON.stringify(Array.isArray(queryTypeSnapshot) ? queryTypeSnapshot : []),
    queryCategory || null,
    sourceUrl || null,
    Number.isFinite(prioritySnapshot) ? prioritySnapshot : 0,
    now,
    null,
    'RUNNING',
    0,
    0,
    0,
    0,
    null,
  );

  return getQueryRunById(db, id);
}

function updateQueryRun(db, queryRunId, patch) {
  const updates = [];
  const values = [];

  const fields = {
    finishedAt: 'finished_at',
    status: 'status',
    pagesFetched: 'pages_fetched',
    hitsCount: 'hits_count',
    uniqueAdsCount: 'unique_ads_count',
    apiHitsCount: 'api_hits_count',
    errorMessage: 'error_message',
  };

  for (const [key, column] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;

    if (key === 'status' && patch[key] != null && !QUERY_RUN_STATUSES.has(patch[key])) {
      throw new Error(`Invalid query run status: ${patch[key]}`);
    }

    updates.push(`${column} = ?`);
    values.push(patch[key]);
  }

  if (!updates.length) return;

  values.push(queryRunId);

  db.prepare(`
    UPDATE meta_query_runs
    SET ${updates.join(', ')}
    WHERE id = ?
  `).run(...values);
}

function getQueryRunById(db, queryRunId) {
  const row = db.prepare(`
    SELECT *
    FROM meta_query_runs
    WHERE id = ?
  `).get(queryRunId);

  return mapQueryRunRow(row);
}

function linkQueryRunVariants(db, queryRunId, variants) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO meta_query_run_variants (
      id,
      query_run_id,
      query_variant_id,
      query_plan_seed_id,
      source_seed_id,
      seed_text,
      query_text_snapshot,
      query_type_snapshot,
      priority_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const variant of variants) {
      insert.run(
        crypto.randomUUID(),
        queryRunId,
        variant.queryVariantId,
        variant.queryPlanSeedId,
        variant.sourceSeedId,
        variant.seedText,
        variant.queryText,
        variant.queryType,
        variant.priority,
      );
    }
  });

  tx();
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item ?? '').trim()).filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function parseInteger(value) {
  if (value == null) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractBodyText(snapshot) {
  if (!snapshot) return null;

  if (typeof snapshot.body === 'string') {
    const value = snapshot.body.trim();
    return value || null;
  }

  if (snapshot.body && typeof snapshot.body.text === 'string') {
    const value = snapshot.body.text.trim();
    return value || null;
  }

  if (Array.isArray(snapshot.body)) {
    const first = snapshot.body.find(item => typeof item === 'string' && item.trim());
    return first ? first.trim() : null;
  }

  return null;
}

function extractTitle(snapshot) {
  if (!snapshot) return null;

  const candidates = [
    snapshot.title,
    snapshot.link_title,
    snapshot.headline,
    snapshot.link_description,
    Array.isArray(snapshot.cards) && snapshot.cards.length ? snapshot.cards[0]?.title : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  return null;
}

function extractDestinationUrl(snapshot) {
  if (!snapshot) return null;

  const candidates = [
    snapshot.link_url,
    Array.isArray(snapshot.cards) && snapshot.cards.length ? snapshot.cards[0]?.link_url : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  return null;
}

function extractCollationId(rawAd, snapshot) {
  const candidates = [
    rawAd?.collation_id,
    rawAd?.collationId,
    snapshot?.collation_id,
    snapshot?.collationId,
  ];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    const value = String(candidate).trim();
    if (value) return value;
  }

  return null;
}

function getDomainAndPath(urlText) {
  if (!urlText || typeof urlText !== 'string') {
    return {
      domain: null,
      path: null,
    };
  }

  try {
    const parsed = new URL(urlText);
    const path = parsed.pathname && parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
      ? parsed.pathname.slice(0, -1)
      : (parsed.pathname || '/');

    return {
      domain: parsed.hostname.toLowerCase(),
      path,
    };
  } catch {
    return {
      domain: null,
      path: null,
    };
  }
}

function extractAdFromApify(rawAd, observedAt) {
  const adArchiveId = String(rawAd.ad_archive_id || rawAd.id || '').trim();
  if (!adArchiveId) {
    throw new Error('Record is missing ad_archive_id');
  }

  const snapshot = rawAd.snapshot && typeof rawAd.snapshot === 'object'
    ? rawAd.snapshot
    : {};

  const pageName = String(rawAd.page_name || snapshot.page_name || '').trim() || null;
  const bodyText = extractBodyText(snapshot);
  const title = extractTitle(snapshot);
  const destinationUrl = extractDestinationUrl(snapshot);
  const canonicalDestinationUrl = canonicalizeUrl(destinationUrl);
  const urlParts = getDomainAndPath(canonicalDestinationUrl || destinationUrl);
  const collationId = extractCollationId(rawAd, snapshot);

  const isActive = typeof rawAd.is_active === 'boolean'
    ? rawAd.is_active
    : String(rawAd.is_active || '').toLowerCase() === 'true';

  const startDate = rawAd.start_date_formatted || rawAd.start_date || null;
  const endDate = rawAd.end_date_formatted || rawAd.end_date || null;

  const lifecycle = classifyAdLifecycle({
    startDate,
    endDate,
    isActive,
    now: new Date(observedAt),
  });

  const publisherPlatforms = toStringArray(rawAd.publisher_platform);
  const pageCategories = toStringArray(snapshot.page_categories);

  const imageUrls = Array.isArray(snapshot.images)
    ? snapshot.images.map(image => image?.original_image_url || image?.resized_image_url || image?.url || null).filter(Boolean)
    : [];

  const videoUrls = Array.isArray(snapshot.videos)
    ? snapshot.videos.map(video => video?.video_hd_url || video?.video_sd_url || video?.url || null).filter(Boolean)
    : [];

  const creativeBodies = bodyText ? [bodyText] : [];
  const creativeTitles = title ? [title] : [];
  const creativeDescriptions = toStringArray(snapshot.link_description);

  return {
    metaAdId: adArchiveId,
    adArchiveId,
    pageId: rawAd.page_id ? String(rawAd.page_id) : null,
    pageName,
    pageProfileUrl: snapshot.page_profile_uri || null,
    bodyText,
    title,
    displayFormat: snapshot.display_format || null,
    ctaType: snapshot.cta_type || null,
    ctaText: snapshot.cta_text || null,
    destinationUrl,
    canonicalDestinationUrl,
    destinationDomain: urlParts.domain,
    destinationPath: urlParts.path,
    collationId,
    collationCount: parseInteger(rawAd.collation_count || snapshot.collation_count),
    adLibraryUrl: rawAd.ad_library_url || rawAd.url || null,
    isActive,
    startDate,
    endDate,
    publisherPlatforms,
    pageCategories,
    pageLikeCount: parseInteger(snapshot.page_like_count),
    adsCount: parseInteger(rawAd.ads_count),
    runtimeDays: lifecycle.runtimeDays,
    longevityCategory: lifecycle.longevityCategory,
    lifecycleClass: mapLegacyLifecycle(lifecycle.longevityCategory),
    lifecycleConfidence: lifecycle.lifecycleConfidence,
    lifecycleReasons: lifecycle.lifecycleReasons,
    createdAt: observedAt,
    updatedAt: observedAt,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    rawJson: JSON.stringify(rawAd),
    creativeBodies,
    creativeTitles,
    creativeDescriptions,
    imageUrls,
    videoUrls,
  };
}

function upsertMetaAd(db, model) {
  const existing = db.prepare(`
    SELECT meta_ad_id, first_seen_at
    FROM meta_ads
    WHERE ad_archive_id = ? OR meta_ad_id = ?
    LIMIT 1
  `).get(model.adArchiveId, model.metaAdId);

  if (!existing) {
    db.prepare(`
      INSERT INTO meta_ads (
        meta_ad_id,
        ad_archive_id,
        page_id,
        page_name,
        page_profile_url,
        body_text,
        title,
        display_format,
        cta_type,
        cta_text,
        destination_url,
        canonical_destination_url,
        destination_domain,
        destination_path,
        collation_id,
        collation_count,
        ad_library_url,
        is_active,
        start_date,
        end_date,
        publisher_platforms,
        page_categories,
        page_like_count,
        ads_count,
        runtime_days,
        longevity_category,
        relevance_score,
        relevance_status,
        rejection_reason,
        raw_json,
        created_at,
        updated_at,
        ad_delivery_start_time,
        ad_delivery_stop_time,
        ad_snapshot_url,
        creative_bodies_json,
        creative_link_titles_json,
        creative_link_descriptions_json,
        publisher_platforms_json,
        languages_json,
        eu_total_reach,
        first_seen_at,
        last_seen_at,
        latest_raw_json,
        lifecycle_class,
        lifecycle_confidence,
        lifecycle_reasons_json,
        delivery_age_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      model.metaAdId,
      model.adArchiveId,
      model.pageId,
      model.pageName,
      model.pageProfileUrl,
      model.bodyText,
      model.title,
      model.displayFormat,
      model.ctaType,
      model.ctaText,
      model.destinationUrl,
      model.canonicalDestinationUrl,
      model.destinationDomain,
      model.destinationPath,
      model.collationId,
      model.collationCount,
      model.adLibraryUrl,
      model.isActive ? 1 : 0,
      model.startDate,
      model.endDate,
      JSON.stringify(model.publisherPlatforms),
      JSON.stringify(model.pageCategories),
      model.pageLikeCount,
      model.adsCount,
      model.runtimeDays,
      model.longevityCategory,
      null,
      null,
      null,
      model.rawJson,
      model.createdAt,
      model.updatedAt,
      model.startDate,
      model.endDate,
      model.adLibraryUrl,
      JSON.stringify(model.creativeBodies),
      JSON.stringify(model.creativeTitles),
      JSON.stringify(model.creativeDescriptions),
      JSON.stringify(model.publisherPlatforms),
      '[]',
      null,
      model.firstSeenAt,
      model.lastSeenAt,
      model.rawJson,
      model.lifecycleClass,
      model.lifecycleConfidence,
      JSON.stringify(model.lifecycleReasons),
      model.runtimeDays,
    );

    return { metaAdId: model.metaAdId, inserted: true };
  }

  db.prepare(`
    UPDATE meta_ads
    SET ad_archive_id = ?,
        page_id = ?,
        page_name = ?,
        page_profile_url = ?,
        body_text = ?,
        title = ?,
        display_format = ?,
        cta_type = ?,
        cta_text = ?,
        destination_url = ?,
        canonical_destination_url = ?,
        destination_domain = ?,
        destination_path = ?,
        collation_id = ?,
        collation_count = ?,
        ad_library_url = ?,
        is_active = ?,
        start_date = ?,
        end_date = ?,
        publisher_platforms = ?,
        page_categories = ?,
        page_like_count = ?,
        ads_count = ?,
        runtime_days = ?,
        longevity_category = ?,
        raw_json = ?,
        updated_at = ?,
        ad_delivery_start_time = ?,
        ad_delivery_stop_time = ?,
        ad_snapshot_url = ?,
        creative_bodies_json = ?,
        creative_link_titles_json = ?,
        creative_link_descriptions_json = ?,
        publisher_platforms_json = ?,
        latest_raw_json = ?,
        last_seen_at = ?,
        lifecycle_class = ?,
        lifecycle_confidence = ?,
        lifecycle_reasons_json = ?,
        delivery_age_days = ?
    WHERE meta_ad_id = ?
  `).run(
    model.adArchiveId,
    model.pageId,
    model.pageName,
    model.pageProfileUrl,
    model.bodyText,
    model.title,
    model.displayFormat,
    model.ctaType,
    model.ctaText,
    model.destinationUrl,
    model.canonicalDestinationUrl,
    model.destinationDomain,
    model.destinationPath,
    model.collationId,
    model.collationCount,
    model.adLibraryUrl,
    model.isActive ? 1 : 0,
    model.startDate,
    model.endDate,
    JSON.stringify(model.publisherPlatforms),
    JSON.stringify(model.pageCategories),
    model.pageLikeCount,
    model.adsCount,
    model.runtimeDays,
    model.longevityCategory,
    model.rawJson,
    model.updatedAt,
    model.startDate,
    model.endDate,
    model.adLibraryUrl,
    JSON.stringify(model.creativeBodies),
    JSON.stringify(model.creativeTitles),
    JSON.stringify(model.creativeDescriptions),
    JSON.stringify(model.publisherPlatforms),
    model.rawJson,
    model.lastSeenAt,
    model.lifecycleClass,
    model.lifecycleConfidence,
    JSON.stringify(model.lifecycleReasons),
    model.runtimeDays,
    existing.meta_ad_id,
  );

  return { metaAdId: existing.meta_ad_id, inserted: false };
}

function ensureProjectAdRelevanceRows(db, {
  projectId,
  metaAdIds,
}) {
  const uniqueMetaAdIds = [...new Set((metaAdIds || []).map(item => String(item || '').trim()).filter(Boolean))];
  if (!uniqueMetaAdIds.length) {
    return { ensuredCount: 0 };
  }

  const placeholders = uniqueMetaAdIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      meta_ad_id,
      COALESCE(ad_archive_id, meta_ad_id) AS ad_archive_id
    FROM meta_ads
    WHERE meta_ad_id IN (${placeholders})
  `).all(...uniqueMetaAdIds);

  if (!rows.length) {
    return { ensuredCount: 0 };
  }

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO project_ad_relevance (
      id,
      project_id,
      meta_ad_id,
      ad_archive_id,
      relevance_status,
      relevance_source,
      details_status,
      manual_override,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      insert.run(
        crypto.randomUUID(),
        projectId,
        row.meta_ad_id,
        row.ad_archive_id,
        'UNREVIEWED',
        'MR04',
        'NOT_FETCHED',
        0,
        now,
        now,
      );
    }
  });

  tx();

  return {
    ensuredCount: rows.length,
  };
}

function getProjectRelevancePendingCount(db, projectId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count_pending
    FROM project_ad_relevance
    WHERE project_id = ?
      AND manual_override = 0
      AND relevance_status = 'UNREVIEWED'
  `).get(projectId);

  return row?.count_pending || 0;
}

function getProjectAdsForRelevanceReview(db, projectId, {
  includeResolved = false,
  limit = 1500,
} = {}) {
  const rows = db.prepare(`
    SELECT
      par.meta_ad_id,
      par.ad_archive_id,
      par.relevance_status,
      par.relevance_source,
      par.manual_override,
      par.mr04_decision,
      par.mr04_confidence,
      par.mr04_reason_code,
      par.mr04_reason,
      par.mr04_filter_version,
      par.mr04_checked_at,
      par.details_status,
      par.details_fetched_at,
      par.details_provider,
      par.details_error,
      ma.page_id,
      ma.page_name,
      ma.page_profile_url,
      ma.body_text,
      ma.title,
      ma.destination_url,
      ma.ad_library_url,
      ma.start_date,
      ma.end_date,
      ma.is_active,
      ma.longevity_category,
      ma.runtime_days,
      ma.updated_at,
      (
        SELECT GROUP_CONCAT(DISTINCT maqm.query_text)
        FROM meta_ad_query_matches maqm
        JOIN meta_research_runs mrr ON mrr.id = maqm.research_run_id
        WHERE maqm.meta_ad_id = ma.meta_ad_id
          AND mrr.project_id = par.project_id
      ) AS matched_queries,
      (
        SELECT GROUP_CONCAT(DISTINCT mqrv.seed_text)
        FROM meta_ad_query_matches maqm
        JOIN meta_research_runs mrr ON mrr.id = maqm.research_run_id
        LEFT JOIN meta_query_run_variants mqrv ON mqrv.query_run_id = maqm.query_run_id
        WHERE maqm.meta_ad_id = ma.meta_ad_id
          AND mrr.project_id = par.project_id
      ) AS matched_seeds
    FROM project_ad_relevance par
    JOIN meta_ads ma ON ma.meta_ad_id = par.meta_ad_id
    WHERE par.project_id = ?
      AND (
        ? = 1
        OR (par.manual_override = 0 AND par.relevance_status = 'UNREVIEWED')
      )
    ORDER BY COALESCE(ma.updated_at, ma.last_seen_at, ma.first_seen_at) DESC
    LIMIT ?
  `).all(projectId, includeResolved ? 1 : 0, Math.max(1, Number(limit) || 1500));

  return rows.map(row => ({
    metaAdId: row.meta_ad_id,
    adArchiveId: row.ad_archive_id,
    relevanceStatus: normalizeRelevanceStatus(row.relevance_status),
    relevanceSource: row.relevance_source || 'MR04',
    manualOverride: row.manual_override === 1,
    mr04Decision: row.mr04_decision || null,
    mr04Confidence: Number.isFinite(Number(row.mr04_confidence)) ? Number(row.mr04_confidence) : null,
    mr04ReasonCode: row.mr04_reason_code || null,
    mr04Reason: row.mr04_reason || null,
    mr04FilterVersion: row.mr04_filter_version || null,
    mr04CheckedAt: row.mr04_checked_at || null,
    detailsStatus: normalizeDetailsStatus(row.details_status),
    detailsFetchedAt: row.details_fetched_at || null,
    detailsProvider: row.details_provider || null,
    detailsError: row.details_error || null,
    pageId: row.page_id,
    pageName: row.page_name,
    pageProfileUrl: row.page_profile_url,
    bodyText: row.body_text,
    title: row.title,
    destinationUrl: row.destination_url,
    adLibraryUrl: row.ad_library_url,
    startDate: row.start_date,
    endDate: row.end_date,
    isActive: row.is_active === 1,
    longevityCategory: row.longevity_category,
    runtimeDays: row.runtime_days,
    matchedQueries: row.matched_queries
      ? row.matched_queries.split(',').map(item => item.trim()).filter(Boolean)
      : [],
    matchedSeeds: row.matched_seeds
      ? row.matched_seeds.split(',').map(item => item.trim()).filter(Boolean)
      : [],
  }));
}

function applyMr04Decisions(db, {
  projectId,
  decisions,
  filterVersion = 'mr04',
}) {
  const selectRow = db.prepare(`
    SELECT *
    FROM project_ad_relevance
    WHERE project_id = ? AND ad_archive_id = ?
    LIMIT 1
  `);

  const updateRow = db.prepare(`
    UPDATE project_ad_relevance
    SET relevance_status = ?,
        relevance_source = 'MR04',
        mr04_decision = ?,
        mr04_confidence = ?,
        mr04_reason_code = ?,
        mr04_reason = ?,
        mr04_filter_version = ?,
        mr04_checked_at = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const stats = {
    processed: 0,
    keep: 0,
    potential: 0,
    reject: 0,
    skippedManual: 0,
    missing: 0,
    invalid: 0,
  };

  const tx = db.transaction(() => {
    for (const decisionItem of decisions || []) {
      const adArchiveId = String(decisionItem.adArchiveId || '').trim();
      const decision = String(decisionItem.decision || '').trim().toUpperCase();

      if (!adArchiveId || !MR04_DECISIONS.has(decision)) {
        stats.invalid += 1;
        continue;
      }

      const row = selectRow.get(projectId, adArchiveId);
      if (!row) {
        stats.missing += 1;
        continue;
      }

      if (row.manual_override === 1) {
        stats.skippedManual += 1;
        continue;
      }

      const mappedStatus = mapMr04DecisionToStatus(decision);
      const now = new Date().toISOString();
      const confidenceRaw = Number(decisionItem.confidence);
      const confidence = Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
        : null;

      updateRow.run(
        mappedStatus,
        decision,
        confidence,
        decisionItem.reasonCode ? String(decisionItem.reasonCode) : null,
        decisionItem.reason ? String(decisionItem.reason) : null,
        String(filterVersion || 'mr04'),
        now,
        now,
        row.id,
      );

      stats.processed += 1;
      if (mappedStatus === 'KEEP') stats.keep += 1;
      if (mappedStatus === 'POTENTIAL') stats.potential += 1;
      if (mappedStatus === 'REJECT') stats.reject += 1;
    }
  });

  tx();

  return stats;
}

function getProjectAdRelevanceRow(db, projectId, adArchiveId) {
  return db.prepare(`
    SELECT *
    FROM project_ad_relevance
    WHERE project_id = ? AND ad_archive_id = ?
    LIMIT 1
  `).get(projectId, adArchiveId);
}

function mapProjectAdRelevanceRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    projectId: row.project_id,
    metaAdId: row.meta_ad_id,
    adArchiveId: row.ad_archive_id,
    relevanceStatus: normalizeRelevanceStatus(row.relevance_status),
    relevanceSource: row.relevance_source || 'MR04',
    manualOverride: row.manual_override === 1,
    manualOverrideStatus: row.manual_override_status || null,
    manualOverrideAt: row.manual_override_at || null,
    mr04Decision: row.mr04_decision || null,
    mr04Confidence: row.mr04_confidence,
    mr04ReasonCode: row.mr04_reason_code || null,
    mr04Reason: row.mr04_reason || null,
    mr04FilterVersion: row.mr04_filter_version || null,
    mr04CheckedAt: row.mr04_checked_at || null,
    detailsStatus: normalizeDetailsStatus(row.details_status),
    detailsFetchedAt: row.details_fetched_at || null,
    detailsProvider: row.details_provider || null,
    detailsError: row.details_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function setProjectAdManualRelevance(db, {
  projectId,
  adArchiveId,
  relevanceStatus,
}) {
  const normalizedStatus = String(relevanceStatus || '').trim().toUpperCase();
  if (!['KEEP', 'POTENTIAL', 'REJECT'].includes(normalizedStatus)) {
    const error = new Error('Invalid relevance status. Allowed: KEEP, POTENTIAL, REJECT');
    error.code = 'INVALID_RELEVANCE_STATUS';
    throw error;
  }

  const now = new Date().toISOString();
  const normalizedArchiveId = String(adArchiveId || '').trim();

  if (!normalizedArchiveId) {
    const error = new Error('adArchiveId is required');
    error.code = 'INVALID_AD_ARCHIVE_ID';
    throw error;
  }

  const tx = db.transaction(() => {
    const existing = getProjectAdRelevanceRow(db, projectId, normalizedArchiveId);

    if (!existing) {
      const ad = db.prepare(`
        SELECT meta_ad_id, COALESCE(ad_archive_id, meta_ad_id) AS ad_archive_id
        FROM meta_ads
        WHERE COALESCE(ad_archive_id, meta_ad_id) = ?
        LIMIT 1
      `).get(normalizedArchiveId);

      if (!ad) {
        const error = new Error('Ad not found in meta_ads');
        error.code = 'AD_NOT_FOUND';
        throw error;
      }

      db.prepare(`
        INSERT INTO project_ad_relevance (
          id,
          project_id,
          meta_ad_id,
          ad_archive_id,
          relevance_status,
          relevance_source,
          manual_override,
          manual_override_status,
          manual_override_at,
          details_status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        projectId,
        ad.meta_ad_id,
        ad.ad_archive_id,
        normalizedStatus,
        'MANUAL',
        1,
        normalizedStatus,
        now,
        'NOT_FETCHED',
        now,
        now,
      );
    } else {
      db.prepare(`
        UPDATE project_ad_relevance
        SET relevance_status = ?,
            relevance_source = 'MANUAL',
            manual_override = 1,
            manual_override_status = ?,
            manual_override_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        normalizedStatus,
        normalizedStatus,
        now,
        now,
        existing.id,
      );
    }
  });

  tx();

  const updated = getProjectAdRelevanceRow(db, projectId, normalizedArchiveId);
  return mapProjectAdRelevanceRow(updated);
}

function restoreProjectAdRelevanceToMr04(db, {
  projectId,
  adArchiveId,
}) {
  const normalizedArchiveId = String(adArchiveId || '').trim();
  const existing = getProjectAdRelevanceRow(db, projectId, normalizedArchiveId);
  if (!existing) {
    const error = new Error('Relevance row not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const mappedStatus = mapMr04DecisionToStatus(existing.mr04_decision);
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE project_ad_relevance
    SET relevance_status = ?,
        relevance_source = 'MR04',
        manual_override = 0,
        manual_override_status = NULL,
        manual_override_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(
    mappedStatus,
    now,
    existing.id,
  );

  const updated = getProjectAdRelevanceRow(db, projectId, normalizedArchiveId);
  return mapProjectAdRelevanceRow(updated);
}

function getProjectAdsEligibleForDetails(db, projectId, {
  statuses = ['KEEP', 'POTENTIAL'],
  includeFailed = true,
  limit = 2000,
  adArchiveIds = [],
} = {}) {
  const normalizedStatuses = [...new Set((statuses || []).map(status => String(status || '').trim().toUpperCase()).filter(status => ['KEEP', 'POTENTIAL', 'REJECT', 'UNREVIEWED'].includes(status)))];
  if (!normalizedStatuses.length) {
    return [];
  }

  const normalizedArchiveIds = [...new Set((adArchiveIds || [])
    .map(adArchiveId => String(adArchiveId || '').trim())
    .filter(Boolean))];
  if (Array.isArray(adArchiveIds) && !normalizedArchiveIds.length) {
    return [];
  }

  const statusPlaceholders = normalizedStatuses.map(() => '?').join(', ');
  const detailStatuses = includeFailed ? ['NOT_FETCHED', 'FAILED'] : ['NOT_FETCHED'];
  const detailPlaceholders = detailStatuses.map(() => '?').join(', ');
  const archivePlaceholders = normalizedArchiveIds.map(() => '?').join(', ');
  const archiveClause = normalizedArchiveIds.length
    ? `\n      AND par.ad_archive_id IN (${archivePlaceholders})`
    : '';

  return db.prepare(`
    SELECT
      par.id,
      par.project_id,
      par.meta_ad_id,
      par.ad_archive_id,
      par.relevance_status,
      par.relevance_source,
      par.details_status,
      par.details_fetched_at,
      par.details_provider,
      par.details_error,
      par.details_json,
      ma.page_name,
      ma.ad_library_url,
      ma.raw_json
    FROM project_ad_relevance par
    JOIN meta_ads ma ON ma.meta_ad_id = par.meta_ad_id
    WHERE par.project_id = ?
      AND par.relevance_status IN (${statusPlaceholders})
      AND par.details_status IN (${detailPlaceholders})
      ${archiveClause}
    ORDER BY COALESCE(ma.updated_at, ma.last_seen_at, ma.first_seen_at) DESC
    LIMIT ?
  `).all(
    projectId,
    ...normalizedStatuses,
    ...detailStatuses,
    ...normalizedArchiveIds,
    Math.max(1, Number(limit) || 2000),
  ).map(row => ({
    id: row.id,
    projectId: row.project_id,
    metaAdId: row.meta_ad_id,
    adArchiveId: row.ad_archive_id,
    relevanceStatus: normalizeRelevanceStatus(row.relevance_status),
    relevanceSource: row.relevance_source || 'MR04',
    detailsStatus: normalizeDetailsStatus(row.details_status),
    detailsFetchedAt: row.details_fetched_at || null,
    detailsProvider: row.details_provider || null,
    detailsError: row.details_error || null,
    detailsJson: safeJsonParse(row.details_json, null),
    pageName: row.page_name || null,
    adLibraryUrl: row.ad_library_url || null,
    rawJson: safeJsonParse(row.raw_json, {}),
  }));
}

function applyLocalDetailsSnapshot(db, {
  projectId,
  ads,
  providerName = 'LOCAL_META_ADS_SNAPSHOT',
}) {
  const list = Array.isArray(ads) ? ads : [];
  if (!list.length) {
    return {
      provider: providerName,
      fetched: 0,
      failed: 0,
      skipped: 0,
      detailsMode: 'local-snapshot',
    };
  }

  const updateFetched = db.prepare(`
    UPDATE project_ad_relevance
    SET details_status = 'FETCHED',
        details_fetched_at = ?,
        details_provider = ?,
        details_error = NULL,
        details_json = ?,
        updated_at = ?
    WHERE id = ? AND project_id = ?
  `);

  const updateFailed = db.prepare(`
    UPDATE project_ad_relevance
    SET details_status = 'FAILED',
        details_provider = ?,
        details_error = ?,
        updated_at = ?
    WHERE id = ? AND project_id = ?
  `);

  const stats = {
    provider: providerName,
    fetched: 0,
    failed: 0,
    skipped: 0,
    detailsMode: 'local-snapshot',
  };

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const ad of list) {
      if (!ad || !ad.id) {
        stats.skipped += 1;
        continue;
      }

      try {
        const rawJson = ad.rawJson && typeof ad.rawJson === 'object' ? ad.rawJson : null;
        const detailsJson = {
          source: 'meta_ads_snapshot',
          capturedAt: now,
          adArchiveId: ad.adArchiveId || null,
          pageName: ad.pageName || null,
          adLibraryUrl: ad.adLibraryUrl || null,
          rawJson,
        };

        updateFetched.run(
          now,
          providerName,
          JSON.stringify(detailsJson),
          now,
          ad.id,
          projectId,
        );
        stats.fetched += 1;
      } catch (error) {
        updateFailed.run(
          providerName,
          error.message,
          now,
          ad.id,
          projectId,
        );
        stats.failed += 1;
      }
    }
  });

  tx();
  return stats;
}

function saveSearchHit(db, {
  queryRunId,
  metaAdId,
  discoveredAt,
  resultPosition,
  visibleTextMatch,
  matchedTerms,
  missingTerms,
}) {
  db.prepare(`
    INSERT OR IGNORE INTO meta_search_hits (
      id,
      query_run_id,
      meta_ad_id,
      discovered_at,
      result_position,
      visible_text_match,
      matched_terms_json,
      missing_terms_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    queryRunId,
    metaAdId,
    discoveredAt,
    resultPosition,
    visibleTextMatch ? 1 : 0,
    JSON.stringify(matchedTerms || []),
    JSON.stringify(missingTerms || []),
  );
}

function saveAdObservation(db, {
  metaAdId,
  researchRunId,
  observedAt,
  adDeliveryStartTime,
  adDeliveryStopTime,
  euTotalReach,
  rawJson,
}) {
  db.prepare(`
    INSERT INTO meta_ad_observations (
      id,
      meta_ad_id,
      research_run_id,
      observed_at,
      ad_delivery_start_time,
      ad_delivery_stop_time,
      eu_total_reach,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(meta_ad_id, research_run_id)
    DO UPDATE SET
      observed_at = excluded.observed_at,
      ad_delivery_start_time = excluded.ad_delivery_start_time,
      ad_delivery_stop_time = excluded.ad_delivery_stop_time,
      eu_total_reach = excluded.eu_total_reach,
      raw_json = excluded.raw_json
  `).run(
    crypto.randomUUID(),
    metaAdId,
    researchRunId,
    observedAt,
    adDeliveryStartTime,
    adDeliveryStopTime,
    euTotalReach,
    rawJson,
  );
}

function computeMatchEvidence(queryText, model) {
  const haystack = [model.pageName, model.title, model.bodyText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const normalized = normalizeQueryTextForGrouping(queryText);
  const terms = normalized.split(' ').filter(Boolean);

  const matchedTerms = [];
  const missingTerms = [];

  for (const term of terms) {
    if (haystack.includes(term)) matchedTerms.push(term);
    else missingTerms.push(term);
  }

  return {
    visibleTextMatch: missingTerms.length === 0,
    matchedTerms,
    missingTerms,
  };
}

function saveAdQueryMatch(db, {
  researchRunId,
  metaAdId,
  queryRunId,
  queryText,
  queryCategory,
  sourceUrl,
  sourcePosition,
  matchedAt,
}) {
  db.prepare(`
    INSERT OR IGNORE INTO meta_ad_query_matches (
      id,
      research_run_id,
      meta_ad_id,
      query_run_id,
      query_text,
      query_category,
      source_url,
      source_position,
      matched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    researchRunId,
    metaAdId,
    queryRunId,
    queryText,
    queryCategory || null,
    sourceUrl || null,
    sourcePosition || null,
    matchedAt,
  );
}

function saveAdsPageBatch(db, {
  researchRunId,
  ads,
  observedAt,
}) {
  let processedCount = 0;
  let invalidCount = 0;
  let insertedCount = 0;
  let firstErrorMessage = null;
  const uniqueAdIds = new Set();

  const tx = db.transaction(() => {
    for (const hit of ads) {
      try {
        const model = extractAdFromApify(hit.rawAd, observedAt);
        const upsertResult = upsertMetaAd(db, model);

        const evidence = computeMatchEvidence(hit.queryText, model);

        saveAdQueryMatch(db, {
          researchRunId,
          metaAdId: upsertResult.metaAdId,
          queryRunId: hit.queryRunId || null,
          queryText: hit.queryText,
          queryCategory: hit.queryCategory,
          sourceUrl: hit.sourceUrl,
          sourcePosition: hit.resultPosition,
          matchedAt: observedAt,
        });

        if (hit.queryRunId) {
          saveSearchHit(db, {
            queryRunId: hit.queryRunId,
            metaAdId: upsertResult.metaAdId,
            discoveredAt: observedAt,
            resultPosition: hit.resultPosition,
            visibleTextMatch: evidence.visibleTextMatch,
            matchedTerms: evidence.matchedTerms,
            missingTerms: evidence.missingTerms,
          });
        }

        saveAdObservation(db, {
          metaAdId: upsertResult.metaAdId,
          researchRunId,
          observedAt,
          adDeliveryStartTime: model.startDate,
          adDeliveryStopTime: model.endDate,
          euTotalReach: null,
          rawJson: model.rawJson,
        });

        if (upsertResult.inserted) insertedCount += 1;
        uniqueAdIds.add(upsertResult.metaAdId);
        processedCount += 1;
      } catch (error) {
        if (!firstErrorMessage) {
          firstErrorMessage = error.message;
        }
        invalidCount += 1;
      }
    }
  });

  tx();

  return {
    processedCount,
    invalidCount,
    insertedCount,
    firstErrorMessage,
    uniqueAdIds,
  };
}

function buildRunLongevityBreakdown(db, runId) {
  const rows = db.prepare(`
    SELECT
      COALESCE(ma.longevity_category, 'BALON_PROBNY') AS longevity_category,
      COUNT(DISTINCT ma.meta_ad_id) AS count_ads
    FROM meta_ads ma
    JOIN meta_ad_query_matches maqm ON maqm.meta_ad_id = ma.meta_ad_id
    WHERE maqm.research_run_id = ?
    GROUP BY COALESCE(ma.longevity_category, 'BALON_PROBNY')
  `).all(runId);

  const breakdown = {
    BALON_PROBNY: 0,
    TEST_W_TOKU: 0,
    ROKUJACA: 0,
    MOCNA: 0,
    EVERGREEN: 0,
  };

  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(breakdown, row.longevity_category)) {
      breakdown[row.longevity_category] = row.count_ads;
    }
  }

  return breakdown;
}

function getResearchRunWithQueryRuns(db, runId) {
  const run = getResearchRunById(db, runId);
  if (!run) return null;

  const queryRuns = db.prepare(`
    SELECT *
    FROM meta_query_runs
    WHERE research_run_id = ?
    ORDER BY started_at ASC
  `).all(runId).map(mapQueryRunRow);

  const lifecycleBreakdown = buildRunLongevityBreakdown(db, runId);

  return {
    ...run,
    lifecycleBreakdown,
    queryRuns,
  };
}

function getLatestResearchRunWithQueryRuns(db, projectId) {
  const latest = getLatestResearchRunForProject(db, projectId);
  if (!latest) return null;
  return getResearchRunWithQueryRuns(db, latest.id);
}

function buildOrderClause(sortBy, sortDirection) {
  const dir = String(sortDirection || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  switch (sortBy) {
    case 'lifecycle':
      return ` ORDER BY longevity_rank ${dir}, ma.runtime_days DESC, ma.updated_at DESC `;
    case 'duration':
      return ` ORDER BY COALESCE(ma.runtime_days, 0) ${dir}, ma.updated_at DESC `;
    case 'reach':
      return ` ORDER BY COALESCE(ma.page_like_count, 0) ${dir}, ma.updated_at DESC `;
    case 'start':
      return ` ORDER BY ma.start_date ${dir}, ma.updated_at DESC `;
    case 'firstSeen':
      return ` ORDER BY ma.created_at ${dir}, ma.updated_at DESC `;
    case 'lastSeen':
    default:
      return ` ORDER BY ma.updated_at ${dir} `;
  }
}

function buildWildcardLikePattern(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  const escaped = raw
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\$/g, '%');

  return `%${escaped}%`;
}

function normalizeLifecycleValues(values) {
  if (!Array.isArray(values)) return [];

  const normalized = values
    .map(value => String(value || '').trim().toUpperCase())
    .filter(value => LIFECYCLE_SET.has(value));

  return [...new Set(normalized)];
}

function buildResearchAdsFilterQuery(projectId, runId, filters = {}, {
  includeLifecycle = true,
} = {}) {
  const where = ['maqm.research_run_id = ?'];
  const params = [projectId, runId];

  const relevanceScope = String(filters.relevanceScope || 'USEFUL').trim().toUpperCase();
  if (relevanceScope === 'USEFUL' || relevanceScope === 'KEEP') {
    where.push("COALESCE(par.relevance_status, 'UNREVIEWED') = 'KEEP'");
  } else if (relevanceScope === 'POTENTIAL') {
    where.push("COALESCE(par.relevance_status, 'UNREVIEWED') = 'POTENTIAL'");
  } else if (relevanceScope === 'UNREVIEWED') {
    where.push("COALESCE(par.relevance_status, 'UNREVIEWED') = 'UNREVIEWED'");
  } else if (relevanceScope === 'REJECT') {
    where.push("COALESCE(par.relevance_status, 'UNREVIEWED') IN ('REJECT', 'POTENTIAL')");
  }

  if (filters.pageName) {
    where.push("LOWER(COALESCE(ma.page_name, '')) LIKE ?");
    params.push(`%${String(filters.pageName).trim().toLowerCase()}%`);
  }

  if (filters.startDate) {
    where.push('ma.start_date >= ?');
    params.push(String(filters.startDate));
  }

  const lifecycleValues = normalizeLifecycleValues(filters.lifecycleValues);
  if (includeLifecycle) {
    if (lifecycleValues.length) {
      const placeholders = lifecycleValues.map(() => '?').join(', ');
      where.push(`ma.longevity_category IN (${placeholders})`);
      params.push(...lifecycleValues);
    } else if (filters.lifecycle && filters.lifecycle !== 'ALL') {
      where.push('ma.longevity_category = ?');
      params.push(String(filters.lifecycle));
    }
  }

  if (filters.activeState === 'ACTIVE') {
    where.push('ma.is_active = 1');
  }

  if (filters.activeState === 'INACTIVE') {
    where.push('ma.is_active = 0');
  }

  if (filters.minReach != null && filters.minReach !== '') {
    const minReach = Number(filters.minReach);
    if (Number.isFinite(minReach)) {
      where.push('COALESCE(ma.page_like_count, 0) >= ?');
      params.push(minReach);
    }
  }

  if (filters.queryText) {
    where.push("LOWER(maqm.query_text) LIKE ? ESCAPE '\\\\'");
    params.push(buildWildcardLikePattern(filters.queryText));
  }

  if (filters.seedText) {
    where.push(`EXISTS (
      SELECT 1
      FROM meta_query_run_variants mqrv
      WHERE mqrv.query_run_id = maqm.query_run_id
        AND LOWER(mqrv.seed_text) LIKE ? ESCAPE '\\\\'
    )`);
    params.push(buildWildcardLikePattern(filters.seedText));
  }

  if (filters.visibleTextMatch === 'YES') {
    where.push(`EXISTS (
      SELECT 1
      FROM meta_search_hits msh
      JOIN meta_query_runs mqr2 ON mqr2.id = msh.query_run_id
      WHERE mqr2.research_run_id = maqm.research_run_id
        AND msh.meta_ad_id = ma.meta_ad_id
        AND msh.visible_text_match = 1
    )`);
  }

  if (filters.visibleTextMatch === 'NO') {
    where.push(`NOT EXISTS (
      SELECT 1
      FROM meta_search_hits msh
      JOIN meta_query_runs mqr2 ON mqr2.id = msh.query_run_id
      WHERE mqr2.research_run_id = maqm.research_run_id
        AND msh.meta_ad_id = ma.meta_ad_id
        AND msh.visible_text_match = 1
    )`);
  }

  return { where, params };
}

function getResearchRunAds(db, runId, filters = {}) {
  const runRow = db.prepare(`
    SELECT project_id
    FROM meta_research_runs
    WHERE id = ?
    LIMIT 1
  `).get(runId);

  if (!runRow) {
    return [];
  }

  const { where, params } = buildResearchAdsFilterQuery(runRow.project_id, runId, filters);
  const queryParams = [runRow.project_id, runRow.project_id, ...params.slice(1)];

  const orderClause = buildOrderClause(filters.sortBy, filters.sortDirection);

  const rows = db.prepare(`
    SELECT
      ma.*,
      ma.canonical_destination_url,
      ma.destination_domain,
      ma.destination_path,
      ma.collation_id,
      ma.collation_count,
      par.relevance_status,
      par.relevance_source,
      par.manual_override,
      par.manual_override_status,
      par.manual_override_at,
      par.mr04_decision,
      par.mr04_confidence,
      par.mr04_reason_code,
      par.mr04_reason,
      par.mr04_filter_version,
      par.mr04_checked_at,
      par.details_status,
      par.details_fetched_at,
      par.details_provider,
      par.details_error,
      par.details_json,
      ofm.id AS family_id,
      ofm.family_class,
      ofm.family_status,
      ofm.family_confidence,
      ofm.family_reason,
      ofm.family_calendar_span_days,
      ofm.covered_delivery_days,
      ofm.ads_count AS family_ads_count,
      ofm.active_ads_count AS family_active_ads_count,
      ofm.family_patterns_json,
      ofa.relationship_type AS relationship_to_previous,
      ofa.previous_ad_id AS previous_ad_id,
      ofa.offer_match_confidence AS offer_match_confidence,
      ofa.match_reasons_json AS offer_match_reasons_json,
      ofa.sort_order AS family_sort_order,
      CASE COALESCE(ma.longevity_category, 'BALON_PROBNY')
        WHEN 'BALON_PROBNY' THEN ${LONGEVITY_ORDER.BALON_PROBNY}
        WHEN 'TEST_W_TOKU' THEN ${LONGEVITY_ORDER.TEST_W_TOKU}
        WHEN 'ROKUJACA' THEN ${LONGEVITY_ORDER.ROKUJACA}
        WHEN 'MOCNA' THEN ${LONGEVITY_ORDER.MOCNA}
        WHEN 'EVERGREEN' THEN ${LONGEVITY_ORDER.EVERGREEN}
        ELSE 0
      END AS longevity_rank,
      GROUP_CONCAT(DISTINCT maqm.query_text) AS matched_queries,
      GROUP_CONCAT(DISTINCT COALESCE(maqm.query_category, 'CORE')) AS matched_categories,
      GROUP_CONCAT(DISTINCT COALESCE(mqrv.seed_text, '')) AS matched_seeds
    FROM meta_ads ma
    JOIN meta_ad_query_matches maqm ON maqm.meta_ad_id = ma.meta_ad_id
    LEFT JOIN project_ad_relevance par ON par.meta_ad_id = ma.meta_ad_id AND par.project_id = ?
    LEFT JOIN offer_family_ads ofa ON ofa.meta_ad_id = ma.meta_ad_id AND ofa.project_id = ?
    LEFT JOIN offer_families ofm ON ofm.id = ofa.offer_family_id
    LEFT JOIN meta_query_run_variants mqrv ON mqrv.query_run_id = maqm.query_run_id
    WHERE ${where.join(' AND ')}
    GROUP BY ma.meta_ad_id
    ${orderClause}
    LIMIT 500
  `).all(...queryParams);

  const normalizedFamilyClass = normalizeFamilyClassFilter(filters.familyClass || 'ALL');
  const normalizedFamilyStatus = normalizeFamilyStatusFilter(filters.familyStatus || 'ALL');
  const normalizedFamilyPattern = normalizeFamilyPatternFilter(filters.familyPattern || 'ALL');

  const filteredRows = rows.filter(row => {
    if (normalizedFamilyClass !== 'ALL' && String(row.family_class || 'UNCLASSIFIED') !== normalizedFamilyClass) {
      return false;
    }

    if (normalizedFamilyStatus !== 'ALL' && String(row.family_status || 'UNKNOWN') !== normalizedFamilyStatus) {
      return false;
    }

    if (normalizedFamilyPattern !== 'ALL') {
      const patterns = safeJsonParse(row.family_patterns_json, []);
      if (!Array.isArray(patterns) || !patterns.includes(normalizedFamilyPattern)) {
        return false;
      }
    }

    return true;
  });

  return filteredRows.map(row => {
    const matchedQueries = row.matched_queries
      ? row.matched_queries.split(',').map(item => item.trim()).filter(Boolean)
      : [];

    const matchedCategories = row.matched_categories
      ? row.matched_categories.split(',').map(item => item.trim()).filter(Boolean)
      : [];

    const matchedSeeds = row.matched_seeds
      ? row.matched_seeds.split(',').map(item => item.trim()).filter(Boolean)
      : [];

    const lifecycleReasons = safeJsonParse(row.lifecycle_reasons_json, []);

    return {
      metaAdId: row.meta_ad_id,
      adArchiveId: row.ad_archive_id,
      pageId: row.page_id,
      pageName: row.page_name,
      pageProfileUrl: row.page_profile_url,
      bodyText: row.body_text,
      title: row.title,
      displayFormat: row.display_format,
      ctaType: row.cta_type,
      ctaText: row.cta_text,
      destinationUrl: row.destination_url,
      canonicalUrl: row.canonical_destination_url,
      destinationDomain: row.destination_domain,
      destinationPath: row.destination_path,
      collationId: row.collation_id,
      collationCount: row.collation_count,
      adLibraryUrl: row.ad_library_url,
      isActive: row.is_active === 1,
      startDate: row.start_date,
      endDate: row.end_date,
      publisherPlatforms: safeJsonParse(row.publisher_platforms, []),
      pageCategories: safeJsonParse(row.page_categories, []),
      pageLikeCount: row.page_like_count,
      adsCount: row.ads_count,
      runtimeDays: row.runtime_days,
      longevityCategory: row.longevity_category,
      firstSeenAt: row.created_at || row.first_seen_at,
      lastSeenAt: row.updated_at || row.last_seen_at,
      lifecycleClass: row.longevity_category,
      lifecycleConfidence: row.lifecycle_confidence,
      lifecycleReasons: Array.isArray(lifecycleReasons) ? lifecycleReasons : [],
      relevanceStatus: normalizeRelevanceStatus(row.relevance_status),
      relevanceSource: row.relevance_source || 'MR04',
      manualOverride: row.manual_override === 1,
      manualOverrideStatus: row.manual_override_status || null,
      manualOverrideAt: row.manual_override_at || null,
      mr04Decision: row.mr04_decision || null,
      mr04Confidence: Number.isFinite(Number(row.mr04_confidence)) ? Number(row.mr04_confidence) : null,
      mr04ReasonCode: row.mr04_reason_code || null,
      mr04Reason: row.mr04_reason || null,
      mr04FilterVersion: row.mr04_filter_version || null,
      mr04CheckedAt: row.mr04_checked_at || null,
      detailsStatus: normalizeDetailsStatus(row.details_status),
      detailsFetchedAt: row.details_fetched_at || null,
      detailsProvider: row.details_provider || null,
      detailsError: row.details_error || null,
      detailsJson: safeJsonParse(row.details_json, null),
      familyId: row.family_id || null,
      familyClass: row.family_class || 'UNCLASSIFIED',
      familyStatus: row.family_status || 'UNKNOWN',
      familyConfidence: Number.isFinite(Number(row.family_confidence)) ? Number(row.family_confidence) : null,
      familyReason: row.family_reason || null,
      familyCalendarSpanDays: Number.isFinite(Number(row.family_calendar_span_days)) ? Number(row.family_calendar_span_days) : 0,
      familyCoveredDeliveryDays: Number.isFinite(Number(row.covered_delivery_days)) ? Number(row.covered_delivery_days) : 0,
      familyAdsCount: Number.isFinite(Number(row.family_ads_count)) ? Number(row.family_ads_count) : 0,
      familyActiveAdsCount: Number.isFinite(Number(row.family_active_ads_count)) ? Number(row.family_active_ads_count) : 0,
      familyPatterns: safeJsonParse(row.family_patterns_json, []),
      relationshipToPrevious: row.relationship_to_previous || null,
      previousAdId: row.previous_ad_id || null,
      offerMatchConfidence: Number.isFinite(Number(row.offer_match_confidence)) ? Number(row.offer_match_confidence) : null,
      offerMatchReasons: safeJsonParse(row.offer_match_reasons_json, []),
      familySortOrder: Number.isFinite(Number(row.family_sort_order)) ? Number(row.family_sort_order) : null,
      visibleTextMatch: null,
      matchedQueries,
      matchedCategories,
      matchedSeeds,
      creativeBodies: safeJsonParse(row.creative_bodies_json, []),
      creativeLinkTitles: safeJsonParse(row.creative_link_titles_json, []),
      creativeLinkDescriptions: safeJsonParse(row.creative_link_descriptions_json, []),
      rawJson: safeJsonParse(row.raw_json || row.latest_raw_json, {}),
    };
  });
}

function getResearchRunLifecycleSummary(db, runId, filters = {}) {
  const runRow = db.prepare(`
    SELECT project_id
    FROM meta_research_runs
    WHERE id = ?
    LIMIT 1
  `).get(runId);

  const empty = {
    BALON_PROBNY: 0,
    TEST_W_TOKU: 0,
    ROKUJACA: 0,
    MOCNA: 0,
    EVERGREEN: 0,
    ALL: 0,
  };

  if (!runRow) {
    return empty;
  }

  const { where, params } = buildResearchAdsFilterQuery(runRow.project_id, runId, filters, {
    includeLifecycle: false,
  });

  const rows = db.prepare(`
    SELECT
      COALESCE(ma.longevity_category, 'BALON_PROBNY') AS lifecycle,
      COUNT(DISTINCT ma.meta_ad_id) AS count_ads
    FROM meta_ads ma
    JOIN meta_ad_query_matches maqm ON maqm.meta_ad_id = ma.meta_ad_id
    LEFT JOIN project_ad_relevance par ON par.meta_ad_id = ma.meta_ad_id AND par.project_id = ?
    WHERE ${where.join(' AND ')}
    GROUP BY COALESCE(ma.longevity_category, 'BALON_PROBNY')
  `).all(...params);

  const summary = {
    ...empty,
  };

  for (const row of rows) {
    const key = String(row.lifecycle || '').trim().toUpperCase();
    const count = Number(row.count_ads) || 0;
    summary.ALL += count;

    if (Object.prototype.hasOwnProperty.call(summary, key)) {
      summary[key] += count;
    }
  }

  return summary;
}

function getResearchRunRelevanceSummary(db, runId) {
  const runRow = db.prepare(`
    SELECT project_id
    FROM meta_research_runs
    WHERE id = ?
    LIMIT 1
  `).get(runId);

  if (!runRow) {
    return {
      useful: 0,
      keep: 0,
      potential: 0,
      unreviewed: 0,
      reject: 0,
      all: 0,
    };
  }

  const rows = db.prepare(`
    SELECT
      COALESCE(par.relevance_status, 'UNREVIEWED') AS relevance_status,
      COUNT(DISTINCT ma.meta_ad_id) AS count_ads
    FROM meta_ads ma
    JOIN meta_ad_query_matches maqm ON maqm.meta_ad_id = ma.meta_ad_id
    LEFT JOIN project_ad_relevance par ON par.meta_ad_id = ma.meta_ad_id AND par.project_id = ?
    WHERE maqm.research_run_id = ?
    GROUP BY COALESCE(par.relevance_status, 'UNREVIEWED')
  `).all(runRow.project_id, runId);

  const summary = {
    useful: 0,
    keep: 0,
    potential: 0,
    unreviewed: 0,
    reject: 0,
    all: 0,
  };

  for (const row of rows) {
    const status = normalizeRelevanceStatus(row.relevance_status);
    const count = Number(row.count_ads) || 0;
    summary.all += count;

    if (status === 'KEEP') summary.keep += count;
    if (status === 'POTENTIAL') summary.potential += count;
    if (status === 'UNREVIEWED') summary.unreviewed += count;
    if (status === 'REJECT') summary.reject += count;
  }

  summary.useful = summary.keep;
  return summary;
}

function getProjectAdsForOfferFamilyRebuild(db, projectId) {
  return db.prepare(`
    SELECT
      ma.meta_ad_id,
      COALESCE(ma.ad_archive_id, ma.meta_ad_id) AS ad_archive_id,
      ma.page_id,
      ma.page_name,
      ma.title,
      ma.body_text,
      ma.destination_url,
      ma.canonical_destination_url,
      ma.destination_domain,
      ma.destination_path,
      ma.ad_library_url,
      ma.collation_id,
      ma.collation_count,
      ma.start_date,
      ma.end_date,
      ma.runtime_days,
      ma.longevity_category,
      ma.lifecycle_confidence,
      ma.lifecycle_reasons_json,
      ma.is_active,
      ma.created_at,
      ma.updated_at,
      ma.first_seen_at,
      ma.last_seen_at,
      ma.display_format,
      ma.cta_type,
      ma.publisher_platforms,
      ma.page_like_count,
      ma.ads_count,
      ma.raw_json
    FROM project_ad_relevance par
    JOIN meta_ads ma ON ma.meta_ad_id = par.meta_ad_id
    WHERE par.project_id = ?
    GROUP BY ma.meta_ad_id
  `).all(projectId).map(row => ({
    metaAdId: row.meta_ad_id,
    adArchiveId: row.ad_archive_id,
    pageId: row.page_id,
    pageName: row.page_name,
    title: row.title,
    bodyText: row.body_text,
    destinationUrl: row.destination_url,
    canonicalUrl: row.canonical_destination_url,
    destinationDomain: row.destination_domain,
    destinationPath: row.destination_path,
    adLibraryUrl: row.ad_library_url,
    collationId: row.collation_id,
    collationCount: row.collation_count,
    startDate: row.start_date,
    endDate: row.end_date,
    runtimeDays: row.runtime_days,
    longevityCategory: row.longevity_category,
    lifecycleConfidence: row.lifecycle_confidence,
    lifecycleReasons: safeJsonParse(row.lifecycle_reasons_json, []),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    displayFormat: row.display_format,
    ctaType: row.cta_type,
    publisherPlatforms: safeJsonParse(row.publisher_platforms, []),
    pageLikeCount: row.page_like_count,
    adsCount: row.ads_count,
    rawJson: safeJsonParse(row.raw_json, {}),
  }));
}

function rebuildOfferFamilies(db, projectId, {
  classifierVersion = 'offer-family-v1',
} = {}) {
  const ads = getProjectAdsForOfferFamilyRebuild(db, projectId);
  const now = new Date().toISOString();

  const offerFamilies = buildOfferFamilies(projectId, ads, {
    classifierVersion,
    now: new Date(now),
  });

  const clearFamilyAds = db.prepare('DELETE FROM offer_family_ads WHERE project_id = ?');
  const clearFamilies = db.prepare('DELETE FROM offer_families WHERE project_id = ?');

  const updateCanonical = db.prepare(`
    UPDATE meta_ads
    SET canonical_destination_url = ?,
        destination_domain = ?,
        destination_path = ?
    WHERE meta_ad_id = ?
  `);

  const insertFamily = db.prepare(`
    INSERT INTO offer_families (
      id,
      project_id,
      family_class,
      family_status,
      family_confidence,
      family_reason,
      first_ad_start,
      latest_ad_start,
      latest_ad_end,
      family_calendar_span_days,
      covered_delivery_days,
      ads_count,
      active_ads_count,
      ended_ads_count,
      max_ad_duration_days,
      median_ad_duration_days,
      successor_count,
      parallel_count,
      relaunch_count,
      longest_gap_days,
      currently_active,
      family_patterns_json,
      classifier_version,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFamilyAd = db.prepare(`
    INSERT INTO offer_family_ads (
      offer_family_id,
      project_id,
      meta_ad_id,
      relationship_type,
      previous_ad_id,
      offer_match_confidence,
      match_type,
      match_reasons_json,
      title_similarity,
      body_similarity,
      combined_similarity,
      sort_order,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    clearFamilyAds.run(projectId);
    clearFamilies.run(projectId);

    for (const ad of ads) {
      const canonical = offerFamilies.canonicalDestinationByAdId[ad.metaAdId] || null;
      let domain = null;
      let path = null;

      if (canonical) {
        try {
          const parsed = new URL(canonical);
          domain = parsed.hostname.toLowerCase();
          path = parsed.pathname && parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
            ? parsed.pathname.slice(0, -1)
            : (parsed.pathname || '/');
        } catch {
          domain = null;
          path = null;
        }
      }

      updateCanonical.run(canonical, domain, path, ad.metaAdId);
    }

    for (const family of offerFamilies.families) {
      insertFamily.run(
        family.id,
        family.projectId,
        family.familyClass,
        family.familyStatus,
        family.familyConfidence,
        family.familyReason,
        family.firstAdStart,
        family.latestAdStart,
        family.latestAdEnd,
        family.familyCalendarSpanDays,
        family.coveredDeliveryDays,
        family.adsCount,
        family.activeAdsCount,
        family.endedAdsCount,
        family.maxAdDurationDays,
        family.medianAdDurationDays,
        family.successorCount,
        family.parallelCount,
        family.relaunchCount,
        family.longestGapDays,
        family.currentlyActive ? 1 : 0,
        JSON.stringify(family.familyPatterns || []),
        family.classifierVersion,
        now,
        now,
      );

      for (const member of family.members) {
        insertFamilyAd.run(
          family.id,
          projectId,
          member.metaAdId,
          member.relationshipType,
          member.previousAdId,
          member.offerMatchConfidence,
          member.matchType,
          JSON.stringify(member.matchReasons || []),
          member.titleSimilarity,
          member.bodySimilarity,
          member.combinedSimilarity,
          member.sortOrder,
          now,
          now,
        );
      }
    }
  });

  tx();

  const classBreakdown = {
    TEST_ONLY: 0,
    REPEATED_TEST: 0,
    PROMISING: 0,
    ESTABLISHED: 0,
    EVERGREEN: 0,
    UNCLASSIFIED: 0,
  };

  let directSuccessorCount = 0;
  let relaunchCount = 0;
  let parallelCount = 0;

  for (const family of offerFamilies.families) {
    if (Object.prototype.hasOwnProperty.call(classBreakdown, family.familyClass)) {
      classBreakdown[family.familyClass] += 1;
    }

    for (const member of family.members) {
      if (member.relationshipType === 'DIRECT_SUCCESSOR') directSuccessorCount += 1;
      if (member.relationshipType === 'RELAUNCH') relaunchCount += 1;
      if (member.relationshipType === 'PARALLEL') parallelCount += 1;
    }
  }

  return {
    projectId,
    classifierVersion,
    adsCount: ads.length,
    familiesCount: offerFamilies.families.length,
    multiAdFamiliesCount: offerFamilies.families.filter(item => item.adsCount > 1).length,
    classBreakdown,
    directSuccessorCount,
    relaunchCount,
    parallelCount,
  };
}

function normalizeFamilyClassFilter(value) {
  const normalized = String(value || 'ALL').trim().toUpperCase();
  const allowed = new Set(['ALL', 'TEST_ONLY', 'REPEATED_TEST', 'PROMISING', 'ESTABLISHED', 'EVERGREEN', 'UNCLASSIFIED']);
  return allowed.has(normalized) ? normalized : 'ALL';
}

function normalizeFamilyStatusFilter(value) {
  const normalized = String(value || 'ALL').trim().toUpperCase();
  const allowed = new Set(['ALL', 'ACTIVE', 'ENDED', 'UNKNOWN']);
  return allowed.has(normalized) ? normalized : 'ALL';
}

function normalizeFamilyPatternFilter(value) {
  const normalized = String(value || 'ALL').trim().toUpperCase();
  const allowed = new Set(['ALL', 'DIRECT_SUCCESSOR', 'PARALLEL_TEST', 'RELAUNCH', 'CONTINUOUS_CAMPAIGN', 'SUCCESSOR_AFTER_GAP', 'CREATIVE_REFRESH']);
  return allowed.has(normalized) ? normalized : 'ALL';
}

function getProjectOfferFamilies(db, projectId, {
  familyClass = 'ALL',
  familyStatus = 'ALL',
  familyPattern = 'ALL',
  runId = null,
} = {}) {
  const where = ['ofm.project_id = ?'];
  const params = [projectId];

  const normalizedClass = normalizeFamilyClassFilter(familyClass);
  const normalizedStatus = normalizeFamilyStatusFilter(familyStatus);
  const normalizedPattern = normalizeFamilyPatternFilter(familyPattern);

  if (normalizedClass !== 'ALL') {
    where.push('ofm.family_class = ?');
    params.push(normalizedClass);
  }

  if (normalizedStatus !== 'ALL') {
    where.push('ofm.family_status = ?');
    params.push(normalizedStatus);
  }

  if (normalizedPattern !== 'ALL') {
    where.push(`EXISTS (
      SELECT 1
      FROM json_each(ofm.family_patterns_json)
      WHERE value = ?
    )`);
    params.push(normalizedPattern);
  }

  if (runId) {
    where.push(`EXISTS (
      SELECT 1
      FROM offer_family_ads ofa2
      JOIN meta_ad_query_matches maqm2 ON maqm2.meta_ad_id = ofa2.meta_ad_id
      WHERE ofa2.offer_family_id = ofm.id
        AND ofa2.project_id = ofm.project_id
        AND maqm2.research_run_id = ?
    )`);
    params.push(runId);
  }

  const families = db.prepare(`
    SELECT
      ofm.*
    FROM offer_families ofm
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE ofm.family_class
        WHEN 'EVERGREEN' THEN ${FAMILY_CLASS_ORDER.EVERGREEN}
        WHEN 'ESTABLISHED' THEN ${FAMILY_CLASS_ORDER.ESTABLISHED}
        WHEN 'PROMISING' THEN ${FAMILY_CLASS_ORDER.PROMISING}
        WHEN 'REPEATED_TEST' THEN ${FAMILY_CLASS_ORDER.REPEATED_TEST}
        WHEN 'TEST_ONLY' THEN ${FAMILY_CLASS_ORDER.TEST_ONLY}
        ELSE ${FAMILY_CLASS_ORDER.UNCLASSIFIED}
      END ASC,
      ofm.family_confidence DESC,
      ofm.covered_delivery_days DESC,
      ofm.ads_count DESC,
      ofm.id ASC
  `).all(...params).map(row => ({
    id: row.id,
    projectId: row.project_id,
    familyClass: row.family_class,
    familyStatus: row.family_status,
    familyConfidence: Number(row.family_confidence) || 0,
    familyReason: row.family_reason,
    firstAdStart: row.first_ad_start,
    latestAdStart: row.latest_ad_start,
    latestAdEnd: row.latest_ad_end,
    familyCalendarSpanDays: Number(row.family_calendar_span_days) || 0,
    coveredDeliveryDays: Number(row.covered_delivery_days) || 0,
    adsCount: Number(row.ads_count) || 0,
    activeAdsCount: Number(row.active_ads_count) || 0,
    endedAdsCount: Number(row.ended_ads_count) || 0,
    maxAdDurationDays: Number(row.max_ad_duration_days) || 0,
    medianAdDurationDays: Number(row.median_ad_duration_days) || 0,
    successorCount: Number(row.successor_count) || 0,
    parallelCount: Number(row.parallel_count) || 0,
    relaunchCount: Number(row.relaunch_count) || 0,
    longestGapDays: Number(row.longest_gap_days) || 0,
    currentlyActive: row.currently_active === 1,
    familyPatterns: safeJsonParse(row.family_patterns_json, []),
    classifierVersion: row.classifier_version,
    members: [],
  }));

  if (!families.length) return families;

  const familyById = new Map(families.map(family => [family.id, family]));
  const familyIds = families.map(family => family.id);
  const placeholders = familyIds.map(() => '?').join(', ');

  const memberRows = db.prepare(`
    SELECT
      ofa.offer_family_id,
      ofa.meta_ad_id,
      ofa.relationship_type,
      ofa.previous_ad_id,
      ofa.offer_match_confidence,
      ofa.match_type,
      ofa.match_reasons_json,
      ofa.title_similarity,
      ofa.body_similarity,
      ofa.combined_similarity,
      ofa.sort_order,
      ma.ad_archive_id,
      ma.page_id,
      ma.page_name,
      ma.title,
      ma.body_text,
      ma.destination_url,
      ma.canonical_destination_url,
      ma.ad_library_url,
      ma.start_date,
      ma.end_date,
      ma.runtime_days,
      ma.is_active,
      ma.longevity_category,
      ma.display_format,
      ma.cta_type,
      ma.publisher_platforms,
      ma.page_like_count,
      ma.collation_id,
      ma.collation_count,
      par.relevance_status,
      par.mr04_reason,
      (
        SELECT GROUP_CONCAT(DISTINCT maqm.query_text)
        FROM meta_ad_query_matches maqm
        JOIN meta_research_runs mrr ON mrr.id = maqm.research_run_id
        WHERE maqm.meta_ad_id = ma.meta_ad_id
          AND mrr.project_id = ofa.project_id
      ) AS matched_queries,
      (
        SELECT GROUP_CONCAT(DISTINCT mqrv.seed_text)
        FROM meta_ad_query_matches maqm
        JOIN meta_research_runs mrr ON mrr.id = maqm.research_run_id
        LEFT JOIN meta_query_run_variants mqrv ON mqrv.query_run_id = maqm.query_run_id
        WHERE maqm.meta_ad_id = ma.meta_ad_id
          AND mrr.project_id = ofa.project_id
      ) AS matched_seeds
    FROM offer_family_ads ofa
    JOIN meta_ads ma ON ma.meta_ad_id = ofa.meta_ad_id
    LEFT JOIN project_ad_relevance par ON par.project_id = ofa.project_id AND par.meta_ad_id = ofa.meta_ad_id
    WHERE ofa.project_id = ?
      AND ofa.offer_family_id IN (${placeholders})
    ORDER BY ofa.offer_family_id ASC, ofa.sort_order ASC
  `).all(projectId, ...familyIds);

  for (const row of memberRows) {
    const family = familyById.get(row.offer_family_id);
    if (!family) continue;

    family.members.push({
      metaAdId: row.meta_ad_id,
      adArchiveId: row.ad_archive_id,
      pageId: row.page_id,
      pageName: row.page_name,
      title: row.title,
      bodyText: row.body_text,
      destinationUrl: row.destination_url,
      canonicalUrl: row.canonical_destination_url,
      adLibraryUrl: row.ad_library_url,
      startDate: row.start_date,
      endDate: row.end_date,
      runtimeDays: row.runtime_days,
      isActive: row.is_active === 1,
      longevityCategory: row.longevity_category,
      displayFormat: row.display_format,
      ctaType: row.cta_type,
      publisherPlatforms: safeJsonParse(row.publisher_platforms, []),
      pageLikeCount: row.page_like_count,
      collationId: row.collation_id,
      collationCount: row.collation_count,
      relevanceStatus: normalizeRelevanceStatus(row.relevance_status),
      mr04Reason: row.mr04_reason,
      relationshipType: row.relationship_type,
      previousAdId: row.previous_ad_id,
      offerMatchConfidence: Number.isFinite(Number(row.offer_match_confidence)) ? Number(row.offer_match_confidence) : null,
      matchType: row.match_type,
      matchReasons: safeJsonParse(row.match_reasons_json, []),
      titleSimilarity: Number.isFinite(Number(row.title_similarity)) ? Number(row.title_similarity) : null,
      bodySimilarity: Number.isFinite(Number(row.body_similarity)) ? Number(row.body_similarity) : null,
      combinedSimilarity: Number.isFinite(Number(row.combined_similarity)) ? Number(row.combined_similarity) : null,
      sortOrder: Number(row.sort_order) || 0,
      matchedQueries: row.matched_queries
        ? row.matched_queries.split(',').map(item => item.trim()).filter(Boolean)
        : [],
      matchedSeeds: row.matched_seeds
        ? row.matched_seeds.split(',').map(item => item.trim()).filter(Boolean)
        : [],
    });
  }

  return families;
}

module.exports = {
  extractApprovedPlanAndGroups,
  createResearchRun,
  updateResearchRunProgress,
  getResearchRunById,
  getLatestResearchRunForProject,
  createQueryRun,
  updateQueryRun,
  getQueryRunById,
  linkQueryRunVariants,
  saveAdsPageBatch,
  getResearchRunWithQueryRuns,
  getLatestResearchRunWithQueryRuns,
  getResearchRunAds,
  getResearchRunRelevanceSummary,
  getResearchRunLifecycleSummary,
  rebuildOfferFamilies,
  getProjectOfferFamilies,
  normalizeQueryTextForGrouping,
  ensureProjectAdRelevanceRows,
  getProjectRelevancePendingCount,
  getProjectAdsForRelevanceReview,
  applyMr04Decisions,
  setProjectAdManualRelevance,
  restoreProjectAdRelevanceToMr04,
  getProjectAdsEligibleForDetails,
  applyLocalDetailsSnapshot,
};
