import { buildDailyReport } from './daily-report.js';

const fields = ["observationId", "station", "hour", "value", "unit", "quality", "revision"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "站点观测接收器", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}

// 业务消费入口的日报视图：覆盖范围来自应报站点清单，缺测与未收到照常出现，
// 汇总只采用覆盖完整且 validated 的数据，并引用当前质控版本作为依据。
export async function readDailyReport(observationRepository, population) {
  return buildDailyReport(population, await observationRepository.read());
}
