import { lstat, readdir, readlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Read metadata only. Link-count/ctime changes from our private hardlink view
// are not edits. Never follow links into another project or read media bytes.
export async function projectMetadata(root, { limit = 100000 } = {}) {
  const hash = createHash('sha256'); let count = 0;
  async function visit(relative) {
    if (++count > limit) throw new Error('WE_PROJECT_METADATA_TOO_LARGE');
    const file = path.join(root, relative), info = await lstat(file, { bigint: true });
    const kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    const row = [relative.replaceAll(path.sep, '/'), kind, String(info.dev), String(info.ino), String(info.mode)];
    // Directory names/identity are sufficient: adding/removing a child is
    // represented by its own row, without incidental directory timestamps.
    if (kind !== 'directory') row.push(String(info.size), String(info.mtimeNs));
    if (kind === 'link') row.push(await readlink(file));
    hash.update(JSON.stringify(row)); hash.update('\n');
    if (kind === 'directory') {
      const names = await readdir(file);
      names.sort();
      for (const name of names) await visit(path.join(relative, name));
    }
  }
  await visit(''); return hash.digest('hex');
}

export class SourceWatch {
  constructor(root, { changed, notified, failed, snapshot = projectMetadata, watchRoot = watch, clock = Date.now, debounceMs = 100 } = {}) {
    Object.assign(this, { root, changed, notified, failed, snapshot, clock, debounceMs });
    this.version = 0; this.checkedVersion = -1; this.lastScan = -Infinity;
    try {
      this.watcher = watchRoot(root, { recursive: true }, () => this.signal());
      this.watcher.on('error', error => {
        if (this.closed) return;
        this.watcher?.close(); this.watcher = null; this.signal(); this.failed?.(error);
      });
    } catch (error) { this.failed?.(error); }
  }
  get pending() { return this.version !== this.checkedVersion; }
  signal() {
    if (this.closed) return;
    this.version++; this.notified?.(); this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.refresh().catch(error => {
      if (!this.closed) this.failed?.(error);
    }); }, this.debounceMs);
    this.timer.unref?.();
  }
  async refresh() {
    if (this.closed) return;
    if (this.scanning) return this.scanning;
    clearTimeout(this.timer); this.timer = null;
    const version = this.version;
    this.scanning = (async () => {
      const next = await this.snapshot(this.root);
      if (this.closed) return;
      const changed = this.baseline !== undefined && next !== this.baseline;
      this.baseline = next; this.checkedVersion = version; this.lastScan = this.clock();
      if (changed) this.changed?.();
    })();
    try { await this.scanning; }
    finally {
      this.scanning = null;
      // An event during the scan is never acknowledged by that older scan.
      if (!this.closed && this.version !== version) this.schedule();
    }
  }
  async ready() {
    if (this.scanning) await this.scanning;
    if (this.baseline === undefined || this.pending || (!this.watcher && this.clock() - this.lastScan >= 3000)) await this.refresh();
  }
  close() { this.closed = true; clearTimeout(this.timer); this.watcher?.close(); }
}
