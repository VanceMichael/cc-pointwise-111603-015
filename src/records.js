import { schema } from './schema.js';

const QUALITIES = new Set(['provisional', 'validated', 'missing']);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function trimmed(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseValue(value, sourceId) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid value for ${sourceId}`);
  return number;
}

function parseRevision(value, sourceId) {
  if (value === undefined || value === null || String(value).trim() === '') return 1;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`invalid revision for ${sourceId}`);
  return revision;
}

function normalizeQuality(value, sourceId) {
  const quality = trimmed(value).toLowerCase();
  if (!quality) return 'provisional';
  if (!QUALITIES.has(quality)) throw new Error(`invalid quality for ${sourceId}: ${value}`);
  return quality;
}

export function stationOf(record) {
  return trimmed(record?.station ?? record?.attributes?.station ?? record?.label);
}

export function revisionOf(record) {
  // Reading persisted or foreign state should never fail because of one bad
  // revision; strict validation happens during ingest via parseRevision.
  const revision = Number(record?.revision ?? record?.attributes?.revision ?? 1);
  return Number.isInteger(revision) && revision >= 1 ? revision : 1;
}

/**
 * Normalize a source row into an observation. The normalized `value` is null
 * whenever the row is missing, even if the source sent a numeric placeholder.
 * The untouched source object is kept in `sourceAttributes` for traceability.
 */
export function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${schema.entity} must be an object`);
  }
  const rawAttributes = input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
    ? structuredClone(input.attributes) : {};
  const sourceAttributes = input.sourceAttributes && typeof input.sourceAttributes === 'object'
    && !Array.isArray(input.sourceAttributes)
    ? structuredClone(input.sourceAttributes) : structuredClone(rawAttributes);
  const record = {
    sourceId: trimmed(input.sourceId),
    source: trimmed(input.source),
    observedAt: trimmed(input.observedAt),
    label: trimmed(input.label),
    attributes: rawAttributes,
    sourceAttributes,
  };
  for (const field of schema.required) {
    if (!record[field]) throw new Error(`missing ${field} for ${schema.entity}`);
  }
  if (!Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error(`invalid observedAt for ${schema.entity}`);
  }

  const station = trimmed(input.station ?? rawAttributes.station ?? record.label);
  const unit = trimmed(input.unit ?? rawAttributes.unit);
  const quality = normalizeQuality(input.quality ?? rawAttributes.quality, record.sourceId);
  const revision = parseRevision(input.revision ?? rawAttributes.revision, record.sourceId);
  const reason = trimmed(input.reason ?? rawAttributes.reason) || null;
  const reportedValue = parseValue(
    hasOwn(input, 'value') ? input.value : rawAttributes.value,
    record.sourceId,
  );
  // A missing observation never carries a numeric value. This prevents a
  // placeholder 0 from being read as a real, clean measurement downstream.
  const value = quality === 'missing' ? null : reportedValue;

  record.station = station || record.label;
  record.value = value;
  record.unit = unit || null;
  record.quality = quality;
  record.revision = revision;
  record.reason = reason;

  record.attributes = {
    ...structuredClone(rawAttributes),
    station: record.station,
    value,
    quality,
    revision,
    reason,
  };
  if (quality === 'missing' && reportedValue !== null) {
    record.attributes.reportedValue = reportedValue;
  }
  return record;
}

/**
 * Explicit status for consumers. `missing` is intentionally distinct from a
 * valid zero observation; the only way to get a numeric value here is for a
 * non-missing row to carry one.
 */
export function describeObservation(record) {
  const sourceId = record?.sourceId ?? 'record';
  let quality;
  try {
    quality = normalizeQuality(record?.quality ?? record?.attributes?.quality, sourceId);
  } catch {
    return { status: 'invalid', value: null, quality: trimmed(record?.quality ?? record?.attributes?.quality) || null, reason: 'invalid-quality' };
  }
  const reason = trimmed(record?.reason ?? record?.attributes?.reason) || null;
  const rawValue = hasOwn(record, 'value') ? record.value : record?.attributes?.value;
  if (quality === 'missing') {
    return { status: 'missing', value: null, quality, reason: reason ?? 'unspecified' };
  }
  let value;
  try {
    value = parseValue(rawValue, sourceId);
  } catch {
    return { status: 'invalid', value: null, quality, reason: reason ?? 'invalid-value' };
  }
  if (value === null) {
    return { status: 'missing', value: null, quality, reason: reason ?? 'value-unavailable' };
  }
  if (quality === 'validated') return { status: 'validated', value, quality, reason };
  if (quality === 'provisional') return { status: 'provisional', value, quality, reason };
  return { status: 'invalid', value: null, quality, reason: reason ?? 'invalid-quality' };
}

export function observationStatus(record) {
  return describeObservation(record).status;
}

export function versionKey(record) {
  return `${String(record?.sourceId ?? '')}\u0000${revisionOf(record)}`;
}

export function observationKey(record) {
  return String(record?.sourceId ?? '');
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentKey(record) {
  // Compare the payload the source actually sent. Normalized records keep it
  // in `sourceAttributes`; records read from legacy state only have
  // `attributes`, which was the raw payload at the time.
  return stableValue({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    payload: record.sourceAttributes ?? record.attributes ?? {},
  });
}

export function citationOf(record) {
  const summary = describeObservation(record);
  const revision = revisionOf(record);
  return {
    observationId: record.sourceId,
    sourceId: record.sourceId,
    source: record.source,
    station: stationOf(record),
    hour: record.observedAt,
    revision,
    quality: summary.quality,
    value: summary.value,
    reason: summary.reason,
    basis: `${record.sourceId}@${revision}`,
    citationId: `${record.sourceId}@${revision}`,
  };
}

/**
 * Merge revisions without losing the earlier version of a station-hour.
 * `records` remains the current (highest-revision) view for legacy consumers;
 * `versions` contains each distinct `sourceId + revision` exactly once.
 */
export function mergeVersionedRecords(existingVersions, incoming, existingRecords = []) {
  const versions = new Map();
  const addExisting = (record) => {
    if (!record || typeof record !== 'object') return;
    const key = versionKey(record);
    if (!versions.has(key)) versions.set(key, record);
  };
  for (const record of existingVersions ?? []) addExisting(record);
  for (const record of existingRecords ?? []) addExisting(record);

  const previousLatest = new Map();
  for (const record of existingRecords ?? []) {
    const key = observationKey(record);
    const current = previousLatest.get(key);
    if (!current || revisionOf(record) > revisionOf(current)) previousLatest.set(key, record);
  }

  const stats = { added: 0, duplicates: 0, corrections: 0, conflicts: [] };
  for (const record of incoming) {
    const key = versionKey(record);
    const current = versions.get(key);
    if (current) {
      if (contentKey(current) === contentKey(record)) {
        stats.duplicates += 1;
      } else {
        stats.conflicts.push({
          sourceId: record.sourceId,
          station: stationOf(record),
          hour: record.observedAt,
          revision: revisionOf(record),
          signature: contentKey(record),
          message: `conflicting content for ${record.sourceId} revision ${revisionOf(record)}`,
        });
      }
      continue;
    }
    versions.set(key, record);
    stats.added += 1;
    const previous = previousLatest.get(observationKey(record));
    if (previous && revisionOf(record) > revisionOf(previous)) stats.corrections += 1;
    if (!previous || revisionOf(record) > revisionOf(previous)) {
      previousLatest.set(observationKey(record), record);
    }
  }

  const latest = new Map();
  for (const record of versions.values()) {
    const key = observationKey(record);
    const current = latest.get(key);
    if (!current || revisionOf(record) > revisionOf(current)) latest.set(key, record);
  }

  const records = [...latest.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sortedVersions = [...versions.values()].sort((left, right) => (
    left.sourceId.localeCompare(right.sourceId) || revisionOf(left) - revisionOf(right)
  ));
  return { records, versions: sortedVersions, ...stats };
}

export function mergeRecords(existing, incoming) {
  const merged = new Map(existing.map((record) => [record.sourceId, record]));
  for (const record of incoming) {
    const current = merged.get(record.sourceId);
    if (!current || Date.parse(record.observedAt) >= Date.parse(current.observedAt)) {
      merged.set(record.sourceId, record);
    }
  }
  return [...merged.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export function findRecords(records, { source, from, to } = {}) {
  return records.filter((record) => {
    if (source && record.source !== source) return false;
    const timestamp = Date.parse(record.observedAt);
    if (from && timestamp < Date.parse(from)) return false;
    if (to && timestamp > Date.parse(to)) return false;
    return true;
  });
}
