import { randomBytes } from 'node:crypto';

export const FRAME_ORIGIN = 'https://persistent.oaistatic.com';
export const MAX_FRAME_BYTES = 4.5 * 1024 * 1024;

// Only this target's random synthetic route is intercepted. JPEG bytes are a
// local DevTools response, never an upload or a request to a wallpaper server.
// The response proof is deliberately absent from the URL/request: a normal
// remote response after debugger loss cannot be accepted as a Bridge frame.
export class FrameFetch {
  constructor(client, { current = () => true, clock = Date.now } = {}) {
    Object.assign(this, { client, current, clock }); this.epoch = 0; this.sequence = 0; this.requests = new Set();
    this.prefix = `${FRAME_ORIGIN}/__cwb_frame/${randomBytes(16).toString('hex')}/`;
    this.listener = event => this.receive(event);
  }
  async start() {
    if (this.closed) throw new Error('FRAME_FETCH_CLOSED');
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { frameTree } = await this.client.call('Page.getFrameTree');
      const { result } = await this.client.call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
      if (!frameTree?.frame?.id || !['app://-', 'null'].includes(result?.value)) throw new Error('FRAME_FETCH_DOCUMENT_INVALID');
      this.frameId = frameTree.frame.id; this.loaderId = frameTree.frame.loaderId; this.origin = result.value;
      if (this.closed || !this.current()) throw new Error('FRAME_FETCH_CLOSED');
      this.socket = this.client.ws;
      if (!this.socket?.addEventListener) throw new Error('CDP_CLOSED');
      this.socket.addEventListener('message', this.listener); this.listening = true;
      await this.client.call('Page.enable');
      if (this.closed || !this.current()) throw new Error('FRAME_FETCH_CLOSED');
      await this.client.call('Fetch.enable', { patterns: [{ urlPattern: `${this.prefix}*`, requestStage: 'Request' }] });
      this.enabled = true;
      if (this.closed || !this.current()) throw new Error('FRAME_FETCH_CLOSED');
      this.ready = true;
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  async offer(frame, generation) {
    const epoch = this.epoch;
    if (typeof frame?.jpeg !== 'string' || frame.jpeg.length > 6 * 1024 * 1024 || !Number.isSafeInteger(generation) || generation < 0)
      throw new Error('FRAME_FETCH_PAYLOAD_INVALID');
    const size = Buffer.byteLength(frame.jpeg, 'base64');
    if (size < 1 || size > MAX_FRAME_BYTES) throw new Error('FRAME_FETCH_PAYLOAD_INVALID');
    await this.start();
    if (this.closed || !this.current() || epoch !== this.epoch || this.documentChanged) throw new Error('FRAME_FETCH_STALE');
    const ticket = { url: `${this.prefix}${++this.sequence}`, proof: randomBytes(32).toString('hex'), size };
    this.frame = { ticket, jpeg: frame.jpeg, generation, at: this.clock() }; return ticket;
  }
  invalidate() { this.epoch++; this.frame = null; }
  receive(event) {
    if (typeof event.data !== 'string' || event.data.length > 64 * 1024) return;
    let row; try { row = JSON.parse(event.data); } catch { return; }
    if (row.method === 'Page.frameNavigated' && row.params?.frame?.id === this.frameId && row.params.frame.loaderId !== this.loaderId) {
      this.documentChanged = true; this.invalidate(); return;
    }
    if (row.method !== 'Fetch.requestPaused') return;
    const request = row.params;
    // Never inspect/continue/log requests outside the private route.
    if (typeof request?.request?.url !== 'string' || !request.request.url.startsWith(this.prefix)) return;
    const frame = this.frame;
    const accepted = !this.closed && !this.documentChanged && this.current() && request.frameId === this.frameId &&
      request.request.method === 'GET' && !this.requests.size && frame && !frame.consumed &&
      request.request.url === frame.ticket.url && this.clock() >= frame.at && this.clock() - frame.at < 5000;
    if (accepted) frame.consumed = true;
    this.requests.add(request.requestId);
    const action = accepted ? this.client.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'image/jpeg' }, { name: 'Content-Length', value: String(frame.ticket.size) },
        { name: 'Cache-Control', value: 'no-store' }, { name: 'Access-Control-Allow-Origin', value: this.origin },
        { name: 'Access-Control-Expose-Headers', value: 'X-Cwb-Frame-Proof' }, { name: 'X-Cwb-Frame-Proof', value: frame.ticket.proof }], body: frame.jpeg }) :
      this.client.call('Fetch.failRequest', { requestId: request.requestId, errorReason: 'Aborted' });
    void action.catch(() => { /* The renderer's bounded request fails; no request is continued. */ })
      .finally(() => this.requests.delete(request.requestId));
  }
  async stop() {
    this.closed = true; this.invalidate();
    await this.starting?.catch(() => {});
    if (this.listening) { this.socket.removeEventListener('message', this.listener); this.listening = false; }
    await Promise.all([...this.requests].map(requestId => this.client.call('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {})));
    this.requests.clear();
    if (this.enabled) { this.enabled = false; await this.client.call('Fetch.disable').catch(() => {}); }
    this.ready = false;
  }
}
