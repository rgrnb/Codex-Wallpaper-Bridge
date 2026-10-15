export function validateTarget(target, port, paths = ['/index.html', '/detached-window.html']) {
  try {
    const page = new URL(target.url), ws = new URL(target.webSocketDebuggerUrl);
    return target.type === 'page' && /^[A-Za-z0-9_-]{1,128}$/.test(target.id) &&
      page.protocol === 'app:' && page.hostname === '-' && paths.includes(page.pathname) &&
      ws.protocol === 'ws:' && ws.hostname === '127.0.0.1' && Number(ws.port) === port &&
      ws.username === '' && ws.password === '' && !ws.search && !ws.hash &&
      ws.pathname === `/devtools/page/${target.id}`;
  } catch { return false; }
}
export class CdpClient {
  constructor(url, { timeout = 10000 } = {}) { this.url = url; this.timeout = timeout; this.next = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('CDP_CONNECT_TIMEOUT')); }, this.timeout);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')); }, { once: true });
    });
    this.ws.addEventListener('message', event => {
      let row; try { row = JSON.parse(event.data); } catch { return; }
      const pending = this.pending.get(row.id); if (!pending) return;
      this.pending.delete(row.id); clearTimeout(pending.timer);
      if (row.error) pending.reject(new Error(`CDP_${row.error.code}`)); else pending.resolve(row.result);
    });
    this.ws.addEventListener('close', () => this.close());
    this.ws.addEventListener('error', () => this.close());
    return this;
  }
  call(method, params = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP_CLOSED'));
    if (this.pending.size >= 8) return Promise.reject(new Error('CDP_BACKPRESSURE'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP_TIMEOUT')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('CDP_SEND_FAILED')); }
    });
  }
  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) {
      const code = String(response.exceptionDetails.exception?.description || '').match(/^Error: ((?:VIDEO|SOURCE|STRUCTURE|DISPOSED)[A-Z0-9_]*)\b/);
      throw new Error(code ? code[1] : 'RENDERER_EVALUATION_FAILED');
    }
    return response.result?.value;
  }
  close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP_CLOSED')); }
    this.pending.clear();
    const ws = this.ws; this.ws = null;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  }
}
export async function listTargets(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CDP_PORT_INVALID');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw new Error('CDP_DISCOVERY_FAILED');
  const reader = response.body.getReader(); let text = '', count = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    count += value.length; if (count > 256 * 1024) throw new Error('CDP_DISCOVERY_TOO_LARGE');
    text += new TextDecoder().decode(value, { stream: true });
  } } finally { await reader.cancel(); }
  const rows = JSON.parse(text); if (!Array.isArray(rows)) throw new Error('CDP_TARGETS_INVALID');
  // Titles, remote-page URLs, and other targets are never retained or logged.
  return rows.filter(t => validateTarget(t, port)).map(t => ({ id: t.id, webSocketDebuggerUrl: t.webSocketDebuggerUrl }));
}
