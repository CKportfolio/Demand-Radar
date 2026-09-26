(function initDemandRadarTimeline(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && root.document) {
    root.DemandRadarTimeline = api;
    root.openFamilyTimeline = api.openFamilyTimeline;
    api.install(root.document);
  }
})(typeof window !== 'undefined' ? window : null, function createDemandRadarTimeline() {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const STYLE_ID = 'dr-timeline-styles';
  const OVERLAY_ID = 'dr-timeline-overlay';
  const TOOLTIP_ID = 'dr-timeline-tooltip';

  const LIFECYCLE_CONFIG = Object.freeze([
    { key: 'BALON_PROBNY', label: 'BALON PRÓBNY', range: '0–7 dni', color: '#9CA3AF' },
    { key: 'TEST_W_TOKU', label: 'TEST W TOKU', range: '8–30 dni', color: '#FBBF24' },
    { key: 'ROKUJACA', label: 'ROKUJĄCA', range: '31–90 dni', color: '#FB923C' },
    { key: 'MOCNA', label: 'MOCNA', range: '91–180 dni', color: '#EF4444' },
    { key: 'EVERGREEN', label: 'EVERGREEN', range: '>180 dni', color: '#10B981' },
  ]);

  const LIFECYCLE_BY_KEY = new Map(LIFECYCLE_CONFIG.map(item => [item.key, item]));

  const state = {
    document: null,
    installed: false,
    families: new Map(),
    overlay: null,
    tooltip: null,
    previousFocus: null,
    previousBodyOverflow: '',
    currentModel: null,
    zoom: 1,
    pinnedAdId: null,
  };

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    }

    const raw = String(value).trim();
    const isoDay = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    const parsed = isoDay ? new Date(`${isoDay}T00:00:00Z`) : new Date(raw);
    if (!Number.isFinite(parsed.getTime())) return null;

    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }

  function addDays(date, days) {
    return new Date(date.getTime() + (days * DAY_MS));
  }

  function differenceInDays(later, earlier) {
    return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
  }

  function toIsoDay(date) {
    return date ? date.toISOString().slice(0, 10) : null;
  }

  function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
  }

  function positiveInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.max(1, Math.round(number)) : fallback;
  }

  function deriveLifecycle(daysActive) {
    if (daysActive <= 7) return 'BALON_PROBNY';
    if (daysActive <= 30) return 'TEST_W_TOKU';
    if (daysActive <= 90) return 'ROKUJACA';
    if (daysActive <= 180) return 'MOCNA';
    return 'EVERGREEN';
  }

  function normalizeLifecycle(value, daysActive) {
    const normalized = String(value || '').trim().toUpperCase();
    return LIFECYCLE_BY_KEY.has(normalized) ? normalized : deriveLifecycle(daysActive);
  }

  function familyAds(family) {
    if (Array.isArray(family?.members)) return family.members;
    if (Array.isArray(family?.ads)) return family.ads;
    return [];
  }

  function prepareAd(rawAd, family, sourceIndex) {
    const start = parseDate(firstDefined(rawAd.startDate, rawAd.start_date));
    if (!start) return null;

    const explicitEnd = parseDate(firstDefined(rawAd.endDate, rawAd.end_date));
    let daysActive = positiveInteger(firstDefined(rawAd.runtimeDays, rawAd.daysActive, rawAd.days_active));

    if (!daysActive && explicitEnd) {
      daysActive = Math.max(1, differenceInDays(explicitEnd, start) + 1);
    }
    if (!daysActive) daysActive = 1;

    const end = explicitEnd || addDays(start, daysActive - 1);
    const lifecycle = normalizeLifecycle(
      firstDefined(rawAd.longevityCategory, rawAd.lifecycleClass, rawAd.lifecycle),
      daysActive,
    );

    return {
      sourceIndex,
      raw: rawAd,
      adArchiveId: String(firstDefined(rawAd.adArchiveId, rawAd.ad_archive_id, rawAd.metaAdId, rawAd.id, '—')),
      title: String(firstDefined(rawAd.title, 'Reklama bez tytułu')),
      body: String(firstDefined(rawAd.bodyText, rawAd.body, rawAd.body_text, '')),
      pageId: String(firstDefined(rawAd.pageId, rawAd.page_id, family.pageId, family.page_id, '—')),
      landingUrl: String(firstDefined(
        rawAd.canonicalUrl,
        rawAd.canonical_destination_url,
        rawAd.destinationUrl,
        rawAd.destination_url,
        family.landingUrlClean,
        family.landing_url_clean,
        '—',
      )),
      snapshotUrl: String(firstDefined(rawAd.adLibraryUrl, rawAd.adSnapshotUrl, rawAd.ad_snapshot_url, '')),
      isActive: Boolean(firstDefined(rawAd.isActive, rawAd.is_active, false)),
      start,
      end,
      startDate: toIsoDay(start),
      endDate: explicitEnd ? toIsoDay(explicitEnd) : null,
      daysActive,
      lifecycle,
      color: LIFECYCLE_BY_KEY.get(lifecycle)?.color || '#9CA3AF',
    };
  }

  function buildTimelineModel(family) {
    const sourceAds = familyAds(family);
    const prepared = sourceAds
      .map((ad, index) => prepareAd(ad || {}, family || {}, index))
      .filter(Boolean)
      .sort((left, right) => left.start - right.start || left.end - right.end || left.sourceIndex - right.sourceIndex);

    const firstSeen = parseDate(firstDefined(family?.firstSeen, family?.first_seen, family?.firstAdStart));
    const lastSeen = parseDate(firstDefined(
      family?.lastSeen,
      family?.last_seen,
      family?.latestAdEnd,
      family?.latestAdStart,
    ));

    const startCandidates = [...prepared.map(ad => ad.start), firstSeen].filter(Boolean);
    const endCandidates = [...prepared.map(ad => ad.end), lastSeen].filter(Boolean);
    const timelineStart = startCandidates.length
      ? new Date(Math.min(...startCandidates.map(date => date.getTime())))
      : null;
    const timelineEnd = endCandidates.length
      ? new Date(Math.max(...endCandidates.map(date => date.getTime())))
      : timelineStart;
    const totalDays = timelineStart && timelineEnd
      ? Math.max(1, differenceInDays(timelineEnd, timelineStart) + 1)
      : 0;

    const laneEnds = [];
    const blocks = prepared.map(ad => {
      const startOffset = differenceInDays(ad.start, timelineStart);
      const endOffset = differenceInDays(ad.end, timelineStart);
      let lane = laneEnds.findIndex(lastEnd => startOffset > lastEnd);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = endOffset;

      return {
        ...ad,
        lane,
        startOffset,
        endOffset,
        leftPercent: totalDays ? (startOffset / totalDays) * 100 : 0,
        widthPercent: totalDays ? (ad.daysActive / totalDays) * 100 : 100,
      };
    });

    return {
      family,
      sourceAdsCount: sourceAds.length,
      undatedAdsCount: sourceAds.length - prepared.length,
      blocks,
      laneCount: Math.max(1, laneEnds.length),
      timelineStart,
      timelineEnd,
      totalDays,
      canvasMinWidth: Math.max(840, Math.min(6000, totalDays * 5)),
    };
  }

  function injectStyles(documentRef) {
    if (documentRef.getElementById(STYLE_ID)) return;

    const style = documentRef.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .offer-family-timeline-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 27px;
        padding: 4px 8px;
        border: 1px solid #4b6487;
        border-radius: 7px;
        background: #1a2b43;
        color: #dceaff;
        font-size: 10px;
        font-weight: 750;
        cursor: pointer;
      }
      .offer-family-timeline-btn:hover { background: #233c5e; border-color: #6e91c2; }
      .offer-family-timeline-btn:focus-visible { outline: 2px solid #84b6ff; outline-offset: 2px; }
      .offer-family-head-actions { display: inline-flex; align-items: center; gap: 8px; }
      .dr-timeline-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: grid;
        place-items: center;
        background: rgba(3, 7, 13, 0.76);
        backdrop-filter: blur(3px);
      }
      .dr-timeline-overlay[hidden] { display: none; }
      .dr-timeline-modal {
        width: 80vw;
        height: 80vh;
        min-width: 720px;
        min-height: 460px;
        border: 1px solid #40526d;
        border-radius: 14px;
        background: #121923;
        color: #edf4ff;
        box-shadow: 0 28px 80px rgba(0, 0, 0, 0.55);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        overflow: hidden;
      }
      .dr-timeline-header {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        padding: 13px 15px;
        border-bottom: 1px solid #34445a;
        background: #182231;
      }
      .dr-timeline-heading { min-width: 0; flex: 1; }
      .dr-timeline-heading h3 { margin: 0; color: #f4f8ff; font-size: 15px; line-height: 1.3; }
      .dr-timeline-heading p { margin: 4px 0 0; color: #9fb0c6; font-size: 10px; overflow-wrap: anywhere; }
      .dr-timeline-zoom {
        display: flex;
        align-items: center;
        gap: 7px;
        flex: 0 0 auto;
        color: #aebdd0;
        font-size: 9px;
      }
      .dr-timeline-zoom button {
        width: 29px;
        height: 29px;
        padding: 0;
        border: 1px solid #526780;
        border-radius: 50%;
        background: #1f2d40;
        color: #f2f7ff;
        font-size: 17px;
        line-height: 1;
        cursor: pointer;
      }
      .dr-timeline-zoom button:hover { background: #2a4160; }
      .dr-timeline-zoom input { width: 96px; accent-color: #65b7ff; }
      .dr-timeline-zoom-value { min-width: 34px; text-align: right; font-weight: 800; }
      .dr-timeline-close {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 1px solid #53637a;
        border-radius: 8px;
        background: #263244;
        color: #f1f5fb;
        font-size: 17px;
        cursor: pointer;
      }
      .dr-timeline-close:hover { background: #3a2830; border-color: #8d4f5d; }
      .dr-timeline-content {
        min-height: 0;
        padding: 12px 14px 13px;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 10px;
      }
      .dr-timeline-summary { display: flex; flex-wrap: wrap; gap: 6px; }
      .dr-timeline-chip {
        padding: 4px 7px;
        border: 1px solid #35465e;
        border-radius: 999px;
        background: #101720;
        color: #b9c8da;
        font-size: 9px;
      }
      .dr-timeline-viewport {
        min-height: 0;
        overflow: auto;
        border: 1px solid #35455b;
        border-radius: 10px;
        background: #0c121a;
      }
      .dr-timeline-canvas {
        position: relative;
        width: 100%;
        min-height: 180px;
        background:
          linear-gradient(to bottom, rgba(255,255,255,0.018), transparent 45%),
          #0d141e;
      }
      .dr-timeline-axis {
        position: absolute;
        left: 20px;
        right: 20px;
        top: 42px;
        height: 1px;
        background: #5a6d87;
      }
      .dr-timeline-tick {
        position: absolute;
        top: -5px;
        width: 1px;
        height: calc(var(--dr-canvas-height) - 42px);
        background: rgba(112, 132, 160, 0.18);
      }
      .dr-timeline-tick::before {
        content: '';
        position: absolute;
        left: -2px;
        top: 0;
        width: 5px;
        height: 9px;
        border-radius: 2px;
        background: #7488a4;
      }
      .dr-timeline-tick-label {
        position: absolute;
        top: -27px;
        transform: translateX(-50%);
        color: #91a3ba;
        font-size: 9px;
        white-space: nowrap;
      }
      .dr-timeline-block {
        position: absolute;
        height: 30px;
        min-width: 12px;
        max-width: calc(100% - var(--dr-left));
        padding: 0 6px;
        border: 1px solid rgba(255,255,255,0.34);
        border-radius: 6px;
        display: flex;
        align-items: center;
        overflow: hidden;
        color: #0a0f16;
        box-shadow: 0 4px 10px rgba(0,0,0,0.28);
        cursor: default;
      }
      .dr-timeline-lanes {
        position: absolute;
        inset: 0 20px;
      }
      .dr-timeline-block:hover,
      .dr-timeline-block:focus-visible {
        z-index: 4;
        outline: 2px solid #e8f1ff;
        outline-offset: 2px;
        filter: brightness(1.08);
      }
      .dr-timeline-block-label {
        min-width: 0;
        overflow: hidden;
        font-size: 9px;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dr-timeline-empty {
        min-height: 210px;
        padding: 24px;
        display: grid;
        place-items: center;
        color: #9dadc2;
        text-align: center;
        font-size: 12px;
      }
      .dr-timeline-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 7px 14px;
        color: #adbbcd;
        font-size: 9px;
      }
      .dr-timeline-legend span { display: inline-flex; align-items: center; gap: 5px; }
      .dr-timeline-legend i { width: 9px; height: 9px; border-radius: 3px; }
      .dr-timeline-tooltip {
        position: absolute;
        z-index: 1002;
        width: min(360px, calc(100vw - 24px));
        padding: 10px 11px;
        border: 1px solid #657b9a;
        border-radius: 9px;
        background: #192538;
        color: #eaf2ff;
        box-shadow: 0 14px 38px rgba(0,0,0,0.5);
        pointer-events: none;
        font-size: 10px;
        line-height: 1.35;
      }
      .dr-timeline-tooltip.is-pinned {
        border-color: #8ebcff;
        pointer-events: auto;
      }
      .dr-timeline-tooltip-link {
        display: inline-flex;
        margin-top: 9px;
        padding: 5px 8px;
        border: 1px solid #5076a9;
        border-radius: 6px;
        background: #213854;
        color: #e9f3ff;
        font-weight: 750;
        text-decoration: none;
      }
      .dr-timeline-tooltip-link:hover { background: #2b4a70; }
      .dr-timeline-tooltip[hidden] { display: none; }
      .dr-timeline-tooltip strong { display: block; margin-bottom: 6px; color: #fff; font-size: 12px; }
      .dr-timeline-tooltip-body { margin-bottom: 7px; color: #c7d5e7; white-space: pre-wrap; }
      .dr-timeline-tooltip-grid { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 8px; }
      .dr-timeline-tooltip-grid dt { color: #8296b1; }
      .dr-timeline-tooltip-grid dd { margin: 0; overflow-wrap: anywhere; }
      @media (max-width: 800px) {
        .dr-timeline-modal { width: 94vw; height: 90vh; min-width: 0; min-height: 0; }
        .dr-timeline-header { padding: 10px; }
        .dr-timeline-content { padding: 9px; }
      }
    `;
    documentRef.head.appendChild(style);
  }

  function createModal(documentRef) {
    if (state.overlay && state.overlay.isConnected) return state.overlay;

    const overlay = documentRef.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'dr-timeline-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="dr-timeline-modal" role="dialog" aria-modal="true" aria-labelledby="dr-timeline-title">
        <header class="dr-timeline-header">
          <div class="dr-timeline-heading">
            <h3 id="dr-timeline-title">Timeline rodziny ofert</h3>
            <p id="dr-timeline-subtitle"></p>
          </div>
          <div class="dr-timeline-zoom" title="Zmień skalę przyciskami, suwakiem lub Ctrl + kółko nad osią">
            <button class="dr-timeline-zoom-out" type="button" aria-label="Zwęź Timeline">−</button>
            <input class="dr-timeline-zoom-range" type="range" min="60" max="300" step="10" value="100" aria-label="Skala Timeline">
            <span class="dr-timeline-zoom-value">100%</span>
            <button class="dr-timeline-zoom-in" type="button" aria-label="Rozszerz Timeline">+</button>
          </div>
          <button class="dr-timeline-close" type="button" aria-label="Zamknij Timeline">✕</button>
        </header>
        <div class="dr-timeline-content">
          <div class="dr-timeline-summary"></div>
          <div class="dr-timeline-viewport"></div>
          <div class="dr-timeline-legend"></div>
        </div>
      </section>
    `;

    const tooltip = documentRef.createElement('div');
    tooltip.id = TOOLTIP_ID;
    tooltip.className = 'dr-timeline-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    overlay.appendChild(tooltip);

    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeFamilyTimeline();
      if (
        state.pinnedAdId
        && !event.target.closest('.dr-timeline-block')
        && !event.target.closest('.dr-timeline-tooltip')
      ) {
        state.pinnedAdId = null;
        hideTooltip(true);
      }
    });
    overlay.querySelector('.dr-timeline-close').addEventListener('click', closeFamilyTimeline);
    overlay.querySelector('.dr-timeline-zoom-out').addEventListener('click', () => setTimelineZoom(state.zoom - 0.2));
    overlay.querySelector('.dr-timeline-zoom-in').addEventListener('click', () => setTimelineZoom(state.zoom + 0.2));
    overlay.querySelector('.dr-timeline-zoom-range').addEventListener('input', event => {
      setTimelineZoom(Number(event.target.value) / 100);
    });
    overlay.querySelector('.dr-timeline-viewport').addEventListener('wheel', event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setTimelineZoom(state.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    documentRef.body.appendChild(overlay);
    state.overlay = overlay;
    state.tooltip = tooltip;
    return overlay;
  }

  function formatDate(date) {
    if (!date) return '—';
    return new Intl.DateTimeFormat('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }

  function truncate(value, maxLength) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trimEnd()}…`;
  }

  function landingPath(value) {
    if (!value || value === '—') return null;
    try {
      const url = new URL(value);
      return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      return String(value);
    }
  }

  function appendTooltipRow(documentRef, list, label, value) {
    const term = documentRef.createElement('dt');
    term.textContent = label;
    const detail = documentRef.createElement('dd');
    detail.textContent = value || '—';
    list.append(term, detail);
  }

  function showTooltip(blockElement, block, { pinned = false } = {}) {
    const documentRef = state.document;
    const tooltip = state.tooltip;
    if (!documentRef || !tooltip) return;

    tooltip.replaceChildren();
    tooltip.classList.toggle('is-pinned', pinned);
    const title = documentRef.createElement('strong');
    title.textContent = block.title;
    tooltip.appendChild(title);

    if (block.body) {
      const body = documentRef.createElement('div');
      body.className = 'dr-timeline-tooltip-body';
      body.textContent = truncate(block.body, 150);
      tooltip.appendChild(body);
    }

    const details = documentRef.createElement('dl');
    details.className = 'dr-timeline-tooltip-grid';
    appendTooltipRow(documentRef, details, 'Start', block.startDate);
    appendTooltipRow(documentRef, details, 'Koniec', block.endDate || (block.isActive ? 'aktywna' : '—'));
    appendTooltipRow(documentRef, details, 'Czas', `${block.daysActive} dni`);
    appendTooltipRow(documentRef, details, 'Lifecycle', block.lifecycle);
    appendTooltipRow(documentRef, details, 'ad_archive_id', block.adArchiveId);
    appendTooltipRow(documentRef, details, 'page_id', block.pageId);
    appendTooltipRow(documentRef, details, 'Landing URL', block.landingUrl);
    appendTooltipRow(documentRef, details, 'Status', block.isActive ? 'active' : 'inactive');
    tooltip.appendChild(details);

    const adUrl = block.snapshotUrl || (block.landingUrl !== '—' ? block.landingUrl : '');
    if (adUrl) {
      const link = documentRef.createElement('a');
      link.className = 'dr-timeline-tooltip-link';
      link.href = adUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = block.snapshotUrl ? 'Otwórz reklamę ↗' : 'Otwórz landing page ↗';
      tooltip.appendChild(link);
    }

    tooltip.hidden = false;
    tooltip.style.visibility = 'hidden';
    const blockRect = blockElement.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = documentRef.documentElement.clientWidth;
    const viewportHeight = documentRef.documentElement.clientHeight;

    let left = blockRect.left + (blockRect.width / 2) - (tooltipRect.width / 2);
    left = Math.max(12, Math.min(left, viewportWidth - tooltipRect.width - 12));

    let top = blockRect.top - tooltipRect.height - 10;
    if (top < 12) top = blockRect.bottom + 10;
    if (top + tooltipRect.height > viewportHeight - 12) {
      top = Math.max(12, viewportHeight - tooltipRect.height - 12);
    }

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.visibility = 'visible';
  }

  function hideTooltip(force = false) {
    if (!force && state.pinnedAdId) return;
    if (state.tooltip) {
      state.tooltip.hidden = true;
      state.tooltip.classList.remove('is-pinned');
    }
  }

  function setTimelineZoom(value) {
    state.zoom = Math.max(0.6, Math.min(3, Math.round(Number(value || 1) * 10) / 10));
    if (!state.overlay) return;

    const range = state.overlay.querySelector('.dr-timeline-zoom-range');
    const label = state.overlay.querySelector('.dr-timeline-zoom-value');
    const canvas = state.overlay.querySelector('.dr-timeline-canvas');
    if (range) range.value = String(Math.round(state.zoom * 100));
    if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
    if (canvas && state.currentModel) {
      canvas.style.minWidth = `${Math.round(state.currentModel.canvasMinWidth * state.zoom)}px`;
    }
  }

  function createLegend(documentRef, root) {
    root.replaceChildren();
    for (const item of LIFECYCLE_CONFIG) {
      const entry = documentRef.createElement('span');
      const dot = documentRef.createElement('i');
      dot.style.background = item.color;
      const label = documentRef.createTextNode(`${item.label} (${item.range})`);
      entry.append(dot, label);
      root.appendChild(entry);
    }
  }

  function renderTicks(documentRef, axis, model) {
    const tickCount = Math.min(6, Math.max(2, Math.ceil(model.totalDays / 30) + 1));
    for (let index = 0; index < tickCount; index += 1) {
      const ratio = tickCount === 1 ? 0 : index / (tickCount - 1);
      const dayOffset = Math.round((model.totalDays - 1) * ratio);
      const tick = documentRef.createElement('div');
      tick.className = 'dr-timeline-tick';
      tick.style.left = `${ratio * 100}%`;

      const label = documentRef.createElement('span');
      label.className = 'dr-timeline-tick-label';
      label.textContent = formatDate(addDays(model.timelineStart, dayOffset));
      tick.appendChild(label);
      axis.appendChild(tick);
    }
  }

  function renderTimeline(documentRef, viewport, model) {
    viewport.replaceChildren();

    if (!model.blocks.length || !model.timelineStart) {
      const empty = documentRef.createElement('div');
      empty.className = 'dr-timeline-empty';
      empty.textContent = model.sourceAdsCount
        ? 'Rodzina nie ma reklam z poprawną datą startu.'
        : 'Ta rodzina nie zawiera jeszcze reklam.';
      viewport.appendChild(empty);
      return;
    }

    const canvas = documentRef.createElement('div');
    canvas.className = 'dr-timeline-canvas';
    const canvasHeight = Math.max(180, 76 + (model.laneCount * 40));
    canvas.style.minWidth = `${model.canvasMinWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    canvas.style.setProperty('--dr-canvas-height', `${canvasHeight}px`);

    const axis = documentRef.createElement('div');
    axis.className = 'dr-timeline-axis';
    renderTicks(documentRef, axis, model);
    canvas.appendChild(axis);

    const lanes = documentRef.createElement('div');
    lanes.className = 'dr-timeline-lanes';
    canvas.appendChild(lanes);

    for (const block of model.blocks) {
      const blockElement = documentRef.createElement('div');
      blockElement.className = 'dr-timeline-block';
      blockElement.tabIndex = 0;
      blockElement.setAttribute('role', 'img');
      blockElement.setAttribute('aria-describedby', TOOLTIP_ID);
      blockElement.setAttribute(
        'aria-label',
        `${block.title}; ${block.startDate}; ${block.daysActive} dni; ${block.lifecycle}`,
      );
      blockElement.style.setProperty('--dr-left', `${block.leftPercent}%`);
      blockElement.style.left = `${block.leftPercent}%`;
      blockElement.style.width = `max(12px, ${block.widthPercent}%)`;
      blockElement.style.top = `${58 + (block.lane * 40)}px`;
      blockElement.style.background = block.color;
      blockElement.dataset.adId = block.adArchiveId;

      const label = documentRef.createElement('span');
      label.className = 'dr-timeline-block-label';
      label.textContent = `${block.title} · ${block.daysActive}d`;
      blockElement.appendChild(label);

      blockElement.addEventListener('mouseenter', () => {
        if (!state.pinnedAdId) showTooltip(blockElement, block);
      });
      blockElement.addEventListener('mouseleave', hideTooltip);
      blockElement.addEventListener('focus', () => {
        if (!state.pinnedAdId) showTooltip(blockElement, block);
      });
      blockElement.addEventListener('blur', hideTooltip);
      blockElement.addEventListener('click', event => {
        event.stopPropagation();
        state.pinnedAdId = state.pinnedAdId === block.adArchiveId ? null : block.adArchiveId;
        if (state.pinnedAdId) showTooltip(blockElement, block, { pinned: true });
        else hideTooltip(true);
      });
      lanes.appendChild(blockElement);
    }

    viewport.appendChild(canvas);
  }

  function renderFamily(family) {
    const documentRef = state.document;
    const overlay = createModal(documentRef);
    const model = buildTimelineModel(family);
    state.currentModel = model;
    state.zoom = 1;
    state.pinnedAdId = null;
    hideTooltip(true);
    const ads = familyAds(family);
    const firstAd = ads[0] || {};
    const landingUrl = firstDefined(
      family.landingUrlClean,
      family.landing_url_clean,
      firstAd.canonicalUrl,
      firstAd.canonical_destination_url,
      firstAd.destinationUrl,
      firstAd.destination_url,
      '—',
    );
    const familyLabel = landingPath(landingUrl) || family.id || family.family_id || 'bez identyfikatora';
    const familyClass = firstDefined(family.familyClass, family.classification, 'UNCLASSIFIED');
    const familyId = firstDefined(family.id, family.familyId, family.family_id, '—');
    const pageId = firstDefined(family.pageId, family.page_id, firstAd.pageId, firstAd.page_id, '—');

    overlay.querySelector('#dr-timeline-title').textContent = `Rodzina: ${familyLabel} · ${familyClass} · ${model.sourceAdsCount} reklam`;
    overlay.querySelector('#dr-timeline-subtitle').textContent = `family_id: ${familyId} · page_id: ${pageId} · ${landingUrl}`;

    const summary = overlay.querySelector('.dr-timeline-summary');
    summary.replaceChildren();
    const summaryValues = [
      `Zakres: ${formatDate(model.timelineStart)} – ${formatDate(model.timelineEnd)}`,
      `Rozpiętość: ${model.totalDays || 0} dni`,
      `Reklamy: ${model.sourceAdsCount}`,
      `Łącznie aktywne: ${firstDefined(family.coveredDeliveryDays, family.totalActiveDays, family.total_active_days, '—')} dni`,
      `Status: ${firstDefined(family.familyStatus, family.status, '—')}`,
    ];
    if (model.undatedAdsCount) summaryValues.push(`Bez daty: ${model.undatedAdsCount}`);

    for (const value of summaryValues) {
      const chip = documentRef.createElement('span');
      chip.className = 'dr-timeline-chip';
      chip.textContent = value;
      summary.appendChild(chip);
    }

    renderTimeline(documentRef, overlay.querySelector('.dr-timeline-viewport'), model);
    setTimelineZoom(1);
    createLegend(documentRef, overlay.querySelector('.dr-timeline-legend'));
  }

  function familyKey(family) {
    return String(firstDefined(family?.id, family?.familyId, family?.family_id, ''));
  }

  function setFamilies(families) {
    state.families.clear();
    for (const family of Array.isArray(families) ? families : []) {
      const key = familyKey(family);
      if (key) state.families.set(key, family);
    }
  }

  function openFamilyTimeline(familyId) {
    if (!state.document) return false;
    const key = String(familyId || '');
    const family = state.families.get(key);
    if (!family) return false;

    injectStyles(state.document);
    const overlay = createModal(state.document);
    state.previousFocus = state.document.activeElement;
    state.previousBodyOverflow = state.document.body.style.overflow;
    renderFamily(family);
    overlay.hidden = false;
    state.document.body.style.overflow = 'hidden';
    overlay.querySelector('.dr-timeline-close').focus();
    return true;
  }

  function closeFamilyTimeline() {
    if (!state.overlay || state.overlay.hidden) return;
    state.pinnedAdId = null;
    state.currentModel = null;
    hideTooltip(true);
    state.overlay.hidden = true;
    if (state.document) state.document.body.style.overflow = state.previousBodyOverflow;
    if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
      state.previousFocus.focus();
    }
    state.previousFocus = null;
  }

  function install(documentRef) {
    if (!documentRef || state.installed) return;
    state.document = documentRef;
    state.installed = true;
    injectStyles(documentRef);

    documentRef.addEventListener('click', event => {
      const button = event.target.closest?.('.offer-family-timeline-btn');
      if (!button) return;
      openFamilyTimeline(button.dataset.familyId);
    });

    documentRef.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeFamilyTimeline();
    });
  }

  return {
    install,
    setFamilies,
    openFamilyTimeline,
    closeFamilyTimeline,
    buildTimelineModel,
    lifecycleConfig: LIFECYCLE_CONFIG,
  };
});

