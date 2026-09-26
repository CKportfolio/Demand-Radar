function getActiveQueryPlanProject() {
  const selectedProjectId = selectedSavedProject?.project?.id;
  const selectedCountry = selectedSavedProject?.project?.brief?.market?.country;

  return {
    projectId: selectedProjectId || projectId,
    country: selectedCountry || collectBriefFromForm().market.country || 'PL',
    name: selectedSavedProject?.project?.name || collectBriefFromForm().projectName || '—',
  };
}

function normalizeQueryText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function countQueryTerms(value) {
  const normalized = normalizeQueryText(value);
  if (!normalized) return 0;
  return normalized.split(' ').length;
}

function validateSeedPlansForSave(seedPlans) {
  const errors = [];

  seedPlans.forEach((seedPlan, seedIndex) => {
    const seen = new Set();

    (seedPlan.queries || []).forEach((query, queryIndex) => {
      const text = normalizeQueryText(query.text);
      const terms = countQueryTerms(text);
      const duplicateKey = text.toLowerCase();

      if (!text) {
        errors.push(`Seed ${seedIndex + 1}, query ${queryIndex + 1}: query nie moze byc puste.`);
      }

      if (terms < 2 || terms > 3) {
        errors.push(`Seed ${seedIndex + 1}, query ${queryIndex + 1}: query musi miec 2-3 slowa.`);
      }

      if (text) {
        if (seen.has(duplicateKey)) {
          errors.push(`Seed ${seedIndex + 1}: duplikat query "${text}".`);
        }
        seen.add(duplicateKey);
      }

      if (!QUERY_TYPES.includes(query.queryType)) {
        errors.push(`Seed ${seedIndex + 1}, query ${queryIndex + 1}: niepoprawny queryType.`);
      }

      if (!Number.isFinite(Number(query.priority))) {
        errors.push(`Seed ${seedIndex + 1}, query ${queryIndex + 1}: priority musi byc liczba.`);
      }
    });
  });

  return errors;
}

function normalizeQueryPlan(plan) {
  if (!plan) return null;

  return {
    ...plan,
    seedPlans: (Array.isArray(plan.seedPlans) ? plan.seedPlans : []).map(seedPlan => ({
      ...seedPlan,
      audience: Array.isArray(seedPlan.audience) ? seedPlan.audience : [],
      formatHints: Array.isArray(seedPlan.formatHints) ? seedPlan.formatHints : [],
      queries: (Array.isArray(seedPlan.queries) ? seedPlan.queries : []).map((query, index) => {
        const text = normalizeQueryText(query.text);
        return {
          ...query,
          text,
          termCount: countQueryTerms(text),
          queryType: QUERY_TYPES.includes(query.queryType) ? query.queryType : 'CORE',
          priority: Number.isFinite(Number(query.priority)) ? Number(query.priority) : 50,
          rationale: String(query.rationale || ''),
          enabled: query.enabled !== false,
          sortOrder: Number.isFinite(Number(query.sortOrder)) ? Number(query.sortOrder) : index,
        };
      }),
    })),
  };
}

function renderQueryPlanProjectMeta() {
  const active = getActiveQueryPlanProject();
  $('queryPlanProjectMeta').innerHTML = `
    <div class="query-project-meta-grid">
      <div class="query-project-meta-item"><span>Projekt</span><strong>${escapeHtml(active.name)}</strong></div>
      <div class="query-project-meta-item"><span>projectId</span>${escapeHtml(active.projectId)}</div>
      <div class="query-project-meta-item"><span>Kraj</span><strong>${escapeHtml(active.country)}</strong></div>
    </div>
  `;
}

function renderQueryPlanSeedSourceList() {
  const root = $('queryPlanSeedSourceList');

  if (!queryPlanContext || !Array.isArray(queryPlanContext.seeds) || !queryPlanContext.seeds.length) {
    root.innerHTML = '<div class="muted">Brak seedow w najnowszym planie projektu.</div>';
    $('queryPlanSeedSelectionSummary').textContent = 'Brak seedow w najnowszym planie projektu.';
    return;
  }

  const selectedCount = queryPlanSelectedSeedIds.size;
  const totalCount = queryPlanContext.seeds.length;
  $('queryPlanSeedSelectionSummary').textContent = `Wybrane do Planowania zapytań (MR03): ${selectedCount} / ${totalCount}. Usunięcie działa lokalnie, tylko dla kolejnej generacji.`;

  root.innerHTML = queryPlanContext.seeds.map(seed => `
    <div class="seed-inspect-item">
      <div class="seed-select-row">
        <input type="checkbox" class="query-plan-seed-checkbox" data-seed-id="${escapeHtml(seed.seedId)}" ${queryPlanSelectedSeedIds.has(String(seed.seedId)) ? 'checked' : ''}>
        <div>
          <strong>${escapeHtml(seed.text)}</strong><br>
          <span class="tiny">seedId: ${escapeHtml(seed.seedId)} · source: ${escapeHtml(seed.source)} · enabled: ${seed.enabled ? 'true' : 'false'}</span>
        </div>
        <button class="seed-remove-btn" data-remove-seed-id="${escapeHtml(seed.seedId)}">Usun</button>
      </div>
    </div>
  `).join('');
}

function renderQueryPlanSummary() {
  if (!currentQueryPlan) {
    $('queryPlanSummary').textContent = 'Brak Query Planu. Kliknij GENERUJ QUERY PLAN.';
    $('queryPlanRawOutput').textContent = 'Brak.';
    $('queryPlanEditor').innerHTML = '<div class="muted">Brak danych do edycji.</div>';
    $('queryPlanValidation').textContent = '';
    $('queryPlanSaveBtn').disabled = true;
    $('queryPlanApproveBtn').disabled = true;
    $('metaResearchStartBtn').disabled = true;
    return;
  }

  const seedCount = currentQueryPlan.seedPlans.length;
  const queryCount = currentQueryPlan.seedPlans.reduce((acc, seed) => acc + seed.queries.length, 0);

  const summaryItems = [
    ['ID', currentQueryPlan.id, ''],
    ['Status', currentQueryPlan.status, currentQueryPlan.status === 'APPROVED' ? 'is-approved' : ''],
    ['Planer', currentQueryPlan.plannerVersion, ''],
    ['Seedy', seedCount, ''],
    ['Zapytania', queryCount, ''],
    ['Aktualizacja', formatDateTime(currentQueryPlan.updatedAt), ''],
  ];

  $('queryPlanSummary').innerHTML = `
    <div class="query-plan-summary-grid">
      ${summaryItems.map(([label, value, className]) => `
        <div class="query-plan-summary-item ${className}">
          <span>${escapeHtml(label)}</span>
          <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
        </div>
      `).join('')}
    </div>
  `;

  const errors = validateSeedPlansForSave(currentQueryPlan.seedPlans);
  $('queryPlanValidation').textContent = errors.length ? errors.slice(0, 3).join(' ') : '';

  $('queryPlanRawOutput').textContent = JSON.stringify(currentQueryPlan, null, 2);
  $('queryPlanSaveBtn').disabled = false;
  $('queryPlanApproveBtn').disabled = false;
  $('metaResearchStartBtn').disabled = currentQueryPlan.status !== 'APPROVED' || currentQueryPlanDirty;

  const typeOptions = QUERY_TYPES.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');

  const tableRows = currentQueryPlan.seedPlans.map((seedPlan, seedIndex) => {
    const seedHeader = `
      <tr class="query-seed-divider">
        <td colspan="7">
          <strong>Seed: ${escapeHtml(seedPlan.seedText)}</strong>
          <span class="tiny"> · ${escapeHtml(seedPlan.sourceSeedOrigin || '—')} · ${escapeHtml(seedPlan.concept || '—')}</span>
          <button class="secondary add-query-btn" data-seed-index="${seedIndex}">+ zapytanie</button>
        </td>
      </tr>
    `;
    const queries = seedPlan.queries.map((query, queryIndex) => {
      const queryTypeSelect = `<select class="query-type" data-seed-index="${seedIndex}" data-query-index="${queryIndex}">${typeOptions}</select>`;
      return `
        <tr>
          <td><input type="checkbox" class="query-enabled query-row-enabled" data-seed-index="${seedIndex}" data-query-index="${queryIndex}" ${query.enabled ? 'checked' : ''}></td>
          <td><input type="text" class="query-text" data-seed-index="${seedIndex}" data-query-index="${queryIndex}" value="${escapeHtml(query.text)}" placeholder="2-3 słowa"></td>
          <td>${queryTypeSelect}</td>
          <td><input type="number" class="query-priority" data-seed-index="${seedIndex}" data-query-index="${queryIndex}" value="${escapeHtml(query.priority)}"></td>
          <td>${escapeHtml(query.termCount)}</td>
          <td class="query-rationale-cell"><textarea class="query-rationale" data-seed-index="${seedIndex}" data-query-index="${queryIndex}">${escapeHtml(query.rationale)}</textarea></td>
          <td><button class="query-delete" data-seed-index="${seedIndex}" data-query-index="${queryIndex}">Usuń</button></td>
        </tr>
      `;
    }).join('');
    return seedHeader + (queries || '<tr><td colspan="7" class="muted">Brak zapytań.</td></tr>');
  }).join('');

  $('queryPlanEditor').innerHTML = `
    <div class="query-plan-editor-table-wrap query-plan-all-table-wrap">
      <table class="query-plan-editor-table query-plan-all-table">
        <thead><tr>
          <th style="width:38px">Wł.</th>
          <th style="width:190px">Zapytanie</th>
          <th style="width:110px">Typ</th>
          <th style="width:70px">Priorytet</th>
          <th style="width:52px">Słowa</th>
          <th>Uzasadnienie</th>
          <th style="width:70px"></th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;

  for (const select of $('queryPlanEditor').querySelectorAll('.query-type')) {
    const seedIndex = Number(select.dataset.seedIndex);
    const queryIndex = Number(select.dataset.queryIndex);
    const value = currentQueryPlan.seedPlans[seedIndex].queries[queryIndex].queryType;
    select.value = QUERY_TYPES.includes(value) ? value : 'CORE';
  }
}

function markQueryPlanDirty() {
  currentQueryPlanDirty = true;
  const errors = validateSeedPlansForSave(currentQueryPlan.seedPlans);
  $('queryPlanValidation').textContent = errors.length ? errors.slice(0, 3).join(' ') : '';
  $('queryPlanSaveBtn').disabled = false;
  $('queryPlanApproveBtn').disabled = false;
  $('metaResearchStartBtn').disabled = true;
  $('queryPlanRawOutput').textContent = JSON.stringify(currentQueryPlan, null, 2);
}

function getEditableQuery(seedIndex, queryIndex) {
  const seedPlan = currentQueryPlan?.seedPlans?.[seedIndex];
  if (!seedPlan) return null;
  return seedPlan.queries?.[queryIndex] || null;
}

function buildQueryPlanSavePayload() {
  return {
    seedPlans: currentQueryPlan.seedPlans.map(seedPlan => ({
      sourceSeedId: seedPlan.sourceSeedId,
      sourceSeedOrigin: seedPlan.sourceSeedOrigin,
      seedText: seedPlan.seedText,
      concept: seedPlan.concept || '',
      audience: Array.isArray(seedPlan.audience) ? seedPlan.audience : [],
      formatHints: Array.isArray(seedPlan.formatHints) ? seedPlan.formatHints : [],
      queries: seedPlan.queries.map(query => ({
        text: normalizeQueryText(query.text),
        queryType: query.queryType,
        priority: Number(query.priority),
        rationale: String(query.rationale || ''),
        enabled: query.enabled !== false,
      })),
    })),
  };
}

async function refreshQueryPlanContext() {
  const active = getActiveQueryPlanProject();
  renderQueryPlanProjectMeta();
  $('queryPlanActionOk').textContent = '';
  $('queryPlanActionErr').textContent = '';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(active.projectId)}/query-plan`);
    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    queryPlanContext = payload;
    currentQueryPlan = payload.queryPlan ? normalizeQueryPlan(payload.queryPlan) : null;
    currentQueryPlanDirty = false;
    const defaultSelected = (Array.isArray(payload.seeds) ? payload.seeds : []).filter(seed => seed.enabled).map(seed => String(seed.seedId));
    const fallbackAll = (Array.isArray(payload.seeds) ? payload.seeds : []).map(seed => String(seed.seedId));
    queryPlanSelectedSeedIds = new Set(defaultSelected.length ? defaultSelected : fallbackAll);

    renderQueryPlanProjectMeta();
    renderQueryPlanSeedSourceList();
    renderQueryPlanSummary();
    await refreshLatestMetaResearchStatusForProject();
  } catch (error) {
    queryPlanContext = null;
    currentQueryPlan = null;
    currentQueryPlanDirty = false;

    renderQueryPlanProjectMeta();
    $('queryPlanSeedSourceList').innerHTML = `<div class="bad">BLAD: ${escapeHtml(error.message)}</div>`;
    renderQueryPlanSummary();
    renderMetaResearchSummary(null);
    $('queryPlanActionErr').textContent = `BLAD odczytu kontekstu: ${error.message}`;
  }
}

async function generateQueryPlan() {
  const active = getActiveQueryPlanProject();
  const maxQueriesPerSeed = Number($('queryPlanMaxQueries').value || 6);

  $('queryPlanActionOk').textContent = '';
  $('queryPlanActionErr').textContent = '';

  try {
    const selectedSeedIds = Array.from(queryPlanSelectedSeedIds);
    if (!selectedSeedIds.length) {
      throw new Error('Wybierz co najmniej jeden seed do Planowania zapytań (MR03).');
    }

    const res = await fetch(`/api/projects/${encodeURIComponent(active.projectId)}/query-plan/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        country: active.country,
        maxQueriesPerSeed,
        seedIds: selectedSeedIds,
      }),
    });

    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    currentQueryPlan = normalizeQueryPlan(payload.queryPlan);
    currentQueryPlanDirty = false;
    $('queryPlanActionOk').textContent = '✓ Query Plan wygenerowany i zapisany jako DRAFT.';

    await refreshQueryPlanContext();
  } catch (error) {
    $('queryPlanActionErr').textContent = `BŁĄD — Planowanie zapytań (MR03): ${error.message}`;
  }
}

async function saveQueryPlanDraft() {
  $('queryPlanActionOk').textContent = '';
  $('queryPlanActionErr').textContent = '';

  if (!currentQueryPlan) {
    $('queryPlanActionErr').textContent = 'Brak Query Planu do zapisu.';
    return;
  }

  const errors = validateSeedPlansForSave(currentQueryPlan.seedPlans);
  if (errors.length) {
    $('queryPlanActionErr').textContent = errors[0];
    renderQueryPlanSummary();
    return;
  }

  try {
    const res = await fetch(`/api/query-plans/${encodeURIComponent(currentQueryPlan.id)}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildQueryPlanSavePayload()),
    });

    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    currentQueryPlan = normalizeQueryPlan(payload.queryPlan);
    currentQueryPlanDirty = false;
    $('queryPlanActionOk').textContent = '✓ Zapisano Query Plan jako DRAFT.';
    renderQueryPlanSummary();
  } catch (error) {
    $('queryPlanActionErr').textContent = `BLAD zapisu Query Planu: ${error.message}`;
  }
}

async function approveQueryPlan() {
  $('queryPlanActionOk').textContent = '';
  $('queryPlanActionErr').textContent = '';

  if (!currentQueryPlan) {
    $('queryPlanActionErr').textContent = 'Brak Query Planu do zatwierdzenia.';
    return;
  }

  if (currentQueryPlanDirty) {
    $('queryPlanActionErr').textContent = 'Najpierw zapisz zmiany.';
    return;
  }

  try {
    const res = await fetch(`/api/query-plans/${encodeURIComponent(currentQueryPlan.id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    currentQueryPlan = normalizeQueryPlan(payload.queryPlan);
    currentQueryPlanDirty = false;
    $('queryPlanActionOk').textContent = payload.message || 'Query Plan zatwierdzony.';
    renderQueryPlanSummary();
  } catch (error) {
    $('queryPlanActionErr').textContent = `BLAD zatwierdzenia: ${error.message}`;
  }
}
