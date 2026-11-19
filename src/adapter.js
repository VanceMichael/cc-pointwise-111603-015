export const entryPath = "/stations/S1/hourly";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  if (next !== null && typeof next !== 'string') throw new Error('source next must be a path or null');
  return { next, records: items.map((item) => ({
    sourceId: String(item["observationId"]),
    source: "站点观测接收器",
    observedAt: item["hour"],
    label: String(item["station"]),
    attributes: structuredClone(item),
  })) };
}

function resolveNext(current, next) {
  if (!next) return null;
  if (next.startsWith('/')) return next;
  const base = new URL(current, 'http://source.local');
  const resolved = new URL(next, base);
  return `${resolved.pathname}${resolved.search}`;
}

/**
 * Follow the source's `next` links until the page set is exhausted. The
 * adapter itself stays unaware of business identity; every page is parsed with
 * the same rules so revisions are preserved by the collection service.
 */
export async function readAllPages(client, path = entryPath) {
  const records = [];
  const pages = [];
  const visited = new Set();
  let current = path;
  while (current) {
    if (visited.has(current)) throw new Error(`source page cycle at ${current}`);
    visited.add(current);
    const response = await client.read(current);
    const page = parsePage(response);
    pages.push({ path: current, next: page.next, records: page.records.length });
    records.push(...page.records);
    current = resolveNext(current, page.next);
  }
  return { records, pages };
}
