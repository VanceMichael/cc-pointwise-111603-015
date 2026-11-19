import {
  citationOf,
  describeObservation,
  revisionOf,
  stationOf,
} from './records.js';

function isoHour(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid report hour: ${value}`);
  return new Date(timestamp).toISOString();
}

function normalizePopulation(population) {
  if (!population || !Array.isArray(population.stations) || !Array.isArray(population.hours)) {
    throw new TypeError('population must contain stations and hours arrays');
  }
  const stations = [...new Set(population.stations.map((station) => String(station).trim()).filter(Boolean))];
  // Keep the population's own hour spelling as the report label while using
  // the normalized instant for matching source rows.
  const byInstant = new Map();
  for (const hour of population.hours) {
    const instant = isoHour(hour);
    if (!byInstant.has(instant)) byInstant.set(instant, String(hour).trim());
  }
  const hours = [...byInstant.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([instant, label]) => ({ instant, label }));
  if (!stations.length || !hours.length) throw new Error('population must not be empty');
  return { stations, hours };
}

function cellKey(station, hour) {
  return `${station}\u0000${hour}`;
}

function groupVersions(versions) {
  const groups = new Map();
  for (const record of versions) {
    const station = stationOf(record);
    if (!station) continue;
    const key = cellKey(station, isoHour(record.observedAt));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

function unitOf(record) {
  const unit = record?.unit ?? record?.attributes?.unit;
  return unit === undefined || unit === null || String(unit).trim() === '' ? null : String(unit).trim();
}

function latestCell(group) {
  if (!group?.length) return null;
  const revision = Math.max(...group.map(revisionOf));
  const candidates = group.filter((record) => revisionOf(record) === revision);
  return { revision, candidates, conflict: candidates.length > 1 };
}

function statusDetail(summary) {
  if (summary.status === 'missing') return summary.reason ? `missing (${summary.reason})` : 'missing';
  if (summary.status === 'provisional') return 'provisional (not final)';
  if (summary.status === 'absent') return 'not-received';
  return summary.reason ? `${summary.status} (${summary.reason})` : summary.status;
}

function buildCell(station, hour, group, conflictedRevisions = new Set()) {
  const latest = latestCell(group);
  const base = { station, hour };
  if (!latest) {
    return {
      ...base,
      status: 'absent',
      value: null,
      unit: null,
      quality: null,
      reason: 'not-received',
      detail: 'not-received',
      revision: null,
      basis: null,
      citation: null,
      countsTowardSummary: false,
      versions: 0,
    };
  }
  if (latest.conflict || conflictedRevisions.has(latest.revision)) {
    return {
      ...base,
      status: 'conflict',
      value: null,
      unit: null,
      quality: null,
      reason: 'conflicting-content-same-revision',
      detail: 'conflict',
      revision: latest.revision,
      basis: null,
      citation: null,
      countsTowardSummary: false,
      versions: group.length,
    };
  }
  const record = latest.candidates[0];
  const detail = describeObservation(record);
  const citation = citationOf(record);
  return {
    ...base,
    sourceId: record.sourceId,
    status: detail.status,
    // Only a non-missing observation may expose a numeric value; a missing
    // row is reported as null even if the source sent a placeholder zero.
    value: detail.value,
    unit: unitOf(record),
    quality: detail.quality,
    reason: detail.reason,
    detail: statusDetail(detail),
    revision: latest.revision,
    basis: citation.basis,
    citation,
    countsTowardSummary: detail.status === 'validated' && detail.value !== null,
    versions: group.length,
  };
}

function summarize(label, cells) {
  const counts = { expected: cells.length, validated: 0, provisional: 0, missing: 0, absent: 0, invalid: 0, conflict: 0 };
  for (const cell of cells) {
    if (Object.prototype.hasOwnProperty.call(counts, cell.status)) counts[cell.status] += 1;
    else counts.invalid += 1;
  }
  const included = cells.filter((cell) => cell.countsTowardSummary);
  const excluded = cells.filter((cell) => !cell.countsTowardSummary);
  // A summary is per unit. If the validated observations disagree on unit,
  // averaging them would be meaningless, so the summary stays undetermined.
  const units = new Set(included.map((cell) => cell.unit));
  const unitMismatch = units.size > 1;
  const determined = cells.length > 0 && included.length === cells.length && !unitMismatch;
  const reasons = excluded.map((cell) => `${cell.station} ${cell.hour}: ${cell.detail}`);
  if (unitMismatch) reasons.push('inconsistent units across included observations');
  const value = determined
    ? included.reduce((total, cell) => total + cell.value, 0) / included.length
    : null;
  return {
    label,
    status: determined ? 'determined' : 'undetermined',
    aggregation: 'mean',
    sampleSize: included.length,
    value,
    unit: determined && units.size === 1 ? [...units][0] : null,
    counts,
    included: included.map((cell) => ({
      station: cell.station,
      hour: cell.hour,
      value: cell.value,
      basis: cell.basis,
    })),
    excluded: excluded.map((cell) => ({
      station: cell.station,
      hour: cell.hour,
      status: cell.status,
      reason: cell.reason,
      detail: cell.detail,
      basis: cell.basis,
    })),
    citations: determined ? included.map((cell) => cell.citation) : [],
    undeterminedReasons: determined ? [] : reasons,
  };
}

/**
 * Build a daily report from the expected station population, never from the
 * records that happened to be returned. Every expected station-hour appears,
 * including those that were not received. Only a fully validated set of cells
 * may feed a summary; missing/provisional/absent cells never become zero.
 */
export function buildDailyReport({ population, versions = [], conflicts = [], date } = {}) {
  const expected = normalizePopulation(population);
  const hours = date ? expected.hours.filter((hour) => hour.label.startsWith(String(date))) : expected.hours;
  if (!hours.length) throw new Error(`population has no hours for ${date}`);
  const groups = groupVersions(versions);
  // A conflict recorded during ingest may have been seen on a different
  // revision than the locally stored one; treat that cell as conflicted rather
  // than picking one version silently.
  const conflictedByIdentity = new Map();
  for (const conflict of conflicts) {
    const station = String(conflict.station ?? '').trim();
    const hour = conflict.hour ? isoHour(conflict.hour) : null;
    if (!station || !hour) continue;
    if (!conflictedByIdentity.has(cellKey(station, hour))) conflictedByIdentity.set(cellKey(station, hour), new Set());
    conflictedByIdentity.get(cellKey(station, hour)).add(Number(conflict.revision));
  }
  const cells = [];
  for (const hour of hours) {
    for (const station of expected.stations) {
      const key = cellKey(station, hour.instant);
      const cell = buildCell(station, hour.label, groups.get(key), conflictedByIdentity.get(key) ?? new Set());
      cell.hour = hour.label;
      cell.observedAt = hour.instant;
      cells.push(cell);
    }
  }

  const missingStations = expected.stations.filter((station) => {
    const stationCells = cells.filter((cell) => cell.station === station);
    return stationCells.some((cell) => cell.status === 'missing' || cell.status === 'absent');
  });
  const notReceivedStations = expected.stations.filter((station) => (
    cells.filter((cell) => cell.station === station).every((cell) => cell.status === 'absent')
  ));
  const incompleteStations = expected.stations.filter((station) => (
    !cells.filter((cell) => cell.station === station).every((cell) => cell.countsTowardSummary)
  ));

  const byStation = expected.stations.map((station) => summarize(
    `station:${station}`,
    cells.filter((cell) => cell.station === station),
  ));
  const byHour = hours.map((hour) => summarize(
    `hour:${hour.label}`,
    cells.filter((cell) => cell.hour === hour.label),
  ));
  const daily = summarize('day', cells);
  const summaries = [...byStation, ...byHour, daily];

  const counts = { expected: cells.length, validated: 0, provisional: 0, missing: 0, absent: 0, invalid: 0, conflict: 0 };
  for (const cell of cells) {
    if (Object.prototype.hasOwnProperty.call(counts, cell.status)) counts[cell.status] += 1;
    else counts.invalid += 1;
  }
  const complete = counts.expected > 0 && counts.validated === counts.expected;

  return {
    date: date ?? null,
    population: {
      stations: expected.stations,
      hours: hours.map((hour) => hour.label),
    },
    status: complete ? 'complete' : 'incomplete',
    coverage: counts,
    stations: expected.stations.map((station) => {
      const stationCells = cells.filter((cell) => cell.station === station);
      const allValidated = stationCells.every((cell) => cell.countsTowardSummary);
      return {
        station,
        status: allValidated
          ? 'complete'
          : (stationCells.every((cell) => cell.status === 'absent') ? 'not-received' : 'incomplete'),
        cells: stationCells,
      };
    }),
    missingStations,
    notReceivedStations,
    incompleteStations,
    cells,
    summaries,
    undeterminedSummaries: summaries
      .filter((summary) => summary.status === 'undetermined')
      .map((summary) => ({
        summary: summary.label,
        reasons: summary.undeterminedReasons,
      })),
  };
}
