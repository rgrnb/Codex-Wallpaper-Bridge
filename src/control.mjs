import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
export async function readBody(request, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('REQUEST_TOO_LARGE'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export async function startControl({ token, coordinator, onExit, onExport, onStartup, onLaunch, onUpdateCheck, onUpdateInstall,
  onLibrary, onLibraryRefresh, onSelect, onPreview, onPreviewClose, onWallpaperConfigure }) {
  const authorized = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));
  let mutating = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.headers.origin || !authorized(request.headers['x-bridge-token']) ||
        !/^127\.0\.0\.1:\d+$/.test(request.headers.host || '')) { response.writeHead(403).end('{}'); return; }
    let locked = false;
    try {
      if (request.method === 'GET' && request.url === '/status') { response.end(JSON.stringify(coordinator.snapshot())); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/library' && onLibrary) {
        response.end(JSON.stringify(await onLibrary({ search: url.searchParams.get('search') || '', type: url.searchParams.get('type') || '' }))); return;
      }
      if (request.method !== 'POST' || !['/settings', '/restore', '/export', '/exit', '/launch', '/updates/check', '/updates/install', '/updates/configure',
        '/library/refresh', '/wallpaper/select', '/wallpaper/preview', '/wallpaper/preview/close', '/wallpaper/configure'].includes(request.url)) {
        response.writeHead(404).end('{}'); return;
      }
      if (mutating) { response.writeHead(409).end(JSON.stringify({ error: 'ACTION_IN_PROGRESS' })); return; }
      mutating = locked = true;
      const body = await readBody(request, request.url === '/settings' ? 1024 * 1024 : 16384);
      if (request.url.startsWith('/wallpaper/') || request.url === '/library/refresh') {
        if (['/wallpaper/select', '/wallpaper/configure', '/wallpaper/preview'].includes(request.url) &&
            ['Downloading', 'Installing'].includes(coordinator.updater?.status)) throw new Error('UPDATE_IN_PROGRESS');
        const handler = { '/library/refresh': onLibraryRefresh, '/wallpaper/select': onSelect, '/wallpaper/preview': onPreview,
          '/wallpaper/preview/close': onPreviewClose, '/wallpaper/configure': onWallpaperConfigure }[request.url];
        if (!handler) throw new Error('ACTION_UNAVAILABLE');
        const result = await handler(body); response.end(JSON.stringify({ ok: true, ...result })); return;
      }
      if (request.url === '/settings') {
        if (['Downloading', 'Installing'].includes(coordinator.updater?.status)) throw new Error('UPDATE_IN_PROGRESS');
        const previous = coordinator.store.value;
        // Validate and persist first; roll back preferences if startup registration fails.
        await coordinator.applySettings(body);
        if (previous.startup !== body.startup) {
          try { await onStartup(body.startup); }
          catch (error) { await coordinator.applySettings(previous); throw error; }
        }
      } else if (request.url === '/restore') await coordinator.restore();
      else if (request.url === '/export') await onExport();
      else if (request.url === '/launch') await onLaunch();
      else if (request.url === '/updates/check') await onUpdateCheck();
      else if (request.url === '/updates/configure') {
        if (body.confirmed !== true) throw new Error('UPDATE_CONFIRMATION_REQUIRED');
        await coordinator.updater.configure(body); await onUpdateCheck();
      }
      else if (request.url === '/updates/install') {
        if (body.confirmed !== true || body.version !== coordinator.updater?.candidate?.version) throw new Error('UPDATE_CONFIRMATION_REQUIRED');
        await onUpdateInstall();
      }
      else if (request.url === '/exit') { response.end('{"ok":true}'); setImmediate(onExit); return; }
      response.end(JSON.stringify({ ok: true }));
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: /^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'ACTION_FAILED' })); }
    finally { if (locked) mutating = false; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
