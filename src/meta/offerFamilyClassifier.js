const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

const OFFER_FAMILY_THRESHOLDS = {
  TEST_MAX_DAYS: 7,
  REPEATED_TEST_MAX_DAYS: 14,
  ESTABLISHED_MIN_DAYS: 30,
  EVERGREEN_MIN_DAYS: 90,
  DIRECT_SUCCESSOR_MAX_GAP: 7,
  SUCCESSOR_AFTER_GAP_MAX: 29,
  RELAUNCH_MIN_GAP: 30,
  EDGE_LINK_MIN_CONFIDENCE: 70,
};

const FAMILY_CLASS_ORDER = {
  EVERGREEN: 1,
  ESTABLISHED: 2,
  PROMISING: 3,
  REPEATED_TEST: 4,
  TEST_ONLY: 5,
  UNCLASSIFIED: 6,
};

const TRACKING_PARAM_PREFIXES = [
  'utm_',
  'fb_',
  'ga_',
  'mc_',
];

const TRACKING_PARAM_EXACT = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'igshid',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
  'hsa_src',
  'hsa_net',
  'hsa_kw',
  'hsa_acc',
  's',
  'si',
]);

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toIso(value) {
  if (!value) return null;
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function diffDays(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const diff = Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MS);
  return diff >= 0 ? diff : 0;
}

function normalizePath(pathname) {
  let path = pathname || '/';
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path;
}

function isTrackingParam(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function canonicalizeUrl(urlText) {
  if (!urlText || typeof urlText !== 'string') return null;

  try {
    const parsed = new URL(urlText.trim());
    parsed.hash = '';

    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = normalizePath(parsed.pathname);

    const params = [];
    for (const [name, value] of parsed.searchParams.entries()) {
      if (isTrackingParam(name)) continue;
      params.push([name, value]);
    }

    params.sort((left, right) => {
      if (left[0] === right[0]) {
        return left[1].localeCompare(right[1]);
      }
      return left[0].localeCompare(right[0]);
    });

    const query = params.length
      ? `?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}`
      : '';

    return `${protocol}//${host}${path}${query}`;
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[\u2018\u2019\u201c\u201d]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ');
}

function toTokenSet(value) {
  const normalized = normalizeText(value);
  if (!normalized) return new Set();
  return new Set(normalized.split(' ').filter(Boolean));
}

function jaccardSimilarity(leftText, rightText) {
  const left = toTokenSet(leftText);
  const right = toTokenSet(rightText);
  if (!left.size && !right.size) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = left.size + right.size - intersection;
  if (!union) return 0;
  return intersection / union;
}

function combinedTextSimilarity(leftAd, rightAd) {
  const titleSimilarity = jaccardSimilarity(leftAd.title, rightAd.title);
  const bodySimilarity = jaccardSimilarity(leftAd.bodyText, rightAd.bodyText);

  const leftHasBody = normalizeText(leftAd.bodyText).length > 0;
  const rightHasBody = normalizeText(rightAd.bodyText).length > 0;

  const combinedSimilarity = leftHasBody && rightHasBody
    ? (titleSimilarity * 0.45) + (bodySimilarity * 0.55)
    : titleSimilarity;

  return {
    titleSimilarity,
    bodySimilarity,
    combinedSimilarity,
  };
}

function getDomainAndPath(urlText) {
  const canonical = canonicalizeUrl(urlText);
  if (!canonical) {
    return {
      canonical: null,
      domain: null,
      path: null,
    };
  }

  try {
    const parsed = new URL(canonical);
    return {
      canonical,
      domain: parsed.hostname,
      path: normalizePath(parsed.pathname),
    };
  } catch {
    return {
      canonical,
      domain: null,
      path: null,
    };
  }
}

function pathSimilarity(leftPath, rightPath) {
  if (!leftPath || !rightPath) return 0;
  if (leftPath === rightPath) return 1;

  const leftParts = leftPath.split('/').filter(Boolean);
  const rightParts = rightPath.split('/').filter(Boolean);
  if (!leftParts.length || !rightParts.length) return 0;

  let samePrefix = 0;
  const max = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < max; index += 1) {
    if (leftParts[index] === rightParts[index]) {
      samePrefix += 1;
    } else {
      break;
    }
  }

  return samePrefix / Math.max(leftParts.length, rightParts.length);
}

function buildPairKey(leftId, rightId) {
  return leftId < rightId ? `${leftId}::${rightId}` : `${rightId}::${leftId}`;
}

function buildFamilyId(projectId, memberIds) {
  const hash = crypto
    .createHash('sha1')
    .update(`${projectId}|${memberIds.join('|')}`)
    .digest('hex')
    .slice(0, 24);
  return `fam_${hash}`;
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map();
    this.rank = new Map();
    for (const id of ids) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(leftId, rightId) {
    const leftRoot = this.find(leftId);
    const rightRoot = this.find(rightId);
    if (leftRoot === rightRoot) return;

    const leftRank = this.rank.get(leftRoot) || 0;
    const rightRank = this.rank.get(rightRoot) || 0;

    if (leftRank < rightRank) {
      this.parent.set(leftRoot, rightRoot);
      return;
    }

    if (leftRank > rightRank) {
      this.parent.set(rightRoot, leftRoot);
      return;
    }

    this.parent.set(rightRoot, leftRoot);
    this.rank.set(leftRoot, leftRank + 1);
  }
}

function buildOfferMatch(leftAd, rightAd) {
  const reasons = [];

  if (!leftAd.pageId || !rightAd.pageId || leftAd.pageId !== rightAd.pageId) {
    return {
      shouldLink: false,
      confidence: 0,
      matchType: 'PAGE_MISMATCH',
      reasons: ['inne page_id'],
      titleSimilarity: 0,
      bodySimilarity: 0,
      combinedSimilarity: 0,
    };
  }

  reasons.push('same page_id');

  const leftUrl = getDomainAndPath(leftAd.destinationUrl);
  const rightUrl = getDomainAndPath(rightAd.destinationUrl);

  const text = combinedTextSimilarity(leftAd, rightAd);

  if (leftUrl.canonical && rightUrl.canonical && leftUrl.canonical === rightUrl.canonical) {
    reasons.push('same canonical destination URL');
    if (text.titleSimilarity >= 0.7) {
      reasons.push(`title similarity ${text.titleSimilarity.toFixed(2)}`);
      return {
        shouldLink: true,
        confidence: 100,
        matchType: 'PAGE_CANONICAL_URL_EXACT',
        reasons,
        ...text,
      };
    }

    return {
      shouldLink: true,
      confidence: 98,
      matchType: 'PAGE_CANONICAL_URL_EXACT',
      reasons,
      ...text,
    };
  }

  if (leftAd.collationId && rightAd.collationId && leftAd.collationId === rightAd.collationId) {
    reasons.push('same collation_id');
    return {
      shouldLink: true,
      confidence: 95,
      matchType: 'PAGE_COLLATION_ID_EXACT',
      reasons,
      ...text,
    };
  }

  if (
    leftUrl.canonical
    && rightUrl.canonical
    && leftUrl.canonical === rightUrl.canonical
    && text.titleSimilarity >= 0.62
  ) {
    reasons.push('same canonical URL');
    reasons.push(`title similarity ${text.titleSimilarity.toFixed(2)}`);
    return {
      shouldLink: true,
      confidence: 90,
      matchType: 'PAGE_CANONICAL_TITLE_SIMILAR',
      reasons,
      ...text,
    };
  }

  const sameDomain = leftUrl.domain && rightUrl.domain && leftUrl.domain === rightUrl.domain;
  const urlPathSimilarity = pathSimilarity(leftUrl.path, rightUrl.path);

  if (sameDomain && text.combinedSimilarity >= 0.72 && urlPathSimilarity >= 0.34) {
    const confidence = Math.min(
      89,
      Math.round(78 + ((text.combinedSimilarity - 0.72) * 20) + (urlPathSimilarity * 6)),
    );

    reasons.push('same domain');
    reasons.push(`title similarity ${text.titleSimilarity.toFixed(2)}`);
    reasons.push(`body similarity ${text.bodySimilarity.toFixed(2)}`);
    reasons.push(`path similarity ${urlPathSimilarity.toFixed(2)}`);

    return {
      shouldLink: confidence >= OFFER_FAMILY_THRESHOLDS.EDGE_LINK_MIN_CONFIDENCE,
      confidence,
      matchType: 'PAGE_TEXT_DOMAIN_SIMILARITY',
      reasons,
      ...text,
    };
  }

  if (text.combinedSimilarity >= 0.9) {
    const confidence = Math.min(84, Math.round(70 + ((text.combinedSimilarity - 0.9) * 40)));
    reasons.push(`title similarity ${text.titleSimilarity.toFixed(2)}`);
    reasons.push(`body similarity ${text.bodySimilarity.toFixed(2)}`);
    reasons.push('destination URL changed');

    return {
      shouldLink: confidence >= OFFER_FAMILY_THRESHOLDS.EDGE_LINK_MIN_CONFIDENCE,
      confidence,
      matchType: 'PAGE_TEXT_HIGH_URL_CHANGED',
      reasons,
      ...text,
    };
  }

  return {
    shouldLink: false,
    confidence: Math.round(text.combinedSimilarity * 60),
    matchType: 'INSUFFICIENT_EVIDENCE',
    reasons: [...reasons, `combined similarity ${text.combinedSimilarity.toFixed(2)}`],
    ...text,
  };
}

function buildIntervals(ads, now) {
  const ranges = [];

  for (const ad of ads) {
    const start = toDate(ad.startDate || ad.firstSeenAt);
    if (!start) continue;

    const stop = toDate(ad.endDate) || (ad.isActive ? now : toDate(ad.lastSeenAt)) || start;
    const end = stop.getTime() < start.getTime() ? start : stop;

    ranges.push({
      start,
      end,
    });
  }

  ranges.sort((left, right) => left.start.getTime() - right.start.getTime());
  return ranges;
}

function unionIntervalDays(intervals) {
  if (!intervals.length) return 0;

  let covered = 0;
  let currentStart = intervals[0].start;
  let currentEnd = intervals[0].end;

  for (let index = 1; index < intervals.length; index += 1) {
    const next = intervals[index];
    if (next.start.getTime() <= currentEnd.getTime()) {
      if (next.end.getTime() > currentEnd.getTime()) {
        currentEnd = next.end;
      }
      continue;
    }

    covered += diffDays(currentStart, currentEnd) + 1;
    currentStart = next.start;
    currentEnd = next.end;
  }

  covered += diffDays(currentStart, currentEnd) + 1;
  return covered;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function classifyTemporalRelationship(previousAd, currentAd, now) {
  if (!previousAd) {
    return {
      relationshipType: 'FIRST',
      gapDays: null,
    };
  }

  const previousStart = toDate(previousAd.startDate || previousAd.firstSeenAt);
  const previousEnd = toDate(previousAd.endDate)
    || (previousAd.isActive ? now : toDate(previousAd.lastSeenAt))
    || previousStart;

  const currentStart = toDate(currentAd.startDate || currentAd.firstSeenAt);
  if (!previousEnd || !currentStart) {
    return {
      relationshipType: 'UNKNOWN',
      gapDays: null,
    };
  }

  if (currentStart.getTime() === previousEnd.getTime()) {
    return {
      relationshipType: 'DIRECT_SUCCESSOR',
      gapDays: 0,
    };
  }

  if (currentStart.getTime() < previousEnd.getTime()) {
    const overlapDays = Math.abs(diffDays(currentStart, previousEnd));
    return {
      relationshipType: 'PARALLEL',
      gapDays: overlapDays,
    };
  }

  const gapDays = diffDays(previousEnd, currentStart);

  if (gapDays <= OFFER_FAMILY_THRESHOLDS.DIRECT_SUCCESSOR_MAX_GAP) {
    return {
      relationshipType: 'DIRECT_SUCCESSOR',
      gapDays,
    };
  }

  if (gapDays <= OFFER_FAMILY_THRESHOLDS.SUCCESSOR_AFTER_GAP_MAX) {
    return {
      relationshipType: 'SUCCESSOR_AFTER_GAP',
      gapDays,
    };
  }

  if (gapDays >= OFFER_FAMILY_THRESHOLDS.RELAUNCH_MIN_GAP) {
    return {
      relationshipType: 'RELAUNCH',
      gapDays,
    };
  }

  return {
    relationshipType: 'UNKNOWN',
    gapDays,
  };
}

function classifyFamilyClass(metrics) {
  if (!metrics.adsCount) return 'UNCLASSIFIED';

  if (metrics.maxAdDurationDays >= OFFER_FAMILY_THRESHOLDS.EVERGREEN_MIN_DAYS) {
    return 'EVERGREEN';
  }

  if (
    metrics.coveredDeliveryDays >= OFFER_FAMILY_THRESHOLDS.ESTABLISHED_MIN_DAYS
    || metrics.maxAdDurationDays >= OFFER_FAMILY_THRESHOLDS.ESTABLISHED_MIN_DAYS
  ) {
    return 'ESTABLISHED';
  }

  if (
    metrics.adsCount === 1
    && metrics.maxAdDurationDays <= OFFER_FAMILY_THRESHOLDS.TEST_MAX_DAYS
    && metrics.endedAdsCount === 1
  ) {
    return 'TEST_ONLY';
  }

  if (
    metrics.adsCount >= 2
    && metrics.maxAdDurationDays <= OFFER_FAMILY_THRESHOLDS.REPEATED_TEST_MAX_DAYS
    && metrics.successorCount === 0
    && metrics.parallelCount <= 1
    && metrics.activeAdsCount === 0
  ) {
    return 'REPEATED_TEST';
  }

  if (
    metrics.maxAdDurationDays > OFFER_FAMILY_THRESHOLDS.TEST_MAX_DAYS
    || metrics.successorCount > 0
    || metrics.activeAdsCount > 0
  ) {
    return 'PROMISING';
  }

  return 'UNCLASSIFIED';
}

function classifyFamilyStatus(metrics) {
  if (!metrics.adsCount) return 'UNKNOWN';
  if (metrics.activeAdsCount > 0) return 'ACTIVE';
  return 'ENDED';
}

function buildFamilyConfidence(familyClass, metrics, averageEdgeConfidence) {
  const classBase = {
    TEST_ONLY: 44,
    REPEATED_TEST: 52,
    PROMISING: 60,
    ESTABLISHED: 72,
    EVERGREEN: 80,
    UNCLASSIFIED: 36,
  };

  let score = classBase[familyClass] || 36;
  score += Math.min(12, Math.max(0, metrics.adsCount - 1) * 3);
  score += Math.min(10, metrics.successorCount * 4);
  score += Math.min(6, metrics.parallelCount * 2);
  score += Math.min(8, metrics.relaunchCount * 4);
  score += Math.min(8, Math.floor(metrics.coveredDeliveryDays / 30) * 2);
  score += Math.min(8, Math.max(0, averageEdgeConfidence - 65) * 0.4);

  if (familyClass === 'EVERGREEN' && metrics.adsCount === 1 && metrics.successorCount === 0) {
    score = Math.min(score, 58);
  }

  if (familyClass === 'EVERGREEN' && metrics.adsCount >= 3 && metrics.successorCount >= 2) {
    score += 6;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildFamilyReason(familyClass, metrics, adsSorted) {
  const durations = adsSorted
    .map(ad => Number(ad.runtimeDays))
    .filter(value => Number.isFinite(value) && value > 0);

  const durationChain = durations.length
    ? durations.join(' -> ')
    : 'brak pelnych danych o czasie emisji';

  if (familyClass === 'EVERGREEN') {
    return `${metrics.adsCount} reklamy tej samej oferty; ${durationChain} dni; ${metrics.successorCount} nastepcow bezposrednich; najdluzsza emisja ${metrics.maxAdDurationDays} dni.`;
  }

  if (familyClass === 'ESTABLISHED') {
    return `${metrics.adsCount} reklamy oferty; laczny zasieg czasowy ${metrics.coveredDeliveryDays} dni; co najmniej jedna dluga emisja.`;
  }

  if (familyClass === 'PROMISING') {
    return `${metrics.adsCount} reklamy oferty; widac kontynuacje po testach (${durationChain}).`;
  }

  if (familyClass === 'REPEATED_TEST') {
    return `${metrics.adsCount} krotkie emisje (${durationChain}); brak mocnego przejscia do dlugiej kampanii.`;
  }

  if (familyClass === 'TEST_ONLY') {
    return 'Pojedynczy krotki test oferty bez nastepcy.';
  }

  return `${metrics.adsCount} reklamy; zbyt malo danych do jednoznacznej klasyfikacji.`;
}

function buildFamilyPatterns({
  successorCount,
  parallelCount,
  relaunchCount,
  hasCreativeRefresh,
  longestGapDays,
}) {
  const patterns = [];

  if (parallelCount > 0) patterns.push('PARALLEL_TEST');
  if (successorCount > 0) patterns.push('DIRECT_SUCCESSOR');
  if (relaunchCount > 0) patterns.push('RELAUNCH');
  if (hasCreativeRefresh) patterns.push('CREATIVE_REFRESH');
  if (longestGapDays != null && longestGapDays <= OFFER_FAMILY_THRESHOLDS.DIRECT_SUCCESSOR_MAX_GAP) {
    patterns.push('CONTINUOUS_CAMPAIGN');
  }

  return patterns;
}

function normalizeAdRecord(ad) {
  const canonical = canonicalizeUrl(ad.destinationUrl);
  const parsed = getDomainAndPath(canonical || ad.destinationUrl);
  const runtimeDays = Number(ad.runtimeDays);

  return {
    ...ad,
    pageId: ad.pageId ? String(ad.pageId) : null,
    title: String(ad.title || ''),
    bodyText: String(ad.bodyText || ''),
    destinationUrl: ad.destinationUrl || null,
    canonicalDestinationUrl: canonical,
    destinationDomain: parsed.domain,
    destinationPath: parsed.path,
    collationId: ad.collationId ? String(ad.collationId) : null,
    runtimeDays: Number.isFinite(runtimeDays) ? Math.max(0, Math.round(runtimeDays)) : null,
  };
}

function findBestEdge(currentAd, candidateAds, edgeMap) {
  let best = null;

  for (const candidate of candidateAds) {
    const key = buildPairKey(currentAd.metaAdId, candidate.metaAdId);
    const edge = edgeMap.get(key);
    if (!edge) continue;

    if (!best || edge.confidence > best.confidence) {
      best = edge;
    }
  }

  return best;
}

function buildOfferFamilies(projectId, ads, {
  classifierVersion = 'offer-family-v1',
  now = new Date(),
} = {}) {
  const prepared = (Array.isArray(ads) ? ads : []).map(normalizeAdRecord);
  const ids = prepared.map(ad => ad.metaAdId);

  const unionFind = new UnionFind(ids);
  const edgeMap = new Map();

  const byPage = new Map();
  for (const ad of prepared) {
    const key = ad.pageId || `no-page:${ad.metaAdId}`;
    if (!byPage.has(key)) {
      byPage.set(key, []);
    }
    byPage.get(key).push(ad);
  }

  for (const pageAds of byPage.values()) {
    for (let leftIndex = 0; leftIndex < pageAds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < pageAds.length; rightIndex += 1) {
        const leftAd = pageAds[leftIndex];
        const rightAd = pageAds[rightIndex];

        const edge = buildOfferMatch(leftAd, rightAd);
        if (!edge.shouldLink) continue;

        const key = buildPairKey(leftAd.metaAdId, rightAd.metaAdId);
        edgeMap.set(key, edge);
        unionFind.union(leftAd.metaAdId, rightAd.metaAdId);
      }
    }
  }

  const components = new Map();
  for (const ad of prepared) {
    const root = unionFind.find(ad.metaAdId);
    if (!components.has(root)) {
      components.set(root, []);
    }
    components.get(root).push(ad);
  }

  const families = [];

  for (const componentAds of components.values()) {
    const adsSorted = [...componentAds].sort((left, right) => {
      const leftStart = toDate(left.startDate || left.firstSeenAt);
      const rightStart = toDate(right.startDate || right.firstSeenAt);

      if (leftStart && rightStart && leftStart.getTime() !== rightStart.getTime()) {
        return leftStart.getTime() - rightStart.getTime();
      }

      if (leftStart && !rightStart) return -1;
      if (!leftStart && rightStart) return 1;

      return String(left.adArchiveId || left.metaAdId).localeCompare(String(right.adArchiveId || right.metaAdId));
    });

    const intervals = buildIntervals(adsSorted, now);
    const coveredDeliveryDays = unionIntervalDays(intervals);

    const firstAdStart = adsSorted
      .map(ad => toDate(ad.startDate || ad.firstSeenAt))
      .filter(Boolean)
      .sort((left, right) => left.getTime() - right.getTime())[0] || null;

    const latestAdStart = adsSorted
      .map(ad => toDate(ad.startDate || ad.firstSeenAt))
      .filter(Boolean)
      .sort((left, right) => right.getTime() - left.getTime())[0] || null;

    const latestAdEnd = adsSorted
      .map(ad => toDate(ad.endDate) || (ad.isActive ? now : toDate(ad.lastSeenAt)))
      .filter(Boolean)
      .sort((left, right) => right.getTime() - left.getTime())[0] || null;

    const familyCalendarSpanDays = firstAdStart && latestAdEnd
      ? (diffDays(firstAdStart, latestAdEnd) + 1)
      : coveredDeliveryDays;

    const durations = adsSorted
      .map(ad => Number(ad.runtimeDays))
      .filter(value => Number.isFinite(value) && value >= 0);

    const metrics = {
      adsCount: adsSorted.length,
      activeAdsCount: adsSorted.filter(ad => ad.isActive).length,
      endedAdsCount: adsSorted.filter(ad => !ad.isActive).length,
      firstAdStart,
      latestAdStart,
      latestAdEnd,
      familyCalendarSpanDays,
      coveredDeliveryDays,
      maxAdDurationDays: durations.length ? Math.max(...durations) : 0,
      medianAdDurationDays: durations.length ? median(durations) : 0,
      successorCount: 0,
      parallelCount: 0,
      relaunchCount: 0,
      longestGapDays: 0,
      currentlyActive: adsSorted.some(ad => ad.isActive),
    };

    const members = [];
    let sumEdgeConfidence = 0;
    let countedEdges = 0;
    let hasCreativeRefresh = false;

    for (let index = 0; index < adsSorted.length; index += 1) {
      const ad = adsSorted[index];
      const previous = index > 0 ? adsSorted[index - 1] : null;
      const previousCandidates = adsSorted.slice(0, index);
      const temporal = classifyTemporalRelationship(previous, ad, now);

      if (temporal.relationshipType === 'DIRECT_SUCCESSOR' || temporal.relationshipType === 'SUCCESSOR_AFTER_GAP') {
        metrics.successorCount += 1;
      }
      if (temporal.relationshipType === 'PARALLEL') {
        metrics.parallelCount += 1;
      }
      if (temporal.relationshipType === 'RELAUNCH') {
        metrics.relaunchCount += 1;
      }
      if (Number.isFinite(temporal.gapDays)) {
        metrics.longestGapDays = Math.max(metrics.longestGapDays, temporal.gapDays || 0);
      }

      let provenance = null;
      if (previous) {
        const directKey = buildPairKey(ad.metaAdId, previous.metaAdId);
        provenance = edgeMap.get(directKey) || null;
      }

      if (!provenance && previousCandidates.length) {
        provenance = findBestEdge(ad, previousCandidates, edgeMap);
      }

      if (provenance) {
        sumEdgeConfidence += provenance.confidence;
        countedEdges += 1;

        if (
          provenance.combinedSimilarity >= 0.55
          && ad.adArchiveId
          && previous
          && ad.adArchiveId !== previous.adArchiveId
        ) {
          hasCreativeRefresh = true;
        }
      }

      members.push({
        projectId,
        metaAdId: ad.metaAdId,
        relationshipType: temporal.relationshipType,
        previousAdId: previous ? previous.metaAdId : null,
        offerMatchConfidence: provenance ? provenance.confidence : null,
        matchReasons: provenance ? provenance.reasons : ['brak wystarczajacego dowodu pary z poprzednikiem'],
        matchType: provenance ? provenance.matchType : 'NONE',
        titleSimilarity: provenance ? Number(provenance.titleSimilarity.toFixed(4)) : null,
        bodySimilarity: provenance ? Number(provenance.bodySimilarity.toFixed(4)) : null,
        combinedSimilarity: provenance ? Number(provenance.combinedSimilarity.toFixed(4)) : null,
        sortOrder: index + 1,
      });
    }

    const averageEdgeConfidence = countedEdges ? (sumEdgeConfidence / countedEdges) : 0;
    const familyClass = classifyFamilyClass(metrics);
    const familyStatus = classifyFamilyStatus(metrics);
    const familyPatterns = buildFamilyPatterns({
      successorCount: metrics.successorCount,
      parallelCount: metrics.parallelCount,
      relaunchCount: metrics.relaunchCount,
      hasCreativeRefresh,
      longestGapDays: metrics.longestGapDays,
    });
    const familyConfidence = buildFamilyConfidence(familyClass, metrics, averageEdgeConfidence);
    const familyReason = buildFamilyReason(familyClass, metrics, adsSorted);

    const memberIds = members.map(member => member.metaAdId).sort((left, right) => left.localeCompare(right));
    const familyId = buildFamilyId(projectId, memberIds);

    families.push({
      id: familyId,
      projectId,
      familyClass,
      familyStatus,
      familyConfidence,
      familyReason,
      firstAdStart: toIso(metrics.firstAdStart),
      latestAdStart: toIso(metrics.latestAdStart),
      latestAdEnd: toIso(metrics.latestAdEnd),
      familyCalendarSpanDays: metrics.familyCalendarSpanDays || 0,
      coveredDeliveryDays: metrics.coveredDeliveryDays || 0,
      adsCount: metrics.adsCount,
      activeAdsCount: metrics.activeAdsCount,
      endedAdsCount: metrics.endedAdsCount,
      maxAdDurationDays: metrics.maxAdDurationDays,
      medianAdDurationDays: metrics.medianAdDurationDays,
      successorCount: metrics.successorCount,
      parallelCount: metrics.parallelCount,
      relaunchCount: metrics.relaunchCount,
      longestGapDays: metrics.longestGapDays || 0,
      currentlyActive: metrics.currentlyActive,
      familyPatterns,
      classifierVersion,
      members,
    });
  }

  families.sort((left, right) => {
    const classDiff = (FAMILY_CLASS_ORDER[left.familyClass] || 99) - (FAMILY_CLASS_ORDER[right.familyClass] || 99);
    if (classDiff !== 0) return classDiff;

    if (right.familyConfidence !== left.familyConfidence) {
      return right.familyConfidence - left.familyConfidence;
    }

    if (right.coveredDeliveryDays !== left.coveredDeliveryDays) {
      return right.coveredDeliveryDays - left.coveredDeliveryDays;
    }

    if (right.adsCount !== left.adsCount) {
      return right.adsCount - left.adsCount;
    }

    return String(left.id).localeCompare(String(right.id));
  });

  return {
    families,
    canonicalDestinationByAdId: Object.fromEntries(prepared.map(ad => [ad.metaAdId, ad.canonicalDestinationUrl || null])),
  };
}

module.exports = {
  OFFER_FAMILY_THRESHOLDS,
  FAMILY_CLASS_ORDER,
  canonicalizeUrl,
  normalizeText,
  jaccardSimilarity,
  buildOfferMatch,
  buildOfferFamilies,
};
