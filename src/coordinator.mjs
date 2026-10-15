import { effectivePolicy } from './config.mjs';
import { applicationSurfaces } from './platform.mjs';

export const STATES = Object.freeze(['WaitingForApps', 'CheckingCompatibility', 'Ready', 'LoadingWallpaper',
  'Active', 'Paused', 'Recovering', 'Incompatible', 'Disabled', 'Updating', 'Stopped']);
export class Coordinator {
  constructor({ settings, wallpaper, presentation, frames, web, processSampler, capabilities, probe, log, clock = Date.now }) {
    Object.assign(this, { store: settings, wallpaper, presentation, frames, web, processSampler, capabilities, probe, log, clock });
    this.state = 'Disabled'; this.source = null; this.generation = 0; this.attempt = 0;
    this.retryAt = 0; this.blockedIdentity = null; this.loading = null; this.stopped = false;
    this.frameBusy = false; this.lastFrame = 0; this.lastProbe = 0; this.lastObservation = 0;
    this.lastHeartbeat = 0; this.lastMetrics = 0; this.ticking = false; this.cpu = process.cpuUsage();
    this.measureAt = this.clock(); this.overloaded = false; this.metrics = { gpu: 'unavailable', decoding: 'unavailable' };
  }
  setState(state, code = '') {
    if (this.state !== state || this.code !== code) {
      this.state = state; this.code = code;
      void this.log.event(state === 'Recovering' ? 'error' : 'info', 'coordinator', 'STATE_CHANGED', { state, code });
    }
  }
  snapshot() {
    const s = this.store.value;
    return { state: this.state, code: this.code || '', settings: s, generation: this.generation,
      source: this.source ? { id: this.source.id, type: this.source.type, sourceMethod: this.sourceMethod,
        ...(s.debug ? { resource: this.source.resource } : {}) } : null,
      windowCount: this.presentation.windows.size, visibleWindowCount: this.presentation.visibleCount,
      policy: effectivePolicy(s, this.presentation.visibleCount, this.overloaded),
      retry: { attempt: this.attempt, at: this.retryAt || null },
      apps: this.apps ? { codex: this.apps.codex?.map(x => ({ version: x.version, path: x.path, endpoints: x.endpoints })),
        wallpaperEngine: this.apps.wallpaperEngine ? { running: true, version: this.apps.wallpaperEngine.version } : { running: false } } : null,
      metrics: this.metrics, adapter: { id: this.presentation.adapter.id, status: this.presentation.adapter.status },
      ...(s.debug ? { windows: [...this.presentation.windows.values()].map(w => ({ visible: w.visible, generation: w.generation, fps: w.fps, playback: w.playback, connection: 'connected' })),
        modules: { coordinator: this.state, browser: this.web?.current ? 'running' : 'idle', nativeCapture: this.frames.child ? 'running' : 'idle', load: this.loading || this.frameBusy ? 'pending' : 'idle' } } : {}),
      updates: this.updater ? { status: this.updater.status, version: this.updater.candidate?.version || null, code: this.updater.code || '' } : { status: 'NotConfigured' },
      version: this.version || '0.1.0', fullPrdAccepted: false };
  }
  async applySettings(input) {
    await this.store.save(input); this.log.debug = this.store.value.debug;
    this.blockedIdentity = null; this.attempt = 0; this.retryAt = 0; this.lastObservation = 0;
    if (!this.store.value.enabled) { this.generation++; await this.presentation.invalidate(this.generation);
      await this.presentation.restore(); this.frames.stop(); await this.web?.stop(); this.setState('Disabled'); }
    else if (this.presentation.windows.size) await this.presentation.configure({ effects: this.store.value.effects,
      policy: effectivePolicy(this.store.value, this.presentation.visibleCount, this.overloaded) });
  }
  async restore() {
    await this.applySettings({ ...this.store.value, enabled: false });
    this.setState('Disabled', 'USER_RESTORED');
  }
  async fail(error, generation = this.generation) {
    if (generation !== this.generation || this.stopped) return;
    this.generation++; await this.presentation.restore(); this.frames.stop(); await this.web?.stop();
    if (/^(?:WEB_(?:AUDIO_VISUALIZER|MEDIA_INTERFACE|RANDOM_FILE_INTERFACE)_UNAVAILABLE|WEB_(?:CREDENTIAL_PROPERTY|PROJECT_INTERFACE)_UNSUPPORTED|GRAPHICS_FORMAT_UNSUPPORTED_\d+)$/.test(error.message)) {
      this.blockedIdentity = this.compatibilityIdentity; this.retryAt = Infinity;
      this.setState('Incompatible', error.message);
      await this.log.event('error', 'compatibility', 'PROJECT_UNSUPPORTED', { code: error.message, generation });
      return;
    }
    this.attempt++;
    const delayMs = Math.min(60000, 2000 * 2 ** Math.min(this.attempt - 1, 5));
    this.retryAt = this.attempt <= 6 ? this.clock() + delayMs : Infinity;
    // Enabled preference is preserved; presentation itself is disabled during recovery.
    this.setState('Recovering', /^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'PRESENTATION_FAILED');
    await this.log.event('error', 'recovery', 'SAFE_RESTORE', { code: this.code, attempt: this.attempt, delayMs });
    await this.log.failure?.('presentation', 'LOAD_FAILURE', error, { generation });
  }
  async tick() {
    if (this.ticking || this.stopped) return; this.ticking = true;
    this.tickDone = new Promise(resolve => { this.finishTick = resolve; });
    try {
      const now = this.clock(), s = this.store.value;
      if (!this.apps || now - this.lastProbe >= 5000) {
        this.apps = await this.probe(); if (this.stopped) return; this.lastProbe = now;
        const identity = JSON.stringify([this.apps.codex?.map(a => [a.pid, a.version, a.endpoints]),
          this.apps.wallpaperEngine && [this.apps.wallpaperEngine.pid, this.apps.wallpaperEngine.version,
            this.apps.wallpaperEngine.surfaces?.map(surface => [surface.hwnd, surface.type, surface.className])]]);
        if (identity !== this.environmentIdentity) { this.environmentIdentity = identity; this.blockedIdentity = null; this.attempt = 0; this.retryAt = 0; }
      }
      if (this.apps.wallpaperEngine && (now - this.lastObservation >= 3000 || (this.wallpaper.dirty && now - this.lastObservation >= 500))) {
        const observation = await this.wallpaper.observe(this.apps.wallpaperEngine, s); if (this.stopped) return; this.lastObservation = now;
        this.sourceMethod = observation.sourceMethod;
        if (observation.source?.fingerprint !== this.source?.fingerprint) {
          const previous = this.source;
          this.source = observation.source; this.generation++; this.retryAt = 0; this.attempt = 0; this.blockedIdentity = null;
          this.sourceWaitAt = 0; this.lastSourceFrameSequence = null;
          this.backendMetrics = null;
          this.surfaceWaitStarted = null;
          if (previous && (previous.type !== this.source.type || previous.resource !== this.source.resource)) {
            if (previous.type === 'web') await this.web?.stop();
            if (['scene', 'application'].includes(previous.type)) this.frames.stop();
          }
          await this.presentation.invalidate(this.generation);
          void this.log.event('info', 'wallpaper', 'SOURCE_CHANGED', { id: this.source.id, type: this.source.type,
            generation: this.generation, sourceMethod: this.sourceMethod });
        }
      }
      if (!s.enabled) { this.setState('Disabled'); return; }
      const app = this.apps.codex?.find(x => x.endpoints?.length);
      if (!this.apps.wallpaperEngine || !app || !this.source) {
        if (this.presentation.windows.size) { this.generation++; await this.presentation.restore(); this.frames.stop(); await this.web?.stop(); }
        this.setState('WaitingForApps', !this.apps.wallpaperEngine ? 'WAITING_FOR_WALLPAPER_ENGINE' : !app ? 'CODEX_CONNECTION_REQUIRED' : 'WAITING_FOR_SOURCE'); return;
      }
      const identity = `${this.environmentIdentity}:${this.source.fingerprint}:${s.allowCandidateAdapter}:${s.experimentalWindowFrames}`;
      this.compatibilityIdentity = identity;
      if (this.blockedIdentity === identity) return;
      if (this.retryAt && now < this.retryAt) return;
      if (now - this.lastHeartbeat >= 3000) {
        this.lastHeartbeat = now;
        await this.presentation.heartbeat();
        await this.presentation.configure({ effects: s.effects, policy: effectivePolicy(s, this.presentation.visibleCount || 1, this.overloaded) });
        try { this.compatibility = await this.presentation.reconcile(this.apps.codex.flatMap(x => (x.endpoints || []).map(port => ({ port, version: x.version }))), app.version, s.allowCandidateAdapter); }
        catch (error) {
          if (/ADAPTER_UNVERIFIED|STRUCTURE_INCOMPATIBLE/.test(error.message)) {
            await this.presentation.restore(); this.frames.stop(); await this.web?.stop(); this.blockedIdentity = identity;
            this.setState('Incompatible', error.message); return;
          } throw error;
        }
        if (this.stopped) return;
      }
      if (!this.presentation.windows.size) {
        this.setState(this.compatibility?.incompatible ? 'Incompatible' : 'WaitingForApps',
          this.compatibility?.incompatible ? 'CODEX_STRUCTURE_INCOMPATIBLE' : 'WAITING_FOR_CODEX_WINDOW'); return;
      }
      const policy = effectivePolicy(s, this.presentation.visibleCount, this.overloaded);
      const useVideo = this.source.type === 'video';
      const useWeb = this.source.type === 'web' && !!this.web;
      const useApplication = this.source.type === 'application';
      const verifiedScene = this.source.type === 'scene' && this.capabilities?.automaticSceneVersions?.includes(this.apps.wallpaperEngine.version);
      if (!useVideo && !useWeb && !useApplication && !verifiedScene && !s.experimentalWindowFrames) {
        await this.presentation.restore(); this.blockedIdentity = identity;
        this.setState('Incompatible', `${this.source.type.toUpperCase()}_NEEDS_RENDERER_VALIDATION`); return;
      }
      if (useVideo) {
        if (policy.paused) this.setState('Paused');
        else if (!this.loading && [...this.presentation.windows.values()].some(w => w.visible && w.generation !== this.generation)) {
          const generation = this.generation, source = this.source;
          this.setState('LoadingWallpaper');
          this.loading = this.presentation.video(source, generation, () => !this.stopped && this.store.value.enabled && generation === this.generation)
            .then(committed => { if (committed && generation === this.generation) { this.attempt = 0; this.retryAt = 0;
              this.setState(this.presentation.visibleCount ? 'Active' : 'Paused'); } })
            .catch(error => this.fail(error, generation)).finally(() => { this.loading = null; });
        } else if (!this.loading) this.setState(policy.paused ? 'Paused' : 'Active');
      } else {
        // Only an application-owned renderer surface may be captured. Never a monitor,
        // desktop, Codex window, arbitrary executable, or a new unmuted pop-out instance.
        if (useApplication && (this.appSurfaceFingerprint !== this.source.fingerprint || now - (this.lastAppSurfaceProbe || 0) >= 5000)) {
          this.appSurfaces = await applicationSurfaces(this.source.resource, this.apps.wallpaperEngine.pid);
          this.appSurfaceFingerprint = this.source.fingerprint; this.lastAppSurfaceProbe = now;
        }
        const surfaces = useApplication ? this.appSurfaces : (this.apps.wallpaperEngine.surfaces || []).filter(x => x.type === this.source.type &&
          (!verifiedScene || x.className === this.capabilities.sceneWindowClass));
        if (!useWeb && !surfaces.length && (useApplication || s.monitor === 0)) {
          this.surfaceWaitStarted ??= now;
          if (now - this.surfaceWaitStarted > 15000) { await this.fail(new Error('WALLPAPER_RENDER_SURFACE_UNAVAILABLE')); return; }
          this.retryAt = now + 1000; this.setState('LoadingWallpaper', 'WAITING_FOR_WALLPAPER_RENDER_SURFACE'); return;
        }
        if (!useWeb && (surfaces.length !== 1 || (!useApplication && s.monitor !== 0))) {
          await this.presentation.restore(); this.frames.stop();
          // Recheck Application window membership; these windows can appear or
          // close without the selected EXE or WE PID changing.
          if (useApplication) this.retryAt = now + 5000; else this.blockedIdentity = identity;
          this.setState('Incompatible', 'WALLPAPER_RENDER_SURFACE_AMBIGUOUS'); return;
        }
        this.surfaceWaitStarted = null;
        if (!policy.paused && !this.frameBusy && now >= (this.sourceWaitAt || 0) && now - this.lastFrame >= 1000 / policy.fps) {
          this.frameBusy = true; this.lastFrame = now; const generation = this.generation;
          const capture = useWeb ? this.web.capture(this.source, policy) : this.frames.capture(surfaces[0], policy);
          capture.then(async frame => {
            if (generation !== this.generation || this.stopped) return;
            if (frame?.paused) { this.sourceWaitAt = this.clock() + 5000; this.setState('Paused', 'SOURCE_RENDER_PAUSED'); return; }
            if (!frame) { this.setState('LoadingWallpaper'); return; }
            this.backendMetrics = frame.metrics;
            if (frame.sequence === undefined || frame.sequence === 0 || this.lastSourceFrameSequence !== `${generation}:${frame.sequence}` ||
                [...this.presentation.windows.values()].some(w => w.generation !== generation)) {
              await this.presentation.frame(frame, generation); this.lastSourceFrameSequence = `${generation}:${frame.sequence}`;
            }
            this.attempt = 0; this.retryAt = 0;
            if (frame.sourcePaused) { this.sourceWaitAt = this.clock() + 1000; this.setState('Paused', 'SOURCE_RENDER_PAUSED'); return; }
            this.sourceWaitAt = 0;
            this.setState('Active', useWeb ? `${this.source.type.toUpperCase()}_ISOLATED_MUTED` : useApplication ? 'APPLICATION_EXISTING_RENDERER' : verifiedScene ? 'SCENE_EXISTING_RENDERER' : 'EXPERIMENTAL_RENDERER_FRAMES');
          }).catch(error => this.fail(error, generation)).finally(() => { this.frameBusy = false; });
        } else if (policy.paused) { if (useWeb && this.web.current) await this.web.configure(policy); this.setState('Paused'); }
      }
      if (now - this.lastMetrics >= 10000) {
        const usage = process.cpuUsage(this.cpu), elapsed = now - this.measureAt;
        const cpu = elapsed > 0 ? (usage.user + usage.system) / (elapsed * 1000) : null;
        let aggregate;
        if (this.processSampler) try { aggregate = await this.processSampler.collect([process.pid, Number(process.env.BRIDGE_PARENT_PID), this.web?.child?.pid, this.frames.child?.pid]); } catch { }
        this.cpu = process.cpuUsage(); this.measureAt = this.lastMetrics = now;
        this.overloaded = (aggregate?.cpu ?? cpu ?? 0) > 0.25;
        const nativePlayback = [...this.presentation.windows.values()].map(w => w.playback).filter(Boolean);
        this.metrics = { cpu, memory: process.memoryUsage().rss, ...(aggregate || { scope: 'node-only' }), gpu: 'unavailable',
          decoding: this.source.type === 'video' && nativePlayback.length ? nativePlayback : this.backendMetrics || 'unavailable',
          rendererFps: [...this.presentation.windows.values()].map(w => w.fps) };
        void this.log.event('debug', 'performance', 'METRICS', { cpu, memory: this.metrics.memory, fps: policy.fps, windowCount: this.presentation.windows.size });
      }
    } catch (error) { await this.fail(error); }
    finally { this.ticking = false; this.finishTick?.(); }
  }
  async stop() {
    this.stopped = true; this.generation++;
    if (this.ticking) {
      let timer;
      try { await Promise.race([this.tickDone, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(timer); }
    }
    this.wallpaper.close(); this.frames.stop(); await this.web?.stop();
    await this.presentation.restore(); this.setState('Stopped');
    await this.log.event('info', 'lifecycle', 'STOPPED');
  }
}
