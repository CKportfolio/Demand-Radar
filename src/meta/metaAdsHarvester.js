const {
  extractApprovedPlanAndGroups,
  createResearchRun,
  updateResearchRunProgress,
  createQueryRun,
  updateQueryRun,
  linkQueryRunVariants,
  saveAdsPageBatch,
  ensureProjectAdRelevanceRows,
  rebuildOfferFamilies,
} = require('../db/metaResearchRepository');

function parseIntEnv(name, defaultValue, minValue = null) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (minValue != null && parsed < minValue) return minValue;

  return parsed;
}

function parseNumberEnv(name, defaultValue, minValue = null) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (minValue != null && parsed < minValue) return minValue;

  return parsed;
}

function normalizeQueryText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeSourceUrl(urlText) {
  if (!urlText || typeof urlText !== 'string') return null;

  try {
    const url = new URL(urlText);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const query = params.map(([k, v]) => `${k}=${v}`).join('&');
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildApifyConfigFromEnv() {
  return {
    token: process.env.APIFY_API_TOKEN || '',
    apiBaseUrl: (process.env.APIFY_API_BASE_URL || 'https://api.apify.com/v2').replace(/\/+$/, ''),
    actorId: (process.env.APIFY_ACTOR_ID || 'curious_coder/facebook-ads-library-scraper').trim(),
    pollIntervalMs: parseIntEnv('APIFY_POLL_INTERVAL_MS', 4000, 1000),
    runTimeoutMs: parseIntEnv('APIFY_RUN_TIMEOUT_MS', 20 * 60 * 1000, 30000),
    limitPerSource: parseIntEnv('APIFY_LIMIT_PER_SOURCE', 200, 1),
    maxRecordsPerQuery: parseIntEnv('APIFY_MAX_RECORDS_PER_QUERY', 200, 1),
    scrapeAdDetails: String(process.env.APIFY_SCRAPE_AD_DETAILS || 'false').toLowerCase() === 'true',
    maxTotalChargeUsd: parseNumberEnv('APIFY_MAX_TOTAL_CHARGE_USD', 5, 0),
    country: (process.env.META_AD_LIBRARY_COUNTRY || 'PL').trim() || 'PL',
  };
}

function buildMetaAdsLibraryUrl({ queryText, country }) {
  const safeCountry = country || 'PL';
  const encodedQuery = encodeURIComponent(queryText);

  return `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${encodeURIComponent(safeCountry)}&is_targeted_country=false&media_type=all&q=${encodedQuery}&search_type=keyword_unordered`;
}

function toActorRef(actorId) {
  if (!actorId) return 'curious_coder~facebook-ads-library-scraper';
  return actorId.replace('/', '~');
}

function parseTerminalApifyError(runPayload) {
  const statusMessage = runPayload?.statusMessage || runPayload?.status_message || '';
  const status = runPayload?.status || 'UNKNOWN';
  if (statusMessage) return `${status}: ${statusMessage}`;
  return `Apify run ended with status ${status}`;
}

class MetaAdsHarvester {
  constructor(db) {
    this.db = db;
    this.config = buildApifyConfigFromEnv();
    this.activeRuns = new Map();
  }

  getConfigSnapshot() {
    return {
      provider: 'APIFY',
      apiBaseUrl: this.config.apiBaseUrl,
      actorId: this.config.actorId,
      pollIntervalMs: this.config.pollIntervalMs,
      runTimeoutMs: this.config.runTimeoutMs,
      limitPerSource: this.config.limitPerSource,
      maxRecordsPerQuery: this.config.maxRecordsPerQuery,
      scrapeAdDetails: this.config.scrapeAdDetails,
      maxTotalChargeUsd: this.config.maxTotalChargeUsd,
      country: this.config.country,
      hasToken: Boolean(this.config.token),
    };
  }

  ensureToken() {
    if (!this.config.token) {
      const error = new Error('APIFY_API_TOKEN is not configured');
      error.code = 'APIFY_TOKEN_MISSING';
      throw error;
    }
  }

  startResearchRun({ projectId, queryPlanId = null, queryLimit = null }) {
    this.ensureToken();

    const approved = extractApprovedPlanAndGroups(this.db, projectId, queryPlanId);
    if (!approved.queryPlan) {
      const error = new Error('No query plan found for this project');
      error.code = 'QUERY_PLAN_NOT_FOUND';
      throw error;
    }

    if (approved.notApproved) {
      const error = new Error('Query plan must be APPROVED before running research');
      error.code = 'QUERY_PLAN_NOT_APPROVED';
      throw error;
    }

    const dedupedGroups = approved.queryGroups
      .map(group => ({
        ...group,
        queryText: normalizeQueryText(group.queryText),
      }))
      .filter(group => group.queryText);

    const limitedGroups = Number.isFinite(queryLimit) && queryLimit > 0
      ? dedupedGroups.slice(0, queryLimit)
      : dedupedGroups;

    if (!limitedGroups.length) {
      const error = new Error('No enabled queries in APPROVED query plan');
      error.code = 'NO_ENABLED_QUERIES';
      throw error;
    }

    const queryJobs = limitedGroups.map(group => {
      const sourceUrl = buildMetaAdsLibraryUrl({
        queryText: group.queryText,
        country: approved.queryPlan.country || this.config.country,
      });

      return {
        group,
        sourceUrl,
        normalizedSourceUrl: normalizeSourceUrl(sourceUrl),
      };
    });

    const run = createResearchRun(this.db, {
      projectId,
      queryPlanId: approved.queryPlan.id,
      country: approved.queryPlan.country || this.config.country,
      queriesTotal: queryJobs.length,
      provider: 'APIFY',
      config: {
        provider: 'APIFY',
        actorId: this.config.actorId,
        limitPerSource: this.config.limitPerSource,
        maxRecordsPerQuery: this.config.maxRecordsPerQuery,
        scrapeAdDetails: this.config.scrapeAdDetails,
        maxTotalChargeUsd: this.config.maxTotalChargeUsd,
        urlsCount: queryJobs.length,
      },
    });

    this.activeRuns.set(run.id, {
      runId: run.id,
      status: 'PENDING',
      startedAt: run.startedAt,
      projectId,
    });

    this.executeRun({
      runId: run.id,
      projectId,
      queryPlan: approved.queryPlan,
      queryJobs,
      country: approved.queryPlan.country || this.config.country,
    })
      .catch(() => {
        // Execution errors are persisted in DB.
      })
      .finally(() => {
        this.activeRuns.delete(run.id);
      });

    return run;
  }

  async executeRun(context) {
    const startedAt = Date.now();

    try {
      updateResearchRunProgress(this.db, context.runId, {
        status: 'RUNNING',
        progressStage: 'Przygotowuje query...',
      });

      const queryRuns = context.queryJobs.map(job => {
        const queryRun = createQueryRun(this.db, {
          researchRunId: context.runId,
          queryText: job.group.queryText,
          queryTextNormalized: job.group.normalizedText,
          queryTypeSnapshot: job.group.queryTypeSnapshot,
          queryCategory: job.group.queryCategory,
          sourceUrl: job.sourceUrl,
          prioritySnapshot: job.group.prioritySnapshot,
        });

        linkQueryRunVariants(this.db, queryRun.id, job.group.variants);

        return {
          ...job,
          queryRun,
        };
      });

      updateResearchRunProgress(this.db, context.runId, {
        progressStage: 'Uruchamiam Apify...',
        queriesCompleted: 0,
      });

      const startedProviderRun = await this.startApifyRun(queryRuns);

      updateResearchRunProgress(this.db, context.runId, {
        providerRunId: startedProviderRun.id,
        providerDatasetId: startedProviderRun.defaultDatasetId || null,
      });

      const finishedProviderRun = await this.waitForApifyRun(startedProviderRun.id, startedAt, context.runId);

      const datasetId = finishedProviderRun.defaultDatasetId || startedProviderRun.defaultDatasetId || null;

      updateResearchRunProgress(this.db, context.runId, {
        providerDatasetId: datasetId,
        progressStage: 'Pobieram reklamy...',
      });

      const datasetItems = await this.fetchRunDatasetItems(startedProviderRun.id);

      updateResearchRunProgress(this.db, context.runId, {
        progressStage: 'Przetwarzam wyniki...',
      });

      const bySourceUrl = new Map();
      for (const queryRun of queryRuns) {
        if (queryRun.normalizedSourceUrl) {
          bySourceUrl.set(queryRun.normalizedSourceUrl, queryRun);
        }
      }

      const perQueryAccepted = new Map();
      const perQueryUniqueAds = new Map();
      const acceptedHits = [];
      let unmatchedCount = 0;

      for (const item of datasetItems) {
        const sourceCandidate = item?.url || item?.sourceUrl || item?.source_url || item?.searchUrl || null;
        const normalizedSource = normalizeSourceUrl(sourceCandidate);

        let queryRun = normalizedSource ? bySourceUrl.get(normalizedSource) : null;

        if (!queryRun && queryRuns.length === 1) {
          queryRun = queryRuns[0];
        }

        if (!queryRun) {
          unmatchedCount += 1;
          continue;
        }

        const countForQuery = perQueryAccepted.get(queryRun.queryRun.id) || 0;
        if (countForQuery >= this.config.maxRecordsPerQuery) {
          continue;
        }

        perQueryAccepted.set(queryRun.queryRun.id, countForQuery + 1);

        const adArchiveId = String(item?.ad_archive_id || item?.id || '').trim();
        if (adArchiveId) {
          const uniqueSet = perQueryUniqueAds.get(queryRun.queryRun.id) || new Set();
          uniqueSet.add(adArchiveId);
          perQueryUniqueAds.set(queryRun.queryRun.id, uniqueSet);
        }

        acceptedHits.push({
          rawAd: item,
          queryRunId: queryRun.queryRun.id,
          queryText: queryRun.group.queryText,
          queryCategory: queryRun.group.queryCategory,
          sourceUrl: queryRun.sourceUrl,
          resultPosition: Number.isFinite(Number(item?.position)) ? Number(item.position) : (countForQuery + 1),
        });
      }

      updateResearchRunProgress(this.db, context.runId, {
        progressStage: 'Zapisuje do bazy...',
      });

      const observedAt = new Date().toISOString();
      const batchResult = saveAdsPageBatch(this.db, {
        researchRunId: context.runId,
        ads: acceptedHits,
        observedAt,
      });

      ensureProjectAdRelevanceRows(this.db, {
        projectId: context.projectId,
        metaAdIds: [...batchResult.uniqueAdIds],
      });

      rebuildOfferFamilies(this.db, context.projectId);

      let queriesCompleted = 0;
      for (const queryRun of queryRuns) {
        const hitsCount = perQueryAccepted.get(queryRun.queryRun.id) || 0;
        const uniqueAdsCount = (perQueryUniqueAds.get(queryRun.queryRun.id) || new Set()).size;

        updateQueryRun(this.db, queryRun.queryRun.id, {
          status: 'COMPLETED',
          finishedAt: new Date().toISOString(),
          pagesFetched: 1,
          hitsCount,
          uniqueAdsCount,
          apiHitsCount: 1,
          errorMessage: null,
        });

        queriesCompleted += 1;
      }

      const fetchedCount = batchResult.processedCount;
      const uniqueAdsTotal = batchResult.uniqueAdIds.size;
      const duplicatesCount = Math.max(fetchedCount - uniqueAdsTotal, 0);
      const errorsTotal = batchResult.invalidCount + unmatchedCount;

      updateResearchRunProgress(this.db, context.runId, {
        status: errorsTotal > 0 ? 'PARTIAL' : 'COMPLETED',
        progressStage: 'Badanie zakonczone.',
        queriesCompleted,
        apiHitsTotal: datasetItems.length,
        fetchedCount,
        uniqueAdsTotal,
        duplicatesCount,
        errorsTotal,
        finishedAt: new Date().toISOString(),
        errorMessage: errorsTotal > 0
          ? `Processed with ${errorsTotal} warning(s). ${batchResult.firstErrorMessage || ''}`.trim()
          : null,
      });
    } catch (error) {
      updateResearchRunProgress(this.db, context.runId, {
        status: 'FAILED',
        progressStage: 'Badanie zakonczone.',
        finishedAt: new Date().toISOString(),
        errorMessage: error.message,
      });

      throw error;
    }
  }

  async startApifyRun(queryRuns) {
    const actorRef = toActorRef(this.config.actorId);
    const url = new URL(`${this.config.apiBaseUrl}/actors/${actorRef}/runs`);

    if (Number.isFinite(this.config.maxTotalChargeUsd) && this.config.maxTotalChargeUsd >= 0) {
      url.searchParams.set('maxTotalChargeUsd', String(this.config.maxTotalChargeUsd));
    }

    const body = {
      urls: queryRuns.map(queryRun => ({ url: queryRun.sourceUrl })),
      limitPerSource: this.config.limitPerSource,
      scrapeAdDetails: this.config.scrapeAdDetails,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`Apify start failed: ${message}`);
    }

    const runData = payload?.data || payload;
    if (!runData?.id) {
      throw new Error('Apify start failed: run id missing in response');
    }

    return {
      id: runData.id,
      defaultDatasetId: runData.defaultDatasetId || null,
      status: runData.status || 'READY',
    };
  }

  async waitForApifyRun(providerRunId, startedAtMs, runId) {
    const terminalStatuses = new Set(['SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTED']);

    while (true) {
      const elapsed = Date.now() - startedAtMs;
      if (elapsed > this.config.runTimeoutMs) {
        throw new Error(`Apify run timeout after ${Math.floor(this.config.runTimeoutMs / 1000)}s`);
      }

      const response = await fetch(`${this.config.apiBaseUrl}/actor-runs/${providerRunId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
        },
        signal: AbortSignal.timeout(30000),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
        throw new Error(`Apify status check failed: ${message}`);
      }

      const runData = payload?.data || payload;
      const status = runData?.status || 'UNKNOWN';

      if (status === 'RUNNING' || status === 'READY') {
        updateResearchRunProgress(this.db, runId, {
          progressStage: 'Uruchamiam Apify...',
        });
      }

      if (!terminalStatuses.has(status)) {
        await delay(this.config.pollIntervalMs);
        continue;
      }

      if (status !== 'SUCCEEDED') {
        throw new Error(parseTerminalApifyError(runData));
      }

      return runData;
    }
  }

  async fetchRunDatasetItems(providerRunId) {
    const url = new URL(`${this.config.apiBaseUrl}/actor-runs/${providerRunId}/dataset/items`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('clean', 'true');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
      signal: AbortSignal.timeout(60000),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`Apify dataset fetch failed: ${message}`);
    }

    if (!Array.isArray(payload)) {
      throw new Error('Apify dataset fetch failed: expected JSON array');
    }

    return payload;
  }
}

function createMetaAdsHarvester(db) {
  return new MetaAdsHarvester(db);
}

module.exports = {
  createMetaAdsHarvester,
  buildApifyConfigFromEnv,
  buildMetaAdsLibraryUrl,
};
