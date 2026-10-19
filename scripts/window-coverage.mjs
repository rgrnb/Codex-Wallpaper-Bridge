import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

// Decode only the tiny RGB/RGBA screenshot returned for an authored probe.
// Never retain a full application screenshot or any foreground text.
export function screenshotPixel(encoded) {
  const png = Buffer.from(encoded, 'base64');
  assert.ok(png.length < 16384 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  let width, height, channels; const chunks = [];
  for (let at = 8; at + 12 <= png.length;) {
    const size = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    assert.ok(at + 12 + size <= png.length);
    if (type === 'IHDR') {
      width = png.readUInt32BE(at + 8); height = png.readUInt32BE(at + 12);
      assert.ok(width > 0 && width <= 8 && height > 0 && height <= 8);
      assert.equal(png[at + 16], 8); assert.ok([2, 6].includes(png[at + 17])); assert.equal(png[at + 20], 0);
      channels = png[at + 17] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  assert.ok(channels);
  const stride = width * channels, raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: 264 });
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0, corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = left + up - corner, distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : corner;
      pixels[y * stride + x] = raw[y * (stride + 1) + 1 + x] + [0, left, up, Math.floor((left + up) / 2), paeth][filter];
    }
  }
  return [...pixels.subarray(0, 3)];
}

function inspect(selectors) {
  const rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const signature = (selector, preserveBorder) => [...document.querySelectorAll(selector)].filter(n => n.checkVisibility()).map(n => {
    const s = getComputedStyle(n); return { rect: rect(n), font: [s.fontFamily, s.fontSize, s.fontWeight],
      ...(preserveBorder ? { border: s.borderColor, background: s.backgroundColor, shadow: s.boxShadow } : {}), pointer: s.pointerEvents };
  });
  const layout = Object.fromEntries(['root', 'main', 'sidebar', 'header', 'composer'].map(key => [key, signature(selectors[key], key === 'composer')]));
  const composer = document.querySelector(selectors.composer), candidates = {};
  let composerBounds = composer?.getBoundingClientRect();
  const composerInitial = composerBounds, mainBounds = document.querySelector(selectors.main)?.getBoundingClientRect();
  // The selector identifies the editor layout. Its surrounding control chrome
  // can include padding/toolbars above that layout; sample outside that whole
  // compact subtree rather than sampling the preserved input surface itself.
  for (let node = composer?.parentElement; node && composerInitial && node !== document.querySelector(selectors.main); node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.height > Math.max(composerInitial.height * 2, composerInitial.height + 96) || r.width > (mainBounds?.width || innerWidth) + 24) break;
    if (r.width && r.height) composerBounds = r;
  }
  const regions = { main: document.querySelector(selectors.main), sidebar: document.querySelector(selectors.sidebar),
    header: document.querySelector(selectors.header), composerSurround: composer };
  const clear = (x, y) => {
    const stack = document.elementsFromPoint(x, y);
    if (stack.some(n => n.closest('button,input,textarea,[contenteditable="true"],[role="button"],[role="textbox"],a,svg,img,canvas,video') || getComputedStyle(n).opacity !== '1')) return false;
    for (const node of stack) for (const child of node.childNodes) if (child.nodeType === Node.TEXT_NODE) {
      const range = document.createRange(); range.selectNode(child);
      if ([...range.getClientRects()].some(r => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1)) return false;
    }
    return true;
  };
  for (const [name, node] of Object.entries(regions)) {
    if (!node?.checkVisibility()) { candidates[name] = []; continue; }
    const bounds = name === 'composerSurround' ? composerBounds : node.getBoundingClientRect(), points = [];
    const r = name === 'composerSurround' ? { x: bounds.x - 12, y: bounds.y - 18, width: bounds.width + 24, height: bounds.height + 36 } : bounds;
    for (const py of (name === 'composerSurround' ? [0, 1, .5] : [.12, .38, .62, .88])) for (const px of (name === 'composerSurround' ? [.3, .7, 0, 1] : [.08, .3, .5, .7, .92])) {
      const x = Math.floor(r.x + r.width * px) + .5, y = Math.floor(r.y + r.height * py) + .5;
      const c = composerBounds;
      if (name === 'composerSurround' && c && x >= c.left && x <= c.right && y >= c.top && y <= c.bottom) continue;
      // Exclude the native shell's antialiased edge/shadow at fractional DPI.
      if (x >= 8 && y >= 8 && x < innerWidth - 8 && y < innerHeight - 8 && clear(x, y)) points.push({ x: Math.floor(x), y: Math.floor(y) });
    }
    candidates[name] = points.filter((_, i) => i === 0 || i === Math.floor(points.length / 2) || i === points.length - 1);
  }
  return { layout, candidates, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } };
}

export async function sampleComposedPixels(client, candidates) {
  const regions = {};
  // Chromium temporarily changes shared view/emulation parameters for a
  // clipped screenshot. Concurrent captures can restore another capture's
  // temporary parameters and leave the renderer pinned to its old viewport.
  try { for (const [name, points] of Object.entries(candidates)) {
    regions[name] = [];
    for (const point of points) {
      const capture = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
        clip: { ...point, width: 1, height: 1, scale: 1 } });
      regions[name].push({ ...point, rgb: screenshotPixel(capture.data) });
      await client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    }
  } } finally {
    // These are exclusively owned empty profiles with no device emulation.
    // Clear the diagnostic clip's temporary metrics before any native resize.
    await client.call('Emulation.clearDeviceMetricsOverride');
  }
  return regions;
}

function compositeExpectations(candidates, source) {
  const context = new OffscreenCanvas(1, 1).getContext('2d'), result = {};
  for (const [name, points] of Object.entries(candidates)) result[name] = points.map(point => {
    let expected = [...source], transmission = 1;
    for (const node of document.elementsFromPoint(point.x + .5, point.y + .5).reverse()) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none' || style.opacity !== '1' || style.filter !== 'none' || style.backdropFilter !== 'none')
        return { ...point, unsupported: { tag: node.tagName, image: style.backgroundImage !== 'none', opacity: style.opacity,
          filter: style.filter, backdropFilter: style.backdropFilter } };
      context.clearRect(0, 0, 1, 1); context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
      const rgba = context.getImageData(0, 0, 1, 1).data, alpha = rgba[3] / 255;
      expected = expected.map((value, i) => value * (1 - alpha) + rgba[i] * alpha); transmission *= 1 - alpha;
    }
    return { ...point, expected, transmission };
  });
  return result;
}

export async function verifyWindowCoverage({ clients, adapter, payload, ownGeometry, width, height, report, checkpoint }) {
  const results = report.windowCoverage = { scope: 'Owned empty-profile windows; text-free single-pixel composites and numeric layout only.',
    fullApplicationScreenshotSaved: false, cases: [], completed: false };
  const options = { effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 8294400 } };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Prove native resize before any diagnostic screenshot can affect the view.
  results.initialViewport = (await clients[0].evaluate(`(${inspect.toString()})(${JSON.stringify(adapter.selectors)})`)).viewport;
  await ownGeometry(0, '--maximize'); await wait(800);
  results.preCaptureMaximize = { native: JSON.parse((await ownGeometry(0, '--state')).stdout),
    viewport: await clients[0].evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})') };
  await ownGeometry(0, 10, 50, width, height); await wait(800);
  await checkpoint?.();
  for (const mode of ['normal', 'maximized', 'restored']) {
    const client = clients[0];
    if (mode === 'maximized') {
      await ownGeometry(0, '--maximize');
    } else if (mode === 'restored') {
      await ownGeometry(0, 10, 50, width, height);
    }
    await wait(600);
    const probe = `(${inspect.toString()})(${JSON.stringify(adapter.selectors)})`;
    let before = await client.evaluate(probe);
    const entry = { mode, before, colors: [], after: null }; results.cases.push(entry);
    entry.nativeState = JSON.parse((await ownGeometry(0, '--state')).stdout);
    try {
      if (mode === 'maximized') {
        assert.equal(entry.nativeState.show, 3, 'COVERAGE_NATIVE_MAXIMIZE_REQUIRED');
        entry.resizeObservations = [before.viewport];
        const deadline = Date.now() + 5000;
        while (before.viewport.width <= results.cases[0].before.viewport.width && Date.now() < deadline) {
          await wait(150); before = await client.evaluate(probe); entry.resizeObservations.push(before.viewport);
        }
        entry.before = before;
        assert.ok(before.viewport.width > results.cases[0].before.viewport.width, 'COVERAGE_MAXIMIZED_VIEWPORT_REQUIRED');
      }
      await client.evaluate(payload);
      await client.evaluate(`window.__codexWallpaperBridgeV1.install(${JSON.stringify(options)},${JSON.stringify(adapter.selectors)})`);
      for (let index = 0; index < 2; index++) {
        const color = index ? '#18e638' : '#e62818';
        await client.evaluate(`(async()=>{const c=new OffscreenCanvas(128,72),x=c.getContext('2d');x.fillStyle=${JSON.stringify(color)};x.fillRect(0,0,128,72);const b=await c.convertToBlob({type:'image/jpeg',quality:1});const bytes=new Uint8Array(await b.arrayBuffer());return window.__codexWallpaperBridgeV1.frame(${index},btoa(String.fromCharCode(...bytes)))})()`);
        await wait(420);
        const expected = index ? [24, 230, 56] : [230, 40, 24];
        const model = await client.evaluate(`(${compositeExpectations.toString()})(${JSON.stringify(before.candidates)},${JSON.stringify(expected)})`);
        (entry.compositeModels ||= []).push(model);
        assert.ok(Object.values(model).flat().every(point => !point.unsupported), 'COVERAGE_COMPOSITE_MODEL_UNSUPPORTED');
        const regions = await sampleComposedPixels(client, before.candidates);
        entry.colors.push({ expected, model, regions });
      }
      entry.after = await client.evaluate(probe);
      assert.deepEqual(entry.after.layout, before.layout, 'COVERAGE_LAYOUT_OR_FONT_CHANGED');
      for (const required of ['main', 'sidebar', 'composerSurround']) assert.ok(before.candidates[required].length, `COVERAGE_REGION_MISSING:${mode}:${required}`);
      for (const color of entry.colors) for (const [name, points] of Object.entries(color.regions)) for (const point of points) {
        const expected = color.model[name].find(row => row.x === point.x && row.y === point.y);
        assert.ok(expected && expected.transmission * 206 > 8, `COVERAGE_BACKGROUND_NOT_MEASURABLE:${mode}:${name}`);
        if (!point.rgb.every((value, i) => Math.abs(value - expected.expected[i]) <= 4)) {
          entry.failedPointContext = await client.evaluate(`document.elementsFromPoint(${point.x}+.5,${point.y}+.5).map(n=>{const s=getComputedStyle(n);const r=n.getBoundingClientRect();return {tag:n.tagName,role:n.getAttribute('role'),background:s.backgroundColor,image:s.backgroundImage==='none'?'none':'present',opacity:s.opacity,rect:[r.x,r.y,r.width,r.height],before:getComputedStyle(n,'::before').backgroundColor,after:getComputedStyle(n,'::after').backgroundColor}})`);
          assert.fail(`COVERAGE_OCCLUDED:${mode}:${name}:${point.x},${point.y}:${point.rgb}`);
        }
      }
    } finally {
      await client.evaluate('window.__codexWallpaperBridgeV1?.restore()');
      await checkpoint?.();
    }
  }
  await ownGeometry(0, 10, 50, width, height);
  results.completed = true;
  await checkpoint?.();
}
