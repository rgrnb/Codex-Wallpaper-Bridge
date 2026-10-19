import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeSource } from './wallpaper-engine.mjs';
import { HOST } from './platform.mjs';
import { inspectSilentUnityApplication, stageSilentUnityApplication, removeSilentUnityApplication } from './silent-unity-application.mjs';

const WORKER = fileURLToPath(new URL('./independent-application-worker.ps1', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const positive = value => Number.isInteger(value) && value > 0;
const identityValid = value => value && positive(value.pid) && /^\d{16,20}$/.test(value.startTime)
  && /^[a-f0-9-]{36}$/.test(value.session) && typeof value.executable === 'string' && path.isAbsolute(value.executable);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const bounded = (value, fallback, minimum, maximum) => Number.isFinite(value) && value > 0 ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
export function applicationRenderPolicy(policy = {}) {
  const maxWidth = bounded(policy.maxWidth, 1280, 320, 1920);
  return { maxWidth, height: bounded(policy.height, Math.round(maxWidth * 9 / 16), 180, 2160), jpegQuality: bounded(policy.jpegQuality, 75, 30, 95) };
}
const sameLaunchPolicy = (a, b) => a?.maxWidth === b.maxWidth && a?.height === b.height;
export function applicationEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    /^(?:SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|PATH|PATHEXT|COMSPEC|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|USERNAME|USERDOMAIN)$/i.test(key)));
}
const surfaceValid = (surface, identity) => surface && /^\d{1,20}$/.test(surface.hwnd) && BigInt(surface.hwnd) > 0n
  && surface.pid === identity.pid && surface.startTime === identity.startTime && surface.session === identity.session
  && surface.type === 'application' && surface.backend === 'independent-owned-application'
  && samePath(surface.sourceFile, identity.executable) && positive(surface.width) && positive(surface.height)
  && surface.width * surface.height <= 16777216;

// The absence of an audio asset, an EXE filename or a caller-provided flag is
// not a proof that an arbitrary application cannot synthesize sound. Keep this
// default closed until a reviewed source or a pre-resume audio backend exists.
export async function inspectApplicationAudio(source) {
  return inspectSilentUnityApplication(source);
}

export class PowerShellApplicationAdapter {
  constructor({ launch = spawn, worker = WORKER, graphicsHost = HOST, applicationInputAssembly = path.join(path.dirname(graphicsHost), 'BridgeApplicationInput.dll') } = {}) {
    this.launch = launch; this.worker = worker; this.graphicsHost = graphicsHost; this.applicationInputAssembly = applicationInputAssembly;
    this.child = null; this.pending = null; this.sequence = 0; this.buffer = ''; this.closed = Promise.resolve();
  }
  open(specification) {
    if (this.stoppingChild) throw new Error('APPLICATION_WORKER_STOP_PENDING');
    if (this.child) return;
    const environment = applicationEnvironment();
    // The reviewed original Sheep is PE i386. Its private input DLL and loader
    // must share that architecture; ordinary authored apps keep the WM worker.
    const reviewed = specification?.reviewedPointer?.profile === 'unity-2017.2-reviewed-sheep';
    const executable = reviewed ? path.win32.join(environment.WINDIR || environment.SystemRoot || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    const child = this.child = this.launch(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.worker,
      '-GraphicsHost', reviewed ? this.applicationInputAssembly : this.graphicsHost],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment });
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { this.abort(new Error('APPLICATION_PROTOCOL_TOO_LARGE')); return; }
      for (let index; (index = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, index).replace(/^\uFEFF/, ''); this.buffer = this.buffer.slice(index + 1);
        let value; try { value = JSON.parse(line); } catch { this.abort(new Error('APPLICATION_PROTOCOL_INVALID')); return; }
        const pending = this.pending;
        if (!pending || value.id !== pending.id) { this.abort(new Error('APPLICATION_PROTOCOL_ID_INVALID')); return; }
        this.pending = null; clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error(value.error)); else pending.resolve(value.result);
      }
    });
    child.stdin.on('error', () => { if (this.child === child) this.abort(new Error('APPLICATION_WORKER_CLOSED')); });
    child.on('error', () => { if (this.child === child) this.abort(new Error('APPLICATION_WORKER_START_FAILED')); });
    child.on('exit', () => { if (this.child === child) this.abort(new Error('APPLICATION_WORKER_CLOSED')); });
  }
  request(operation, parameters, timeout = 5000) {
    if (this.pending) return Promise.reject(new Error('APPLICATION_BACKPRESSURE'));
    this.open(operation === 'start' ? parameters : null);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.abort(new Error('APPLICATION_WORKER_TIMEOUT')), timeout);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(JSON.stringify({ id, operation, ...parameters }) + '\n');
    });
  }
  start(specification) { return this.request('start', specification, 15000); }
  surface(identity, policy) { return this.request('surface', { identity, policy }, 12000); }
  capture(identity, policy) { return this.request('capture', { identity, policy }, 5000); }
  pointer(identity, event) { return this.request('pointer', { identity, event }, 3000); }
  async stop(identity) {
    if (!this.child) return this.stoppingChild ? this.abort() : this.closed;
    if (this.pending) return this.abort();
    try { await this.request('stop', { identity }, 5000); } finally { await this.abort(); }
  }
  abort(error = new Error('APPLICATION_WORKER_STOPPED')) {
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    const child = this.child || this.stoppingChild; this.child = null; this.buffer = '';
    if (this.closing) return this.closed;
    if (child) {
      // The worker's job handle has KILL_ON_JOB_CLOSE. EOF closes it normally;
      // force-killing a hung worker also closes the handle in the kernel.
      this.stoppingChild = child; this.closing = true;
      this.closed = new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode != null || !child.pid) {
          this.stoppingChild = null; this.closing = false; resolve(); return;
        }
        const timer = setTimeout(() => { if (child.exitCode === null) try { child.kill(); } catch {} }, 500); timer.unref();
        const done = () => {
          clearTimeout(timer); clearTimeout(deadline); child.removeListener('exit', done); this.closing = false;
          if (child.exitCode === null && child.signalCode == null) reject(new Error('APPLICATION_WORKER_STOP_TIMEOUT'));
          else { this.stoppingChild = null; resolve(); }
        };
        const deadline = setTimeout(done, 3000); deadline.unref();
        child.once('exit', done);
      });
      // Event-driven aborts have no caller; stop() still observes rejection.
      this.closed.catch(() => {});
      child.stdin.end();
    }
    return this.closed;
  }
}

export class IndependentApplicationPlayer {
  constructor({ adapter = new PowerShellApplicationAdapter(), verifyAudio = inspectApplicationAudio,
    stageRuntime = stageSilentUnityApplication, removeRuntime = removeSilentUnityApplication } = {}) {
    this.adapter = adapter; this.verifyAudio = verifyAudio; this.stageRuntime = stageRuntime; this.removeRuntime = removeRuntime;
    this.queue = Promise.resolve(); this.session = null; this.source = null; this.surface = null;
    this.backend = 'independent-owned-application'; this.runtime = null; this.generation = 0;
  }
  serial(action) { const result = this.queue.then(action, action); this.queue = result.catch(() => {}); return result; }
  inspect(source) { return this.verifyAudio(source); }
  start(source, options = {}) { const generation = this.generation; return this.serial(() => this._start(source, options, generation)); }
  checkGeneration(generation) { if (generation !== this.generation) throw new Error('APPLICATION_START_CANCELLED'); }
  async _start(source, { policy = {}, preview = false } = {}, generation = this.generation) {
    this.checkGeneration(generation);
    if (source?.type !== 'application') throw new Error('APPLICATION_SOURCE_TYPE_INVALID');
    policy = applicationRenderPolicy(policy);
    if (this.source?.fingerprint === source.fingerprint && samePath(this.source.project, source.project)
      && samePath(this.source.resource, source.resource) && samePath(this.source.root, source.root)
      && this.session && this.preview === preview && sameLaunchPolicy(this.launchPolicy, policy)) return this.surface;
    const canonical = await describeSource(source.project);
    if (canonical.type !== 'application' || path.resolve(canonical.resource).toLowerCase() !== path.resolve(source.resource).toLowerCase()
      || path.resolve(canonical.root).toLowerCase() !== path.resolve(source.root).toLowerCase() || !/\.exe$/i.test(canonical.resource))
      throw new Error('APPLICATION_SOURCE_IDENTITY_INVALID');
    // The verifier is a trusted backend dependency, never a field from project
    // metadata or the HTTP selection request. It must review the complete source.
    const audio = await this.verifyAudio(canonical); this.audioSafety = audio;
    this.checkGeneration(generation);
    if (!audio?.safe) {
      const failure = new Error('APPLICATION_INDEPENDENT_MUTE_UNAVAILABLE'); failure.detail = audio?.detail; throw failure;
    }
    const argumentsList = audio.arguments || [];
    if (!Array.isArray(argumentsList) || argumentsList.length > 32 || argumentsList.some(value => typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f]/.test(value)))
      throw new Error('APPLICATION_ARGUMENTS_INVALID');
    await this._stop();
    try {
      this.checkGeneration(generation);
      if (audio.profile) this.runtime = await this.stageRuntime(canonical, audio, policy);
      this.checkGeneration(generation);
      const executable = this.runtime?.executable || canonical.resource;
      const executableHash = sha256(await readFile(executable));
      this.checkGeneration(generation);
      const requestedSession = randomUUID();
      const identity = await this.adapter.start({ session: requestedSession, executable, executableHash, sourceFile: canonical.resource,
        arguments: this.runtime?.arguments || argumentsList, policy, preview,
        ...(audio.profile === 'unity-2017.2-reviewed-sheep' && this.runtime ? {
          reviewedPointer: { profile: audio.profile, runtimeToken: this.runtime.token },
        } : {}) });
      if (!identityValid(identity) || identity.session !== requestedSession || path.resolve(identity.executable).toLowerCase() !== path.resolve(executable).toLowerCase())
        throw new Error('APPLICATION_SESSION_IDENTITY_INVALID');
      this.session = Object.freeze({ ...identity });
      this.checkGeneration(generation);
      this.surface = await this.adapter.surface(this.session, policy);
      if (!surfaceValid(this.surface, this.session)) throw new Error('APPLICATION_SURFACE_IDENTITY_INVALID');
      this.checkGeneration(generation);
      if (audio.profile === 'unity-2017.2-reviewed-sheep') {
        // Unity creates its HWND before loading the scene. Keep the previous
        // Codex frame until this known, nonblack scene actually has content.
        const deadline = Date.now() + 20000;
        do {
          this.checkGeneration(generation);
          const frame = await this.adapter.capture(this.session, policy);
          this.checkGeneration(generation);
          if (frame.visibleContent) { this.preparedFrame = frame; this.preparedFramePolicy = policy; break; }
          await delay(100);
        } while (Date.now() < deadline);
        if (!this.preparedFrame) throw new Error('APPLICATION_SCENE_LOADING_TIMEOUT');
      }
      this.source = source; this.preview = preview; this.launchPolicy = policy; return this.surface;
    } catch (failure) {
      // A staging failure can also fail its own cleanup. Retain its exact
      // ownership identity so a later stop can retry without launching again.
      if (failure.runtime && !this.runtime) this.runtime = failure.runtime;
      try { await this._stop(); }
      catch (cleanupFailure) { throw new AggregateError([failure, cleanupFailure], `${failure.message}; ${cleanupFailure.message}`); }
      throw failure;
    }
  }
  capture(source, policy = {}) {
    const generation = this.generation;
    return this.serial(async () => {
      policy = applicationRenderPolicy(policy);
      await this._start(source, { policy }, generation);
      try {
        if (this.preparedFrame) {
          const frame = this.preparedFrame, prepared = this.preparedFramePolicy; this.preparedFrame = null; this.preparedFramePolicy = null;
          if (sameLaunchPolicy(prepared, policy) && prepared.jpegQuality === policy.jpegQuality) return frame;
        }
        const frame = await this.adapter.capture(this.session, policy);
        this.checkGeneration(generation);
        if (this.runtime && !frame.visibleContent) throw new Error('APPLICATION_RENDER_PAUSED');
        return frame;
      }
      catch (failure) {
        try { await this._stop(); }
        catch (cleanupFailure) { throw new AggregateError([failure, cleanupFailure], `${failure.message}; ${cleanupFailure.message}`); }
        throw failure;
      }
    });
  }
  pointer(event, { current = () => true } = {}) {
    const session = this.session?.session, fingerprint = this.source?.fingerprint, generation = this.generation;
    return this.serial(async () => {
      if (generation !== this.generation || !current() || !this.session || session !== this.session.session || fingerprint !== this.source?.fingerprint
        || !['move', 'click'].includes(event.type) || !Number.isFinite(event.x) || !Number.isFinite(event.y)
        || event.x < 0 || event.x > 1 || event.y < 0 || event.y > 1 || !this.adapter.pointer) return false;
      await this.adapter.pointer(this.session, event); return true;
    });
  }
  async _stop() {
    const identity = this.session; this.source = null; this.surface = null; this.preparedFrame = null; this.preparedFramePolicy = null; this.launchPolicy = null;
    const runtime = this.runtime;
    // Even if an invalid start reply failed validation, close the worker/job.
    await this.adapter.stop(identity);
    this.session = null;
    if (runtime) {
      await this.removeRuntime(runtime);
      if (this.runtime === runtime) this.runtime = null;
    }
  }
  stop() {
    // Invalidate queued input/startup immediately when visibility or selection
    // changes, even while the serialized worker is still preparing a window.
    this.generation++;
    if (this.adapter.pending) this.adapter.abort?.();
    return this.serial(() => this._stop());
  }
}
