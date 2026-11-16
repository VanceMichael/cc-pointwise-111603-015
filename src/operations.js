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
