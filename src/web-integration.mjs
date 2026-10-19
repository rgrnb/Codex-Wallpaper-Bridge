import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Each helper is created only after the wallpaper requests that interface. Data
// stays in memory and is delivered to this wallpaper, never logged or recorded.
export class WebIntegration {
  constructor({ helperPath, clock = Date.now } = {}) {
    this.helperPath = helperPath; this.clock = clock; this.hosts = new Map(); this.closed = false;
  }
  async ensure(mode) {
    if (this.hosts.has(mode) || this.closed) return;
    const state = { started: this.clock(), ready: false, sequence: 0, updated: 0, error: null, data: null, child: null };
    this.hosts.set(mode, state);
    try {
      const root = fileURLToPath(new URL('../', import.meta.url)); let helper;
      for (const candidate of [this.helperPath, path.join(root, 'BridgeWebIntegration.exe'), path.join(root, 'build', 'BridgeWebIntegration.exe')]) {
        if (!candidate || !path.isAbsolute(candidate)) continue;
        try { await access(candidate); helper = candidate; break; } catch { }
      }
      if (!helper || process.platform !== 'win32') throw new Error();
      if (this.closed) return;
      const child = spawn(helper, [`--${mode}`, String(process.pid), '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      state.child = child; let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) { state.error = true; child.kill(); return; }
        for (;;) {
          const at = buffer.indexOf('\n'); if (at < 0) break;
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let row; try { row = JSON.parse(line); } catch { state.error = true; child.kill(); return; }
          if (row.ready === mode) state.ready = true;
          if (row.error) { state.error = true; child.kill(); return; }
          const data = mode === 'audio' ? row.audio : row.media;
          if (data === undefined) continue;
          if (mode === 'audio' && (!Array.isArray(data) || data.length !== 128 || data.some(v => !Number.isFinite(v) || v < 0 || v > 1))) {
            state.error = true; child.kill(); return;
          }
          if (mode === 'media' && (!data || typeof data !== 'object' || !['playing', 'paused', 'stopped'].includes(data.playback))) {
            state.error = true; child.kill(); return;
          }
          state.data = data; state.updated = this.clock(); state.sequence++;
          if (mode === 'audio') state.sampleFrames = Number.isSafeInteger(row.sampleFrames) && row.sampleFrames >= 0 ? row.sampleFrames : null;
        }
      });
      child.once('error', () => { state.error = true; });
      child.once('exit', () => { if (!this.closed) state.error = true; });
    } catch { state.error = true; }
  }
  async snapshot({ audio = false, media = false } = {}) {
    if (this.closed) return {};
    if (audio) await this.ensure('audio');
    if (media) await this.ensure('media');
    const result = {};
    for (const mode of ['audio', 'media']) {
      const state = this.hosts.get(mode); if (!state) continue;
      const stale = state.data && this.clock() - state.updated > (mode === 'audio' ? 2500 : 6000);
      if (state.error || stale || (!state.data && this.clock() - state.started > 6000)) {
        result.error = mode === 'audio' ? 'WEB_AUDIO_VISUALIZER_UNAVAILABLE' : 'WEB_MEDIA_INTERFACE_UNAVAILABLE'; break;
      }
      if (state.data) { result[mode] = state.data; result[`${mode}Sequence`] = state.sequence; }
    }
    return result;
  }
  diagnostics() {
    return Object.fromEntries([...this.hosts].map(([mode, state]) => [mode, {
      ready: state.ready, sequence: state.sequence, sampleFrames: state.sampleFrames ?? null, failed: !!state.error, pid: state.child?.pid || null,
    }]));
  }
  async stop() {
    this.closed = true;
    await Promise.allSettled([...this.hosts.values()].map(state => new Promise(resolve => {
      const child = state.child; if (!child || child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
    })));
    this.hosts.clear();
  }
}
