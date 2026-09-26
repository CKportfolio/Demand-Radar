for (const tabButton of document.querySelectorAll('.tab-btn')) {
  tabButton.addEventListener('click', () => setActiveTab(tabButton.dataset.tab));
}

$('seedTableBody').addEventListener('change', event => {
  const target = event.target;
  const seedId = target.dataset.seedId;
  if (!seedId) return;

  if (target.classList.contains('seed-enabled')) {
    updateSeed(seedId, { enabled: target.checked });
  } else if (target.classList.contains('seed-priority')) {
    updateSeed(seedId, { priority: target.value });
  }
});

$('seedTableBody').addEventListener('input', event => {
  const target = event.target;
  const seedId = target.dataset.seedId;
  if (!seedId) return;

  const seed = findSeed(seedId);
  if (!seed) return;

  if (target.classList.contains('seed-query')) {
    seed.query = target.value;
  } else if (target.classList.contains('seed-rationale')) {
    seed.rationale = target.value;
  } else {
    return;
  }

  markPlanDirty('MANUAL_REVISION');
  $('currentPlanOutput').textContent = JSON.stringify(currentPlan, null, 2);
  const check = basicContractCheck(currentPlan);
  setContract(check);
  $('reviseBtn').disabled = !check.ok;
});

$('seedTableBody').addEventListener('click', event => {
  if (!event.target.classList.contains('seed-delete')) return;
  deleteSeed(event.target.dataset.seedId);
});

$('addSeedBtn').addEventListener('click', createUserSeed);

$('enableAllSeedsBtn').addEventListener('click', () => {
  if (!currentPlan?.seedQueries) return;
  currentPlan.seedQueries.forEach(seed => { seed.enabled = true; });
  markPlanDirty('MANUAL_REVISION');
  syncPlanViews();
});

$('disableAllSeedsBtn').addEventListener('click', () => {
  if (!currentPlan?.seedQueries) return;
  currentPlan.seedQueries.forEach(seed => { seed.enabled = false; });
  markPlanDirty('MANUAL_REVISION');
  syncPlanViews();
});

$('copyEnabledSeedsBtn').addEventListener('click', async () => {
  if (!currentPlan?.seedQueries) return;
  const enabled = currentPlan.seedQueries.filter(seed => seed.enabled);
  await navigator.clipboard.writeText(JSON.stringify(enabled, null, 2));
  const old = $('copyEnabledSeedsBtn').textContent;
  $('copyEnabledSeedsBtn').textContent = `Skopiowano ${enabled.length}`;
  setTimeout(() => { $('copyEnabledSeedsBtn').textContent = old; }, 1000);
});

$('generateBtn').addEventListener('click', async () => {
  $('saveResult').textContent = '';
  $('saveError').textContent = '';

  const requestId = uuid();
  $('requestIdText').textContent = requestId;

  const payload = {
    requestId,
    projectId,
    brief: collectBriefFromForm(),
    availableDiscoveryCapabilities: capabilities(),
  };

  try {
    const { plan } = await callWorkflow('/api/mr01', payload);
    if (plan) {
      conversation = [];
      revisionNumber = 0;
      setCurrentPlan(plan, {
        sourceLabel: 'Generowanie planu odkrywania (MR01)',
        origin: 'LLM_GENERATION',
        persistedVersionId: null,
        persistedVersionNumber: null,
        dirty: true,
        addHistory: true,
      });
      setWorkbenchStage('mr02');
    }
  } catch (error) {
    $('output').textContent = error.stack || error.message;
    setContract({ ok: false, reason: error.message });
  }
});

$('reviseBtn').addEventListener('click', async () => {
  $('saveResult').textContent = '';
  $('saveError').textContent = '';

  if (!currentPlan) return;

  const instruction = $('instruction').value.trim();
  if (!instruction) return;

  const requestId = uuid();
  $('requestIdText').textContent = requestId;

  const payload = {
    requestId,
    projectId,
    currentPlan,
    userInstruction: instruction,
    recentConversation: conversation.slice(-8),
    availableDiscoveryCapabilities: capabilities(),
  };

  try {
    const { plan } = await callWorkflow('/api/mr02', payload);

    if (plan) {
      conversation.push({ role: 'user', content: instruction });
      conversation.push({ role: 'assistant', content: plan.changeSummary || 'Plan revised.' });

      setCurrentPlan(plan, {
        sourceLabel: 'Rozmowa i korekta planu (MR02)',
        origin: 'LLM_REVISION',
        dirty: true,
        addHistory: true,
      });
    }
  } catch (error) {
    $('output').textContent = error.stack || error.message;
    setContract({ ok: false, reason: error.message });
  }
});

$('newProjectBtn').addEventListener('click', () => {
  projectId = uuid();
  localStorage.setItem('marketRadarProjectId', projectId);
  $('projectIdText').textContent = projectId;

  currentPlan = null;
  currentPlanOrigin = null;
  currentPersistedVersionId = null;
  currentPersistedVersionNumber = null;
  currentPlanDirty = false;

  conversation = [];
  revisionNumber = 0;

  syncPlanViews();
  setWorkbenchStage('mr01');

  $('planStateText').textContent = 'Najpierw użyj Generowania planu odkrywania (MR01).';
  $('history').className = 'muted';
  $('history').textContent = 'Brak.';
  $('versionPreview').textContent = 'Kliknij POKAZ przy wybranej wersji.';
});

$('clearPlanBtn').addEventListener('click', () => {
  currentPlan = null;
  currentPlanOrigin = null;
  currentPlanDirty = false;
  conversation = [];
  revisionNumber = 0;
  syncPlanViews();
  setWorkbenchStage('mr01');
  $('planStateText').textContent = 'currentPlan wyczyszczony.';
});

$('loadPlanBtn').addEventListener('click', () => {
  try {
    const value = JSON.parse($('manualPlan').value);
    const check = basicContractCheck(value);
    setContract(check);
    if (!check.ok) throw new Error(check.reason);

    setCurrentPlan(value, {
      sourceLabel: 'manual JSON load',
      origin: 'MANUAL_REVISION',
      dirty: true,
      addHistory: true,
    });
    setWorkbenchStage('mr02');
  } catch (error) {
    setContract({ ok: false, reason: `Nie mozna wczytac planu: ${error.message}` });
  }
});

$('copyBtn').addEventListener('click', async () => {
  if (lastResponseData == null) return;
  await navigator.clipboard.writeText(JSON.stringify(lastResponseData, null, 2));
  const old = $('copyBtn').textContent;
  $('copyBtn').textContent = 'Skopiowano';
  setTimeout(() => { $('copyBtn').textContent = old; }, 900);
});

$('saveProjectBtn').addEventListener('click', saveCurrentProject);

$('refreshProjectsBtn').addEventListener('click', refreshProjects);

$('savedProjectsBody').addEventListener('click', event => {
  const button = event.target.closest('.open-project-btn');
  if (button) {
    openProject(button.dataset.projectId);
    return;
  }

  const deleteButton = event.target.closest('.delete-project-btn');
  if (deleteButton) {
    deleteSavedProject(deleteButton.dataset.projectId).catch(error => {
      alert(`Błąd usuwania projektu: ${error.message}`);
    });
  }
});

$('loadLatestProjectBtn').addEventListener('click', () => {
  const versionId = $('loadLatestProjectBtn').dataset.versionId;
  if (versionId) loadVersionIntoWorkbench(versionId);
});

$('deleteProjectBtn').addEventListener('click', () => {
  const projectIdToDelete = $('deleteProjectBtn').dataset.projectId;
  if (!projectIdToDelete) return;
  deleteSavedProject(projectIdToDelete).catch(error => {
    alert(`Błąd usuwania projektu: ${error.message}`);
  });
});

$('selectedProjectVersions').addEventListener('click', event => {
  const previewBtn = event.target.closest('.preview-version-btn');
  if (previewBtn) {
    previewVersion(previewBtn.dataset.versionId);
    return;
  }

  const loadBtn = event.target.closest('.load-version-btn');
  if (loadBtn) {
    loadVersionIntoWorkbench(loadBtn.dataset.versionId);
  }
});

$('queryPlanGenerateBtn').addEventListener('click', generateQueryPlan);
$('queryPlanRefreshBtn').addEventListener('click', refreshQueryPlanContext);
$('queryPlanSaveBtn').addEventListener('click', saveQueryPlanDraft);
$('queryPlanApproveBtn').addEventListener('click', approveQueryPlan);
$('metaResearchStartBtn').addEventListener('click', startMetaResearch);
$('metaRunRelevanceBtn').addEventListener('click', runMetaRelevanceFilter);
$('metaRunMr05Btn').addEventListener('click', runMr05RelevanceFilter);
$('metaMr04RunStatus').addEventListener('click', handleRelevanceProgressAction);
$('metaMr05RunStatus').addEventListener('click', handleRelevanceProgressAction);
$('metaApplyFiltersBtn').addEventListener('click', () => loadMetaResearchAds());
$('metaExportFullCsvBtn').addEventListener('click', () => downloadAllMetaAdsCsv('full'));
$('metaExportShortCsvBtn').addEventListener('click', () => downloadAllMetaAdsCsv('short'));
$('offerFamilySection').addEventListener('toggle', () => {
  if ($('offerFamilySection').open) loadOfferFamilies();
});

$('queryDensityDecreaseBtn').addEventListener('click', () => {
  queryDensityIndex -= 1;
  applyQueryDensity();
});

$('queryDensityIncreaseBtn').addEventListener('click', () => {
  queryDensityIndex += 1;
  applyQueryDensity();
});

$('queryPlanSelectAllSeedsBtn').addEventListener('click', () => {
  if (!queryPlanContext?.seeds?.length) return;
  queryPlanSelectedSeedIds = new Set(queryPlanContext.seeds.map(seed => String(seed.seedId)));
  renderQueryPlanSeedSourceList();
});

$('queryPlanClearSeedSelectionBtn').addEventListener('click', () => {
  queryPlanSelectedSeedIds = new Set();
  renderQueryPlanSeedSourceList();
});

$('queryPlanSeedSourceList').addEventListener('change', event => {
  const target = event.target;
  if (!target.classList.contains('query-plan-seed-checkbox')) return;
  const seedId = String(target.dataset.seedId || '');
  if (!seedId) return;

  if (target.checked) {
    queryPlanSelectedSeedIds.add(seedId);
  } else {
    queryPlanSelectedSeedIds.delete(seedId);
  }
  renderQueryPlanSeedSourceList();
});

$('queryPlanSeedSourceList').addEventListener('click', event => {
  const removeBtn = event.target.closest('.seed-remove-btn');
  if (!removeBtn) return;
  const seedId = String(removeBtn.dataset.removeSeedId || '');
  if (!seedId) return;

  queryPlanContext.seeds = (queryPlanContext.seeds || []).filter(seed => String(seed.seedId) !== seedId);
  queryPlanSelectedSeedIds.delete(seedId);
  renderQueryPlanSeedSourceList();
});

$('metaFilterHelpBtn').addEventListener('click', event => {
  event.stopPropagation();
  $('metaFilterHelpBubble').classList.toggle('hidden');
});

$('metaLifecycleHelpBtn').addEventListener('click', event => {
  event.stopPropagation();
  $('metaLifecycleHelpBubble').classList.toggle('hidden');
});

document.addEventListener('click', event => {
  const wrap = event.target.closest('.filter-help-wrap');
  const lifecycleWrap = event.target.closest('#metaLifecycleFilterWrap');
  if (!wrap) {
    $('metaFilterHelpBubble').classList.add('hidden');
  }
  if (!lifecycleWrap) {
    $('metaLifecycleHelpBubble').classList.add('hidden');
  }
});

[
  'metaFilterRelevance',
  'metaFilterQuery',
  'metaFilterSeed',
  'metaFilterPage',
  'metaFilterVisible',
  'metaFilterActive',
  'metaFilterMinReach',
  'metaFilterStartDate',
  'metaSortBy',
  'metaFamilyClassFilter',
  'metaFamilyStatusFilter',
  'metaFamilyPatternFilter',
].forEach(id => {
  $(id).addEventListener('change', loadMetaResearchAds);
});

$('metaLifecycleAllBtn').addEventListener('click', () => {
  setLifecycleFiltersSelected(true);
  loadMetaResearchAds();
});

$('metaLifecycleNoneBtn').addEventListener('click', () => {
  setLifecycleFiltersSelected(false);
  loadMetaResearchAds();
});

$('metaLifecycleCheckboxes').addEventListener('change', () => {
  loadMetaResearchAds();
});

// On wide screens the filters stay beside the results. When their content is
// taller than the viewport, normal page scrolling advances their own scroll
// position too — the lower controls never require reaching the end of an
// infinitely growing ad list. A wheel used directly over the panel still uses
// the browser's native panel scrolling first.
let lastResultsPageScrollY = window.scrollY;
let resultsFilterScrollSyncFrame = null;

function syncResultsFilterPanelScroll() {
  resultsFilterScrollSyncFrame = null;

  const pageScrollY = window.scrollY;
  const delta = pageScrollY - lastResultsPageScrollY;
  lastResultsPageScrollY = pageScrollY;
  if (!delta || window.innerWidth <= 1040 || !$('tab-results').classList.contains('active')) return;

  const panel = document.querySelector('#tab-results .results-filter-panel');
  if (!panel || panel.scrollHeight <= panel.clientHeight + 1) return;

  const stickyTop = Number.parseFloat(window.getComputedStyle(panel).top) || 0;
  const panelTop = panel.getBoundingClientRect().top;
  const isStuck = Math.abs(panelTop - stickyTop) <= 2;
  if (!isStuck) return;

  const maxScrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
  panel.scrollTop = Math.max(0, Math.min(maxScrollTop, panel.scrollTop + delta));
}

window.addEventListener('scroll', () => {
  if (resultsFilterScrollSyncFrame) return;
  resultsFilterScrollSyncFrame = window.requestAnimationFrame(syncResultsFilterPanelScroll);
}, { passive: true });

window.addEventListener('resize', () => {
  lastResultsPageScrollY = window.scrollY;
}, { passive: true });

$('metaAdsBody').addEventListener('change', async event => {
  const select = event.target.closest('.ad-relevance-select');
  if (!select) return;

  const adArchiveId = String(select.dataset.adArchiveId || '').trim();
  if (!adArchiveId) return;

  const nextStatus = String(select.value || '').trim().toUpperCase();

  try {
    await setManualAdRelevance(adArchiveId, nextStatus);
    $('metaActionStatus').textContent = `Zapisano manual override: ${adArchiveId} -> ${nextStatus}`;
    await loadMetaResearchAds();
  } catch (error) {
    $('metaActionStatus').textContent = `BŁĄD manual override: ${error.message}`;
  }
});

$('metaAdsBody').addEventListener('click', async event => {
  const detailsButton = event.target.closest('.ad-details-btn');
  if (detailsButton) {
    const adArchiveId = String(detailsButton.dataset.adArchiveId || '').trim();
    if (adArchiveId) {
      await openAdDetailsModal(adArchiveId);
    }
    return;
  }

  const restoreButton = event.target.closest('.ad-relevance-restore');
  if (!restoreButton) return;

  const adArchiveId = String(restoreButton.dataset.adArchiveId || '').trim();
  if (!adArchiveId) return;

  try {
    await restoreAdRelevanceFromMr04(adArchiveId);
    $('metaActionStatus').textContent = `Przywrócono ostatnią automatyczną decyzję dla reklamy ${adArchiveId}.`;
    await loadMetaResearchAds();
  } catch (error) {
    $('metaActionStatus').textContent = `BŁĄD przywracania decyzji: ${error.message}`;
  }
});

$('metaRestoreAllRelevanceBtn').addEventListener('click', async () => {
  const button = $('metaRestoreAllRelevanceBtn');
  button.disabled = true;

  try {
    const restored = await restoreAllAdRelevanceFromMr04();
    $('metaActionStatus').textContent = `Cofnięto automatyczną segregację (MR04/MR05) dla ${restored} reklam. Możesz ponownie uruchomić Filtrowanie danych (MR04).`;
    await loadMetaResearchAds();
  } catch (error) {
    $('metaActionStatus').textContent = `BŁĄD cofania automatycznej segregacji (MR04/MR05): ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('adDetailsCloseBtn').addEventListener('click', closeAdDetailsModal);
$('adDetailsModalBackdrop').addEventListener('click', event => {
  if (event.target === $('adDetailsModalBackdrop')) {
    closeAdDetailsModal();
  }
});

$('queryPlanEditor').addEventListener('input', event => {
  const target = event.target;
  const seedIndex = Number(target.dataset.seedIndex);
  const queryIndex = Number(target.dataset.queryIndex);

  if (!Number.isFinite(seedIndex) || !Number.isFinite(queryIndex)) return;

  const query = getEditableQuery(seedIndex, queryIndex);
  if (!query) return;

  if (target.classList.contains('query-text')) {
    query.text = target.value;
    query.termCount = countQueryTerms(target.value);
  } else if (target.classList.contains('query-rationale')) {
    query.rationale = target.value;
  } else if (target.classList.contains('query-priority')) {
    query.priority = Number(target.value);
  } else {
    return;
  }

  markQueryPlanDirty();
});

$('queryPlanEditor').addEventListener('change', event => {
  const target = event.target;
  const seedIndex = Number(target.dataset.seedIndex);
  const queryIndex = Number(target.dataset.queryIndex);

  if (!Number.isFinite(seedIndex) || !Number.isFinite(queryIndex)) return;

  const query = getEditableQuery(seedIndex, queryIndex);
  if (!query) return;

  if (target.classList.contains('query-enabled')) {
    query.enabled = target.checked;
  } else if (target.classList.contains('query-type')) {
    query.queryType = target.value;
  } else {
    return;
  }

  markQueryPlanDirty();
});

$('queryPlanEditor').addEventListener('click', event => {
  const deleteBtn = event.target.closest('.query-delete');
  if (deleteBtn) {
    const seedIndex = Number(deleteBtn.dataset.seedIndex);
    const queryIndex = Number(deleteBtn.dataset.queryIndex);
    const seedPlan = currentQueryPlan?.seedPlans?.[seedIndex];
    if (!seedPlan) return;
    seedPlan.queries.splice(queryIndex, 1);
    markQueryPlanDirty();
    return;
  }

  const addBtn = event.target.closest('.add-query-btn');
  if (addBtn) {
    const seedIndex = Number(addBtn.dataset.seedIndex);
    const seedPlan = currentQueryPlan?.seedPlans?.[seedIndex];
    if (!seedPlan) return;

    seedPlan.queries.push({
      id: `ui-${uuid()}`,
      text: '',
      termCount: 0,
      queryType: 'CORE',
      priority: 50,
      rationale: '',
      enabled: true,
      sortOrder: seedPlan.queries.length,
    });

    markQueryPlanDirty();
  }
});

checkN8nStatus();
setInterval(checkN8nStatus, 10000);
refreshDbSize();
setInterval(refreshDbSize, 15000);

syncPlanViews();
renderQueryPlanProjectMeta();
renderQueryPlanSummary();
applyQueryDensity();
