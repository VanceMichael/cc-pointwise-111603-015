import { findRecords, mergeVersionedRecords, normalizeRecord, revisionOf } from './records.js';
import { latestVersions } from './repository.js';

export class CollectionService {
  constructor(repository) { this.repository = repository; }

  async ingest(inputs) {
    const details = await this.ingestBatch(inputs);
    // Keep the original public shape for existing callers; batch accounting is
    // available from ingestBatch when a caller needs it.
    return { accepted: details.accepted, stored: details.stored };
  }

  async ingestBatch(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const accepted = inputs.map(normalizeRecord);
    const state = await this.repository.readState();
    const merged = mergeVersionedRecords(state.versions, accepted, state.records);
    const conflicts = new Map((state.conflicts ?? []).map((conflict) => [
      `${conflict.sourceId}\u0000${conflict.revision}\u0000${conflict.signature ?? ''}`,
      conflict,
    ]));
    for (const conflict of merged.conflicts) {
      conflicts.set(`${conflict.sourceId}\u0000${conflict.revision}\u0000${conflict.signature ?? ''}`, conflict);
    }
    await this.repository.replaceState({
      records: merged.records,
      versions: merged.versions,
      conflicts: [...conflicts.values()],
    });
    return {
      accepted: accepted.length,
      stored: merged.records.length,
      versions: merged.versions.length,
      added: merged.added,
      duplicates: merged.duplicates,
      corrections: merged.corrections,
      conflicts: merged.conflicts,
    };
  }

  async query(filters) { return findRecords(await this.repository.read(), filters); }

  async history(sourceId) {
    const versions = await this.repository.readVersions();
    return versions
      .filter((record) => !sourceId || record.sourceId === sourceId)
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || revisionOf(left) - revisionOf(right));
  }

  async latest(sourceId) {
    return latestVersions(await this.repository.readVersions())
      .filter((record) => !sourceId || record.sourceId === sourceId);
  }
}
