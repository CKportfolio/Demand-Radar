const DAY_MS = 24 * 60 * 60 * 1000;

const LONGEVITY_CATEGORIES = {
  BALON_PROBNY: 'BALON_PROBNY',
  TEST_W_TOKU: 'TEST_W_TOKU',
  ROKUJACA: 'ROKUJACA',
  MOCNA: 'MOCNA',
  EVERGREEN: 'EVERGREEN',
};

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function diffDays(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const diff = Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MS);
  return diff >= 0 ? diff : 0;
}

function calculateRuntimeDays({ startDate, endDate, isActive, now }) {
  const start = toDate(startDate);
  if (!start) return null;

  const parsedEnd = toDate(endDate);
  const effectiveEnd = isActive ? now : (parsedEnd || now);
  return diffDays(start, effectiveEnd);
}

function classifyAdLifecycle(input) {
  const now = input.now || new Date();
  const startDate = input.startDate || input.adDeliveryStartTime || null;
  const endDate = input.endDate || input.adDeliveryStopTime || null;
  const isActive = input.isActive != null
    ? Boolean(input.isActive)
    : !toDate(endDate);

  const runtimeDays = calculateRuntimeDays({
    startDate,
    endDate,
    isActive,
    now,
  });

  let longevityCategory = LONGEVITY_CATEGORIES.BALON_PROBNY;
  if (runtimeDays == null) {
    longevityCategory = LONGEVITY_CATEGORIES.BALON_PROBNY;
  } else if (runtimeDays <= 7) {
    longevityCategory = LONGEVITY_CATEGORIES.BALON_PROBNY;
  } else if (runtimeDays <= 30) {
    longevityCategory = LONGEVITY_CATEGORIES.TEST_W_TOKU;
  } else if (runtimeDays <= 90) {
    longevityCategory = LONGEVITY_CATEGORIES.ROKUJACA;
  } else if (runtimeDays <= 180) {
    longevityCategory = LONGEVITY_CATEGORIES.MOCNA;
  } else {
    longevityCategory = LONGEVITY_CATEGORIES.EVERGREEN;
  }

  const reasons = [
    runtimeDays == null
      ? 'Brak poprawnej daty startu emisji, przypisano kategorię ostrożną.'
      : `Runtime reklamy: ${runtimeDays} dni.`,
  ];

  return {
    lifecycleClass: longevityCategory,
    lifecycleConfidence: runtimeDays == null ? 45 : 70,
    lifecycleReasons: reasons,
    deliveryAgeDays: runtimeDays,
    runtimeDays,
    longevityCategory,
    isActive,
  };
}

module.exports = {
  LONGEVITY_CATEGORIES,
  classifyAdLifecycle,
  calculateRuntimeDays,
};
