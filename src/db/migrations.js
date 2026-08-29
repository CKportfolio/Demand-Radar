const MIGRATIONS = [
  {
    id: '0001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brief_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_plan_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        parent_version_id TEXT NULL,
        source_event TEXT NOT NULL CHECK (source_event IN ('LLM_GENERATION', 'LLM_REVISION', 'MANUAL_REVISION')),
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'SUPERSEDED', 'REJECTED')),
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id)
          REFERENCES projects(id)
          ON DELETE CASCADE,
        FOREIGN KEY(parent_version_id)
          REFERENCES discovery_plan_versions(id),
        UNIQUE(project_id, version_number)
      );

      CREATE INDEX IF NOT EXISTS idx_discovery_plan_versions_project_id
        ON discovery_plan_versions(project_id);
    `,
  },
  {
    id: '0002_query_plan',
    sql: `
      CREATE TABLE IF NOT EXISTS query_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_plan_version_id TEXT NOT NULL,
        planner_version TEXT NOT NULL,
        country TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED')),
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id)
          REFERENCES projects(id)
          ON DELETE CASCADE,
        FOREIGN KEY(source_plan_version_id)
          REFERENCES discovery_plan_versions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_query_plans_project_id
        ON query_plans(project_id);

      CREATE TABLE IF NOT EXISTS query_plan_seeds (
        id TEXT PRIMARY KEY,
        query_plan_id TEXT NOT NULL,
        source_seed_id TEXT NOT NULL,
        source_seed_origin TEXT NOT NULL,
        seed_text TEXT NOT NULL,
        concept TEXT NOT NULL,
        audience_json TEXT NOT NULL,
        format_hints_json TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        FOREIGN KEY(query_plan_id)
          REFERENCES query_plans(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_query_plan_seeds_query_plan_id
        ON query_plan_seeds(query_plan_id);

      CREATE TABLE IF NOT EXISTS query_variants (
        id TEXT PRIMARY KEY,
        query_plan_seed_id TEXT NOT NULL,
        query_text TEXT NOT NULL,
        term_count INTEGER NOT NULL,
        query_type TEXT NOT NULL CHECK (query_type IN ('CORE', 'PROBLEM', 'AUDIENCE', 'FORMAT', 'SYNONYM', 'PRECISION')),
        priority INTEGER NOT NULL,
        rationale TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(query_plan_seed_id)
          REFERENCES query_plan_seeds(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_query_variants_seed_id
        ON query_variants(query_plan_seed_id);
    `,
  },
  {
    id: '0003_meta_research',
    sql: `
      CREATE TABLE IF NOT EXISTS meta_research_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        query_plan_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
        started_at TEXT NOT NULL,
        finished_at TEXT NULL,
        country TEXT NOT NULL,
        queries_total INTEGER NOT NULL,
        queries_completed INTEGER NOT NULL,
        api_hits_total INTEGER NOT NULL,
        unique_ads_total INTEGER NOT NULL,
        errors_total INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        error_message TEXT NULL,
        FOREIGN KEY(project_id)
          REFERENCES projects(id)
          ON DELETE CASCADE,
        FOREIGN KEY(query_plan_id)
          REFERENCES query_plans(id)
      );

      CREATE INDEX IF NOT EXISTS idx_meta_research_runs_project_id
        ON meta_research_runs(project_id);

      CREATE INDEX IF NOT EXISTS idx_meta_research_runs_query_plan_id
        ON meta_research_runs(query_plan_id);

      CREATE TABLE IF NOT EXISTS meta_query_runs (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL,
        query_text TEXT NOT NULL,
        query_text_normalized TEXT NOT NULL,
        query_type_snapshot_json TEXT NOT NULL,
        priority_snapshot INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
        pages_fetched INTEGER NOT NULL,
        hits_count INTEGER NOT NULL,
        unique_ads_count INTEGER NOT NULL,
        api_hits_count INTEGER NOT NULL,
        error_message TEXT NULL,
        FOREIGN KEY(research_run_id)
          REFERENCES meta_research_runs(id)
          ON DELETE CASCADE,
        UNIQUE(research_run_id, query_text_normalized)
      );

      CREATE INDEX IF NOT EXISTS idx_meta_query_runs_research_run_id
        ON meta_query_runs(research_run_id);

      CREATE TABLE IF NOT EXISTS meta_query_run_variants (
        id TEXT PRIMARY KEY,
        query_run_id TEXT NOT NULL,
        query_variant_id TEXT NOT NULL,
        query_plan_seed_id TEXT NOT NULL,
        source_seed_id TEXT NOT NULL,
        seed_text TEXT NOT NULL,
        query_text_snapshot TEXT NOT NULL,
        query_type_snapshot TEXT NOT NULL,
        priority_snapshot INTEGER NOT NULL,
        FOREIGN KEY(query_run_id)
          REFERENCES meta_query_runs(id)
          ON DELETE CASCADE,
        FOREIGN KEY(query_variant_id)
          REFERENCES query_variants(id),
        FOREIGN KEY(query_plan_seed_id)
          REFERENCES query_plan_seeds(id),
        UNIQUE(query_run_id, query_variant_id)
      );

      CREATE INDEX IF NOT EXISTS idx_meta_query_run_variants_query_run_id
        ON meta_query_run_variants(query_run_id);

      CREATE INDEX IF NOT EXISTS idx_meta_query_run_variants_seed_id
        ON meta_query_run_variants(source_seed_id);

      CREATE TABLE IF NOT EXISTS meta_ads (
        meta_ad_id TEXT PRIMARY KEY,
        page_id TEXT NULL,
        page_name TEXT NULL,
        ad_delivery_start_time TEXT NULL,
        ad_delivery_stop_time TEXT NULL,
        ad_snapshot_url TEXT NULL,
        creative_bodies_json TEXT NOT NULL,
        creative_link_titles_json TEXT NOT NULL,
        creative_link_descriptions_json TEXT NOT NULL,
        publisher_platforms_json TEXT NOT NULL,
        languages_json TEXT NOT NULL,
        eu_total_reach INTEGER NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        latest_raw_json TEXT NOT NULL,
        lifecycle_class TEXT NOT NULL CHECK (lifecycle_class IN ('TEST_BALLOON', 'PROMISING', 'ESTABLISHED', 'EVERGREEN', 'UNCLASSIFIED')),
        lifecycle_confidence INTEGER NOT NULL,
        lifecycle_reasons_json TEXT NOT NULL,
        delivery_age_days INTEGER NULL
      );

      CREATE INDEX IF NOT EXISTS idx_meta_ads_page_id
        ON meta_ads(page_id);

      CREATE INDEX IF NOT EXISTS idx_meta_ads_first_seen_at
        ON meta_ads(first_seen_at);

      CREATE INDEX IF NOT EXISTS idx_meta_ads_last_seen_at
        ON meta_ads(last_seen_at);

      CREATE TABLE IF NOT EXISTS meta_search_hits (
        id TEXT PRIMARY KEY,
        query_run_id TEXT NOT NULL,
        meta_ad_id TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        result_position INTEGER NULL,
        visible_text_match INTEGER NOT NULL CHECK (visible_text_match IN (0, 1)),
        matched_terms_json TEXT NOT NULL,
        missing_terms_json TEXT NOT NULL,
        FOREIGN KEY(query_run_id)
          REFERENCES meta_query_runs(id)
          ON DELETE CASCADE,
        FOREIGN KEY(meta_ad_id)
          REFERENCES meta_ads(meta_ad_id)
          ON DELETE CASCADE,
        UNIQUE(query_run_id, meta_ad_id)
      );

      CREATE INDEX IF NOT EXISTS idx_meta_search_hits_query_run_id
        ON meta_search_hits(query_run_id);

      CREATE INDEX IF NOT EXISTS idx_meta_search_hits_meta_ad_id
        ON meta_search_hits(meta_ad_id);

      CREATE TABLE IF NOT EXISTS meta_ad_observations (
        id TEXT PRIMARY KEY,
        meta_ad_id TEXT NOT NULL,
        research_run_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        ad_delivery_start_time TEXT NULL,
        ad_delivery_stop_time TEXT NULL,
        eu_total_reach INTEGER NULL,
        raw_json TEXT NOT NULL,
        FOREIGN KEY(meta_ad_id)
          REFERENCES meta_ads(meta_ad_id)
          ON DELETE CASCADE,
        FOREIGN KEY(research_run_id)
          REFERENCES meta_research_runs(id)
          ON DELETE CASCADE,
        UNIQUE(meta_ad_id, research_run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_meta_ad_observations_research_run_id
        ON meta_ad_observations(research_run_id);

      CREATE INDEX IF NOT EXISTS idx_meta_ad_observations_meta_ad_id
        ON meta_ad_observations(meta_ad_id);
    `,
  },
  {
    id: '0004_apify_research_upgrade',
    sql: `
      ALTER TABLE meta_research_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'APIFY';
      ALTER TABLE meta_research_runs ADD COLUMN provider_run_id TEXT NULL;
      ALTER TABLE meta_research_runs ADD COLUMN provider_dataset_id TEXT NULL;
      ALTER TABLE meta_research_runs ADD COLUMN progress_stage TEXT NULL;
      ALTER TABLE meta_research_runs ADD COLUMN fetched_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE meta_research_runs ADD COLUMN duplicates_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE meta_research_runs ADD COLUMN created_at TEXT NULL;

      ALTER TABLE meta_query_runs ADD COLUMN query_category TEXT NULL;
      ALTER TABLE meta_query_runs ADD COLUMN source_url TEXT NULL;

      ALTER TABLE meta_ads ADD COLUMN ad_archive_id TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN page_profile_url TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN body_text TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN title TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN display_format TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN cta_type TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN cta_text TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN destination_url TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN ad_library_url TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN is_active INTEGER NULL CHECK (is_active IN (0, 1));
      ALTER TABLE meta_ads ADD COLUMN start_date TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN end_date TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN publisher_platforms TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN page_categories TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN page_like_count INTEGER NULL;
      ALTER TABLE meta_ads ADD COLUMN ads_count INTEGER NULL;
      ALTER TABLE meta_ads ADD COLUMN runtime_days INTEGER NULL;
      ALTER TABLE meta_ads ADD COLUMN longevity_category TEXT NULL CHECK (longevity_category IN ('BALON_PROBNY', 'TEST_W_TOKU', 'ROKUJACA', 'MOCNA', 'EVERGREEN'));
      ALTER TABLE meta_ads ADD COLUMN relevance_score REAL NULL;
      ALTER TABLE meta_ads ADD COLUMN relevance_status TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN rejection_reason TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN raw_json TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN created_at TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN updated_at TEXT NULL;
  UPDATE meta_research_runs
  SET created_at = COALESCE(created_at, started_at, finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));


      UPDATE meta_ads
      SET ad_archive_id = meta_ad_id
      WHERE ad_archive_id IS NULL;

      UPDATE meta_ads
      SET raw_json = latest_raw_json
      WHERE raw_json IS NULL;

      UPDATE meta_ads
      SET start_date = ad_delivery_start_time,
          end_date = ad_delivery_stop_time
      WHERE start_date IS NULL;

      UPDATE meta_ads
      SET publisher_platforms = publisher_platforms_json
      WHERE publisher_platforms IS NULL;

      UPDATE meta_ads
        SET created_at = COALESCE(created_at, first_seen_at, last_seen_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at = COALESCE(updated_at, last_seen_at, first_seen_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_ads_ad_archive_id_unique
        ON meta_ads(ad_archive_id)
        WHERE ad_archive_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS meta_ad_query_matches (
        id TEXT PRIMARY KEY,
        research_run_id TEXT NOT NULL,
        meta_ad_id TEXT NOT NULL,
        query_run_id TEXT NULL,
        query_text TEXT NOT NULL,
        query_category TEXT NULL,
        source_url TEXT NULL,
        source_position INTEGER NULL,
        matched_at TEXT NOT NULL,
        FOREIGN KEY(research_run_id)
          REFERENCES meta_research_runs(id)
          ON DELETE CASCADE,
        FOREIGN KEY(meta_ad_id)
          REFERENCES meta_ads(meta_ad_id)
          ON DELETE CASCADE,
        FOREIGN KEY(query_run_id)
          REFERENCES meta_query_runs(id)
          ON DELETE CASCADE,
        UNIQUE(research_run_id, meta_ad_id, query_text)
      );

      CREATE INDEX IF NOT EXISTS idx_meta_ad_query_matches_run_id
        ON meta_ad_query_matches(research_run_id);

      CREATE INDEX IF NOT EXISTS idx_meta_ad_query_matches_meta_ad_id
        ON meta_ad_query_matches(meta_ad_id);

      CREATE INDEX IF NOT EXISTS idx_meta_ad_query_matches_query_run_id
        ON meta_ad_query_matches(query_run_id);
    `,
  },
  {
    id: '0005_project_ad_relevance',
    sql: `
      CREATE TABLE IF NOT EXISTS project_ad_relevance (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        meta_ad_id TEXT NOT NULL,
        ad_archive_id TEXT NOT NULL,
        relevance_status TEXT NOT NULL DEFAULT 'UNREVIEWED' CHECK (relevance_status IN ('UNREVIEWED', 'KEEP', 'POTENTIAL', 'REJECT')),
        relevance_source TEXT NOT NULL DEFAULT 'MR04' CHECK (relevance_source IN ('MR04', 'MANUAL')),
        mr04_decision TEXT NULL CHECK (mr04_decision IN ('KEEP', 'REVIEW', 'REJECT')),
        mr04_confidence INTEGER NULL,
        mr04_reason_code TEXT NULL,
        mr04_reason TEXT NULL,
        mr04_filter_version TEXT NULL,
        mr04_checked_at TEXT NULL,
        manual_override INTEGER NOT NULL DEFAULT 0 CHECK (manual_override IN (0, 1)),
        manual_override_status TEXT NULL CHECK (manual_override_status IN ('KEEP', 'POTENTIAL', 'REJECT')),
        manual_override_at TEXT NULL,
        details_status TEXT NOT NULL DEFAULT 'NOT_FETCHED' CHECK (details_status IN ('NOT_FETCHED', 'FETCHING', 'FETCHED', 'FAILED')),
        details_fetched_at TEXT NULL,
        details_provider TEXT NULL,
        details_error TEXT NULL,
        details_json TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id)
          REFERENCES projects(id)
          ON DELETE CASCADE,
        FOREIGN KEY(meta_ad_id)
          REFERENCES meta_ads(meta_ad_id)
          ON DELETE CASCADE,
        UNIQUE(project_id, ad_archive_id)
      );

      CREATE INDEX IF NOT EXISTS idx_project_ad_relevance_project_status
        ON project_ad_relevance(project_id, relevance_status);

      CREATE INDEX IF NOT EXISTS idx_project_ad_relevance_project_details
        ON project_ad_relevance(project_id, details_status);

      CREATE INDEX IF NOT EXISTS idx_project_ad_relevance_meta_ad_id
        ON project_ad_relevance(meta_ad_id);

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
      )
      SELECT
        lower(hex(randomblob(16))),
        mrr.project_id,
        ma.meta_ad_id,
        COALESCE(ma.ad_archive_id, ma.meta_ad_id),
        'UNREVIEWED',
        'MR04',
        'NOT_FETCHED',
        0,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM meta_ad_query_matches maqm
      JOIN meta_research_runs mrr ON mrr.id = maqm.research_run_id
      JOIN meta_ads ma ON ma.meta_ad_id = maqm.meta_ad_id;
    `,
  },
  {
    id: '0006_offer_family',
    sql: `
      ALTER TABLE meta_ads ADD COLUMN canonical_destination_url TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN destination_domain TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN destination_path TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN collation_id TEXT NULL;
      ALTER TABLE meta_ads ADD COLUMN collation_count INTEGER NULL;

      CREATE INDEX IF NOT EXISTS idx_meta_ads_page_canonical
        ON meta_ads(page_id, canonical_destination_url);

      CREATE TABLE IF NOT EXISTS offer_families (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        family_class TEXT NOT NULL CHECK (family_class IN ('TEST_ONLY', 'REPEATED_TEST', 'PROMISING', 'ESTABLISHED', 'EVERGREEN', 'UNCLASSIFIED')),
        family_status TEXT NOT NULL CHECK (family_status IN ('ACTIVE', 'ENDED', 'UNKNOWN')),
        family_confidence INTEGER NOT NULL,
        family_reason TEXT NOT NULL,
        first_ad_start TEXT NULL,
        latest_ad_start TEXT NULL,
        latest_ad_end TEXT NULL,
        family_calendar_span_days INTEGER NOT NULL DEFAULT 0,
        covered_delivery_days INTEGER NOT NULL DEFAULT 0,
        ads_count INTEGER NOT NULL DEFAULT 0,
        active_ads_count INTEGER NOT NULL DEFAULT 0,
        ended_ads_count INTEGER NOT NULL DEFAULT 0,
        max_ad_duration_days INTEGER NOT NULL DEFAULT 0,
        median_ad_duration_days INTEGER NOT NULL DEFAULT 0,
        successor_count INTEGER NOT NULL DEFAULT 0,
        parallel_count INTEGER NOT NULL DEFAULT 0,
        relaunch_count INTEGER NOT NULL DEFAULT 0,
        longest_gap_days INTEGER NOT NULL DEFAULT 0,
        currently_active INTEGER NOT NULL DEFAULT 0 CHECK (currently_active IN (0, 1)),
        family_patterns_json TEXT NOT NULL,
        classifier_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id)
          REFERENCES projects(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_offer_families_project_class
        ON offer_families(project_id, family_class, family_confidence DESC);

      CREATE INDEX IF NOT EXISTS idx_offer_families_project_status
        ON offer_families(project_id, family_status);

      CREATE TABLE IF NOT EXISTS offer_family_ads (
        offer_family_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        meta_ad_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL CHECK (relationship_type IN ('FIRST', 'PARALLEL', 'DIRECT_SUCCESSOR', 'SUCCESSOR_AFTER_GAP', 'RELAUNCH', 'UNKNOWN')),
        previous_ad_id TEXT NULL,
        offer_match_confidence INTEGER NULL,
        match_type TEXT NULL,
        match_reasons_json TEXT NOT NULL,
        title_similarity REAL NULL,
        body_similarity REAL NULL,
        combined_similarity REAL NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (offer_family_id, meta_ad_id),
        FOREIGN KEY(offer_family_id)
          REFERENCES offer_families(id)
          ON DELETE CASCADE,
        FOREIGN KEY(project_id)
          REFERENCES projects(id)
          ON DELETE CASCADE,
        FOREIGN KEY(meta_ad_id)
          REFERENCES meta_ads(meta_ad_id)
          ON DELETE CASCADE,
        FOREIGN KEY(previous_ad_id)
          REFERENCES meta_ads(meta_ad_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_family_ads_project_ad_unique
        ON offer_family_ads(project_id, meta_ad_id);

      CREATE INDEX IF NOT EXISTS idx_offer_family_ads_project_sort
        ON offer_family_ads(project_id, offer_family_id, sort_order);
    `,
  },
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const markMigration = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      const alreadyApplied = hasMigration.get(migration.id);
      if (alreadyApplied) continue;

      db.exec(migration.sql);
      markMigration.run(migration.id, new Date().toISOString());
    }
  });

  apply();
}

module.exports = {
  runMigrations,
};
