function lines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean);
}

function checkedFormats() {
  return [...document.querySelectorAll('input[name="format"]:checked')].map(el => el.value);
}

function capabilities() {
  return [
    {
      source: 'META_AD_LIBRARY',
      modes: ['KEYWORD_SEARCH'],
    }
  ];
}

function collectBriefFromForm() {
  return {
    projectName: $('projectName').value.trim(),
    competencies: $('competencies').value.trim(),
    qualifications: $('qualifications').value.trim(),
    availableProductFormats: checkedFormats(),
    market: {
      country: $('country').value.trim() || 'PL',
      language: $('language').value.trim() || 'pl',
    },
    constraints: lines($('constraints').value),
    exclusions: lines($('exclusions').value),
  };
}

function applyBriefToForm(brief) {
  $('projectName').value = brief.projectName || '';
  $('competencies').value = brief.competencies || '';
  $('qualifications').value = brief.qualifications || '';
  $('country').value = brief.market?.country || 'PL';
  $('language').value = brief.market?.language || 'pl';
  $('constraints').value = Array.isArray(brief.constraints) ? brief.constraints.join('\n') : (brief.constraints || '');
  $('exclusions').value = Array.isArray(brief.exclusions) ? brief.exclusions.join('\n') : (brief.exclusions || '');

  const selectedFormats = new Set(Array.isArray(brief.availableProductFormats) ? brief.availableProductFormats : []);
  for (const checkbox of document.querySelectorAll('input[name="format"]')) {
    checkbox.checked = selectedFormats.has(checkbox.value);
  }
}

function basicContractCheck(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'Odpowiedz nie jest obiektem JSON.' };
  }

  if ('text' in value && typeof value.text === 'string') {
    return { ok: false, reason: 'Odpowiedz jest nadal opakowana w pole text zamiast direct DiscoveryPlan.' };
  }

  const missing = REQUIRED_TOP.filter(k => !(k in value));
  if (missing.length) {
    return { ok: false, reason: `Brakuje top-level fields: ${missing.join(', ')}` };
  }

  if (value.schemaVersion !== '1.1') {
    return { ok: false, reason: `schemaVersion = ${JSON.stringify(value.schemaVersion)}, oczekiwano "1.1".` };
  }

  if (!Array.isArray(value.seedQueries)) {
    return { ok: false, reason: 'seedQueries nie jest tablica.' };
  }

  if (value.seedQueries.length === 0) {
    return { ok: false, reason: 'seedQueries jest puste — schema wymaga co najmniej jednego seeda.' };
  }

  for (const [index, seed] of value.seedQueries.entries()) {
    const requiredSeed = ['id', 'query', 'rationale', 'priority', 'enabled', 'source'];
    const missingSeed = requiredSeed.filter(k => !seed || !(k in seed));

    if (missingSeed.length) {
      return { ok: false, reason: `seedQueries[${index}] brakuje: ${missingSeed.join(', ')}` };
    }

    if (!['high', 'medium', 'low'].includes(seed.priority)) {
      return { ok: false, reason: `seedQueries[${index}].priority jest niepoprawne.` };
    }

    if (typeof seed.enabled !== 'boolean') {
      return { ok: false, reason: `seedQueries[${index}].enabled musi byc boolean.` };
    }
  }

  if (!Array.isArray(value.discoveryStrategies)) {
    return { ok: false, reason: 'discoveryStrategies nie jest tablica.' };
  }

  if (!Array.isArray(value.warnings)) {
    return { ok: false, reason: 'warnings nie jest tablica.' };
  }

  if (typeof value.changeSummary !== 'string') {
    return { ok: false, reason: 'changeSummary nie jest stringiem.' };
  }

  return { ok: true, reason: 'Basic contract PASS — wszystkie wymagane top-level fields sa obecne.' };
}

function setContract(result) {
  const el = $('contract');
  el.className = `contract ${result.ok ? 'good' : 'bad'}`;
  el.textContent = result.ok ? `OK ${result.reason}` : `BLAD ${result.reason}`;
}

function setWorkbenchStage(stage) {
  const mr01 = $('mr01Panel');
  const mr02 = $('mr02Panel');
  if (!mr01 || !mr02) return;

  const showMr02 = stage === 'mr02';
  mr01.open = !showMr02;
  mr02.open = showMr02;
}

function updatePlanBadge() {
  const brief = collectBriefFromForm();
  const projectName = brief.projectName || '—';

  let planLabel = '—';
  if (currentPersistedVersionNumber) {
    planLabel = `v${currentPersistedVersionNumber}`;
  } else if (currentPlan) {
    planLabel = 'lokalny (niezapisany)';
  }

  let stateLabel = '<span class="muted">brak currentPlan</span>';
  if (currentPlan) {
    if (currentPlanDirty) {
      stateLabel = '<span class="dirty">NIEZAPISANE ZMIANY</span>';
    } else {
      stateLabel = '<span class="good">zapisany</span>';
    }
  }

  const originLabel = currentPlanOrigin ? SOURCE_EVENT_LABELS[currentPlanOrigin] || currentPlanOrigin : '—';

  $('planBadge').innerHTML = [
    `<span>Projekt: <strong>${escapeHtml(projectName)}</strong></span>`,
    `<span>Plan: <strong>${escapeHtml(planLabel)}</strong></span>`,
    `<span>Pochodzenie: <strong>${escapeHtml(originLabel)}</strong></span>`,
    `<span>Stan: ${stateLabel}</span>`,
  ].join('');

  $('saveProjectBtn').disabled = !currentPlan;
}

function addHistory(title, detail) {
  const root = $('history');
  if (root.classList.contains('muted')) {
    root.classList.remove('muted');
    root.innerHTML = '';
  }

  const div = document.createElement('div');
  div.className = 'history-item';
  div.innerHTML = `<strong>${escapeHtml(title)}</strong><br><span class="muted">${escapeHtml(String(detail || ''))}</span>`;
  root.prepend(div);
}

function markPlanDirty(origin) {
  currentPlanOrigin = origin || 'MANUAL_REVISION';
  currentPlanDirty = true;
  updatePlanBadge();
}

function setCurrentPlan(plan, options = {}) {
  currentPlan = plan;

  if (options.origin !== undefined) {
    currentPlanOrigin = options.origin;
  }

  if (Object.prototype.hasOwnProperty.call(options, 'persistedVersionId')) {
    currentPersistedVersionId = options.persistedVersionId;
  }

  if (Object.prototype.hasOwnProperty.call(options, 'persistedVersionNumber')) {
    currentPersistedVersionNumber = options.persistedVersionNumber;
  }

  if (Object.prototype.hasOwnProperty.call(options, 'dirty')) {
    currentPlanDirty = options.dirty;
  }

  if (options.sourceLabel) {
    revisionNumber += 1;
    $('planStateText').textContent = `currentPlan gotowy - ${options.sourceLabel}`;
    if (options.addHistory !== false) {
      addHistory(`${revisionNumber}. ${options.sourceLabel}`, plan.changeSummary || '(brak changeSummary / initial generation)');
    }
  }

  syncPlanViews();
}

function syncPlanViews() {
  $('currentPlanOutput').textContent = currentPlan ? JSON.stringify(currentPlan, null, 2) : 'Brak currentPlan.';
  renderSeedEditor();
  updatePlanBadge();

  $('saveResult').textContent = '';
  $('saveError').textContent = '';

  if (currentPlan) {
    const check = basicContractCheck(currentPlan);
    setContract(check);
    $('reviseBtn').disabled = !check.ok;
  } else {
    $('reviseBtn').disabled = true;
  }
}

function renderSeedEditor() {
  const editor = $('seedEditor');
  const tbody = $('seedTableBody');

  if (!currentPlan || !Array.isArray(currentPlan.seedQueries)) {
    editor.hidden = true;
    tbody.innerHTML = '';
    return;
  }

  editor.hidden = false;
  tbody.innerHTML = '';

  const seeds = currentPlan.seedQueries;
  $('seedCount').textContent = `${seeds.length} seedow`;
  $('enabledSeedCount').textContent = `${seeds.filter(seed => seed.enabled).length} aktywnych`;

  for (const seed of seeds) {
    const tr = document.createElement('tr');
    if (!seed.enabled) tr.classList.add('seed-disabled');

    tr.innerHTML = `
      <td><input type="checkbox" class="seed-enabled" data-seed-id="${escapeHtml(seed.id)}" ${seed.enabled ? 'checked' : ''}></td>
      <td>
        <select class="seed-priority" data-seed-id="${escapeHtml(seed.id)}">
          <option value="high" ${seed.priority === 'high' ? 'selected' : ''}>high</option>
          <option value="medium" ${seed.priority === 'medium' ? 'selected' : ''}>medium</option>
          <option value="low" ${seed.priority === 'low' ? 'selected' : ''}>low</option>
        </select>
      </td>
      <td><input type="text" class="seed-query" data-seed-id="${escapeHtml(seed.id)}" value="${escapeHtml(seed.query)}"></td>
      <td><textarea class="seed-rationale" data-seed-id="${escapeHtml(seed.id)}">${escapeHtml(seed.rationale)}</textarea></td>
      <td class="seed-source">${escapeHtml(seed.source)}</td>
      <td class="seed-id">${escapeHtml(seed.id)}</td>
      <td><button class="seed-delete" data-seed-id="${escapeHtml(seed.id)}">Usun</button></td>
    `;

    tbody.appendChild(tr);
  }
}

function findSeed(seedId) {
  return currentPlan?.seedQueries?.find(seed => seed.id === seedId) || null;
}

function updateSeed(seedId, patch) {
  const seed = findSeed(seedId);
  if (!seed) return;
  Object.assign(seed, patch);
  markPlanDirty('MANUAL_REVISION');
  syncPlanViews();
}

function deleteSeed(seedId) {
  if (!currentPlan?.seedQueries) return;

  if (currentPlan.seedQueries.length <= 1) {
    alert('DiscoveryPlanV1 wymaga co najmniej jednego seeda. Nie mozna usunac ostatniego.');
    return;
  }

  currentPlan.seedQueries = currentPlan.seedQueries.filter(seed => seed.id !== seedId);
  markPlanDirty('MANUAL_REVISION');
  syncPlanViews();
}

function createUserSeed() {
  if (!currentPlan) return;

  currentPlan.seedQueries.push({
    id: `user-${uuid()}`,
    query: 'nowy seed',
    rationale: 'Seed dodany recznie przez uzytkownika.',
    priority: 'medium',
    enabled: true,
    source: 'USER'
  });

  markPlanDirty('MANUAL_REVISION');
  syncPlanViews();
}

function setMeta(result) {
  $('meta').innerHTML = [
    `HTTP n8n: ${result.upstreamStatus ?? '—'}`,
    `${result.durationMs ?? '—'} ms`,
    result.mode || '',
    result.webhookPath || '',
  ]
    .filter(Boolean)
    .map(x => `<span class="chip">${escapeHtml(String(x))}</span>`)
    .join('');
}

async function callWorkflow(endpoint, payload) {
  const mode = $('mode').value;
  const processLabel = endpoint.endsWith('/mr02')
    ? 'Rozmowa i korekta planu (MR02)'
    : 'Generowanie planu odkrywania (MR01)';
  $('lastResponsePanel').open = true;
  $('output').textContent = `${processLabel}: wysyłanie danych…`;
  $('contract').className = 'contract';
  $('contract').textContent = `${processLabel}: oczekiwanie na odpowiedź modelu…`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, payload }),
  });

  const result = await response.json();
  setMeta(result);

  lastResponseData = result.data ?? result;
  $('copyBtn').disabled = false;
  $('output').textContent = JSON.stringify(lastResponseData, null, 2);

  if (!result.ok) {
    setContract({ ok: false, reason: `n8n zwrocil blad HTTP ${result.upstreamStatus ?? ''}: ${JSON.stringify(result.data ?? result.error)}` });
    return { result, plan: null };
  }

  const contract = basicContractCheck(lastResponseData);
  setContract(contract);

  return {
    result,
    plan: contract.ok ? lastResponseData : null,
  };
}

function setActiveTab(tabId) {
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  }

  for (const button of document.querySelectorAll('.tab-btn')) {
    button.classList.toggle('active', button.dataset.tab === tabId);
  }

  if (tabId === 'saved') {
    refreshProjects();
  }

  if (tabId === 'query-plan') {
    refreshQueryPlanContext();
  }

  if (tabId === 'results') {
    refreshLatestMetaResearchForProject();
  }
}

async function saveCurrentProject() {
  $('saveResult').textContent = '';
  $('saveError').textContent = '';

  if (!currentPlan) {
    $('saveError').textContent = 'Brak currentPlan do zapisu.';
    return;
  }

  const sourceEvent = currentPlanOrigin || 'MANUAL_REVISION';
  const parentVersionId = sourceEvent === 'LLM_GENERATION' ? null : currentPersistedVersionId;

  const payload = {
    brief: collectBriefFromForm(),
    plan: currentPlan,
    sourceEvent,
    parentVersionId: parentVersionId || null,
  };

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    currentPersistedVersionId = data.version.id;
    currentPersistedVersionNumber = data.version.versionNumber;
    currentPlanDirty = false;

    updatePlanBadge();

    if (data.alreadySaved) {
      $('saveResult').textContent = `✓ juz zapisane jako v${data.version.versionNumber}`;
    } else {
      $('saveResult').textContent = `✓ zapisano jako v${data.version.versionNumber}`;
      addHistory(`SAVE v${data.version.versionNumber}`, `${data.version.sourceEvent} (${data.version.id})`);
    }
  } catch (error) {
    $('saveError').textContent = `BLAD zapisu: ${error.message}`;
  }
}
