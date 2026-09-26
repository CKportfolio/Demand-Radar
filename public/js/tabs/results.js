function stopMetaResearchPolling() {
  if (metaResearchPollHandle) {
    clearInterval(metaResearchPollHandle);
    metaResearchPollHandle = null;
  }
}

function renderMetaResearchSummary(run) {
  if (!run) {
    $('metaResearchStatus').textContent = 'Brak uruchomionego badania.';
    $('metaResearchProgress').style.display = 'none';
    $('metaResearchSummary').innerHTML = '';
    $('metaRelevanceSummary').style.display = 'none';
    $('metaRelevanceSummary').textContent = '';
    $('metaActionStatus').textContent = '';
    $('metaMr04RunStatus').textContent = '';
    $('metaMr05RunStatus').textContent = '';
    relevanceProgressStatuses.MR04 = 'IDLE';
    relevanceProgressStatuses.MR05 = 'IDLE';
    relevanceProgressByStage.MR04 = null;
    relevanceProgressByStage.MR05 = null;
    $('metaAdsBody').innerHTML = '<tr><td colspan="1" class="muted">Brak danych.</td></tr>';
    $('metaExportFullCsvBtn').disabled = true;
    $('metaExportShortCsvBtn').disabled = true;
    $('metaRunRelevanceBtn').disabled = true;
    $('metaRunMr05Btn').disabled = true;
    $('metaRestoreAllRelevanceBtn').disabled = true;
    currentMetaAds = [];
    currentOfferFamilies = [];
    metaAdsNextOffset = 0;
    metaAdsTotal = 0;
    metaAdsHasMore = false;
    offerFamiliesLoadedForRunId = null;
    currentMetaRelevanceSummary = null;
    applyMetaLifecycleFilterOptionLabels(null);
    renderOfferFamilies([]);
    setMetaAdsInfiniteStatus('Brak reklam do wyświetlenia.');
    return;
  }

  const duplicates = Number.isFinite(Number(run.duplicatesCount))
    ? Number(run.duplicatesCount)
    : Math.max((run.fetchedCount || 0) - (run.uniqueAdsTotal || 0), 0);
  const breakdown = run.lifecycleBreakdown || {};

  const isPartial = run.status === 'PARTIAL';
  const statusEntries = [
    { key: 'status', label: 'Status', value: isPartial ? 'CZĘŚCIOWE (z ostrzeżeniem)' : run.status },
    { key: 'stage', label: 'Etap', value: run.progressStage || '—' },
    { key: 'id', label: 'ID badania', value: run.id },
    { key: 'source', label: 'Źródło', value: run.provider || 'APIFY' },
    { key: 'start', label: 'Start', value: formatDateTime(run.startedAt) },
    { key: 'end', label: 'Koniec', value: formatDateTime(run.finishedAt) },
    ...(run.errorMessage ? [{
      key: 'notes',
      label: 'Uwagi',
      value: String(run.errorMessage).replace('Record is missing ad_archive_id', 'Pominięto rekord bez identyfikatora reklamy.'),
    }] : []),
  ];

  $('metaResearchStatus').innerHTML = `
    <div class="meta-status-block">
      ${statusEntries.map(({ key, label, value }) => `
        <div class="meta-status-line meta-status-${key}${key === 'status' && isPartial ? ' is-warning' : ''}">
          <strong>${escapeHtml(label)}:</strong>
          <span title="${escapeHtml(value || '—')}">${escapeHtml(value || '—')}</span>
        </div>
      `).join('')}
    </div>
  `;

  const isRunning = run.status === 'PENDING' || run.status === 'RUNNING';
  const relevanceRunning = Object.values(relevanceProgressStatuses).includes('RUNNING');
  $('metaResearchStartBtn').disabled = isRunning || currentQueryPlan?.status !== 'APPROVED' || currentQueryPlanDirty;
  $('metaRunRelevanceBtn').disabled = isRunning || relevanceRunning || metaRelevanceBusy;
  $('metaRunMr05Btn').disabled = isRunning || relevanceRunning || metaRelevanceBusy;
  $('metaRestoreAllRelevanceBtn').disabled = isRunning || relevanceRunning;

  if (isRunning) {
    $('metaResearchProgress').style.display = 'block';
    $('metaResearchProgress').innerHTML = [
      escapeHtml(run.progressStage || 'Badanie trwa...'),
      `${escapeHtml(run.queriesCompleted)} / ${escapeHtml(run.queriesTotal)} query`,
      `Pobrane rekordy: ${escapeHtml(run.fetchedCount || 0)}`,
      `Unikalne reklamy: ${escapeHtml(run.uniqueAdsTotal || 0)}`,
    ].join('<br>');
  } else {
    $('metaResearchProgress').style.display = 'none';
  }

  const summaryItems = [
    ['Zapytania (unikalne)', run.queriesTotal, ''],
    ['Wykonane unikalne wyszukiwania', run.queriesCompleted, ''],
    ['Pobrane rekordy', run.fetchedCount || 0, ''],
    ['Unikalne reklamy', run.uniqueAdsTotal, 'is-primary'],
    ['Duplikaty między zapytaniami', duplicates, ''],
    ['Błędy / ostrzeżenia', run.errorsTotal, Number(run.errorsTotal || 0) > 0 ? 'is-warning' : ''],
    ['Balony próbne', breakdown.BALON_PROBNY || 0, 'is-lifecycle'],
    ['Test w toku', breakdown.TEST_W_TOKU || 0, 'is-lifecycle'],
    ['Rokujące', breakdown.ROKUJACA || 0, 'is-lifecycle'],
    ['Mocne', breakdown.MOCNA || 0, 'is-lifecycle'],
    ['Evergreen', breakdown.EVERGREEN || 0, 'is-lifecycle'],
  ];

  $('metaResearchSummary').innerHTML = `
    <div class="meta-summary-table">
      ${summaryItems.map(([label, value, className]) => `
        <div class="meta-stat-card ${className}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function applyMetaRelevanceFilterOptionLabels(summary) {
  const select = $('metaFilterRelevance');
  const baseLabels = {
    USEFUL: 'Trafność: UŻYTECZNE',
    KEEP: 'Trafność: ZACHOWAJ',
    POTENTIAL: 'Trafność: POTENCJALNE',
    UNREVIEWED: 'Trafność: NIESPRAWDZONE',
    REJECT: 'Trafność: ODRZUCONE',
    ALL: 'Trafność: WSZYSTKIE',
  };

  for (const option of select.options) {
    option.textContent = baseLabels[option.value] || option.value;
  }

  if (!summary) return;

  const byValue = {
    USEFUL: summary.useful ?? 0,
    KEEP: summary.keep ?? 0,
    POTENTIAL: summary.potential ?? 0,
    UNREVIEWED: summary.unreviewed ?? 0,
    REJECT: summary.reject ?? 0,
    ALL: summary.all ?? 0,
  };

  for (const option of select.options) {
    if (Object.prototype.hasOwnProperty.call(byValue, option.value)) {
      option.textContent = `${baseLabels[option.value]} (${byValue[option.value]})`;
    }
  }
}

function getSelectedLifecycleFilters() {
  return [...document.querySelectorAll('.meta-lifecycle-check:checked')]
    .map(checkbox => checkbox.value)
    .filter(Boolean);
}

function setLifecycleFiltersSelected(value) {
  for (const checkbox of document.querySelectorAll('.meta-lifecycle-check')) {
    checkbox.checked = value;
  }
}

function applyMetaLifecycleFilterOptionLabels(summary) {
  for (const lifecycle of LIFECYCLE_FILTER_VALUES) {
    const label = document.querySelector(`[data-lifecycle-label="${lifecycle}"]`);
    if (!label) continue;

    const base = LIFECYCLE_LABELS[lifecycle] || lifecycle;
    const count = summary && Number.isFinite(Number(summary[lifecycle]))
      ? Number(summary[lifecycle])
      : null;

    label.textContent = count == null ? base : `${base} (${count})`;
  }
}

function renderMetaRelevanceSummary(summary) {
  currentMetaRelevanceSummary = summary || null;
  applyMetaRelevanceFilterOptionLabels(currentMetaRelevanceSummary);

  if (!summary) {
    $('metaRelevanceSummary').style.display = 'none';
    $('metaRelevanceSummary').textContent = '';
    return;
  }

  const trashCount = (Number(summary.reject || 0) + Number(summary.potential || 0));

  $('metaRelevanceSummary').style.display = 'block';
  $('metaRelevanceSummary').innerHTML = `
    <div class="meta-relevance-grid">
      <div class="meta-relevance-item is-good"><span>Użyteczne</span><strong>${escapeHtml(summary.useful ?? 0)}</strong></div>
      <div class="meta-relevance-item"><span>KEEP</span><strong>${escapeHtml(summary.keep ?? 0)}</strong></div>
      <div class="meta-relevance-item"><span>Potencjalne</span><strong>${escapeHtml(summary.potential ?? 0)}</strong></div>
      <div class="meta-relevance-item"><span>Niesprawdzone</span><strong>${escapeHtml(summary.unreviewed ?? 0)}</strong></div>
      <div class="meta-relevance-item is-trash"><span>Śmieci<small>REJECT + POTENCJALNE</small></span><strong>${escapeHtml(trashCount)}</strong></div>
      <div class="meta-relevance-item"><span>Wszystkie</span><strong>${escapeHtml(summary.all ?? 0)}</strong></div>
    </div>
  `;
}

function relevanceStageUi(stage) {
  const normalized = String(stage || 'MR04').toUpperCase();
  return normalized === 'MR05'
    ? {
      stage: 'MR05',
      processLabel: 'Rozstrzyganie wyników niejednoznacznych (MR05)',
      buttonLabel: 'ROZSTRZYGNIJ POTENCJALNE (MR05)',
      progressUrl: 'ads/relevance/mr05/progress',
      pendingUrl: 'ads/relevance/mr05/pending-count',
      runUrl: 'ads/relevance/mr05/run',
      stopUrl: 'ads/relevance/mr05/stop',
      statusId: 'metaMr05RunStatus',
      buttonId: 'metaRunMr05Btn',
    }
    : {
      stage: 'MR04',
      processLabel: 'Filtrowanie danych (MR04)',
      buttonLabel: 'ODRZUĆ ŚMIECI',
      progressUrl: 'ads/relevance/mr04/progress',
      pendingUrl: 'ads/relevance/pending-count',
      runUrl: 'ads/relevance/run',
      stopUrl: 'ads/relevance/mr04/stop',
      statusId: 'metaMr04RunStatus',
      buttonId: 'metaRunRelevanceBtn',
    };
}

function relevanceErrorMessage(progress, fallback) {
  return typeof progress?.error === 'string'
    ? progress.error
    : progress?.error?.message || fallback;
}

function renderRelevanceProgress(stage, progress) {
  const ui = relevanceStageUi(stage);
  const container = $(ui.statusId);
  if (!container) return;
  if (!progress || progress.status === 'IDLE') {
    container.textContent = '';
    return;
  }

  const total = Number(progress.totalBatches || 0);
  const completed = Number(progress.completedBatches || 0);
  const totalAds = Number(progress.totalAds || 0);
  const processedAds = Number(progress.processedAds || 0);
  const percent = total
    ? Math.min(100, Math.round((completed / total) * 100))
    : (progress.status === 'COMPLETED' ? 100 : 0);
  const etaSeconds = Math.max(0, Math.ceil((total - completed) * (60 / Number(progress.rateLimitRpm || 14))));
  const etaLabel = progress.status === 'RUNNING' && etaSeconds
    ? ` · ok. ${etaSeconds >= 60 ? `${Math.ceil(etaSeconds / 60)} min` : `${etaSeconds} s`} do końca`
    : '';
  const phaseLabel = progress.phase === 'RATE_LIMIT_WAIT'
    ? `oczekiwanie na limit ${progress.rateLimitRpm || 14}/min`
    : progress.phase === 'MODEL_REQUEST'
      ? `model przetwarza paczkę ${progress.currentBatch || completed + 1}`
      : progress.phase === 'STOP_REQUESTED'
        ? 'zatrzymywanie po bieżącej paczce'
        : progress.status === 'COMPLETED'
          ? 'zakończono'
          : progress.status === 'PAUSED'
            ? 'zatrzymano — można wznowić'
            : progress.status === 'FAILED'
              ? 'przerwano — można wznowić'
              : 'przetwarzanie';
  const errorHtml = progress.status === 'FAILED'
    ? `<small class="relevance-progress-error">${escapeHtml(relevanceErrorMessage(progress, `${ui.processLabel} zakończyło się błędem.`))}</small>`
    : '';
  const canStop = progress.status === 'RUNNING'
    && progress.phase !== 'STOP_REQUESTED'
    && progress.mode === 'production';
  const canResume = progress.status === 'PAUSED' || progress.status === 'FAILED';
  const controlsHtml = canStop || canResume
    ? `
      <div class="relevance-progress-controls">
        ${canStop ? `<button class="danger" type="button" data-relevance-stop="${ui.stage}">ZATRZYMAJ</button>` : ''}
        ${canResume ? `<button class="secondary" type="button" data-relevance-resume="${ui.stage}">WZNÓW</button>` : ''}
        ${canStop ? '<small>Zatrzymanie nastąpi po zapisaniu bieżącej paczki.</small>' : ''}
      </div>
    `
    : '';

  container.innerHTML = `
    <div class="relevance-progress is-${String(progress.status || '').toLowerCase()}">
      <strong>${escapeHtml(ui.processLabel)}: ${escapeHtml(phaseLabel)}</strong>
      <span>${escapeHtml(completed)} / ${escapeHtml(total)} paczek · ${escapeHtml(processedAds)} / ${escapeHtml(totalAds)} reklam · ${percent}%${escapeHtml(etaLabel)}</span>
      <div class="relevance-progress-track"><div class="relevance-progress-fill" style="width:${percent}%"></div></div>
      ${errorHtml}
      ${controlsHtml}
    </div>
  `;
}

async function refreshMetaStatsOnly() {
  if (!currentMetaResearchRun?.id) return null;
  const res = await fetch(`/api/meta-research/${encodeURIComponent(currentMetaResearchRun.id)}/stats`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);

  currentMetaResearchRun = payload.run;
  renderMetaResearchSummary(currentMetaResearchRun);
  renderMetaRelevanceSummary(payload.relevanceSummary || null);
  applyMetaLifecycleFilterOptionLabels(payload.lifecycleSummary || null);
  return payload;
}

async function refreshRelevanceProgress(stage, { refreshStats = true } = {}) {
  const activeProjectId = currentMetaResearchRun?.projectId;
  if (!activeProjectId) return null;
  const ui = relevanceStageUi(stage);

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(activeProjectId)}/${ui.progressUrl}`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    const progress = payload.progress || null;
    relevanceProgressStatuses[ui.stage] = progress?.status || 'IDLE';
    relevanceProgressByStage[ui.stage] = progress;
    renderRelevanceProgress(ui.stage, progress);

    const relevanceRunning = Object.values(relevanceProgressStatuses).includes('RUNNING');
    const researchRunning = currentMetaResearchRun?.status === 'PENDING' || currentMetaResearchRun?.status === 'RUNNING';
    $('metaRunRelevanceBtn').disabled = relevanceRunning || researchRunning || metaRelevanceBusy;
    $('metaRunMr05Btn').disabled = relevanceRunning || researchRunning || metaRelevanceBusy;
    $('metaRestoreAllRelevanceBtn').disabled = relevanceRunning || researchRunning || metaRelevanceBusy;

    const statsKey = `${progress?.status || 'IDLE'}:${progress?.completedBatches || 0}`;
    if (refreshStats && progress && statsKey !== relevanceProgressStatsKeys[ui.stage]) {
      relevanceProgressStatsKeys[ui.stage] = statsKey;
      if (Number(progress.completedBatches || 0) > 0 || ['COMPLETED', 'PAUSED'].includes(progress.status)) {
        refreshMetaStatsOnly().catch(() => {});
      }
    }
    return progress;
  } catch {
    return null;
  }
}

async function waitForRelevanceCompletion(stage) {
  const ui = relevanceStageUi(stage);
  while (true) {
    const progress = await refreshRelevanceProgress(ui.stage);
    if (progress?.status === 'COMPLETED') return progress.result || {};
    if (progress?.status === 'PAUSED') return { ...(progress.result || {}), paused: true };
    if (progress?.status === 'FAILED') {
      throw new Error(relevanceErrorMessage(progress, `${ui.processLabel} zakończyło się błędem.`));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

function startRelevanceProgressPolling(stage) {
  const ui = relevanceStageUi(stage);
  stopRelevanceProgressPolling(ui.stage);
  refreshRelevanceProgress(ui.stage);
  relevanceProgressPollHandles[ui.stage] = setInterval(async () => {
    const progress = await refreshRelevanceProgress(ui.stage);
    if (progress && progress.status !== 'RUNNING') stopRelevanceProgressPolling(ui.stage);
  }, 1800);
}

function stopRelevanceProgressPolling(stage) {
  const ui = relevanceStageUi(stage);
  if (relevanceProgressPollHandles[ui.stage]) {
    clearInterval(relevanceProgressPollHandles[ui.stage]);
    relevanceProgressPollHandles[ui.stage] = null;
  }
}

async function restorePersistedRelevanceProgress() {
  for (const stage of ['MR04', 'MR05']) {
    const progress = await refreshRelevanceProgress(stage, { refreshStats: false });
    if (progress?.status === 'RUNNING') startRelevanceProgressPolling(stage);
  }
}

function getSelectedFamilyFilters() {
  return {
    familyClass: $('metaFamilyClassFilter').value || 'ALL',
    familyStatus: $('metaFamilyStatusFilter').value || 'ALL',
    familyPattern: $('metaFamilyPatternFilter').value || 'ALL',
  };
}

function summarizeOfferFamilies(families) {
  const list = Array.isArray(families) ? families : [];
  if (!list.length) {
    $('offerFamilySummary').textContent = 'Brak rodzin ofert.';
    return;
  }

  const classCounts = {
    TEST_ONLY: 0,
    REPEATED_TEST: 0,
    PROMISING: 0,
    ESTABLISHED: 0,
    EVERGREEN: 0,
    UNCLASSIFIED: 0,
  };

  for (const family of list) {
    if (Object.prototype.hasOwnProperty.call(classCounts, family.familyClass)) {
      classCounts[family.familyClass] += 1;
    }
  }

  $('offerFamilySummary').textContent = [
    `Rodziny: ${list.length}`,
    `Wieznozielone: ${classCounts.EVERGREEN}`,
    `Ustabilizowane: ${classCounts.ESTABLISHED}`,
    `Rokujące: ${classCounts.PROMISING}`,
  ].join(' | ');
}

function renderOfferFamilies(families) {
  const list = Array.isArray(families) ? families : [];
  summarizeOfferFamilies(list);
  window.DemandRadarTimeline?.setFamilies(list);

  if (!list.length) {
    $('offerFamilyList').innerHTML = '<div class="muted">Brak rodzin ofert dla obecnych filtrow.</div>';
    return;
  }

  $('offerFamilyList').innerHTML = list.map(family => {
    const familyId = String(family.id || family.familyId || family.family_id || '');
    const patterns = Array.isArray(family.familyPatterns) && family.familyPatterns.length
      ? family.familyPatterns.join(' | ')
      : 'BRAK';

    const members = Array.isArray(family.members) ? family.members : [];
    const timeline = members.map((member, index) => {
      const start = formatDateTime(member.startDate) || 'brak daty startu';
      const end = formatDateTime(member.endDate) || (member.isActive ? 'aktywna' : 'brak daty konca');
      const duration = Number.isFinite(Number(member.runtimeDays)) ? `${member.runtimeDays} dni` : 'n/d';
      const relation = index === 0 ? '' : `<div class="rel">→ ${escapeHtml(member.relationshipType || 'NIEZNANA RELACJA')}</div>`;

      const adLabel = member.title || member.adArchiveId || member.metaAdId || 'reklama';
      const adLink = member.adLibraryUrl || member.destinationUrl;
      const linkedLabel = adLink
        ? `<a href="${escapeHtml(adLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(adLabel)}</a>`
        : escapeHtml(adLabel);
      return `${relation}<div>${escapeHtml(start)} -> ${escapeHtml(end)} | ${escapeHtml(duration)} | ${linkedLabel}</div>`;
    }).join('');

    return `
      <div class="offer-family-card">
        <div class="offer-family-head">
          <div class="offer-family-class">${escapeHtml(family.familyClass || 'UNCLASSIFIED')} · ${escapeHtml(family.familyStatus || 'UNKNOWN')}</div>
          <div class="offer-family-head-actions">
            <div class="offer-family-score">${escapeHtml(family.familyConfidence ?? 0)}%</div>
            <button class="offer-family-timeline-btn" type="button" data-family-id="${escapeHtml(familyId)}" ${familyId ? '' : 'disabled'}>
              <span aria-hidden="true">↔</span> Timeline
            </button>
          </div>
        </div>
        <div class="offer-family-meta">
          <span>Reklamy: ${escapeHtml(family.adsCount ?? 0)}</span>
          <span>Pokrycie: ${escapeHtml(family.coveredDeliveryDays ?? 0)} dni</span>
          <span>Następcy: ${escapeHtml(family.successorCount ?? 0)}</span>
          <span>Równoległe: ${escapeHtml(family.parallelCount ?? 0)}</span>
          <span>Wznowienia: ${escapeHtml(family.relaunchCount ?? 0)}</span>
        </div>
        <div class="offer-family-patterns">Wzorzec: ${escapeHtml(patterns)}</div>
        <div class="offer-family-reason">Powód: ${escapeHtml(family.familyReason || 'Brak opisu')}</div>
        <div class="offer-family-timeline">${timeline}</div>
      </div>
    `;
  }).join('');
}

function buildFallbackReason(ad) {
  const lifecycle = LIFECYCLE_LABELS[ad.longevityCategory || ad.lifecycleClass] || (ad.longevityCategory || ad.lifecycleClass || 'UNCLASSIFIED');
  const runtime = Number.isFinite(Number(ad.runtimeDays)) ? `${ad.runtimeDays} dni` : 'brak runtime';
  return `Lifecycle ${lifecycle}; ${runtime}.`;
}

function buildShortDescription(bodyText) {
  const source = String(bodyText || '').trim();
  if (!source) return '';

  const directLines = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  let lines = [];
  if (directLines.length >= 2) {
    lines = directLines.slice(0, 3);
  } else {
    const sentences = source
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(item => item.trim())
      .filter(Boolean);

    lines = sentences.slice(0, 3);
    if (!lines.length) {
      lines = [source.slice(0, 180)];
    }
  }

  let text = lines.join('\n');
  if (text.length > 480) {
    text = `${text.slice(0, 477)}...`;
  }

  return text;
}

function prepareAdsForFamilyCsv(sourceAds = currentMetaAds) {
  const dedup = new Map();
  for (const ad of sourceAds || []) {
    if (!ad?.metaAdId) continue;
    if (!dedup.has(ad.metaAdId)) {
      dedup.set(ad.metaAdId, ad);
    }
  }

  const ads = [...dedup.values()];
  ads.sort((left, right) => {
    const leftClassIndex = FAMILY_CLASS_ORDER.indexOf(left.familyClass || 'UNCLASSIFIED');
    const rightClassIndex = FAMILY_CLASS_ORDER.indexOf(right.familyClass || 'UNCLASSIFIED');
    const aClass = leftClassIndex === -1 ? FAMILY_CLASS_ORDER.length : leftClassIndex;
    const bClass = rightClassIndex === -1 ? FAMILY_CLASS_ORDER.length : rightClassIndex;
    if (aClass !== bClass) return aClass - bClass;

    if ((left.familyId || '') !== (right.familyId || '')) {
      return String(left.familyId || '').localeCompare(String(right.familyId || ''));
    }

    if (Number.isFinite(Number(left.familySortOrder)) && Number.isFinite(Number(right.familySortOrder))) {
      if (left.familySortOrder !== right.familySortOrder) {
        return left.familySortOrder - right.familySortOrder;
      }
    }

    const leftStart = new Date(left.startDate || left.firstSeenAt || 0).getTime();
    const rightStart = new Date(right.startDate || right.firstSeenAt || 0).getTime();
    return leftStart - rightStart;
  });

  return ads;
}

function renderAdDetailsModalContent(ad) {
  if (!ad) {
    return '<div class="ad-details-section"><h4>Brak danych</h4><p>Nie znaleziono rekordu reklamy.</p></div>';
  }

  const rawJson = ad.rawJson && typeof ad.rawJson === 'object' ? ad.rawJson : {};
  const lifecycleKey = ad.longevityCategory || ad.lifecycleClass;
  const lifecycleLabel = LIFECYCLE_LABELS[lifecycleKey] || lifecycleKey || '—';

  const basicFields = [
    ['Tytuł', ad.title || rawJson.title || rawJson.name || '—'],
    ['Treść', ad.bodyText || rawJson.bodyText || rawJson.body_text || '—'],
    ['Strona / reklamodawca', ad.pageName || ad.pageId || rawJson.pageName || rawJson.page_name || '—'],
    ['Status aktywności', ad.isActive ? 'Aktywna' : 'Zakończona'],
    ['Start', formatDateTime(ad.startDate || ad.adDeliveryStartTime) || '—'],
    ['Stop', formatDateTime(ad.endDate || ad.adDeliveryStopTime) || '—'],
    ['EU reach', ad.euTotalReach ?? rawJson.euTotalReach ?? '—'],
    ['Likes', ad.pageLikeCount ?? rawJson.pageLikeCount ?? '—'],
    ['Podgląd w Meta', ad.adLibraryUrl || ad.adSnapshotUrl || rawJson.adLibraryUrl || rawJson.ad_library_url || '—'],
  ];

  const lifecycleFields = [
    ['Kategoria lifecycle', lifecycleLabel],
    ['Pewność', Number.isFinite(Number(ad.lifecycleConfidence)) ? `${ad.lifecycleConfidence}%` : '—'],
    ['Runtime', Number.isFinite(Number(ad.runtimeDays)) ? `${ad.runtimeDays} dni` : '—'],
    ['Powód', Array.isArray(ad.lifecycleReasons) && ad.lifecycleReasons.length ? ad.lifecycleReasons.join(' | ') : '—'],
  ];

  const relevanceFields = [
    ['Relevance', RELEVANCE_LABELS[normalizeRelevanceStatus(ad.relevanceStatus)] || normalizeRelevanceStatus(ad.relevanceStatus) || '—'],
    ['Źródło decyzji', ad.relevanceSource === 'MANUAL' ? 'Decyzja ręczna' : 'Filtrowanie danych (MR04)'],
    ['Ostatni etap klasyfikacji', ad.lastClassifier === 'MR05' ? 'Drugi przebieg (MR05)' : 'Filtrowanie danych (MR04)'],
    ['Decyzja filtrowania (MR04)', ad.mr04Decision || '—'],
    ['Pewność filtrowania (MR04)', Number.isFinite(Number(ad.mr04Confidence)) ? `${ad.mr04Confidence}%` : '—'],
    ['Powód filtrowania (MR04)', ad.mr04Reason || ad.mr04ReasonCode || '—'],
    ['Decyzja drugiego przebiegu (MR05)', ad.mr05Decision || '—'],
    ['Pewność drugiego przebiegu (MR05)', Number.isFinite(Number(ad.mr05Confidence)) ? `${ad.mr05Confidence}%` : '—'],
    ['Powód drugiego przebiegu (MR05)', ad.mr05Reason || ad.mr05ReasonCode || '—'],
    ['Manual override', ad.manualOverride ? 'Tak' : 'Nie'],
  ];

  const detailFields = [
    ['Klasa rodziny', ad.familyClass || 'NIEKLASYFIKOWANA'],
    ['Status rodziny', ad.familyStatus || 'NIEZNANY'],
    ['Pewność rodziny', Number.isFinite(Number(ad.familyConfidence)) ? `${ad.familyConfidence}%` : '—'],
    ['Wzorce rodziny', Array.isArray(ad.familyPatterns) && ad.familyPatterns.length ? ad.familyPatterns.join(' | ') : '—'],
    ['Powód rodziny', ad.familyReason || '—'],
    ['Relacja', ad.relationshipToPrevious || 'PIERWSZA'],
    ['Adres kanoniczny', ad.canonicalUrl || '—'],
    ['Collation ID', ad.collationId || '—'],
  ];

  const basicHtml = basicFields.map(([label, value]) => `
    <div class="ad-details-item">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(String(value ?? '—'))}</span>
    </div>
  `).join('');

  const lifecycleHtml = lifecycleFields.map(([label, value]) => `
    <div class="ad-details-item">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(String(value ?? '—'))}</span>
    </div>
  `).join('');

  const relevanceHtml = relevanceFields.map(([label, value]) => `
    <div class="ad-details-item">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(String(value ?? '—'))}</span>
    </div>
  `).join('');

  const detailsHtml = detailFields.map(([label, value]) => `
    <div class="ad-details-item">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(String(value ?? '—'))}</span>
    </div>
  `).join('');

  return `
    <div class="ad-details-section">
      <h4>Podstawowe informacje</h4>
      <div class="ad-details-grid">${basicHtml}</div>
    </div>
    <div class="ad-details-section">
      <h4>Lifecycle</h4>
      <div class="ad-details-grid">${lifecycleHtml}</div>
    </div>
    <div class="ad-details-section">
      <h4>Relevance</h4>
      <div class="ad-details-grid">${relevanceHtml}</div>
    </div>
    <div class="ad-details-section">
      <h4>Metadane reklam</h4>
      <div class="ad-details-grid">${detailsHtml}</div>
    </div>
  `;
}

async function openAdDetailsModal(adArchiveId) {
  if (!currentMetaResearchRun?.projectId || !adArchiveId) return;
  const modal = $('adDetailsModalBackdrop');
  $('adDetailsContent').innerHTML = '<div class="loading-inline"><span class="loading-spinner"></span><span>Ładowanie pełnych szczegółów reklamy…</span></div>';
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentMetaResearchRun.projectId)}/ads/${encodeURIComponent(adArchiveId)}/details`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    $('adDetailsContent').innerHTML = renderAdDetailsModalContent(payload.ad);
  } catch (error) {
    $('adDetailsContent').innerHTML = `<div class="bad">Nie udało się pobrać szczegółów: ${escapeHtml(error.message)}</div>`;
  }
}

function closeAdDetailsModal() {
  const modal = $('adDetailsModalBackdrop');
  modal.classList.remove('visible');
  modal.setAttribute('aria-hidden', 'true');
}

function renderMetaAdsTable(ads, { append = false } = {}) {
  if (!Array.isArray(ads) || !ads.length) {
    if (!append) {
      $('metaAdsBody').innerHTML = '<tr><td colspan="1" class="muted">Brak reklam dla tego filtra.</td></tr>';
    }
    return;
  }

  const rowsHtml = ads.map(ad => {
    const bodyPreview = ad.bodyText || ad.title || (ad.creativeBodies && ad.creativeBodies[0]) || (ad.creativeLinkTitles && ad.creativeLinkTitles[0]) || '';
    const titlePreview = ad.title || (ad.creativeLinkTitles && ad.creativeLinkTitles[0]) || '';
    const lifecycleKey = ad.longevityCategory || ad.lifecycleClass;
    const lifecycle = LIFECYCLE_LABELS[lifecycleKey] || lifecycleKey || '—';
    const confidence = Number.isFinite(Number(ad.lifecycleConfidence)) ? `${ad.lifecycleConfidence}%` : '—';
    const reasons = Array.isArray(ad.lifecycleReasons) ? ad.lifecycleReasons.join(' | ') : '';
    const queries = Array.isArray(ad.matchedQueries) ? ad.matchedQueries.join(', ') : '';
    const categories = Array.isArray(ad.matchedCategories) ? ad.matchedCategories.join(', ') : '';
    const seeds = Array.isArray(ad.matchedSeeds) ? ad.matchedSeeds.join(', ') : '';
    const relevanceStatus = normalizeRelevanceStatus(ad.relevanceStatus);
    const relevanceSource = ad.relevanceSource || 'MR04';
    const relevanceLabel = RELEVANCE_LABELS[relevanceStatus] || relevanceStatus;
    const mr04Confidence = Number.isFinite(Number(ad.mr04Confidence)) ? `${ad.mr04Confidence}%` : '—';
    const mr04Reason = ad.mr04Reason || ad.mr04ReasonCode || '—';
    const mr05Confidence = Number.isFinite(Number(ad.mr05Confidence)) ? `${ad.mr05Confidence}%` : '—';
    const mr05Reason = ad.mr05Reason || ad.mr05ReasonCode || '—';
    const allowRestore = ad.manualOverride && (ad.mr05Decision || ad.mr04Decision);

    const snapshotUrl = ad.adLibraryUrl || ad.adSnapshotUrl;
    const snapshotCell = snapshotUrl
      ? `<a href="${escapeHtml(snapshotUrl)}" target="_blank" rel="noopener noreferrer">Otworz reklame w Meta</a>`
      : '—';

    return `
      <tr>
        <td>
          <div class="ad-row-card">
            <div class="meta-inline-controls">
              <span class="relevance-badge ${relevanceBadgeClass(relevanceStatus)}">Relevance: ${escapeHtml(relevanceLabel)}</span>
              <button class="secondary ad-details-btn" type="button" data-ad-archive-id="${escapeHtml(ad.adArchiveId || '')}">SZCZEGÓŁY</button>
              <select class="ad-relevance-select" data-ad-archive-id="${escapeHtml(ad.adArchiveId || '')}" ${ad.adArchiveId ? '' : 'disabled'}>
                <option value="KEEP" ${relevanceStatus === 'KEEP' ? 'selected' : ''}>KEEP</option>
                <option value="POTENTIAL" ${relevanceStatus === 'POTENTIAL' ? 'selected' : ''}>POTENCJALNE</option>
                <option value="REJECT" ${relevanceStatus === 'REJECT' ? 'selected' : ''}>SMIEC</option>
              </select>
              ${allowRestore ? `<button class="secondary ad-relevance-restore" data-ad-archive-id="${escapeHtml(ad.adArchiveId || '')}">PRZYWRÓĆ AUTOMAT</button>` : ''}
            </div>
            <div class="ad-row-meta" title="${escapeHtml(reasons)}">
              <span><strong>Źródło:</strong> ${escapeHtml(relevanceSource)}${ad.manualOverride ? ' (ręczna zmiana)' : ''}</span>
              <span><strong>Filtrowanie (MR04):</strong> ${escapeHtml(ad.mr04Decision || '—')} / ${escapeHtml(mr04Confidence)}</span>
              <span><strong>Powód filtrowania:</strong> ${escapeHtml(mr04Reason)}</span>
              <span><strong>Drugi przebieg (MR05):</strong> ${escapeHtml(ad.mr05Decision || '—')} / ${escapeHtml(mr05Confidence)}</span>
              <span><strong>Powód drugiego przebiegu:</strong> ${escapeHtml(mr05Reason)}</span>
              <span><strong>Strona:</strong> ${escapeHtml(ad.pageName || ad.pageId || '—')}</span>
              <span><strong>Start:</strong> ${escapeHtml(formatDateTime(ad.startDate || ad.adDeliveryStartTime))}</span>
              <span><strong>Koniec:</strong> ${escapeHtml(formatDateTime(ad.endDate || ad.adDeliveryStopTime))}</span>
              <span><strong>Status:</strong> ${ad.isActive ? 'aktywna' : 'zakończona'}</span>
              <span><strong>Polubienia:</strong> ${escapeHtml(ad.pageLikeCount ?? '—')}</span>
              <span><strong>Cykl życia:</strong> ${escapeHtml(lifecycle)} (${escapeHtml(confidence)})</span>
              <span><strong>Dopasowanie treści:</strong> ${ad.visibleTextMatch == null ? 'N/D' : (ad.visibleTextMatch ? 'TAK' : 'NIE')}</span>
              <span><strong>Zasięg UE:</strong> ${escapeHtml(ad.euTotalReach ?? '—')}</span>
              <span><strong>Zapytanie:</strong> ${escapeHtml(queries || '—')}</span>
              <span><strong>Kategorie:</strong> ${escapeHtml(categories || '—')}</span>
              <span><strong>Seedy:</strong> ${escapeHtml(seeds || '—')}</span>
              <span><strong>Pierwszy zapis:</strong> ${escapeHtml(formatDateTime(ad.firstSeenAt))}</span>
              <span><strong>Ostatni zapis:</strong> ${escapeHtml(formatDateTime(ad.lastSeenAt))}</span>
              <span>${snapshotCell}</span>
            </div>
            <div class="ad-row-content">
              ${titlePreview ? `<div class="title">${escapeHtml(titlePreview)}</div>` : ''}
              ${escapeHtml(bodyPreview || '—')}
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (append) {
    $('metaAdsBody').insertAdjacentHTML('beforeend', rowsHtml);
  } else {
    $('metaAdsBody').innerHTML = rowsHtml;
  }
}

function escapeCsv(value) {
  const text = String(value ?? '');
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function downloadCsvFile(fileNamePrefix, headers, rows) {
  const content = [headers.map(escapeCsv).join(','), ...rows.map(row => row.map(escapeCsv).join(','))].join('\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileNamePrefix}-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportMetaAdsFullCsv(sourceAds = currentMetaAds) {
  const ads = prepareAdsForFamilyCsv(sourceAds);
  if (!ads.length) return;

  const headers = [
    'family_id',
    'family_class',
    'family_status',
    'family_confidence',
    'family_reason',
    'family_patterns',
    'family_ads_count',
    'family_active_ads_count',
    'family_span_days',
    'family_covered_delivery_days',
    'relationship_to_previous',
    'previous_ad_id',
    'offer_match_confidence',
    'offer_match_reasons',
    'ad_archive_id',
    'page_name',
    'page_id',
    'page_like_count',
    'title',
    'body',
    'destination_url',
    'canonical_url',
    'ad_library_url',
    'start_date',
    'end_date',
    'duration_days',
    'is_active',
    'individual_lifecycle',
    'display_format',
    'cta_type',
    'publisher_platform',
    'collation_id',
    'collation_count',
    'matched_query',
    'matched_seed',
  ];

  const rows = [];
  for (const ad of ads) {
    const lifecycle = LIFECYCLE_LABELS[ad.longevityCategory || ad.lifecycleClass] || ad.longevityCategory || ad.lifecycleClass || '';
    rows.push([
      ad.familyId || '',
      ad.familyClass || 'UNCLASSIFIED',
      ad.familyStatus || 'UNKNOWN',
      ad.familyConfidence ?? '',
      ad.familyReason || '',
      Array.isArray(ad.familyPatterns) ? ad.familyPatterns.join(' | ') : '',
      ad.familyAdsCount ?? '',
      ad.familyActiveAdsCount ?? '',
      ad.familyCalendarSpanDays ?? '',
      ad.familyCoveredDeliveryDays ?? '',
      ad.relationshipToPrevious || '',
      ad.previousAdId || '',
      ad.offerMatchConfidence ?? '',
      Array.isArray(ad.offerMatchReasons) ? ad.offerMatchReasons.join(' | ') : '',
      ad.adArchiveId || '',
      ad.pageName || '',
      ad.pageId || '',
      ad.pageLikeCount ?? '',
      ad.title || (ad.creativeLinkTitles && ad.creativeLinkTitles[0]) || '(bez tytulu)',
      ad.bodyText || (ad.creativeBodies && ad.creativeBodies[0]) || '',
      ad.destinationUrl || '',
      ad.canonicalUrl || '',
      ad.adLibraryUrl || ad.adSnapshotUrl || '',
      ad.startDate || ad.adDeliveryStartTime || '',
      ad.endDate || ad.adDeliveryStopTime || '',
      ad.runtimeDays ?? '',
      ad.isActive ? '1' : '0',
      lifecycle,
      ad.displayFormat || '',
      ad.ctaType || '',
      Array.isArray(ad.publisherPlatforms) ? ad.publisherPlatforms.join(' | ') : '',
      ad.collationId || '',
      ad.collationCount ?? '',
      Array.isArray(ad.matchedQueries) ? ad.matchedQueries.join(' | ') : '',
      Array.isArray(ad.matchedSeeds) ? ad.matchedSeeds.join(' | ') : '',
    ]);

    rows.push(['====', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  }

  downloadCsvFile('meta-ads-full', headers, rows);
}

function exportMetaAdsShortCsv(sourceAds = currentMetaAds) {
  const ads = prepareAdsForFamilyCsv(sourceAds);
  if (!ads.length) return;

  const headers = ['title', 'link', 'like', 'reason', 'page', 'description'];
  const rows = [];

  for (const ad of ads) {
    const title = ad.title
      || (ad.creativeLinkTitles && ad.creativeLinkTitles[0])
      || (ad.bodyText ? `${String(ad.bodyText).slice(0, 60)}...` : '(bez tytulu)');

    const link = ad.destinationUrl || ad.adLibraryUrl || ad.adSnapshotUrl || '';
    const reason = ad.familyReason || buildFallbackReason(ad);
    const description = buildShortDescription(ad.bodyText || (ad.creativeBodies && ad.creativeBodies[0]) || '');

    rows.push([
      title,
      link,
      ad.pageLikeCount ?? '',
      reason,
      ad.pageName || '',
      description,
    ]);

    rows.push(['====', '', '', '', '', '']);
  }

  downloadCsvFile('meta-ads-short', headers, rows);
}

async function fetchAllMetaAdsForExport() {
  if (!currentMetaResearchRun?.id) return [];

  const collected = [];
  let offset = 0;
  let hasMore = true;
  let knownTotal = null;

  while (hasMore) {
    const params = new URLSearchParams(buildMetaAdsQueryString());
    params.set('limit', '100');
    params.set('offset', String(offset));
    params.set('includeMeta', '0');
    if (knownTotal != null) params.set('knownTotal', String(knownTotal));
    const res = await fetch(`/api/meta-research/${encodeURIComponent(currentMetaResearchRun.id)}/ads?${params.toString()}`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    const page = Array.isArray(payload.ads) ? payload.ads : [];
    collected.push(...page);
    knownTotal = Number(payload.pagination?.total ?? collected.length);
    offset = Number(payload.pagination?.nextOffset ?? offset + page.length);
    hasMore = Boolean(payload.pagination?.hasMore) && page.length > 0;
    $('metaActionStatus').innerHTML = `<div class="loading-inline"><span class="loading-spinner"></span><span>Przygotowanie CSV: ${collected.length} / ${Number(payload.pagination?.total ?? collected.length)}</span></div>`;
  }

  return collected;
}

async function downloadAllMetaAdsCsv(kind) {
  const fullButton = $('metaExportFullCsvBtn');
  const shortButton = $('metaExportShortCsvBtn');
  fullButton.disabled = true;
  shortButton.disabled = true;

  try {
    const ads = await fetchAllMetaAdsForExport();
    if (!ads.length) throw new Error('Brak reklam do eksportu.');
    if (kind === 'full') exportMetaAdsFullCsv(ads);
    else exportMetaAdsShortCsv(ads);
    $('metaActionStatus').textContent = `Gotowe: wyeksportowano ${ads.length} reklam.`;
  } catch (error) {
    $('metaActionStatus').textContent = `BŁĄD eksportu CSV: ${error.message}`;
  } finally {
    const enabled = metaAdsTotal > 0;
    fullButton.disabled = !enabled;
    shortButton.disabled = !enabled;
  }
}

function buildMetaAdsQueryString() {
  const params = new URLSearchParams();

  const relevance = $('metaFilterRelevance').value;
  const query = $('metaFilterQuery').value.trim();
  const seed = $('metaFilterSeed').value.trim();
  const page = $('metaFilterPage').value.trim();
  const selectedLifecycles = getSelectedLifecycleFilters();
  const visible = $('metaFilterVisible').value;
  const active = $('metaFilterActive').value;
  const minReach = $('metaFilterMinReach').value.trim();
  const startDate = $('metaFilterStartDate').value;
  const sortBy = $('metaSortBy').value;
  const familyFilters = getSelectedFamilyFilters();

  if (relevance && relevance !== 'ALL') params.set('relevance', relevance);
  if (query) params.set('query', query);
  if (seed) params.set('seed', seed);
  if (page) params.set('page', page);
  if (!selectedLifecycles.length) {
    params.set('lifecycle', '__NONE__');
  } else if (selectedLifecycles.length !== LIFECYCLE_FILTER_VALUES.length) {
    params.set('lifecycles', selectedLifecycles.join(','));
  }
  if (visible && visible !== 'ALL') params.set('visible', visible);
  if (active && active !== 'ALL') params.set('active', active);
  if (minReach) params.set('minReach', minReach);
  if (startDate) params.set('startDate', startDate);
  if (sortBy) params.set('sortBy', sortBy);
  if (familyFilters.familyClass && familyFilters.familyClass !== 'ALL') params.set('familyClass', familyFilters.familyClass);
  if (familyFilters.familyStatus && familyFilters.familyStatus !== 'ALL') params.set('familyStatus', familyFilters.familyStatus);
  if (familyFilters.familyPattern && familyFilters.familyPattern !== 'ALL') params.set('familyPattern', familyFilters.familyPattern);

  return params.toString();
}

function setMetaAdsInfiniteStatus(message, { loading = false } = {}) {
  const status = $('metaAdsInfiniteStatus');
  if (!status) return;
  status.innerHTML = loading
    ? `<span class="loading-spinner"></span><span>${escapeHtml(message)}</span>`
    : `<span>${escapeHtml(message)}</span>`;
}

function ensureMetaAdsInfiniteObserver() {
  if (metaAdsInfiniteObserver || !$('metaAdsInfiniteStatus')) return;

  metaAdsInfiniteObserver = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    if (!metaAdsHasMore || metaAdsLoading) return;
    loadMetaResearchAds({ append: true });
  }, {
    root: null,
    rootMargin: '500px 0px',
    threshold: 0,
  });

  metaAdsInfiniteObserver.observe($('metaAdsInfiniteStatus'));
}

function buildOfferFamiliesQueryString() {
  const params = new URLSearchParams();
  const familyFilters = getSelectedFamilyFilters();
  if (familyFilters.familyClass !== 'ALL') params.set('familyClass', familyFilters.familyClass);
  if (familyFilters.familyStatus !== 'ALL') params.set('familyStatus', familyFilters.familyStatus);
  if (familyFilters.familyPattern !== 'ALL') params.set('familyPattern', familyFilters.familyPattern);
  return params.toString();
}

async function loadOfferFamilies({ force = false } = {}) {
  if (!currentMetaResearchRun?.id) return;

  const qs = buildOfferFamiliesQueryString();
  const cacheKey = `${currentMetaResearchRun.id}?${qs}`;
  if (!force && offerFamiliesLoadedForRunId === cacheKey) return;

  $('offerFamilyLoadHint').innerHTML = '<span class="loading-inline"><span class="loading-spinner"></span>Ładowanie…</span>';
  $('offerFamilyList').innerHTML = '<div class="loading-inline"><span class="loading-spinner"></span><span>Pobieranie rodzin ofert…</span></div>';

  try {
    const url = `/api/meta-research/${encodeURIComponent(currentMetaResearchRun.id)}/offer-families${qs ? `?${qs}` : ''}`;
    const res = await fetch(url);
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    currentOfferFamilies = Array.isArray(payload.families) ? payload.families : [];
    offerFamiliesLoadedForRunId = cacheKey;
    $('offerFamilyLoadHint').textContent = `${currentOfferFamilies.length} rodzin · Timeline dostępny przy każdej rodzinie`;
    renderOfferFamilies(currentOfferFamilies);
  } catch (error) {
    offerFamiliesLoadedForRunId = null;
    currentOfferFamilies = [];
    $('offerFamilyLoadHint').textContent = 'Nie udało się pobrać';
    $('offerFamilyList').innerHTML = `<div class="bad">BŁĄD: ${escapeHtml(error.message)}</div>`;
  }
}

async function loadMetaResearchAds({ append = false } = {}) {
  ensureMetaAdsInfiniteObserver();

  if (!currentMetaResearchRun?.id) {
    $('metaAdsBody').innerHTML = '<tr><td colspan="1" class="muted">Brak danych.</td></tr>';
    $('metaExportFullCsvBtn').disabled = true;
    $('metaExportShortCsvBtn').disabled = true;
    currentMetaAds = [];
    currentOfferFamilies = [];
    metaAdsNextOffset = 0;
    metaAdsTotal = 0;
    metaAdsHasMore = false;
    offerFamiliesLoadedForRunId = null;
    renderMetaRelevanceSummary(null);
    applyMetaLifecycleFilterOptionLabels(null);
    renderOfferFamilies([]);
    setMetaAdsInfiniteStatus('Brak reklam do wyświetlenia.');
    return;
  }

  if (append && (metaAdsLoading || !metaAdsHasMore)) return;

  const requestSerial = append ? metaAdsRequestSerial : ++metaAdsRequestSerial;
  const offset = append ? metaAdsNextOffset : 0;
  metaAdsLoading = true;

  if (append) {
    setMetaAdsInfiniteStatus(`Pobieranie kolejnych ${META_ADS_PAGE_SIZE} reklam…`, { loading: true });
  } else {
    currentMetaAds = [];
    metaAdsNextOffset = 0;
    metaAdsTotal = 0;
    metaAdsHasMore = false;
    offerFamiliesLoadedForRunId = null;
    currentOfferFamilies = [];
    $('offerFamilySummary').textContent = 'Rodziny: rozwiń sekcję, aby załadować.';
    window.DemandRadarTimeline?.setFamilies([]);
    $('metaAdsBody').innerHTML = '<tr><td><div class="loading-inline"><span class="loading-spinner"></span><span>Ładowanie pierwszych 20 reklam i statystyk…</span></div></td></tr>';
    setMetaAdsInfiniteStatus('Przygotowywanie wyników…', { loading: true });
  }

  const params = new URLSearchParams(buildMetaAdsQueryString());
  params.set('limit', String(META_ADS_PAGE_SIZE));
  params.set('offset', String(offset));
  params.set('includeMeta', append ? '0' : '1');
  if (append) params.set('knownTotal', String(metaAdsTotal));
  const url = `/api/meta-research/${encodeURIComponent(currentMetaResearchRun.id)}/ads?${params.toString()}`;

  try {
    const res = await fetch(url);
    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    if (requestSerial !== metaAdsRequestSerial) return;

    const nextAds = Array.isArray(payload.ads) ? payload.ads : [];
    currentMetaAds = append ? [...currentMetaAds, ...nextAds] : nextAds;
    metaAdsNextOffset = Number(payload.pagination?.nextOffset ?? currentMetaAds.length);
    metaAdsTotal = Number(payload.pagination?.total ?? currentMetaAds.length);
    metaAdsHasMore = Boolean(payload.pagination?.hasMore);

    renderMetaAdsTable(nextAds, { append });
    const hasExportRows = metaAdsTotal > 0;
    $('metaExportFullCsvBtn').disabled = !hasExportRows;
    $('metaExportShortCsvBtn').disabled = !hasExportRows;

    if (!append) {
      renderMetaRelevanceSummary(payload.relevanceSummary || null);
      applyMetaLifecycleFilterOptionLabels(payload.lifecycleSummary || null);
      if ($('offerFamilySection').open) {
        await loadOfferFamilies({ force: true });
      } else {
        $('offerFamilyLoadHint').textContent = 'Rozwiń, aby pobrać rodziny i Timeline';
        $('offerFamilyList').innerHTML = '<div class="muted">Rodziny nie zostały jeszcze pobrane.</div>';
      }
      await refreshAllRelevancePendingCounts();
      await restorePersistedRelevanceProgress();
    }

    if (metaAdsHasMore) {
      setMetaAdsInfiniteStatus(`Wyświetlono ${currentMetaAds.length} z ${metaAdsTotal}. Przewiń niżej, aby pobrać kolejne 20.`);
    } else {
      setMetaAdsInfiniteStatus(metaAdsTotal
        ? `Wyświetlono wszystkie ${metaAdsTotal} reklam.`
        : 'Brak reklam dla wybranych filtrów.');
    }
  } catch (error) {
    if (requestSerial !== metaAdsRequestSerial) return;
    if (!append) {
      currentMetaAds = [];
      metaAdsNextOffset = 0;
      metaAdsTotal = 0;
      metaAdsHasMore = false;
      $('metaExportFullCsvBtn').disabled = true;
      $('metaExportShortCsvBtn').disabled = true;
      renderMetaRelevanceSummary(null);
      applyMetaLifecycleFilterOptionLabels(null);
      $('metaAdsBody').innerHTML = `<tr><td colspan="1" class="bad">BŁĄD: ${escapeHtml(error.message)}</td></tr>`;
    }
    setMetaAdsInfiniteStatus(`Nie udało się pobrać wyników: ${error.message}`);
  } finally {
    if (requestSerial === metaAdsRequestSerial) {
      metaAdsLoading = false;
    }
  }
}


async function loadMetaResearchRun(runId) {
  $('metaResearchStatus').innerHTML = '<span class="loading-inline"><span class="loading-spinner"></span><span>Odświeżanie stanu badania…</span></span>';
  try {
    const res = await fetch(`/api/meta-research/${encodeURIComponent(runId)}`);
    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    currentMetaResearchRun = payload.run;
    renderMetaResearchSummary(currentMetaResearchRun);
    await loadMetaResearchAds();

    const isRunning = currentMetaResearchRun.status === 'PENDING' || currentMetaResearchRun.status === 'RUNNING';
    if (!isRunning) {
      stopMetaResearchPolling();
    }
  } catch (error) {
    $('metaResearchStatus').textContent = `BLAD run status: ${error.message}`;
  }
}

async function refreshLatestMetaResearchForProject() {
  const active = getActiveQueryPlanProject();
  $('metaResearchStatus').innerHTML = '<span class="loading-inline"><span class="loading-spinner"></span><span>Wczytywanie badania i statystyk z bazy…</span></span>';
  $('metaAdsBody').innerHTML = '<tr><td><div class="loading-inline"><span class="loading-spinner"></span><span>Wczytywanie reklam…</span></div></td></tr>';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(active.projectId)}/meta-research/latest`);
    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    currentMetaResearchRun = payload.run;
    renderMetaResearchSummary(currentMetaResearchRun);

    if (currentMetaResearchRun?.id) {
      await loadMetaResearchAds();

      const isRunning = currentMetaResearchRun.status === 'PENDING' || currentMetaResearchRun.status === 'RUNNING';
      if (isRunning) {
        stopMetaResearchPolling();
        metaResearchPollHandle = setInterval(() => loadMetaResearchRun(currentMetaResearchRun.id), 4000);
      } else {
        stopMetaResearchPolling();
      }
    } else {
      $('metaResearchStatus').textContent = `Brak badania dla projektu: ${active.name} (${active.projectId}).`;
    }
  } catch (error) {
    currentMetaResearchRun = null;
    renderMetaResearchSummary(null);
    $('metaResearchStatus').innerHTML = `<span class="bad">BŁĄD wczytywania projektu ${escapeHtml(active.name)} (${escapeHtml(active.projectId)}): ${escapeHtml(error.message)}</span>`;
    $('metaAdsBody').innerHTML = `<tr><td class="bad">Nie udało się pobrać wyników: ${escapeHtml(error.message)}</td></tr>`;
    setMetaAdsInfiniteStatus(`Nie udało się pobrać wyników: ${error.message}`);
  }
}

async function refreshLatestMetaResearchStatusForProject() {
  const active = getActiveQueryPlanProject();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(active.projectId)}/meta-research/latest`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    currentMetaResearchRun = payload.run;
    renderMetaResearchSummary(currentMetaResearchRun);
    return currentMetaResearchRun;
  } catch {
    currentMetaResearchRun = null;
    renderMetaResearchSummary(null);
    return null;
  }
}

async function refreshRelevancePendingCount(stage) {
  const ui = relevanceStageUi(stage);
  const baseLabel = ui.buttonLabel;
  if (!currentMetaResearchRun?.projectId) {
    $(ui.buttonId).textContent = baseLabel;
    return 0;
  }

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentMetaResearchRun.projectId)}/${ui.pendingUrl}`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    const pending = Number(payload.pending || 0);
    $(ui.buttonId).textContent = `${baseLabel} (${pending})`;
    return pending;
  } catch {
    $(ui.buttonId).textContent = baseLabel;
    return 0;
  }
}

async function refreshAllRelevancePendingCounts() {
  await Promise.all([
    refreshRelevancePendingCount('MR04'),
    refreshRelevancePendingCount('MR05'),
  ]);
}

async function runMetaRelevanceStage(stage, { modeOverride = null } = {}) {
  if (!currentMetaResearchRun?.projectId || metaRelevanceBusy) return;
  const ui = relevanceStageUi(stage);
  const statusElement = $(ui.statusId);
  const mode = modeOverride || $('mode').value;
  const batchSize = getRelevanceBatchSize();

  $('metaActionStatus').textContent = '';
  metaRelevanceBusy = true;
  $('metaRunRelevanceBtn').disabled = true;
  $('metaRunMr05Btn').disabled = true;

  try {
    const pending = await refreshRelevancePendingCount(ui.stage);
    if (!pending) {
      statusElement.textContent = `Brak reklam wymagających procesu: ${ui.processLabel}.`;
      return;
    }

    const preparationText = mode === 'test'
      ? `Przygotowanie jednej paczki testowej — maks. ${Math.min(pending, batchSize)} reklam…`
      : `Przygotowanie ${pending} reklam — po ${batchSize} w paczce…`;
    statusElement.innerHTML = `<div class="loading-inline"><span class="loading-spinner"></span><span>${escapeHtml(ui.processLabel)}: ${escapeHtml(preparationText)}</span></div>`;
    const runRes = await fetch(`/api/projects/${encodeURIComponent(currentMetaResearchRun.projectId)}/${ui.runUrl}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false, mode, batchSize }),
    });
    const runPayload = await runRes.json();

    if (!runRes.ok || !runPayload.ok) {
      throw new Error(runPayload.error || `HTTP ${runRes.status}`);
    }
    if (!runPayload.started) {
      statusElement.textContent = runPayload.message || `Brak reklam wymagających procesu: ${ui.processLabel}.`;
      return;
    }

    const result = await waitForRelevanceCompletion(ui.stage);
    if (result.paused) {
      $('metaActionStatus').textContent = `${ui.processLabel} zatrzymano bez utraty zapisanych paczek. Użyj przycisku WZNÓW, aby przetworzyć pozostałe reklamy.`;
    } else {
      const modeLabel = mode === 'test' ? 'Test jednej paczki zakończony' : `${ui.processLabel} zakończono`;
      $('metaActionStatus').textContent = `${modeLabel}: KEEP ${result.keep || 0}, POTENCJALNE ${result.potential || 0}, ODRZUCONE ${result.reject || 0}.`;
    }
    await loadMetaResearchAds();
  } catch (error) {
    await refreshRelevanceProgress(ui.stage, { refreshStats: true });
    $('metaActionStatus').textContent = `BŁĄD — ${ui.processLabel}: ${error.message} Zapisane paczki pozostały w bazie. Użyj przycisku WZNÓW, aby kontynuować.`;
    await refreshMetaStatsOnly().catch(() => {});
  } finally {
    metaRelevanceBusy = false;
    const researchRunning = currentMetaResearchRun?.status === 'PENDING' || currentMetaResearchRun?.status === 'RUNNING';
    $('metaRunRelevanceBtn').disabled = researchRunning;
    $('metaRunMr05Btn').disabled = researchRunning;
    await refreshAllRelevancePendingCounts();
  }
}

function runMetaRelevanceFilter() {
  return runMetaRelevanceStage('MR04');
}

function runMr05RelevanceFilter() {
  return runMetaRelevanceStage('MR05');
}

async function stopMetaRelevanceStage(stage) {
  if (!currentMetaResearchRun?.projectId) return;
  const ui = relevanceStageUi(stage);
  const progress = relevanceProgressByStage[ui.stage];
  if (progress?.mode !== 'production') {
    $('metaActionStatus').textContent = 'Zatrzymywanie jest dostępne dla trybu produkcyjnego. Test zawsze wysyła tylko jedną paczkę.';
    return;
  }

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentMetaResearchRun.projectId)}/${ui.stopUrl}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    $('metaActionStatus').textContent = `${ui.processLabel}: zatrzymanie zlecone. Bieżąca paczka zostanie najpierw zapisana.`;
    await refreshRelevanceProgress(ui.stage, { refreshStats: true });
    startRelevanceProgressPolling(ui.stage);
  } catch (error) {
    $('metaActionStatus').textContent = `Nie udało się zatrzymać procesu ${ui.processLabel}: ${error.message}`;
  }
}

async function resumeMetaRelevanceStage(stage) {
  const ui = relevanceStageUi(stage);
  const previousMode = relevanceProgressByStage[ui.stage]?.mode;
  for (let attempt = 0; attempt < 12 && metaRelevanceBusy; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (metaRelevanceBusy) {
    $('metaActionStatus').textContent = 'Proces właśnie kończy zatrzymywanie. Spróbuj ponownie za chwilę.';
    return;
  }
  return runMetaRelevanceStage(ui.stage, {
    modeOverride: previousMode === 'test' ? 'test' : 'production',
  });
}

function handleRelevanceProgressAction(event) {
  const stopButton = event.target.closest('[data-relevance-stop]');
  if (stopButton) {
    stopButton.disabled = true;
    stopMetaRelevanceStage(stopButton.dataset.relevanceStop);
    return;
  }

  const resumeButton = event.target.closest('[data-relevance-resume]');
  if (resumeButton) {
    resumeButton.disabled = true;
    resumeMetaRelevanceStage(resumeButton.dataset.relevanceResume);
  }
}

async function setManualAdRelevance(adArchiveId, relevanceStatus) {
  if (!currentMetaResearchRun?.projectId) return;

  const res = await fetch(`/api/projects/${encodeURIComponent(currentMetaResearchRun.projectId)}/ads/${encodeURIComponent(adArchiveId)}/relevance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relevanceStatus }),
  });

  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
}

async function restoreAdRelevanceFromMr04(adArchiveId) {
  if (!currentMetaResearchRun?.projectId) return;

  const res = await fetch(`/api/projects/${encodeURIComponent(currentMetaResearchRun.projectId)}/ads/${encodeURIComponent(adArchiveId)}/relevance/restore-mr04`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
}

async function restoreAllAdRelevanceFromMr04() {
  if (!currentMetaResearchRun?.projectId) return 0;

  const projectId = currentMetaResearchRun.projectId;
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/ads/relevance/restore-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  if (!payload.started) return payload.restored || 0;

  while (true) {
    const progressRes = await fetch(`/api/projects/${encodeURIComponent(projectId)}/ads/relevance/restore-progress`);
    const progressPayload = await progressRes.json();
    if (!progressRes.ok || !progressPayload.ok) {
      throw new Error(progressPayload.error || `HTTP ${progressRes.status}`);
    }

    const progress = progressPayload.progress || {};
    const percent = Number(progress.percent || 0);
    $('metaActionStatus').innerHTML = `
      <div class="relevance-progress">
        <strong>Cofanie automatycznej segregacji (MR04/MR05)</strong>
        <span>${escapeHtml(progress.restored || 0)} / ${escapeHtml(progress.total || payload.total)} reklam · ${escapeHtml(percent)}%</span>
        <div class="relevance-progress-track"><div class="relevance-progress-fill" style="width:${Math.min(100, percent)}%"></div></div>
      </div>
    `;

    if (progress.status === 'COMPLETED') return Number(progress.restored || 0);
    if (progress.status === 'FAILED') throw new Error(progress.error || 'Nie udało się cofnąć automatycznej segregacji.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
