import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function revisionOf(record) {
  const revision = Number(record?.revision ?? record?.attributes?.revision ?? 1);
  return Number.isInteger(revision) && revision > 0 ? revision : 1;
}

function identityOf(record) {
  return String(record?.sourceId ?? '');
}

/**
 * The current view is always derived from the stored versions. Keeping this
 * derivation in one place means a correction and the report that cites it can
 * never disagree about which revision is current.
 */
export function latestVersions(versions) {
  const latest = new Map();
  for (const record of versions) {
    const key = identityOf(record);
    const current = latest.get(key);
    if (!current || revisionOf(record) > revisionOf(current)) latest.set(key, record);
  }
  return [...latest.values()].sort((left, right) => identityOf(left).localeCompare(identityOf(right)));
}

export class RecordRepository {
  constructor(path) { this.path = path; }

  async readState() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value.records) && !Array.isArray(value.versions)) {
        throw new Error('record file has no records or versions array');
      }
      const versions = Array.isArray(value.versions)
        ? value.versions
        : (Array.isArray(value.records) ? value.records : []);
      const records = Array.isArray(value.records) && !Array.isArray(value.versions)
        ? value.records
        : latestVersions(versions);
      const conflicts = Array.isArray(value.conflicts) ? value.conflicts : [];
      return { records, versions, conflicts };
    } catch (error) {
      if (error.code === 'ENOENT') return { records: [], versions: [], conflicts: [] };
      throw error;
    }
  }

  async read() {
    return (await this.readState()).records;
  }

  async readVersions() {
    return (await this.readState()).versions;
  }

  async replaceState({ records, versions, conflicts = [] }) {
    const state = {
      records: Array.isArray(records) ? records : latestVersions(versions ?? []),
      versions: Array.isArray(versions) ? versions : [],
      conflicts: Array.isArray(conflicts) ? conflicts : [],
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }

  async replace(records) {
    await this.replaceState({ records, versions: records });
  }
}
