import { HOST, runFile } from './platform.mjs';

export class ProcessSampler {
  constructor({ run = runFile, clock = Date.now, details = false, scope = 'bridge-process-tree' } = {}) { this.run = run; this.clock = clock; this.previous = new Map(); this.details=details; this.scope=scope; }
  async collect(roots) {
    const pids = [...new Set(roots.filter(pid => Number.isInteger(pid) && pid > 0))].slice(0, 8);
    const { stdout } = await this.run(HOST, ['--metrics', pids.join(',')], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    const rows = JSON.parse(stdout), now = this.clock(), next = new Map();
    let cpu = 0, comparable = false, memory = 0, privateBytes = 0, handles = 0;
    for (const row of rows) {
      const key = `${row.pid}:${row.identity}`, previous = this.previous.get(key);
      if (previous && now > previous.at && row.cpuMs >= previous.cpuMs) {
        cpu += (row.cpuMs - previous.cpuMs) / (now - previous.at); comparable = true;
      }
      next.set(key, { at: now, cpuMs: row.cpuMs });
      memory += row.memory; privateBytes += row.privateBytes; handles += row.handles;
    }
    this.previous = next;
    return { scope: this.scope, cpu: comparable ? cpu : null, memory, privateBytes, handles, processes: rows.length,
      ...(this.details ? { counters: rows } : {}) };
  }
}
