import { effectivePolicy } from './config.mjs';
import { inspectNativeAudio } from './native-player.mjs';

export const STATES = Object.freeze(['WaitingForApps', 'CheckingCompatibility', 'Ready', 'LoadingWallpaper',
  'Active', 'Paused', 'Recovering', 'Incompatible', 'Disabled', 'Updating', 'Stopped']);
export class Coordinator {
  constructor({ settings, wallpaper, presentation, frames, web, player, application, processSampler, capabilities, probe, log, clock = Date.now }) {
    Object.assign(this, { store: settings, wallpaper, presentation, frames, web, player, application, processSampler, capabilities, probe, log, clock });
    this.state = 'Disabled'; this.source = null; this.generation = 0; this.attempt = 0;
    this.retryAt = 0; this.blockedIdentity = null; this.loading = null; this.stopped = false;
    this.settingsEpoch = 0; this.changingSettings = false;
    this.frameBusy = false; this.lastFrame = 0; this.lastProbe = 0; this.lastObservation = 0;
    this.lastHeartbeat = 0; this.lastMetrics = 0; this.ticking = false; this.cpu = process.cpuUsage();
    this.measureAt = this.clock(); this.overloaded = false; this.metrics = { gpu: 'unavailable', decoding: 'unavailable' };
  }
  setState(state, code = '') {
    if (this.state !== state || this.code !== code) {
      this.state = state; this.code = code;
      if (state !== 'Active') void this.presentation.setPointerMode?.({ enabled: false, generation: this.generation });
      void this.log.event(state === 'Recovering' ? 'error' : 'info', 'coordinator', 'STATE_CHANGED', { state, code });
    }
  }
  snapshot() {
    const s = this.store.value;
    return { state: this.state, code: this.code || '', settings: s, generation: this.generation,
      source: this.source ? { id: this.source.id, type: this.source.type, sourceMethod: this.sourceMethod, backend: this.backend || null,
        ...(s.debug ? { resource: this.source.resource } : {}) } : null,
      windowCount: this.presentation.windows.size, visibleWindowCount: this.presentation.visibleCount,
      policy: effectivePolicy(s, this.presentation.visibleCount, this.overloaded, this.apps?.displayRefreshHz),
      retry: { attempt: this.attempt, at: this.retryAt || null },
      apps: this.apps ? { codex: this.apps.codex?.map(x => ({ version: x.version, path: x.path, endpoints: x.endpoints })),
        wallpaperEngine: this.apps.wallpaperEngine ? { running: true, version: this.apps.wallpaperEngine.version } : { running: false } } : null,
      metrics: this.metrics, adapter: { id: this.presentation.adapter.id, status: this.presentation.adapter.status },
      ...(s.debug ? { windows: [...this.presentation.windows.values()].map(w => ({ visible: w.visible, generation: w.generation, fps: w.fps, playback: w.playback, connection: 'connected' })),
        modules: { coordinator: this.state, browser: this.web?.current ? 'running' : 'idle', nativeCapture: this.frames.child ? 'running' : 'idle', load: this.loading || this.frameBusy ? 'pending' : 'idle' } } : {}),
      updates: this.updater ? { status: this.updater.status, version: this.updater.candidate?.version || null, code: this.updater.code || '' } : { status: 'NotConfigured' },
      version: this.version || '0.1.0', fullPrdAccepted: false };
  }
  applySettings(input) {
    this.settingsEpoch++; this.changingSettings = true;
    this.pendingSettings = (this.pendingSettings || 0) + 1;
    const result = (this.settingsQueue || Promise.resolve()).then(() => this.saveSettings(input));
    this.settingsQueue = result.catch(() => {});
    return result.finally(() => { this.changingSettings = --this.pendingSettings > 0; });
  }
  async saveSettings(input) {
      const previous = this.store.value;
      await this.store.save(input); this.log.debug = this.store.value.debug;
      if (previous.selectedWallpaper !== this.store.value.selectedWallpaper ||
          JSON.stringify(previous.wallpaperProfiles?.[this.source?.id]?.properties) !== JSON.stringify(this.store.value.wallpaperProfiles?.[this.source?.id]?.properties)) {
        this.generation++; await this.presentation.invalidate(this.generation);
        this.wallpaper.dirty = true;
      }
      if (this.source) this.source.display = this.store.value.wallpaperProfiles?.[this.source.id]?.display;
      this.blockedIdentity = null; this.attempt = 0; this.retryAt = 0; this.lastObservation = 0;
      if (!this.store.value.enabled) { this.generation++; await this.presentation.invalidate(this.generation);
        await this.presentation.restore(); this.frames.stop();
        try { await this.stopBackends(); } catch (error) { this.setState('Recovering', 'OWNED_CLEANUP_PENDING'); throw error; }
        this.setState('Disabled'); }
      else if (this.presentation.windows.size) await this.presentation.configure({ effects: this.store.value.effects,
        display: this.store.value.wallpaperProfiles[this.source?.id]?.display,
        policy: effectivePolicy(this.store.value, this.presentation.visibleCount, this.overloaded, this.apps?.displayRefreshHz) });
  }
  async stopBackends() {
    const results = await Promise.allSettled([this.web, this.player, this.application].map(async backend => backend?.stop()));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'OWNED_CLEANUP_PENDING');
  }
  async restore() {
    await this.applySettings({ ...this.store.value, enabled: false });
    this.setState('Disabled', 'USER_RESTORED');
  }
  async fail(error, generation = this.generation, epoch = this.settingsEpoch) {
    const current = () => epoch === this.settingsEpoch && !this.stopped && this.store.value.enabled;
    if (generation !== this.generation || !current()) return;
    this.failedResourceRevision = this.wallpaper.resourceRevision;
    this.generation++; await this.presentation.invalidate(this.generation); if (!current()) return;
    await this.presentation.restore(); if (!current()) return;
    this.frames.stop();
    try { await this.stopBackends(); }
    catch (cleanupFailure) {
      await this.log.event('error', 'cleanup', 'OWNED_CLEANUP_PENDING', { code: cleanupFailure.message });
      error = cleanupFailure;
    }
    if (!current()) return;
    // A failed source returns to the original Codex appearance during backoff.
    if (/^(?:NATIVE_INDEPENDENT_MUTE_UNAVAILABLE|APPLICATION_INDEPENDENT_(?:PLAYBACK_UNSUPPORTED|MUTE_UNAVAILABLE)|ISOLATED_ENGINE_(?:VERSION_UNVERIFIED|UNAVAILABLE)|SCENE_VIEW_CROSS_VOLUME_UNSUPPORTED|WEB_(?:AUDIO_VISUALIZER|MEDIA_INTERFACE|RANDOM_FILE_INTERFACE)_UNAVAILABLE|WEB_(?:CREDENTIAL_PROPERTY|PROJECT_INTERFACE)_UNSUPPORTED|WEB_PROPERTY_(?:FILE_UNAVAILABLE|DIRECTORY_TOO_LARGE)|GRAPHICS_FORMAT_UNSUPPORTED_\d+)$/.test(error.message)) {
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
    await this.log.event('error', 'recovery', 'CODEX_APPEARANCE_RESTORED', { code: this.code, attempt: this.attempt, delayMs });
    await this.log.failure?.('presentation', 'LOAD_FAILURE', error, { generation });
  }
  async tick() {
    if (this.ticking || this.stopped || this.changingSettings) return; this.ticking = true;
    this.tickDone = new Promise(resolve => { this.finishTick = resolve; });
    const epoch = this.settingsEpoch, s = this.store.value;
    const current = () => !this.stopped && !this.changingSettings && epoch === this.settingsEpoch && s === this.store.value;
    try {
      const now = this.clock();
      if (!this.apps || now - this.lastProbe >= 5000) {
        const apps = await this.probe(); if (!current()) return; this.apps = apps; this.lastProbe = now;
        const identity = JSON.stringify([this.apps.codex?.map(a => [a.pid, a.version, a.endpoints]),
          this.apps.wallpaperEngine && [this.apps.wallpaperEngine.pid, this.apps.wallpaperEngine.version]]);
        if (identity !== this.environmentIdentity) { this.environmentIdentity = identity; this.blockedIdentity = null; this.attempt = 0; this.retryAt = 0; }
      }
      if (!s.enabled) { this.setState('Disabled'); return; }
      // Refresh attached renderer leases while enabled.
      if (s.enabled && now - (this.lastLease || 0) >= 3000) { await this.presentation.heartbeat(); if (!current()) return; this.lastLease = now; }
      if (this.state === 'Recovering' && now < this.retryAt) {
        if (this.wallpaper.resourceRevision === this.failedResourceRevision) return;
        this.retryAt = 0; this.attempt = 0;
      }
      if (now - this.lastObservation >= 3000 || (this.wallpaper.dirty && now - this.lastObservation >= 500)) {
        const observation = await this.wallpaper.observe(this.apps.wallpaperEngine, s); if (!current()) return; this.lastObservation = now;
        this.sourceMethod = observation.sourceMethod;
        if (observation.source?.fingerprint !== this.source?.fingerprint) {
          const previous = this.source;
          this.source = observation.source; this.generation++; this.retryAt = 0; this.attempt = 0; this.blockedIdentity = null;
          this.sourceWaitAt = 0; this.lastSourceFrameSequence = null;
          this.backendMetrics = null;
          this.surfaceWaitStarted = null;
          if (previous) {
            if (previous.type === 'web') await this.web?.stop();
            if (!current()) return;
            // Native playback can supply Video, Web or Scene. Source type alone
            // cannot identify which owned backend needs releasing.
            this.frames.stop(); await this.player?.stop(); if (!current()) return;
            await this.application?.stop(); if (!current()) return;
          }
          await this.presentation.invalidate(this.generation);
          if (!current()) return;
          if (this.source) await this.presentation.configure({ effects: s.effects, display: this.source.display,
            policy: effectivePolicy(s, this.presentation.visibleCount || 1, this.overloaded, this.apps?.displayRefreshHz) });
          if (!current()) return;
          void this.log.event('info', 'wallpaper', 'SOURCE_CHANGED', { id: this.source?.id || '', type: this.source?.type || '',
            generation: this.generation, sourceMethod: this.sourceMethod });
        }
      }
      const app = this.apps.codex?.find(x => x.endpoints?.length);
      if (!app || !this.source) {
        if (!this.source && this.presentation.windows.size) { await this.presentation.restore(); if (!current()) return; }
        if (!app) {
          if (this.presentation.windows.size) { this.generation++; await this.presentation.restore(); if (!current()) return; }
          this.frames.stop(); await this.web?.stop(); if (!current()) return;
          await this.player?.stop(); if (!current()) return;
          await this.application?.stop(); if (!current()) return;
        }
        this.setState('WaitingForApps', !app ? 'CODEX_CONNECTION_REQUIRED' : 'SELECT_INDEPENDENT_WALLPAPER'); return;
      }
      const identity = `${this.environmentIdentity}:${this.source.fingerprint}:${s.allowCandidateAdapter}:${s.experimentalWindowFrames}`;
      this.compatibilityIdentity = identity;
      if (this.blockedIdentity === identity) return;
      if (this.retryAt && now < this.retryAt) return;
      if (now - this.lastHeartbeat >= 3000) {
        this.lastHeartbeat = now;
        await this.presentation.heartbeat();
        if (!current()) return;
        await this.presentation.configure({ effects: s.effects, display: this.source.display, policy: effectivePolicy(s, this.presentation.visibleCount || 1, this.overloaded, this.apps?.displayRefreshHz) });
        if (!current()) return;
        try { this.compatibility = await this.presentation.reconcile(this.apps.codex.flatMap(x => (x.endpoints || []).map(port => ({ port, version: x.version }))), app.version, s.allowCandidateAdapter); }
        catch (error) {
          if (!current()) return;
          if (/ADAPTER_UNVERIFIED|STRUCTURE_INCOMPATIBLE/.test(error.message)) {
            await this.presentation.restore(); this.frames.stop(); await this.web?.stop(); await this.player?.stop(); await this.application?.stop(); this.blockedIdentity = identity;
            this.setState('Incompatible', error.message); return;
          } throw error;
        }
        if (!current()) return;
      }
      if (!this.presentation.windows.size) {
        this.setState(this.compatibility?.incompatible ? 'Incompatible' : 'WaitingForApps',
          this.compatibility?.incompatible ? 'CODEX_STRUCTURE_INCOMPATIBLE' : 'WAITING_FOR_CODEX_WINDOW'); return;
      }
      const policy = effectivePolicy(s, this.presentation.visibleCount, this.overloaded, this.apps?.displayRefreshHz);
      if (this.source.type !== 'video' && this.player && this.nativeFingerprint !== this.source.fingerprint) {
        const safety = await (this.player.inspect ? this.player.inspect(this.source) : inspectNativeAudio(this.source)); if (!current()) return;
        this.nativeSafety = safety; this.nativeFingerprint = this.source.fingerprint;
      }
      if (this.source.type === 'application' && this.application && this.applicationFingerprint !== this.source.fingerprint) {
        this.applicationSafety = await this.application.inspect(this.source); if (!current()) return;
        this.applicationFingerprint = this.source.fingerprint;
      }
      // Original media stays in the client decoder. Sending WGC/JPEG frames for
      // a silent MP4 was limited to about 9 FPS on the reference machine; native
      // audio safety remains relevant to the separately requested WE preview.
      const useVideo = this.source.type === 'video';
      const useNative = !useVideo && !!this.player && !!this.nativeSafety?.safe;
      const useWeb = this.source.type === 'web' && !!this.web && !useNative;
      const useApplication = this.source.type === 'application' && !!this.application && !!this.applicationSafety?.safe;
      this.backend = useVideo ? 'chromium-muted-video' : useWeb ? 'isolated-muted-web' : useNative ? this.player.backend || 'wallpaper-engine-window' : useApplication ? this.application.backend : 'unsupported';
      if (this.source.type === 'scene' && this.player && !useNative) { await this.fail(new Error(this.nativeSafety?.code || 'NATIVE_INDEPENDENT_MUTE_UNAVAILABLE')); return; }
      if (this.source.type === 'application' && !useApplication) { await this.fail(new Error(this.applicationSafety?.code || 'APPLICATION_INDEPENDENT_PLAYBACK_UNSUPPORTED')); return; }
      if (!useVideo && !useWeb && !useNative && !useApplication) {
        await this.presentation.restore(); this.blockedIdentity = identity;
        this.setState('Incompatible', `${this.source.type.toUpperCase()}_NEEDS_RENDERER_VALIDATION`); return;
      }
      if (useVideo) {
        if (policy.paused) this.setState('Paused');
        else if (!this.loading && [...this.presentation.windows.values()].some(w => w.visible && w.generation !== this.generation)) {
          const generation = this.generation, source = this.source;
          this.setState('LoadingWallpaper');
          this.loading = this.presentation.video(source, generation, () => current() && this.store.value.enabled && generation === this.generation)
            .then(committed => { if (committed && current() && generation === this.generation) { this.attempt = 0; this.retryAt = 0;
              this.setState(this.presentation.visibleCount ? 'Active' : 'Paused'); } })
            .catch(error => current() ? this.fail(error, generation, epoch) : undefined).finally(() => { this.loading = null; });
        } else if (!this.loading) this.setState(policy.paused ? 'Paused' : 'Active');
      } else {
        // Only a verified owned renderer is captured. A private native engine has
        // audio disabled in its own configuration before its first instruction.
        if (!policy.paused && !this.frameBusy && now >= (this.sourceWaitAt || 0) && now >= (this.nextFrameAt || 0)) {
          this.frameBusy = true; this.lastFrame = now;
          this.nextFrameAt = Math.max((this.nextFrameAt || now) + 1000 / policy.fps, now);
          const generation = this.generation;
          const capture = useWeb ? this.web.capture(this.source, policy) : useApplication ? this.application.capture(this.source, policy) : this.player.capture(this.source, policy);
          capture.then(async frame => {
            if (generation !== this.generation || !current() || !this.store.value.enabled) return;
            if (frame?.paused) { this.sourceWaitAt = this.clock() + 5000; this.setState('Paused', 'SOURCE_RENDER_PAUSED'); return; }
            if (!frame) { this.setState('LoadingWallpaper'); return; }
            this.backendMetrics = frame.metrics;
            if (frame.sequence === undefined || frame.sequence === 0 || this.lastSourceFrameSequence !== `${generation}:${frame.sequence}` ||
                [...this.presentation.windows.values()].some(w => w.generation !== generation)) {
              await this.presentation.frame(frame, generation); if (!current() || generation !== this.generation) return;
              this.lastSourceFrameSequence = `${generation}:${frame.sequence}`;
            }
            this.attempt = 0; this.retryAt = 0;
            if (frame.sourcePaused) { this.sourceWaitAt = this.clock() + 1000; this.setState('Paused', 'SOURCE_RENDER_PAUSED'); return; }
            this.sourceWaitAt = 0;
            this.setState('Active', useWeb ? 'WEB_ISOLATED_MUTED' : `${this.source.type.toUpperCase()}_INDEPENDENT_NATIVE`);
          }).catch(error => current() ? this.fail(error, generation, epoch) : undefined).finally(() => { this.frameBusy = false; });
        } else if (policy.paused) {
          if (useWeb && this.web.current) await this.web.configure(policy);
          if (!current()) return;
          // WE pause/play commands are global in this version. Close only our
          // independent source while hidden; recreate it on the next visible
          // frame, keeping the canvas snapshot throughout.
          if (useNative && this.player.surface && !this.frameBusy) await this.player.stop();
          if (useApplication && this.application.session && !this.frameBusy) await this.application.stop();
          if (!current()) return;
          this.setState('Paused');
        }
      }
      const pointerBackend = useWeb ? this.web : useNative ? this.player : useApplication ? this.application : null;
      const pointerEnabled = this.state === 'Active' && !policy.paused && typeof pointerBackend?.pointer === 'function';
      await this.presentation.setPointerMode?.({ enabled: pointerEnabled, generation: this.generation });
      if (!current()) return;
      const pointerGeneration = this.generation;
      for (const event of this.presentation.drainPointers?.(pointerGeneration) || []) {
        if (!pointerEnabled || !current() || this.generation !== pointerGeneration) break;
        const receivedAt = event.receivedAt;
        const valid = () => {
          const now = Date.now();
          return current() && this.generation === pointerGeneration && this.state === 'Active' &&
            Number.isFinite(receivedAt) && receivedAt <= now && now - receivedAt < 250;
        };
        if (!valid()) continue;
        try { await pointerBackend.pointer(event, { current: valid }); }
        catch { void this.log.event('info', 'pointer', 'POINTER_FORWARDING_UNAVAILABLE', { code: 'BACKEND_INPUT_FAILED' }); }
      }
      if (now - this.lastMetrics >= 10000) {
        const usage = process.cpuUsage(this.cpu), elapsed = now - this.measureAt;
        const cpu = elapsed > 0 ? (usage.user + usage.system) / (elapsed * 1000) : null;
        let aggregate;
        if (this.processSampler) try { aggregate = await this.processSampler.collect([process.pid, Number(process.env.BRIDGE_PARENT_PID), this.web?.child?.pid, this.frames.child?.pid]); } catch { }
        if (!current()) return;
        this.cpu = process.cpuUsage(); this.measureAt = this.lastMetrics = now;
        this.overloaded = (aggregate?.cpu ?? cpu ?? 0) > 0.25;
        const nativePlayback = [...this.presentation.windows.values()].map(w => w.playback).filter(Boolean);
        this.metrics = { cpu, memory: process.memoryUsage().rss, ...(aggregate || { scope: 'node-only' }), gpu: 'unavailable',
          decoding: this.source.type === 'video' && nativePlayback.length ? nativePlayback : this.backendMetrics || 'unavailable',
          rendererFps: [...this.presentation.windows.values()].map(w => w.fps) };
        void this.log.event('debug', 'performance', 'METRICS', { cpu, memory: this.metrics.memory, fps: policy.fps, windowCount: this.presentation.windows.size });
      }
    } catch (error) { if (current()) await this.fail(error, this.generation, epoch); }
    finally { this.ticking = false; this.finishTick?.(); }
  }
  async stop() {
    this.stopped = true; this.generation++;
    if (this.ticking) {
      let timer;
      try { await Promise.race([this.tickDone, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(timer); }
    }
    this.wallpaper.close(); this.frames.stop();
    await this.presentation.restore();
    try { await this.stopBackends(); } catch (error) { this.setState('Recovering', 'OWNED_CLEANUP_PENDING'); throw error; }
    this.setState('Stopped');
    await this.log.event('info', 'lifecycle', 'STOPPED');
  }
}
