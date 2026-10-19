/* Bridge-owned runtime only. Wallpaper project JavaScript never executes here. */
(() => {
  const KEY = '__codexWallpaperBridgeV1', VERSION = 5, FADE_MS = 320;
  const bridgeSelector = '[data-cwb-owned="v1"]';
  function surfaceCss(contract) {
    // Composer controls, message cards, hover/selected rows and theme tokens are
    // excluded. Only the observed shell and empty fade layers match.
    const shells = [contract.root, contract.main, contract.sidebar, contract.header, contract.surfaces].filter(Boolean).join(',');
    return `html:has(${bridgeSelector}) body{background:transparent!important}
      :is(${shells}),:is(${shells})::before,:is(${shells})::after{
        background-color:transparent!important;background-image:none!important;
        box-shadow:none!important;backdrop-filter:none!important;border-color:transparent!important}`;
  }
  const existing = window[KEY];
  if (existing) {
    if (existing.runtimeVersion === VERSION) { existing.refreshStyles(); return true; }
    // A legacy controller can still own a playing video. Patch its owned style
    // without restoring playback or creating a second presentation canvas.
    if (!existing.refreshStyles) {
      let contract;
      existing.refreshStyles = next => {
        if (next) contract = next;
        if (contract) document.querySelectorAll(`style${bridgeSelector}`).forEach(node => { node.textContent = surfaceCss(contract); });
        return true;
      };
      for (const method of ['install', 'configure', 'frame', 'commit', 'commitFile']) {
        const original = existing[method];
        existing[method] = function (...args) {
          if (method === 'install') contract = args[1];
          const result = original.apply(this, args);
          if (result?.then) return result.then(value => { existing.refreshStyles(); return value; });
          existing.refreshStyles(); return result;
        };
      }
      const ping = existing.ping;
      existing.ping = function () { return { ...ping.call(this), runtimeVersion: 1, surfaceRevision: 3 }; };
    }
    return true;
  }
  let canvas, context, style, active = null, pending = null, transition = null, epoch = 0, generation = -1;
  let options = {}, selectors = {}, heartbeat = Date.now(), paintCount = 0, paintAt = performance.now();
  let activeGeneration = -1, disposed = false, frameBusy = false, frameAbort = null, nextPaintAt = 0, resizeRequest = null;
  let pointer = { enabled: false }, pointerMove = null, pointerTimer = null, pointerAt = -Infinity, pointerSequence = 0;
  let pointerGesture = null, pointerDragClick = false;
  const display = value => ({ zoom: Math.max(1, Math.min(4, Number(value?.zoom) || 1)),
    positionX: Math.max(0, Math.min(1, Number.isFinite(value?.positionX) ? value.positionX : 0.5)),
    positionY: Math.max(0, Math.min(1, Number.isFinite(value?.positionY) ? value.positionY : 0.5)) });
  function clearPointer() {
    pointerMove = null; pointerGesture = null; pointerDragClick = false;
    if (pointerTimer !== null) clearTimeout(pointerTimer);
    pointerTimer = null;
  }
  function pointerReady() {
    return !disposed && pointer.enabled && !document.hidden && document.hasFocus?.() !== false && !options.policy?.paused &&
      active && !active.video && !active.adopted && generation === activeGeneration && activeGeneration === pointer.generation;
  }
  function sendPointer(value) {
    if (!pointerReady() || typeof window[pointer.binding] !== 'function') return;
    // Invert the same physical canvas transform as drawSource, including its
    // rounded pixel budget. No screen coordinates are sent to the wallpaper.
    const [width, height] = dimensions(active), viewportWidth = innerWidth, viewportHeight = innerHeight;
    if (!(width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0)) return;
    const d = active.display, scale = Math.max(canvas.width / width, canvas.height / height) * d.zoom;
    const drawnWidth = width * scale, drawnHeight = height * scale;
    const x = (value.x * canvas.width / viewportWidth - (canvas.width - drawnWidth) * d.positionX) / drawnWidth;
    const y = (value.y * canvas.height / viewportHeight - (canvas.height - drawnHeight) * d.positionY) / drawnHeight;
    if (![x, y].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1) return;
    try {
      window[pointer.binding](JSON.stringify({ token: pointer.token, generation: pointer.generation,
        sequence: ++pointerSequence, type: value.type, x, y }));
    } catch { /* An absent controller must never affect the native chat event. */ }
  }
  function flushPointer() {
    pointerTimer = null; const value = pointerMove; pointerMove = null;
    if (!value || !pointerReady()) return;
    pointerAt = performance.now(); sendPointer(value);
  }
  function observePointer(event) {
    // No target, DOM path, button labels, input value, text or keyboard state is
    // read. Passive capture observes only the pointer; native handlers retain
    // their normal dispatch, focus, text-selection and scroll behavior.
    if (event.isTrusted && event.pointerType === 'mouse' && pointerGesture &&
        Math.hypot(event.clientX - pointerGesture.x, event.clientY - pointerGesture.y) > 4) pointerGesture.dragged = true;
    if (event.isTrusted && event.type === 'click' && pointerDragClick) { pointerDragClick = false; return; }
    if (!pointerReady() || !event.isTrusted || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.buttons !== 0 ||
        (event.type === 'pointermove' && event.pointerType !== 'mouse') ||
        (event.type === 'click' && (event.button !== 0 || event.detail < 1))) return;
    const x = event.clientX, y = event.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return;
    const value = { type: event.type === 'click' ? 'click' : 'move', x, y };
    if (value.type === 'click') { clearPointer(); sendPointer(value); return; }
    pointerMove = value;
    if (pointerTimer === null) pointerTimer = setTimeout(flushPointer, Math.max(0, 1000 / 30 - (performance.now() - pointerAt)));
  }
  function beginPointerGesture(event) {
    if (!pointerReady() || !event.isTrusted || event.pointerType !== 'mouse' || event.button !== 0) return;
    clearPointer(); pointerGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
  }
  function endPointerGesture(event) {
    if (!event.isTrusted || !pointerGesture || event.pointerId !== pointerGesture.id) return;
    pointerDragClick = event.type === 'pointercancel' || pointerGesture.dragged ||
      Math.hypot(event.clientX - pointerGesture.x, event.clientY - pointerGesture.y) > 4;
    pointerGesture = null;
  }
  function releaseImage(image) {
    if (!image) return;
    if (typeof image.close === 'function') image.close();
    else if (typeof image.getContext === 'function') { image.width = 0; image.height = 0; }
    else image.removeAttribute?.('src');
  }
  function release(media) {
    if (!media) return;
    media.cancelLoad?.(); media.cancelLoad = null;
    cancelMediaLoop(media); media.input?.remove(); media.input = null; media.file = null;
    media.video?.pause(); if (media.video) { media.video.removeAttribute('src'); media.video.load(); }
    if (media.url) { URL.revokeObjectURL(media.url); media.url = null; }
    releaseImage(media.image); media.image = null; media.chunks = null;
  }
  function finishTransition() {
    if (!transition) return;
    if (transition.request != null) cancelAnimationFrame(transition.request);
    release(transition.old); releaseImage(transition.snapshot); transition.snapshot = null; transition = null;
  }
  function removePresentation() {
    finishTransition(); release(active); release(pending); active = pending = null;
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
    style?.remove(); canvas = context = style = null;
  }
  function restore() {
    if (disposed) return true;
    disposed = true; epoch++; frameAbort?.abort(); clearInterval(watchdog); if (resizeRequest !== null) cancelAnimationFrame(resizeRequest);
    clearPointer();
    document.removeEventListener('pointermove', observePointer, true);
    document.removeEventListener('click', observePointer, true);
    document.removeEventListener('pointerdown', beginPointerGesture, true);
    document.removeEventListener('pointerup', endPointerGesture, true);
    document.removeEventListener('pointercancel', endPointerGesture, true);
    if (/^__cwbPointer[a-f0-9]{24}$/.test(pointer.binding || '')) {
      try { delete window[pointer.binding]; } catch { /* CDP also removes its owned binding on detach. */ }
    }
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('resize', resize);
    removePresentation();
    if (window[KEY] === api) delete window[KEY];
    return true;
  }
  function compatible() {
    return !!(document.querySelector(selectors.root) && document.querySelector(selectors.main));
  }
  function refreshStyles(contract) {
    if (contract) selectors = contract;
    if (style) style.textContent = surfaceCss(selectors);
    return true;
  }
  function ensure() {
    if (disposed || !compatible()) throw new Error('STRUCTURE_INCOMPATIBLE');
    if (canvas?.isConnected && style?.isConnected) return;
    document.querySelectorAll(bridgeSelector).forEach(node => node.remove());
    style = document.createElement('style'); style.dataset.cwbOwned = 'v1'; refreshStyles();
    document.head.appendChild(style);
    canvas = document.createElement('canvas'); canvas.dataset.cwbOwned = 'v1';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;contain:strict;';
    document.body.prepend(canvas); context = canvas.getContext('2d', { alpha: true });
    applyEffects();
  }
  function applyEffects() {
    if (!canvas) return;
    const e = options.effects;
    canvas.style.opacity = String(e.opacity);
    canvas.style.filter = `blur(${e.blur}px) brightness(${e.brightness}) contrast(${e.contrast})`;
    if (active?.video) { cancelMediaLoop(active); nextPaintAt = 0; scheduleMediaLoop(active); }
  }
  function cancelMediaLoop(media) {
    if (media?.frameRequest != null) media.video?.cancelVideoFrameCallback?.(media.frameRequest);
    if (media?.animationRequest != null) cancelAnimationFrame(media.animationRequest);
    if (media) media.frameRequest = media.animationRequest = null;
  }
  function scheduleMediaLoop(media) {
    if (disposed || document.hidden || active !== media || !media.video) return;
    const callback = now => {
      media.frameRequest = media.animationRequest = null;
      if (disposed || active !== media || document.hidden) return;
      timedPaint(now);
      scheduleMediaLoop(media);
    };
    if (media.video.requestVideoFrameCallback) media.frameRequest = media.video.requestVideoFrameCallback(callback);
    else media.animationRequest = requestAnimationFrame(callback);
  }
  function timedPaint(now) {
    if (now + 0.5 < nextPaintAt) return;
    paint(now); nextPaintAt = Math.max(nextPaintAt + 1000 / options.policy.fps, now);
  }
  function scheduleTransition() {
    if (!transition || transition.request != null || document.hidden || disposed) return;
    transition.request = requestAnimationFrame(now => {
      if (!transition) return;
      transition.request = null; timedPaint(now); scheduleTransition();
    });
  }
  function resize() {
    if (resizeRequest !== null) return;
    resizeRequest = requestAnimationFrame(() => { resizeRequest = null; paint(); });
  }
  function dimensions(media) {
    return media?.video ? [media.video.videoWidth, media.video.videoHeight] : [media?.image?.width, media?.image?.height];
  }
  function drawSource(media) {
    const [width, height] = dimensions(media), w = canvas.width, h = canvas.height;
    const d = media.display, cover = Math.max(w / width, h / height) * d.zoom, dw = width * cover, dh = height * cover;
    context.drawImage(media.video || media.image, (w - dw) * d.positionX, (h - dh) * d.positionY, dw, dh);
  }
  function paint(now = performance.now()) {
    if (!active || document.hidden || disposed) return;
    if (!compatible()) { restore(); return; }
    const [width, height] = dimensions(active);
    if (!width || !height || (active.video && active.video.readyState < 2)) return;
    const policy = options.policy, dpr = devicePixelRatio || 1;
    // Native video retains physical display resolution. Lower FPS does not
    // re-encode it. Captured image frames respect the configured pixel budget.
    const budget = active.video ? 16777216 : policy.pixelBudget;
    const scale = Math.min(dpr, Math.sqrt(budget / Math.max(1, innerWidth * innerHeight)));
    const w = Math.max(1, Math.round(innerWidth * scale)), h = Math.max(1, Math.round(innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    context.globalAlpha = 1; context.clearRect(0, 0, w, h);
    if (transition) {
      const progress = Math.max(0, Math.min(1, (now - transition.started) / FADE_MS));
      context.drawImage(transition.snapshot, 0, 0, w, h);
      context.globalAlpha = progress; drawSource(active); context.globalAlpha = 1;
      if (progress >= 1) finishTransition();
    } else drawSource(active);
    paintCount++;
  }
  function activate(media, g) {
    ensure();
    const old = active;
    // Snapshot the last complete composite, including an interrupted fade. This
    // memory-only surface never introduces another DOM canvas or dark overlay.
    let snapshot;
    if (old && canvas.width && canvas.height) {
      snapshot = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(canvas.width, canvas.height) : document.createElement('canvas');
      snapshot.width = canvas.width; snapshot.height = canvas.height;
      snapshot.getContext('2d').drawImage(canvas, 0, 0);
    }
    finishTransition(); cancelMediaLoop(old); old?.video?.pause();
    active = media; media.display = display(options.display); activeGeneration = g; nextPaintAt = 0;
    if (snapshot) transition = { snapshot, old, started: performance.now(), request: null };
    else release(old);
    paint(); scheduleTransition();
  }
  function visibility() {
    if (document.hidden) {
      clearPointer();
      cancelMediaLoop(active); active?.video?.pause();
      if (transition?.request != null) { cancelAnimationFrame(transition.request); transition.request = null; }
      return;
    }
    if (!active?.video) { paint(); scheduleTransition(); return; }
    const media = active;
    media.video.play().then(() => { if (active === media) { nextPaintAt = 0; paint(); scheduleMediaLoop(media); scheduleTransition(); } }).catch(() => { /* Keep the last valid frame for controller recovery. */ });
  }
  async function commitMedia(media, g) {
    const token = epoch;
    media.url = URL.createObjectURL(media.file || new Blob(media.chunks, { type: media.mime })); media.chunks = null;
    const video = media.video = document.createElement('video');
    video.muted = true; video.defaultMuted = true; video.volume = 0; video.loop = true; video.playsInline = true; video.preload = 'auto'; video.src = media.url;
    try {
      await new Promise((resolve, reject) => {
        const settle = error => {
          clearTimeout(timeout); media.cancelLoad = null;
          video.removeEventListener('loadeddata', loaded); video.removeEventListener('error', failed);
          if (error) reject(new Error(error)); else resolve();
        };
        const loaded = () => settle(), failed = () => settle('VIDEO_DECODE_FAILED');
        const timeout = setTimeout(() => settle('VIDEO_LOAD_TIMEOUT'), 15000);
        media.cancelLoad = () => settle('VIDEO_LOAD_CANCELLED');
        video.addEventListener('loadeddata', loaded, { once: true });
        video.addEventListener('error', failed, { once: true }); video.load();
      });
      if (disposed || token !== epoch || pending !== media) { release(media); return false; }
      if (!document.hidden) await video.play();
      if (disposed || token !== epoch || pending !== media) { release(media); return false; }
      activate(media, g); pending = null;
      scheduleMediaLoop(media);
      video.addEventListener('error', () => { cancelMediaLoop(media); media.video.pause(); }, { once: true });
      return true;
    } catch (error) {
      const stale = disposed || token !== epoch || pending !== media;
      release(media); if (pending === media) pending = null;
      if (stale) return false;
      throw error;
    }
  }
  async function renderFrame(g, readBytes) {
    if (disposed || frameBusy || !Number.isSafeInteger(g) || g < generation) return false;
    frameBusy = true; const token = epoch; let image;
    try {
      const bytes = await readBytes();
      if (disposed || token !== epoch || g < generation) return false;
      image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      if (disposed || token !== epoch || g < generation) return false;
      generation = g;
      if (active?.image && g === activeGeneration) { const previous = active.image; active.image = image; paint(); releaseImage(previous); }
      else activate({ image }, g);
      image = null; return true;
    } finally { releaseImage(image); frameBusy = false; }
  }
  const api = {
    runtimeVersion: VERSION, refreshStyles,
    adoptSnapshot(snapshot) {
      if (disposed || active || !snapshot || !snapshot.width || !snapshot.height || snapshot.isConnected ||
          !(snapshot instanceof HTMLCanvasElement || (typeof OffscreenCanvas === 'function' && snapshot instanceof OffscreenCanvas))) return false;
      ensure();
      // An upgraded controller adopts already-composited pixels, so applying
      // the selected wallpaper's crop again would zoom the retained frame twice.
      active = { image: snapshot, display: display(), adopted: true };
      generation = activeGeneration = -1;
      canvas.width = snapshot.width; canvas.height = snapshot.height;
      context.drawImage(snapshot, 0, 0); paintCount++;
      return true;
    },
    install(config, contract) {
      if (disposed) throw new Error('DISPOSED'); options = config; selectors = contract;
      if (!compatible()) return { compatible: false };
      // A replacement controller owns a fresh generation sequence. Keep the
      // playing image/video while invalidating transfers left by its predecessor.
      // Revoke even an initial in-flight frame that has not created an active
      // image yet; a new controller can legitimately reuse generation numbers.
      epoch++; frameAbort?.abort(); release(pending); pending = null; generation = activeGeneration = -1;
      heartbeat = Date.now(); refreshStyles();
      return { compatible: true, runtimeVersion: VERSION, sidebar: !!document.querySelector(selectors.sidebar),
        composer: !!document.querySelector(selectors.composer), visible: !document.hidden };
    },
    configure(config) {
      options = config; refreshStyles();
      if (options.policy?.paused) clearPointer();
      if (active && !active.adopted && generation === activeGeneration) active.display = display(options.display);
      applyEffects(); paint(); heartbeat = Date.now(); return true;
    },
    prepareFile(g, size) {
      if (!Number.isSafeInteger(g) || g < generation || !Number.isSafeInteger(size) || size < 1) return null;
      epoch++; generation = g; release(pending);
      const input = document.createElement('input'); input.type = 'file'; input.dataset.cwbOwned = 'v1'; input.style.display = 'none';
      // Detached input/change events must never reach Codex attachment handlers.
      input.setAttribute('aria-hidden', 'true');
      pending = { generation: g, size, input, nativeFile: true }; return input;
    },
    async commitFile(g) {
      const media = pending;
      if (!media?.nativeFile || media.generation !== g) return false;
      if (media.input.files.length !== 1 || media.input.files[0].size !== media.size) throw new Error('VIDEO_FILE_CHANGED');
      media.file = media.input.files[0]; media.input.remove(); media.input = null;
      return commitMedia(media, g);
    },
    begin(g, size, mime) {
      if (!Number.isSafeInteger(g) || g < generation || !Number.isSafeInteger(size) || size < 1 || size > 256 * 1024 * 1024 ||
        !['video/mp4', 'video/webm'].includes(mime)) return false;
      epoch++; generation = g; release(pending); pending = { generation: g, chunks: [], size, received: 0, mime }; return true;
    },
    append(g, encoded) {
      if (!pending || pending.generation !== g || encoded.length > 512 * 1024) return false;
      const raw = atob(encoded), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      if (pending.received + bytes.length > pending.size) return false;
      pending.chunks.push(bytes); pending.received += bytes.length; return true;
    },
    async commit(g) {
      const media = pending;
      if (!media || media.generation !== g || media.received !== media.size) return false;
      return commitMedia(media, g);
    },
    invalidate(g) { if (g > generation) { clearPointer(); epoch++; frameAbort?.abort(); generation = g; release(pending); pending = null; } return true; },
    pointerMode(mode) {
      clearPointer(); pointerAt = -Infinity;
      pointer = { enabled: mode?.enabled === true && Number.isSafeInteger(mode.generation) && mode.generation >= 0 &&
          /^__cwbPointer[a-f0-9]{24}$/.test(mode.binding || '') && /^[a-f0-9]{32}$/.test(mode.token || ''),
        generation: mode?.generation, binding: mode?.binding, token: mode?.token };
      return pointer.enabled;
    },
    frame(g, encoded) {
      if (typeof encoded !== 'string' || encoded.length > 6 * 1024 * 1024) return Promise.resolve(false);
      return renderFrame(g, () => Uint8Array.from(atob(encoded), char => char.charCodeAt(0)));
    },
    frameFromUrl(g, ticket) {
      if (!ticket || !/^https:\/\/persistent\.oaistatic\.com\/__cwb_frame\/[a-f0-9]{32}\/[1-9][0-9]{0,15}$/.test(ticket.url) ||
          !/^[a-f0-9]{64}$/.test(ticket.proof) || !Number.isSafeInteger(ticket.size) || ticket.size < 1 || ticket.size > 4.5 * 1024 * 1024)
        return Promise.resolve(false);
      return renderFrame(g, async () => {
        const controller = new AbortController(); frameAbort = controller;
        const timer = setTimeout(() => controller.abort(), 5000); let reader, response;
        try {
          response = await fetch(ticket.url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
          if (!response.ok || response.headers.get('X-Cwb-Frame-Proof') !== ticket.proof || response.headers.get('Content-Type') !== 'image/jpeg')
            throw new Error('FRAME_FETCH_IDENTITY_INVALID');
          reader = response.body.getReader(); const chunks = []; let size = 0;
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > ticket.size) throw new Error('FRAME_FETCH_SIZE_INVALID'); chunks.push(value);
          }
          if (size !== ticket.size) throw new Error('FRAME_FETCH_SIZE_INVALID');
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return bytes;
        } finally {
          clearTimeout(timer);
          if (reader) await reader.cancel().catch(() => {});
          else await response?.body?.cancel().catch(() => {});
          if (frameAbort === controller) frameAbort = null;
        }
      });
    },
    ping() {
      heartbeat = Date.now(); const now = performance.now(), elapsed = (now - paintAt) / 1000;
      const result = { installed: !disposed, runtimeVersion: VERSION, surfaceRevision: 3, visible: !document.hidden, generation: activeGeneration,
        fps: elapsed > 0 ? paintCount / elapsed : null, compatible: compatible(), transitioning: !!transition, display: active?.display,
        ...(active?.video ? { playback: { nativeFile: !!active.nativeFile, muted: active.video.muted, defaultMuted: active.video.defaultMuted, volume: active.video.volume,
          sourceWidth: active.video.videoWidth, sourceHeight: active.video.videoHeight,
          decodedFrames: active.video.getVideoPlaybackQuality?.().totalVideoFrames, droppedFrames: active.video.getVideoPlaybackQuality?.().droppedVideoFrames,
          canvasWidth: canvas?.width, canvasHeight: canvas?.height } } : {}) };
      paintCount = 0; paintAt = now; return result;
    },
    restore,
  };
  const watchdog = setInterval(() => { if (Date.now() - heartbeat > 15000) restore(); }, 3000);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('pointermove', observePointer, { capture: true, passive: true });
  document.addEventListener('click', observePointer, { capture: true, passive: true });
  document.addEventListener('pointerdown', beginPointerGesture, { capture: true, passive: true });
  document.addEventListener('pointerup', endPointerGesture, { capture: true, passive: true });
  document.addEventListener('pointercancel', endPointerGesture, { capture: true, passive: true });
  window.addEventListener('resize', resize);
  window[KEY] = api;
  return true;
})();
