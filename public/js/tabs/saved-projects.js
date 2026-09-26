function renderProjectList(projects) {
  const body = $('savedProjectsBody');

  if (!projects.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Brak zapisanych projektow.</td></tr>';
    return;
  }

  body.innerHTML = projects.map(project => `
    <tr>
      <td>${escapeHtml(project.name)}</td>
      <td>${escapeHtml(formatDateTime(project.updatedAt))}</td>
      <td>${escapeHtml(project.latestVersionNumber ?? '—')}</td>
      <td>${escapeHtml(project.latestVersionStatus ?? '—')}</td>
        <td class="saved-project-actions">
          <button class="secondary open-project-btn" data-project-id="${escapeHtml(project.id)}">Otwórz</button>
          <button class="danger delete-project-btn" data-project-id="${escapeHtml(project.id)}">Usuń</button>
        </td>
    </tr>
  `).join('');
}

function renderSelectedProject(data) {
  selectedSavedProject = data;
  const latestVersion = data.versions?.[0];
  $('loadLatestProjectBtn').disabled = !latestVersion;
  $('loadLatestProjectBtn').dataset.versionId = latestVersion?.id || '';
  $('deleteProjectBtn').disabled = false;
  $('deleteProjectBtn').dataset.projectId = data.project.id;

  $('selectedProjectMeta').innerHTML = `
    <strong>${escapeHtml(data.project.name)}</strong><br>
    ID: <code>${escapeHtml(data.project.id)}</code><br>
    Aktualizacja: ${escapeHtml(formatDateTime(data.project.updatedAt))}
  `;

  const brief = data.project.brief || {};
  $('selectedProjectBrief').textContent = JSON.stringify({
    competencies: brief.competencies || '',
    qualifications: brief.qualifications || '',
    availableProductFormats: brief.availableProductFormats || [],
    market: brief.market || {},
    constraints: brief.constraints || [],
    exclusions: brief.exclusions || [],
  }, null, 2);

  if (!data.versions.length) {
    $('selectedProjectVersions').innerHTML = '<div class="muted">Brak wersji planu.</div>';
    return;
  }

  $('selectedProjectVersions').innerHTML = data.versions.map(version => `
    <div class="version-row">
      <div class="head">
        <div>
          <strong>v${escapeHtml(version.versionNumber)}</strong>
          ${escapeHtml(version.sourceEvent)}
        </div>
        <div class="tiny">${escapeHtml(formatDateTime(version.createdAt))}</div>
      </div>
      <div class="tiny">status: ${escapeHtml(version.status)} · parent: ${escapeHtml(version.parentVersionId || 'null')}</div>
      <div class="version-actions" style="margin-top:8px">
        <button class="secondary preview-version-btn" data-version-id="${escapeHtml(version.id)}">POKAZ</button>
        <button class="success load-version-btn" data-version-id="${escapeHtml(version.id)}">WCZYTAJ DO WORKBENCHA</button>
      </div>
    </div>
  `).join('');
}

function renderVersionPreview(payload) {
  const plan = payload.plan;
  const version = payload.version;
  const seeds = Array.isArray(plan.seedQueries) ? plan.seedQueries : [];
  const enabledSeeds = seeds.filter(seed => seed.enabled);

  const tableRows = seeds.map(seed => `
    <tr>
      <td>${escapeHtml(seed.id)}</td>
      <td>${escapeHtml(seed.query)}</td>
      <td>${escapeHtml(seed.priority)}</td>
      <td>${seed.enabled ? 'true' : 'false'}</td>
      <td>${escapeHtml(seed.source)}</td>
    </tr>
  `).join('');

  $('versionPreview').innerHTML = `
    <div class="notice">
      <strong>Wersja v${escapeHtml(version.versionNumber)}</strong><br>
      source: ${escapeHtml(version.sourceEvent)}<br>
      status: ${escapeHtml(version.status)}<br>
      created: ${escapeHtml(formatDateTime(version.createdAt))}
    </div>

    <p><strong>capabilityUnderstanding</strong><br>${escapeHtml(plan.capabilityUnderstanding || '')}</p>
    <p><strong>Liczba seedow:</strong> ${escapeHtml(seeds.length)}<br>
    <strong>Enabled:</strong> ${escapeHtml(enabledSeeds.length)}</p>

    <table class="preview-seeds">
      <thead>
        <tr>
          <th>ID</th>
          <th>Query</th>
          <th>Priority</th>
          <th>Enabled</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows || '<tr><td colspan="5" class="muted">Brak seedow.</td></tr>'}
      </tbody>
    </table>

    <p style="margin-top:10px"><strong>changeSummary</strong><br>${escapeHtml(plan.changeSummary || '')}</p>

    <details>
      <summary>Raw JSON</summary>
      <pre>${escapeHtml(JSON.stringify(plan, null, 2))}</pre>
    </details>
  `;
}

async function refreshProjects() {
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();

    if (!Array.isArray(projects)) {
      throw new Error('Nieprawidlowy format odpowiedzi /api/projects');
    }

    renderProjectList(projects);
  } catch (error) {
    $('savedProjectsBody').innerHTML = `<tr><td colspan="5" class="bad">BLAD: ${escapeHtml(error.message)}</td></tr>`;
  }
}

async function deleteSavedProject(projectIdToDelete) {
  const project = (await fetch('/api/projects').then(response => response.json()))
    .find(item => item.id === projectIdToDelete);
  const name = project?.name || projectIdToDelete;
  if (!window.confirm(`Usunąć projekt „${name}” wraz z planami, badaniami, reklamami projektu i wynikami automatycznej segregacji (MR04/MR05)? Tej operacji nie można cofnąć.`)) return;

  const res = await fetch(`/api/projects/${encodeURIComponent(projectIdToDelete)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);

  if (selectedSavedProject?.project?.id === projectIdToDelete) {
    selectedSavedProject = null;
    $('selectedProjectMeta').textContent = 'Wybierz projekt z listy.';
    $('selectedProjectBrief').textContent = '—';
    $('selectedProjectVersions').textContent = 'Brak.';
    $('versionPreview').textContent = 'Kliknij POKAZ przy wybranej wersji.';
    $('loadLatestProjectBtn').disabled = true;
    $('deleteProjectBtn').disabled = true;
  }
  await refreshProjects();
}

async function openProject(projectIdToOpen) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectIdToOpen)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    renderSelectedProject(data);
    projectId = data.project.id;
    localStorage.setItem('marketRadarProjectId', projectId);
    $('projectIdText').textContent = projectId;
    $('versionPreview').textContent = 'Kliknij POKAZ przy wybranej wersji.';

    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (activeTab === 'query-plan') {
      refreshQueryPlanContext();
    } else if (activeTab === 'results') {
      refreshLatestMetaResearchForProject();
    }
  } catch (error) {
    $('selectedProjectMeta').innerHTML = `<span class="bad">BLAD: ${escapeHtml(error.message)}</span>`;
  }
}

async function previewVersion(versionId) {
  try {
    const res = await fetch(`/api/plan-versions/${encodeURIComponent(versionId)}`);
    const payload = await res.json();

    if (!res.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    renderVersionPreview(payload);
  } catch (error) {
    $('versionPreview').innerHTML = `<span class="bad">BLAD podgladu: ${escapeHtml(error.message)}</span>`;
  }
}

async function loadVersionIntoWorkbench(versionId) {
  if (!selectedSavedProject) {
    alert('Najpierw wybierz projekt.');
    return;
  }

  try {
    const res = await fetch(`/api/plan-versions/${encodeURIComponent(versionId)}`);
    const payload = await res.json();

    if (!res.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    const brief = selectedSavedProject.project.brief;
    applyBriefToForm(brief);

    projectId = selectedSavedProject.project.id;
    localStorage.setItem('marketRadarProjectId', projectId);
    $('projectIdText').textContent = projectId;

    conversation = [];
    revisionNumber = 0;

    setCurrentPlan(payload.plan, {
      sourceLabel: `SQL load v${payload.version.versionNumber}`,
      origin: payload.version.sourceEvent,
      persistedVersionId: payload.version.id,
      persistedVersionNumber: payload.version.versionNumber,
      dirty: false,
      addHistory: true,
    });

    $('saveResult').textContent = `✓ wczytano zapisany plan v${payload.version.versionNumber}`;
    refreshQueryPlanContext();
    setWorkbenchStage('mr02');
    setActiveTab('workbench');
  } catch (error) {
    alert(`BLAD wczytywania: ${error.message}`);
  }
}
