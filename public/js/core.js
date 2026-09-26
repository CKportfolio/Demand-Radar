const REQUIRED_TOP = [
  'schemaVersion',
  'capabilityUnderstanding',
  'marketBreadth',
  'seedQueries',
  'candidateProductTypes',
  'initialTaxonomy',
  'discoveryStrategies',
  'queryExpansionPolicy',
  'openUnknowns',
  'constraints',
  'discoveryLimits',
  'saturationCriteria',
  'changeSummary',
  'warnings',
];

const SOURCE_EVENT_LABELS = {
  LLM_GENERATION: 'LLM_GENERATION',
  LLM_REVISION: 'LLM_REVISION',
  MANUAL_REVISION: 'MANUAL_REVISION',
};

let currentPlan = null;
let currentPlanOrigin = null;
let currentPersistedVersionId = null;
let currentPersistedVersionNumber = null;
let currentPlanDirty = false;
let queryPlanContext = null;
let currentQueryPlan = null;
let currentQueryPlanDirty = false;
let currentMetaResearchRun = null;
let metaResearchPollHandle = null;
let queryPlanSelectedSeedIds = new Set();
let currentMetaAds = [];
let currentOfferFamilies = [];
const META_ADS_PAGE_SIZE = 20;
let metaAdsNextOffset = 0;
let metaAdsTotal = 0;
let metaAdsHasMore = false;
let metaAdsLoading = false;
let metaAdsRequestSerial = 0;
let metaAdsInfiniteObserver = null;
let offerFamiliesLoadedForRunId = null;
let currentMetaRelevanceSummary = null;
let metaRelevanceBusy = false;
let conversation = [];
let lastResponseData = null;

let revisionNumber = 0;
let selectedSavedProject = null;
const relevanceProgressPollHandles = { MR04: null, MR05: null };
const relevanceProgressStatsKeys = { MR04: '', MR05: '' };
const relevanceProgressStatuses = { MR04: 'IDLE', MR05: 'IDLE' };
const relevanceProgressByStage = { MR04: null, MR05: null };

const QUERY_TYPES = ['CORE', 'PROBLEM', 'AUDIENCE', 'FORMAT', 'SYNONYM', 'PRECISION'];
const LIFECYCLE_LABELS = {
  BALON_PROBNY: 'BALON PRÓBNY',
  TEST_W_TOKU: 'TEST W TOKU',
  ROKUJACA: 'ROKUJĄCA',
  MOCNA: 'MOCNA',
  EVERGREEN: 'EVERGREEN',
};
const LIFECYCLE_FILTER_VALUES = ['BALON_PROBNY', 'TEST_W_TOKU', 'ROKUJACA', 'MOCNA', 'EVERGREEN'];
const FAMILY_CLASS_ORDER = ['EVERGREEN', 'ESTABLISHED', 'PROMISING', 'REPEATED_TEST', 'TEST_ONLY', 'UNCLASSIFIED'];
const MODE_STORAGE_KEY = 'marketRadarWebhookMode';
const QUERY_DENSITY_STORAGE_KEY = 'marketRadarQueryDensity';
const RELEVANCE_BATCH_SIZE_STORAGE_KEY = 'marketRadarRelevanceBatchSize';
const RELEVANCE_BATCH_SIZE_MIN = 1;
const RELEVANCE_BATCH_SIZE_MAX = 200;
const RELEVANCE_BATCH_SIZE_DEFAULT = 20;
const QUERY_DENSITY_LEVELS = [
  { key: 'compact', label: 'Kompaktowe' },
  { key: 'standard', label: 'Standardowe' },
  { key: 'comfortable', label: 'Większe' },
];

const RELEVANCE_LABELS = {
  USEFUL: 'UZYTECZNE',
  KEEP: 'KEEP',
  POTENTIAL: 'POTENCJALNE',
  UNREVIEWED: 'NIESPRAWDZONE',
  REJECT: 'SMIECI',
  ALL: 'WSZYSTKIE',
};

const $ = id => document.getElementById(id);

const storedQueryDensityIndex = QUERY_DENSITY_LEVELS.findIndex(
  level => level.key === localStorage.getItem(QUERY_DENSITY_STORAGE_KEY),
);
let queryDensityIndex = storedQueryDensityIndex >= 0 ? storedQueryDensityIndex : 1;

function applyQueryDensity() {
  queryDensityIndex = Math.max(0, Math.min(QUERY_DENSITY_LEVELS.length - 1, queryDensityIndex));
  const level = QUERY_DENSITY_LEVELS[queryDensityIndex];
  const editor = $('queryPlanEditor');
  if (editor) editor.dataset.queryDensity = level.key;
  if ($('queryDensityLabel')) $('queryDensityLabel').textContent = level.label;
  if ($('queryDensityDecreaseBtn')) $('queryDensityDecreaseBtn').disabled = queryDensityIndex === 0;
  if ($('queryDensityIncreaseBtn')) $('queryDensityIncreaseBtn').disabled = queryDensityIndex === QUERY_DENSITY_LEVELS.length - 1;
  localStorage.setItem(QUERY_DENSITY_STORAGE_KEY, level.key);
}

function uuid() {
  return crypto.randomUUID();
}

let projectId = localStorage.getItem('marketRadarProjectId') || uuid();
localStorage.setItem('marketRadarProjectId', projectId);
$('projectIdText').textContent = projectId;

$('mode').value = 'production';
localStorage.setItem(MODE_STORAGE_KEY, 'production');
$('mode').addEventListener('change', () => {
  localStorage.setItem(MODE_STORAGE_KEY, $('mode').value);
  updateRelevanceBatchHint();
});

function getRelevanceBatchSize() {
  const input = $('relevanceBatchSize');
  const parsed = Number.parseInt(String(input?.value || ''), 10);
  const normalized = Number.isFinite(parsed)
    ? Math.max(RELEVANCE_BATCH_SIZE_MIN, Math.min(RELEVANCE_BATCH_SIZE_MAX, parsed))
    : RELEVANCE_BATCH_SIZE_DEFAULT;
  if (input) input.value = String(normalized);
  localStorage.setItem(RELEVANCE_BATCH_SIZE_STORAGE_KEY, String(normalized));
  return normalized;
}

function updateRelevanceBatchHint() {
  const hint = $('relevanceBatchHint');
  if (!hint) return;
  const batchSize = getRelevanceBatchSize();
  hint.textContent = $('mode').value === 'test'
    ? `Test: zostanie wysłana tylko 1 paczka, maksymalnie ${batchSize} reklam.`
    : `Produkcja: kolejne paczki po ${batchSize} reklam. STOP działa po zapisaniu bieżącej paczki.`;
}

const storedRelevanceBatchSize = Number.parseInt(
  localStorage.getItem(RELEVANCE_BATCH_SIZE_STORAGE_KEY) || '',
  10,
);
if ($('relevanceBatchSize')) {
  $('relevanceBatchSize').value = String(Number.isFinite(storedRelevanceBatchSize)
    ? Math.max(RELEVANCE_BATCH_SIZE_MIN, Math.min(RELEVANCE_BATCH_SIZE_MAX, storedRelevanceBatchSize))
    : RELEVANCE_BATCH_SIZE_DEFAULT);
  $('relevanceBatchSize').addEventListener('change', updateRelevanceBatchHint);
  $('relevanceBatchSize').addEventListener('input', updateRelevanceBatchHint);
}
updateRelevanceBatchHint();

function updateResultsStickyOffset() {
  const header = document.querySelector('header');
  const offset = (header?.offsetHeight || 0) + 10;
  document.documentElement.style.setProperty('--results-sticky-top', `${offset}px`);
}

window.addEventListener('resize', updateResultsStickyOffset);
window.addEventListener('load', updateResultsStickyOffset);
requestAnimationFrame(updateResultsStickyOffset);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[c]));
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pl-PL');
}

function formatBytes(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 0) return '—';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(2)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function normalizeRelevanceStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['KEEP', 'POTENTIAL', 'REJECT', 'UNREVIEWED'].includes(normalized)) return normalized;
  return 'UNREVIEWED';
}

function relevanceBadgeClass(status) {
  if (status === 'KEEP') return 'keep';
  if (status === 'POTENTIAL') return 'potential';
  if (status === 'REJECT') return 'reject';
  return 'unreviewed';
}
