import { schema } from './schema.js';

// 日报覆盖范围只来自应报站点清单（stations × hours），与本次返回了哪些记录无关。
// 每个应报单元都会出现在 cells 中：未收到是 absent，明确缺测是 missing（带原因），
// 二者都不是零值；provisional 展示暂定值但不进汇总；只有 validated 才进入汇总。
export function buildDailyReport(population, state) {
  const stations = [...new Set((population.stations ?? []).map(String))].sort();
  const hours = [...new Set((population.hours ?? []).map(String))].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );
  const index = new Map();
  for (const entry of state.observations ?? []) index.set(cellKey(entry.station, entry.hour), entry);

  const cells = [];
  for (const station of stations) {
    for (const hour of hours) {
      const entry = index.get(cellKey(station, hour));
      cells.push(entry ? presentCell(entry) : absentCell(station, hour));
    }
  }

  const coverage = {
    expected: cells.length,
    received: cells.filter((cell) => cell.status !== 'absent').length,
    validated: cells.filter((cell) => cell.status === 'validated').length,
    provisional: cells.filter((cell) => cell.status === 'provisional').length,
    missing: cells.filter((cell) => cell.status === 'missing').length,
    absent: cells.filter((cell) => cell.status === 'absent').length,
  };

  const days = [...new Set(hours.map((hour) => new Date(hour).toISOString().slice(0, 10)))];
  return {
    product: schema.product,
    report: '日报',
    day: days.length === 1 ? days[0] : null,
    days,
    coverage,
    cells,
    summaries: stations.map((station) => stationSummary(station, cells.filter((cell) => cell.station === station))),
  };
}

function cellKey(station, hour) {
  return `${station}|${new Date(hour).toISOString()}`;
}

function presentCell(entry) {
  const { current, versions } = entry;
  return {
    station: entry.station,
    hour: entry.hour,
    observationId: entry.observationId,
    status: current.quality,
    value: current.value,
    unit: current.unit,
    quality: current.quality,
    reason: current.reason,
    revision: current.revision,
    revisions: versions.map((version) => version.revision),
    corrected: versions.length > 1,
  };
}

function absentCell(station, hour) {
  return {
    station,
    hour,
    observationId: null,
    status: 'absent',
    value: null,
    unit: null,
    quality: null,
    reason: null,
    revision: null,
    revisions: [],
    corrected: false,
  };
}

// 单站日均汇总：只有该站应报小时全部为 validated 时才可判定；
// 否则保持 undetermined 并逐一列出阻断单元及原因，绝不用零值凑数。
// basis 引用当前版本（observationId + revision），质控修正到达后随 current 一起更新。
function stationSummary(station, cells) {
  const blockers = cells
    .filter((cell) => cell.status !== 'validated')
    .map((cell) => ({ station: cell.station, hour: cell.hour, status: cell.status, reason: cell.reason }));
  if (cells.length === 0 || blockers.length > 0) {
    return { station, metric: 'dailyMean', status: 'undetermined', value: null, unit: null, blockers };
  }
  const mean = cells.reduce((total, cell) => total + cell.value, 0) / cells.length;
  return {
    station,
    metric: 'dailyMean',
    status: 'ok',
    value: Math.round(mean * 1000) / 1000,
    unit: cells[0].unit,
    basis: cells.map((cell) => ({ observationId: cell.observationId, revision: cell.revision, hour: cell.hour })),
  };
}
