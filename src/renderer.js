/* Bridge-owned runtime only. Wallpaper project JavaScript never executes here. */
(() => {
  const KEY = '__codexWallpaperBridgeV1';
  if (window[KEY]) return true;
  let canvas, context, style, active = null, pending = null, epoch = 0, generation = -1;
  let options = {}, selectors = {}, heartbeat = Date.now(), paintCount = 0, paintAt = performance.now();
  let activeGeneration = -1, disposed = false, frameBusy = false, nextPaintAt = 0, resizeRequest = null;
  const bridgeSelector = '[data-cwb-owned="v1"]';
  function release(media) {
    if (!media) return;
    cancelMediaLoop(media); media.input?.remove(); media.input = null; media.file = null;
    media.video?.pause(); if (media.video) { media.video.removeAttribute('src'); media.video.load(); }
    if (media.url) URL.revokeObjectURL(media.url);
    media.chunks = null;
  }
  function removePresentation() {
    release(active); release(pending); active = pending = null;
    canvas?.remove(); style?.remove(); canvas = context = style = null;
  }
  function restore() {
    if (disposed) return true;
    disposed = true; epoch++; clearInterval(watchdog); if (resizeRequest !== null) cancelAnimationFrame(resizeRequest);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('resize', resize);
    removePresentation();
    if (window[KEY] === api) delete window[KEY];
    return true;
  }
  function compatible() {
    return !!(document.querySelector(selectors.root) && document.querySelector(selectors.main));
  }
  function ensure() {
    if (disposed || !compatible()) throw new Error('STRUCTURE_INCOMPATIBLE');
    if (canvas?.isConnected && style?.isConnected) return;
    document.querySelectorAll(bridgeSelector).forEach(node => node.remove());
    style = document.createElement('style'); style.dataset.cwbOwned = 'v1';
    const shells = [selectors.root, selectors.main, selectors.sidebar, selectors.header, selectors.composer,
      selectors.surfaces].filter(Boolean).join(',');
    // Only backgrounds of contract-owned surfaces are changed. No font, layout, opacity,
    // pointer handling, text, token values, or official style nodes are mutated.
    style.textContent = `html:has(${bridgeSelector}) body{background:transparent!important}
      :is(${shells}){background-color:transparent!important;background-image:none!important}`;
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
      if (now + 0.5 >= nextPaintAt) {
        paint(); nextPaintAt = Math.max(nextPaintAt + 1000 / options.policy.fps, now);
      }
      scheduleMediaLoop(media);
    };
    if (media.video.requestVideoFrameCallback) media.frameRequest = media.video.requestVideoFrameCallback(callback);
    else media.animationRequest = requestAnimationFrame(callback);
  }
  function resize() {
    if (resizeRequest !== null) return;
    resizeRequest = requestAnimationFrame(() => { resizeRequest = null; paint(); });
  }
  function draw(source, width, height) {
    if (!canvas || !width || !height) return;
    const policy = options.policy, dpr = devicePixelRatio || 1;
    // Original video is decoded directly and drawn at the display's physical
    // resolution. FPS tuning never reduces its pixel size or re-encodes it.
    const budget = source instanceof HTMLVideoElement ? 16777216 : policy.pixelBudget;
    const scale = Math.min(dpr, Math.sqrt(budget / Math.max(1, innerWidth * innerHeight)));
    const w = Math.max(1, Math.round(innerWidth * scale)), h = Math.max(1, Math.round(innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const cover = Math.max(w / width, h / height), dw = width * cover, dh = height * cover;
    context.clearRect(0, 0, w, h); context.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
    paintCount++;
  }
  function paint() {
    if (!active || document.hidden || disposed) return;
    if (!compatible()) { restore(); return; }
    if (active.video && active.video.readyState >= 2) draw(active.video, active.video.videoWidth, active.video.videoHeight);
    if (active.image) draw(active.image, active.image.width, active.image.height);
  }
  function visibility() {
    if (!active?.video) { paint(); return; }
    const media = active;
    if (document.hidden) { cancelMediaLoop(media); media.video.pause(); }
    else media.video.play().then(() => { if (active === media) { nextPaintAt = 0; paint(); scheduleMediaLoop(media); } }).catch(() => restore());
  }
  async function commitMedia(media, g) {
    const token = epoch;
    media.url = URL.createObjectURL(media.file || new Blob(media.chunks, { type: media.mime })); media.chunks = null;
    const video = media.video = document.createElement('video');
    video.muted = true; video.defaultMuted = true; video.volume = 0; video.loop = true; video.playsInline = true; video.preload = 'auto'; video.src = media.url;
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('VIDEO_LOAD_TIMEOUT')), 15000);
        video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('VIDEO_DECODE_FAILED')); }, { once: true }); video.load();
      });
      if (disposed || token !== epoch || pending !== media) { release(media); return false; }
      if (!document.hidden) await video.play();
      if (disposed || token !== epoch || pending !== media) { release(media); return false; }
      ensure(); const old = active; active = media; pending = null; activeGeneration = g; nextPaintAt = 0; paint(); release(old);
      scheduleMediaLoop(media); video.addEventListener('error', restore, { once: true }); return true;
    } catch (error) { release(media); if (pending === media) pending = null; throw error; }
  }
  const api = {
    install(config, contract) {
      if (disposed) throw new Error('DISPOSED'); options = config; selectors = contract;
      if (!compatible()) return { compatible: false };
      heartbeat = Date.now();
      return { compatible: true, sidebar: !!document.querySelector(selectors.sidebar),
        composer: !!document.querySelector(selectors.composer), visible: !document.hidden };
    },
    configure(config) { options = config; applyEffects(); heartbeat = Date.now(); return true; },
    prepareFile(g, size) {
      if (!Number.isSafeInteger(g) || g < generation || !Number.isSafeInteger(size) || size < 1) return null;
      epoch++; generation = g; release(pending);
      const input = document.createElement('input'); input.type = 'file'; input.dataset.cwbOwned = 'v1'; input.style.display = 'none';
      // Keep it detached: file input/change events must never enter Codex's
      // document or be seen by its attachment/upload handlers.
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
    invalidate(g) { if (g > generation) { epoch++; generation = g; release(pending); pending = null; } return true; },
    async frame(g, encoded) {
      if (disposed || frameBusy || g < generation || encoded.length > 6 * 1024 * 1024) return false;
      frameBusy = true; const token = epoch;
      try {
        const image = new Image(); image.src = `data:image/jpeg;base64,${encoded}`; await image.decode();
        if (disposed || token !== epoch || g < generation) return false;
        ensure(); generation = activeGeneration = g;
        const old = active; active = { image }; draw(image, image.width, image.height); release(old); return true;
      } finally { frameBusy = false; }
    },
    ping() {
      heartbeat = Date.now(); const now = performance.now(), elapsed = (now - paintAt) / 1000;
      const result = { installed: !disposed, visible: !document.hidden, generation: activeGeneration,
        fps: elapsed > 0 ? paintCount / elapsed : null, compatible: compatible(),
        ...(active?.video ? { playback: { nativeFile: !!active.nativeFile, sourceWidth: active.video.videoWidth, sourceHeight: active.video.videoHeight,
          decodedFrames: active.video.getVideoPlaybackQuality?.().totalVideoFrames, droppedFrames: active.video.getVideoPlaybackQuality?.().droppedVideoFrames,
          canvasWidth: canvas?.width, canvasHeight: canvas?.height } } : {}) };
      paintCount = 0; paintAt = now; return result;
    },
    restore,
  };
  const watchdog = setInterval(() => { if (Date.now() - heartbeat > 15000) restore(); }, 3000);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('resize', resize);
  window[KEY] = api;
  return true;
})();
