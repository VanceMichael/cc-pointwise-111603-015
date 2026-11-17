import { isDeepStrictEqual } from 'node:util';
import { schema } from './schema.js';

export const qualities = Object.freeze(['provisional', 'validated', 'missing']);

// 接入边界在这里把三种事实分开：观测值（数值，含真实的 0）、
// 缺测原因（quality=missing 时 value 必须为 null 且给出 reason）、
// 质控更正（revision 单调递增，同一 observationId 的每个版本都保留）。
export function normalizeObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${schema.entity} must be an object`);
  }
  const observation = {
    observationId: String(input.observationId ?? '').trim(),
    station: String(input.station ?? '').trim(),
    hour: String(input.hour ?? '').trim(),
    quality: String(input.quality ?? '').trim(),
    revision: Number(input.revision),
    unit: input.unit == null ? null : String(input.unit).trim(),
    value: input.value === undefined ? null : input.value,
    reason: input.reason == null ? null : String(input.reason).trim(),
  };
  if (!observation.observationId) throw new Error(`missing observationId for ${schema.entity}`);
  if (!observation.station) throw new Error(`missing station for ${schema.entity}`);
  if (!Number.isFinite(Date.parse(observation.hour))) throw new Error(`invalid hour for ${schema.entity}`);
  if (!qualities.includes(observation.quality)) throw new Error(`invalid quality for ${schema.entity}`);
  if (!Number.isInteger(observation.revision) || observation.revision < 1) {
    throw new Error(`invalid revision for ${schema.entity}`);
  }
  if (observation.quality === 'missing') {
    // 缺测不是一次数值为 0 的观测：不允许的取值只有 null，并且必须说明原因。
    if (observation.value !== null) throw new Error(`missing ${schema.entity} must not carry a value`);
    if (!observation.reason) throw new Error(`missing ${schema.entity} requires a reason`);
  } else if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) {
    // 有效/暂定观测必须带数值；null 与 0 不等价，不能互相冒充。
    throw new Error(`${observation.quality} ${schema.entity} requires a numeric value`);
  }
  return observation;
}

// 按 observationId（站点小时）归并版本：同一 revision 重复到达是重放，不多算；
// 新 revision 追加进 versions 并成为 current，旧版本全部保留。
export function mergeObservations(state, observations) {
  const byId = new Map((state.observations ?? []).map((entry) => [entry.observationId, entry]));
  let added = 0;
  for (const observation of observations) {
    const entry = byId.get(observation.observationId);
    if (!entry) {
      byId.set(observation.observationId, {
        observationId: observation.observationId,
        station: observation.station,
        hour: observation.hour,
        current: observation,
        versions: [observation],
      });
      added += 1;
      continue;
    }
    if (entry.station !== observation.station || Date.parse(entry.hour) !== Date.parse(observation.hour)) {
      throw new Error(`identity conflict for ${observation.observationId}`);
    }
    const existing = entry.versions.find((version) => version.revision === observation.revision);
    if (existing) {
      if (!isDeepStrictEqual(existing, observation)) {
        throw new Error(`conflicting revision ${observation.revision} for ${observation.observationId}`);
      }
      continue;
    }
    entry.versions.push(observation);
    entry.versions.sort((left, right) => left.revision - right.revision);
    entry.current = entry.versions[entry.versions.length - 1];
    added += 1;
  }
  const merged = [...byId.values()].sort((left, right) => left.observationId.localeCompare(right.observationId));
  return { state: { observations: merged }, added };
}
