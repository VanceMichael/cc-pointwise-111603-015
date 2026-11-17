import { findRecords, mergeRecords, normalizeRecord } from './records.js';
import { mergeObservations, normalizeObservation } from './observations.js';

export class CollectionService {
  constructor(repository) { this.repository = repository; }

  async ingest(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const accepted = inputs.map(normalizeRecord);
    const current = await this.repository.read();
    const merged = mergeRecords(current, accepted);
    await this.repository.replace(merged);
    return { accepted: accepted.length, stored: merged.length };
  }

  async query(filters) { return findRecords(await this.repository.read(), filters); }
}

// 小时观测的版本化接入：接受适配器产出的记录（attributes 为来源项目）或原始来源项目，
// 逐版本归并到观测状态。返回 added 表示本次真正追加的版本数，重放批次 added 为 0。
export class ObservationService {
  constructor(repository) { this.repository = repository; }

  async ingest(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const items = inputs.map((input) => (
      input && typeof input === 'object' && input.attributes && typeof input.attributes === 'object'
        ? input.attributes
        : input
    ));
    const accepted = items.map(normalizeObservation);
    const current = await this.repository.read();
    const merged = mergeObservations(current, accepted);
    await this.repository.replace(merged.state);
    return { accepted: accepted.length, stored: merged.state.observations.length, added: merged.added };
  }

  async state() { return this.repository.read(); }
}
