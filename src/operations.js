import { citationOf, describeObservation, findRecords, revisionOf, stationOf } from './records.js';
import { buildDailyReport } from './report.js';

const fields = ["observationId", "station", "hour", "value", "reportedValue", "unit", "quality", "reason", "revision"];

function operationRow(record) {
  const detail = describeObservation(record);
  const citation = citationOf(record);
  return {
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    station: stationOf(record),
    status: detail.status,
    value: detail.value,
    basis: citation.basis,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  };
}

/**
 * Business read entry. `rows` is the current, de-duplicated view; `versions`
 * preserves every station-hour revision so corrections can be traced.
 * `dailyReport` is present when a population is supplied.
 */
export async function readOperations(repository, { population, date, filters } = {}) {
  const state = await repository.readState();
  const applyFilters = filters && (filters.source || filters.from || filters.to);
  const versions = applyFilters ? findRecords(state.versions, filters) : state.versions;
  const records = applyFilters ? findRecords(state.records, filters) : state.records;
  const result = {
    product: "站点观测接收器",
    rows: records.map(operationRow),
    versions: versions.map((record) => ({
      ...operationRow(record),
      revision: revisionOf(record),
    })),
    conflicts: state.conflicts ?? [],
  };
  if (population) {
    result.dailyReport = buildDailyReport({ population, versions, conflicts: state.conflicts ?? [], date });
  }
  return result;
}
