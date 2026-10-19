// This function is serialized into the isolated browser before project scripts.
// It implements documented WE callbacks with real host data, never simulated
// spectra, song metadata or randomly invented file paths.
function installWebRuntime(options) {
  const state = { audio: false, media: false, random: [], loaded: false };
  const callbacks = Object.create(null), random = new Map(), mediaVersions = new Map(); let requestId = 0;
  let aliases = options.aliases, policy = options.policy;
  const invoke = (callback, ...args) => { if (typeof callback === 'function') { try { callback(...args); } catch { } } };
  function rewrite(value) {
    if (typeof value !== 'string' || !/^file:\/\//i.test(value)) return value;
    let key; try { key = decodeURIComponent(value.replace(/^file:\/+/, '')).replaceAll('\\', '/').toLowerCase(); } catch { return value; }
    return aliases[key] || value;
  }
  const rewriteCss = value => typeof value === 'string' ? value.replace(/url\(\s*(['"]?)(file:\/\/[^)'"]+)\1\s*\)/gi, (_, quote, file) => `url("${rewrite(file)}")`) : value;
  // WE returns OS paths and authored wallpapers prefix these with file:///. The
  // HTTP fallback remaps only explicit property grants to its capability server.
  // Unselected local paths remain file: URLs and Chromium continues to deny them.
  for (const [type, property] of [[HTMLImageElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLVideoElement, 'poster'], [HTMLLinkElement, 'href']]) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, property);
    if (descriptor?.set) Object.defineProperty(type.prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, rewrite(value)); } });
  }
  const attribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = String(name).toLowerCase();
    return attribute.call(this, name, key === 'style' ? rewriteCss(value) : ['src', 'href', 'poster'].includes(key) ? rewrite(value) : value);
  };
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) { return setProperty.call(this, name, rewriteCss(value), priority); };
  for (const property of ['cssText', 'background', 'backgroundImage', 'maskImage', 'borderImageSource', 'content', 'listStyleImage']) {
    const descriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, property);
    if (descriptor?.set) Object.defineProperty(CSSStyleDeclaration.prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, rewriteCss(value)); } });
  }
  for (const method of ['insertRule', 'replace', 'replaceSync']) {
    const original = CSSStyleSheet.prototype[method];
    if (original) CSSStyleSheet.prototype[method] = function(rule, ...args) { return original.call(this, rewriteCss(rule), ...args); };
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (input instanceof Request) { const url = rewrite(input.url); return originalFetch.call(this, url === input.url ? input : new Request(url, input), init); }
    return originalFetch.call(this, rewrite(input instanceof URL ? input.href : input), init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, rewrite(url instanceof URL ? url.href : url), ...args); };
  function repair(element) {
    if (!(element instanceof Element)) return;
    for (const name of ['src', 'href', 'poster']) {
      const value = element.getAttribute(name), next = rewrite(value); if (next !== value) attribute.call(element, name, next);
    }
    const style = element.getAttribute('style'), next = rewriteCss(style); if (style !== next) attribute.call(element, 'style', next);
    if (element.tagName === 'STYLE') { const text = element.textContent, replaced = rewriteCss(text); if (text !== replaced) element.textContent = replaced; }
  }
  new MutationObserver(rows => {
    for (const row of rows) {
      repair(row.target);
      for (const node of row.addedNodes || []) if (node.nodeType === 1) { repair(node); for (const element of node.querySelectorAll('[src],[href],[poster],[style],style')) repair(element); }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster', 'style'] });
  window.wallpaperOnVideoEnded = () => {};
  window.wallpaperRegisterAudioListener = callback => { if (typeof callback === 'function') { callbacks.audio = callback; state.audio = true; } };
  for (const name of ['Status', 'Properties', 'Thumbnail', 'Playback', 'Timeline']) {
    window[`wallpaperRegisterMedia${name}Listener`] = callback => {
      if (typeof callback === 'function') { callbacks[name] = callback; state.media = true; mediaVersions.delete(name); }
    };
  }
  const playback = Object.freeze({ PLAYING: 1, PAUSED: 2, STOPPED: 0 });
  window.wallpaperMediaIntegration = Object.freeze({ PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2, PLAYBACK_STOPPED: 0, playback });
  window.wallpaperRequestRandomFileForProperty = (key, callback) => {
    if (typeof key !== 'string' || typeof callback !== 'function') return;
    if (random.size >= 32) { window.__cwbUnsupported = 'WEB_RANDOM_FILE_INTERFACE_UNAVAILABLE'; return; }
    const id = ++requestId; random.set(id, callback); state.random.push({ id, key });
  };
  window.wallpaperQuery = ({ onFailure } = {}) => invoke(onFailure, 1, 'Interface unavailable in Bridge');
  function general(next, initial = false) {
    const listener = window.wallpaperPropertyListener;
    if (initial || policy.fps !== next.fps) invoke(listener?.applyGeneralProperties?.bind(listener), { fps: next.fps, videoaudiooutput: false });
    if (initial || policy.paused !== next.paused) invoke(listener?.setPaused?.bind(listener), !!next.paused);
    policy = next;
  }
  window.__cwbReadBridgeState = () => ({ audio: state.audio, media: state.media, random: state.random.splice(0, 32), loaded: state.loaded });
  window.__cwbDeliverBridgeData = data => {
    if (data.error) { window.__cwbUnsupported = data.error; return; }
    if (data.aliases) aliases = data.aliases;
    if (data.policy && state.loaded) general(data.policy);
    if (data.audio) invoke(callbacks.audio, data.audio);
    if (data.media) {
      const media = data.media;
      const events = { Status: { enabled: true }, Properties: media.properties || {},
        Playback: { state: playback[String(media.playback || 'stopped').toUpperCase()] },
        Thumbnail: media.thumbnail || { thumbnail: '', primaryColor: '#000000', secondaryColor: '#FFFFFF', tertiaryColor: '#000000', textColor: '#FFFFFF', highContrastColor: '#FFFFFF' },
        Timeline: media.timeline };
      for (const [name, event] of Object.entries(events)) if (event) {
        const version = JSON.stringify(event);
        if (mediaVersions.get(name) !== version) { mediaVersions.set(name, version); invoke(callbacks[name], event); }
      }
    }
    for (const row of data.random || []) { const callback = random.get(row.id); random.delete(row.id); invoke(callback, row.key, row.path); }
    for (const row of data.directories || []) {
      const listener = window.wallpaperPropertyListener;
      if (row.changed?.length) invoke(listener?.userDirectoryFilesAddedOrChanged?.bind(listener), row.key, row.changed);
      if (row.removed?.length) invoke(listener?.userDirectoryFilesRemoved?.bind(listener), row.key, row.removed);
    }
  };
  window.addEventListener('load', () => {
    state.loaded = true; const listener = window.wallpaperPropertyListener;
    const values = Object.fromEntries(Object.entries(options.properties).filter(([, value]) => value?.type !== 'directory' || value.mode !== 'fetchall'));
    invoke(listener?.applyUserProperties?.bind(listener), values); general(policy, true);
    window.__cwbDeliverBridgeData({ directories: options.directories });
  }, { once: true });
}

export function webBootstrap(options) { return `(${installWebRuntime.toString()})(${JSON.stringify(options)});`; }
