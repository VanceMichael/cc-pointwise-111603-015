export const entryPath = "/stations/S1/hourly";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["observationId"]),
    source: "站点观测接收器",
    observedAt: item["hour"],
    label: String(item["station"]),
    attributes: structuredClone(item),
  })) };
}
