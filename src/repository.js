import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

class JsonArrayFile {
  constructor(path, key) {
    this.path = path;
    this.key = key;
  }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value[this.key])) throw new Error(`state file has no ${this.key} array`);
      return value[this.key];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async replace(items) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ [this.key]: items }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}

export class RecordRepository {
  constructor(path) { this.file = new JsonArrayFile(path, 'records'); }

  async read() { return this.file.read(); }

  async replace(records) { return this.file.replace(records); }
}

// 观测版本状态独立存放（默认 var/observations.json），与通用记录集合互不影响。
export class ObservationRepository {
  constructor(path) { this.file = new JsonArrayFile(path, 'observations'); }

  async read() { return { observations: await this.file.read() }; }

  async replace(state) { return this.file.replace(state.observations); }
}
