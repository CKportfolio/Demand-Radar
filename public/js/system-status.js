async function startMetaResearch() {
  $('queryPlanActionOk').textContent = '';
  $('queryPlanActionErr').textContent = '';

  if (!currentQueryPlan || currentQueryPlan.status !== 'APPROVED') {
    $('queryPlanActionErr').textContent = 'Najpierw zatwierdz Query Plan (APPROVED).';
    return;
  }

  const active = getActiveQueryPlanProject();
  $('metaResearchStartBtn').disabled = true;

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(active.projectId)}/meta-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queryPlanId: currentQueryPlan.id,
      }),
    });

    const payload = await res.json();

    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    currentMetaResearchRun = payload.run;
    $('queryPlanActionOk').textContent = `✓ Uruchomiono badanie: ${currentMetaResearchRun.id}`;
    renderMetaResearchSummary(currentMetaResearchRun);

    stopMetaResearchPolling();
    metaResearchPollHandle = setInterval(() => loadMetaResearchRun(currentMetaResearchRun.id), 4000);
    await loadMetaResearchRun(currentMetaResearchRun.id);
  } catch (error) {
    $('queryPlanActionErr').textContent = `BLAD uruchomienia badania: ${error.message}`;
    $('metaResearchStartBtn').disabled = currentQueryPlan?.status !== 'APPROVED' || currentQueryPlanDirty;
  }
}

async function checkN8nStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const el = $('n8nStatus');
    el.className = `status ${data.reachable ? 'good' : 'bad'}`;
    el.innerHTML = `<span class="dot"></span>${data.reachable ? 'n8n dostepny' : 'n8n niedostepny'} · ${escapeHtml(data.baseUrl)}`;
  } catch {
    const el = $('n8nStatus');
    el.className = 'status bad';
    el.innerHTML = '<span class="dot"></span>blad statusu';
  }
}

async function refreshDbSize() {
  try {
    const res = await fetch('/api/db-size');
    const data = await res.json();
    const el = $('dbSizeStatus');

    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    el.className = 'status db-size-chip';
    el.innerHTML = `<span class="dot"></span>SQL: ${escapeHtml(formatBytes(data.bytes))}`;
  } catch {
    const el = $('dbSizeStatus');
    el.className = 'status bad';
    el.innerHTML = '<span class="dot"></span>SQL: blad';
  }
}
