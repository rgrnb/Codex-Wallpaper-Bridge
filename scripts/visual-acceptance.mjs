import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CdpClient, listTargets } from '../src/cdp.mjs';
import { Presentation } from '../src/presentation.mjs';
const adapter = JSON.parse(await readFile(new URL('../config/adapter.json', import.meta.url), 'utf8'));
const payload = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8');
const evidence = '.local-evidence/visual-acceptance';
await mkdir(evidence, { recursive: true });
const targets = {
  sidebar: '.sidebar-navigation[data-slate-sidebar-content]',
  rail: '[data-app-navigation-rail]',
  top: '[class*="_MainContentTopFade_"]',
  footer: '.thread-scroll-container [data-thread-scroll-footer] > .pointer-events-none.absolute:empty',
  bottom: '.thread-scroll-container .pointer-events-none.sticky.bottom-0 > .pointer-events-none.absolute:empty',
};
const inspect = () => {
  const signature = selector => [...document.querySelectorAll(selector)].filter(n => n.checkVisibility()).map(n => {
    const s = getComputedStyle(n), r = n.getBoundingClientRect();
    return { rect: [r.x, r.y, r.width, r.height], font: [s.fontFamily, s.fontSize, s.fontWeight],
      background: s.backgroundColor, image: s.backgroundImage, shadow: s.boxShadow, backdrop: s.backdropFilter,
      border: s.borderColor, pointer: s.pointerEvents };
  });
  return { signature, style: selector => signature(selector).map(({ rect, font, ...style }) => style) };
};
const inspectSource = `(${inspect.toString()})()`;
if (process.argv.includes('--live')) {
  // Read structure and pixels of the existing window only. The optional style
  // hot-patch never types, clicks, navigates or restores the current media.
  const port = Number(process.env.BRIDGE_CDP_PORT || 9336);
  let client;
  try {
    for (const target of await listTargets(port)) {
      const candidate = await new CdpClient(target.webSocketDebuggerUrl).connect();
      if (await candidate.evaluate(`!!(document.querySelector(${JSON.stringify(adapter.selectors.main)}) && window.__codexWallpaperBridgeV1 && document.querySelector('canvas[data-cwb-owned]'))`)) { client = candidate; break; }
      candidate.close();
    }
    assert.ok(client, 'A compatible existing wallpaper window is required.');
    const probe = `(() => {const i=${inspectSource};return {regions:Object.fromEntries(Object.entries(${JSON.stringify(targets)}).map(([k,v])=>[k,i.style(v)])),layout:Object.fromEntries(Object.entries(${JSON.stringify({ root: adapter.selectors.root, main: adapter.selectors.main, composer: adapter.selectors.composer })}).map(([k,v])=>[k,i.signature(v).map(({rect,font})=>({rect,font}))])),composer:i.style(${JSON.stringify(adapter.selectors.composer)}),canvasCount:document.querySelectorAll('canvas[data-cwb-owned]').length,playback:window.__codexWallpaperBridgeV1.ping()}})()`;
    const before = await client.evaluate(probe);
    await writeFile(`${evidence}/live-before.png`, Buffer.from((await client.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    if (process.argv.includes('--apply-styles')) {
      await client.evaluate(payload);
      await client.evaluate(`window.__codexWallpaperBridgeV1.refreshStyles(${JSON.stringify(adapter.selectors)})`);
    }
    const after = await client.evaluate(probe);
    await writeFile(`${evidence}/live-after.png`, Buffer.from((await client.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    assert.deepEqual(after.layout, before.layout, 'Shell/input geometry and fonts must remain unchanged.');
    assert.equal(after.canvasCount, 1);
    for (const nodes of Object.values(after.regions)) for (const node of nodes) {
      assert.equal(node.background, 'rgba(0, 0, 0, 0)'); assert.equal(node.image, 'none');
      assert.equal(node.shadow, 'none'); assert.equal(node.backdrop, 'none');
    }
    await writeFile(`${evidence}/live.json`, JSON.stringify({ before, after, currentChatTypedOrNavigated: false, limitations: ['Current visible page only; no new-chat navigation or native window geometry was changed.'] }, null, 2));
    console.log('Live shell acceptance passed; one existing canvas, unchanged geometry, transparent observed shell/fade layers.');
  } finally { client?.close(); }
} else {
  const moduleName = process.env.BRIDGE_PLAYWRIGHT_MODULE;
  const { chromium } = await import(moduleName ? pathToFileURL(moduleName).href : 'playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.BRIDGE_BROWSER_PATH ? { executablePath: process.env.BRIDGE_BROWSER_PATH } : {}) });
  const options = { effects: { opacity: 1, blur: 0, brightness: 1, contrast: 1 }, policy: { fps: 60, pixelBudget: 8294400 }, display: { zoom: 1, positionX: 0.5, positionY: 0.5 } };
  const fixture = `<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;font:16px system-ui;background:#17171c;color:white}
    #root{height:100%;display:grid;grid-template-columns:240px minmax(0,1fr);grid-template-rows:40px minmax(0,1fr);background:#17171c}
    #root.collapsed{grid-template-columns:52px minmax(0,1fr)}header{grid-column:1/-1;background:#24242b;box-shadow:0 8px 10px black;backdrop-filter:blur(12px)}
    aside{display:flex;min-width:0;background:#2a2a32}.sidebar-navigation{background:#313138;flex:1;overflow:auto}[data-app-navigation-rail]{width:45px;background:#22222a}
    .selected{background:#555560}.selected:hover{background:#696977}main{min-width:0;background:#191920;position:relative;display:flex;flex-direction:column}
    .thread-scroll-container{display:flex;flex:1;flex-direction:column;overflow:auto;min-height:0}
    [class*="_MainContentTopFade_"]{position:absolute;top:0;width:100%;height:35px;background:linear-gradient(black,transparent);pointer-events:none}
    .messages{padding:35px 20px;flex:1}.card{background:#383842;border:1px solid #999;padding:12px}
    [data-thread-scroll-footer]{position:relative;padding:15px}.pointer-events-none{pointer-events:none}.absolute{position:absolute;inset:0}.sticky{position:sticky}.bottom-0{bottom:0}
    [data-thread-scroll-footer]>.absolute{background:#22222a}.sticky>.absolute{background:linear-gradient(transparent,#17171c)}
    .composer-surface-chrome{position:relative;background:#272735;border:1px solid #9797a1;border-radius:12px;padding:12px;box-shadow:0 0 2px #777;display:flex;gap:8px}
    input{min-width:0;flex:1;background:transparent;color:white;font:inherit}button{flex:none;padding:8px}.new-chat .messages{display:grid;place-content:center}
  </style><div id="root"><header class="app-header-tint">Owned titlebar fixture</header><aside class="app-shell-left-panel"><nav data-app-navigation-rail>Rail</nav><div class="sidebar-navigation" data-slate-sidebar-content><button class="selected">Selected</button></div></aside><main class="main-surface"><div class="_MainContentTopFade_fixture"></div><div class="thread-scroll-container"><div class="messages"><div class="card">Synthetic message card</div></div><div class="pointer-events-none sticky bottom-0"><div class="pointer-events-none absolute"></div></div><div data-thread-scroll-footer><div class="pointer-events-none absolute"></div><div class="composer-surface-chrome"><input aria-label="Editor"><button id="send">Send</button></div></div></div></main></div>`;
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
    await page.setContent(fixture);
    const sampleStyle = () => {const n=document.querySelector('.composer-surface-chrome'),s=getComputedStyle(n),r=n.getBoundingClientRect();return [s.backgroundColor,s.borderColor,s.boxShadow,r.x,r.y,r.width,r.height]};
    const before = await page.evaluate(sampleStyle);
    await page.evaluate(payload);
    await page.evaluate(() => {
      window.__bitmapCounts = { created: 0, closed: 0 };
      const create = window.createImageBitmap.bind(window), close = ImageBitmap.prototype.close, closed = new WeakSet();
      window.createImageBitmap = async (...args) => { const bitmap = await create(...args); window.__bitmapCounts.created++; return bitmap; };
      ImageBitmap.prototype.close = function () { if (!closed.has(this)) { closed.add(this); window.__bitmapCounts.closed++; } return close.call(this); };
    });
    await page.evaluate(({options,selectors}) => window.__codexWallpaperBridgeV1.install(options, selectors), { options, selectors: adapter.selectors });
    const frames = await page.evaluate(() => {
      const make = (color, vertical=false, bands=false) => {const c=document.createElement('canvas');c.width=vertical?600:1200;c.height=vertical?1200:600;const x=c.getContext('2d');
        if(bands){['#ff0000','#00ff00','#0000ff'].forEach((v,i)=>{x.fillStyle=v;x.fillRect(vertical?0:i*400,vertical?i*400:0,vertical?600:400,vertical?400:600)})}else{x.fillStyle=color;x.fillRect(0,0,c.width,c.height)}return c.toDataURL('image/jpeg',1).split(',')[1]};
      return {red:make('#ff0000'),blue:make('#0000ff'),green:make('#00ff00'),bands:make('',false,true),vertical:make('',true,true)};
    });
    const frame = (generation, jpeg) => page.evaluate(({generation,jpeg}) => window.__codexWallpaperBridgeV1.frame(generation,jpeg), { generation,jpeg });
    const pixel = () => page.evaluate(() => {const c=document.querySelector('canvas[data-cwb-owned]');return [...c.getContext('2d').getImageData(4,4,1,1).data]});
    assert.equal(await frame(1,frames.red),true);
    assert.deepEqual(await page.evaluate(sampleStyle),before,'Composer background/border/shadow/layout must be preserved.');
    for (const selector of Object.values(targets)) for (const css of await page.locator(selector).evaluateAll(nodes=>nodes.map(n=>{const s=getComputedStyle(n);return [s.backgroundColor,s.backgroundImage,s.boxShadow,s.backdropFilter]})))
      assert.deepEqual(css,['rgba(0, 0, 0, 0)','none','none','none']);
    assert.equal(await page.locator('.card').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(56, 56, 66)');
    assert.equal(await page.locator('.selected').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(85, 85, 96)');
    await page.locator('.selected').hover();
    assert.equal(await page.locator('.selected').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(105, 105, 119)');
    await page.getByRole('textbox').fill('Typing remains usable');
    await page.locator('#send').evaluate(n=>n.onclick=()=>{n.dataset.clicked='yes'});
    await page.locator('#send').click();assert.equal(await page.locator('#send').getAttribute('data-clicked'),'yes');
    await page.screenshot({ path:`${evidence}/synthetic-existing.png` });
    await page.evaluate(()=>window.__codexWallpaperBridgeV1.invalidate(2));
    assert.ok((await pixel())[0]>245,'Preparing the next generation retains the old frame.');
    const fade = await page.evaluate(async jpeg=>{
      const api=window.__codexWallpaperBridgeV1;await api.frame(2,jpeg);
      const read=()=>{const c=document.querySelector('canvas[data-cwb-owned]');return [...c.getContext('2d').getImageData(4,4,1,1).data]};
      const first=read();await new Promise(r=>setTimeout(r,140));const middle=read();await new Promise(r=>setTimeout(r,280));return {first,middle,last:read(),transitioning:api.ping().transitioning};
    },frames.blue);
    assert.ok(fade.first[0]>225&&fade.first[2]<30,JSON.stringify(fade));
    assert.ok(fade.middle[0]>20&&fade.middle[2]>20,JSON.stringify(fade));
    assert.ok(fade.last[2]>245&&fade.last[0]<10,JSON.stringify(fade));
    assert.equal(fade.transitioning,false);assert.equal(fade.middle[3],255);
    const preserved=await pixel();await page.evaluate(()=>window.__codexWallpaperBridgeV1.invalidate(3));
    await assert.rejects(()=>frame(3,'not a jpeg'));
    assert.deepEqual(await pixel(),preserved,'Decode failure retains the last valid frame.');
    assert.equal((await page.evaluate(()=>window.__codexWallpaperBridgeV1.ping())).generation,2);
    await frame(4,frames.red);await frame(5,frames.green);await page.waitForTimeout(360);
    assert.ok((await pixel())[1]>245,'Rapid switches converge to the latest generation.');
    assert.equal(await page.evaluate(() => window.__bitmapCounts.created - window.__bitmapCounts.closed),1,'Only the active decoded bitmap remains after the fade.');
    const replacedBitmaps = await page.evaluate(async frames => {
      const before = { ...window.__bitmapCounts };
      for (let index = 0; index < 200; index++) await window.__codexWallpaperBridgeV1.frame(5, index % 2 ? frames.red : frames.green);
      return { created: window.__bitmapCounts.created - before.created, closed: window.__bitmapCounts.closed - before.closed,
        retained: window.__bitmapCounts.created - window.__bitmapCounts.closed };
    },frames);
    assert.deepEqual(replacedBitmaps,{created:200,closed:200,retained:1},'Every replaced native frame returns its bitmap resource.');
    const staleBitmap = await page.evaluate(async jpeg => {
      const create = window.createImageBitmap, api = window.__codexWallpaperBridgeV1;
      let decoded, resume; const ready = new Promise(resolve => { decoded = resolve; }), held = new Promise(resolve => { resume = resolve; });
      window.createImageBitmap = async (...args) => { const bitmap = await create(...args); decoded(); await held; return bitmap; };
      const pending = api.frame(5, jpeg); await ready; api.invalidate(6); resume();
      const committed = await pending; window.createImageBitmap = create;
      return { committed, retained: window.__bitmapCounts.created - window.__bitmapCounts.closed };
    },frames.red);
    assert.deepEqual(staleBitmap,{committed:false,retained:1},'A stale asynchronous decode must explicitly close its bitmap.');
    assert.equal(await page.locator('canvas[data-cwb-owned]').count(),1);
    await page.setViewportSize({width:800,height:600});await frame(6,frames.bands);await page.waitForTimeout(360);
    const configure = display => page.evaluate(({options,display})=>window.__codexWallpaperBridgeV1.configure({...options,display}),{options,display});
    await configure({zoom:1,positionX:0,positionY:0});assert.ok((await pixel())[0]>245);
    await configure({zoom:1,positionX:1,positionY:0});assert.ok((await pixel())[1]>245);
    await configure({zoom:2,positionX:1,positionY:0});assert.ok((await pixel())[2]>245);
    await frame(7,frames.vertical);await page.waitForTimeout(360);
    await configure({zoom:1,positionX:0,positionY:0});assert.ok((await pixel())[0]>245);
    await configure({zoom:1,positionX:0,positionY:1});assert.ok((await pixel())[1]>245);
    await configure({zoom:2,positionX:0,positionY:1});assert.ok((await pixel())[2]>245);
    // Change only authored fixture state to exercise new/existing page layout.
    for(const newChat of [false,true])for(const collapsed of [false,true])for(const viewport of [{width:780,height:900},{width:1400,height:800}]){
      await page.setViewportSize(viewport);await page.evaluate(({newChat,collapsed})=>{document.querySelector('#root').classList.toggle('new-chat',newChat);document.querySelector('#root').classList.toggle('collapsed',collapsed);},{newChat,collapsed});
      await page.waitForTimeout(40);await page.getByRole('textbox').fill('Layout and input remain usable');
      const box=await page.getByRole('textbox').boundingBox();assert.ok(box.width>200&&box.x>=0&&box.y+box.height<=viewport.height);
      assert.equal(await page.locator('canvas[data-cwb-owned]').count(),1);assert.equal((await pixel())[3],255);
    }
    await page.screenshot({path:`${evidence}/synthetic-new-collapsed.png`});
    // Exercise actual decoded video first-frame activation and delayed release.
    await page.evaluate(()=>window.__codexWallpaperBridgeV1.ping());
    const video=await page.evaluate(async()=>{
      const c=document.createElement('canvas');c.width=160;c.height=90;const x=c.getContext('2d'),stream=c.captureStream(0),track=stream.getVideoTracks()[0],r=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),parts=[];
      r.ondataavailable=e=>parts.push(e.data);const stopped=new Promise(resolve=>r.onstop=resolve);r.start();
      for(let i=0;i<8;i++){x.fillStyle=`hsl(${i*40} 80% 50%)`;x.fillRect(0,0,160,90);track.requestFrame();await new Promise(resolve=>setTimeout(resolve,100))}
      r.stop();await stopped;stream.getTracks().forEach(t=>t.stop());return [...new Uint8Array(await new Blob(parts).arrayBuffer())];
    });
    assert.ok(video.length>300);
    assert.equal(await page.evaluate(async bytes=>{const a=window.__codexWallpaperBridgeV1;a.begin(8,bytes.length,'video/webm');a.append(8,btoa(String.fromCharCode(...bytes)));return a.commit(8)},video),true);
    await page.waitForTimeout(400);
    const videoStatus=await page.evaluate(()=>window.__codexWallpaperBridgeV1.ping());assert.equal(videoStatus.runtimeVersion,3);assert.equal(videoStatus.generation,8);assert.equal(videoStatus.transitioning,false);assert.equal(videoStatus.playback.sourceWidth,160);
    assert.equal(await page.evaluate(() => window.__bitmapCounts.created - window.__bitmapCounts.closed),0,'Switching to video releases the previous native frame.');
    assert.equal(await page.locator('canvas[data-cwb-owned]').count(),1);
    await assert.rejects(()=>page.evaluate(async()=>{const a=window.__codexWallpaperBridgeV1;a.begin(9,4,'video/webm');a.append(9,btoa('bad!'));return a.commit(9)}));
    assert.equal((await page.evaluate(()=>window.__codexWallpaperBridgeV1.ping())).generation,8,'A failed video decode keeps the previous media.');
    assert.equal(await page.evaluate(async()=>{const a=window.__codexWallpaperBridgeV1;a.begin(10,4,'video/webm');a.append(10,btoa('bad!'));const commit=a.commit(10);a.invalidate(11);return commit}),false,'A superseded decode cancels promptly.');
    assert.equal((await pixel())[3],255);
    await page.evaluate(()=>window.__codexWallpaperBridgeV1.restore());assert.equal(await page.locator('[data-cwb-owned]').count(),0);
    assert.equal(await page.getByRole('textbox').inputValue(),'Layout and input remain usable');
    const upgrades=[];
    // Exercise the real takeover expression against authored browser pages. The
    // injected client uses this page directly; it never opens a live CDP target.
    for(const legacy of [true,false]){
      await page.evaluate(payload);
      await page.evaluate(({options,selectors})=>window.__codexWallpaperBridgeV1.install(options,selectors),{options,selectors:adapter.selectors});
      await frame(99,frames.bands);
      const retained=await pixel();
      await page.evaluate(legacy=>{
        const api=window.__codexWallpaperBridgeV1;window.__upgradePrevious=api;window.__upgradeRestores=0;
        const restore=api.restore;api.restore=()=>{window.__upgradeRestores++;return restore()};
        if(legacy)api.runtimeVersion=1;
        window.__upgradeSamples=[];
        const probe=()=>{const nodes=document.querySelectorAll('canvas[data-cwb-owned]'),c=nodes[0];window.__upgradeSamples.push([nodes.length,c?c.getContext('2d').getImageData(4,4,1,1).data[3]:0]);window.__upgradeRaf=requestAnimationFrame(probe)};
        window.__upgradeRaf=requestAnimationFrame(probe);
      },legacy);
      let evaluations=0;const frameSession=await page.context().newCDPSession(page);
      const presentation=new Presentation(adapter,{async event(){}},{discover:async()=>[{id:'synthetic-owned-target'}],connect:async()=>({call:async(method,params)=>frameSession.send(method,params),evaluate:async expression=>{evaluations++;return page.evaluate(expression)},close(){frameSession.detach().catch(()=>{})}})});
      await presentation.configure({...options,display:{zoom:3,positionX:1,positionY:1}});
      await presentation.reconcile([19399],adapter.verifiedVersions[0],false);
      assert.equal(evaluations,2,'The runtime replacement and snapshot adoption share one evaluation.');
      assert.deepEqual(await pixel(),retained,'Takeover must preserve already-composited pixels without reapplying crop.');
      const ownership=await page.evaluate(()=>({version:window.__codexWallpaperBridgeV1.runtimeVersion,restores:window.__upgradeRestores,sameRuntime:window.__codexWallpaperBridgeV1===window.__upgradePrevious,generation:window.__codexWallpaperBridgeV1.ping().generation}));
      assert.equal(ownership.version,3);assert.equal(ownership.restores,legacy?1:0);assert.equal(ownership.sameRuntime,!legacy);assert.equal(ownership.generation,-1);
      if(legacy)await page.screenshot({path:`${evidence}/synthetic-upgrade-retained.png`});
      await presentation.frame({jpeg:frames.blue},1);
      assert.equal((await page.evaluate(()=>window.__codexWallpaperBridgeV1.ping())).transitioning,true);
      await page.waitForTimeout(380);assert.ok((await pixel())[2]>245);
      assert.equal((await page.evaluate(()=>window.__codexWallpaperBridgeV1.ping())).generation,1,'A fresh controller generation must replace the old generation 99.');
      const samples=await page.evaluate(()=>{cancelAnimationFrame(window.__upgradeRaf);return window.__upgradeSamples});
      assert.ok(samples.length>5);assert.ok(samples.every(([count,alpha])=>count===1&&alpha===255),'Every sampled painted frame retains exactly one opaque canvas.');
      upgrades.push({legacy,ownership,paintSamples:samples.length,allFramesOpaque:true});await presentation.restore();
    }
    for(const deviceScaleFactor of [1,1.25,1.5,2]){
      const context=await browser.newContext({viewport:{width:640,height:480},deviceScaleFactor}),sample=await context.newPage();
      await sample.setContent(fixture);await sample.evaluate(payload);await sample.evaluate(({options,selectors})=>window.__codexWallpaperBridgeV1.install(options,selectors),{options,selectors:adapter.selectors});
      await sample.evaluate(jpeg=>window.__codexWallpaperBridgeV1.frame(1,jpeg),frames.bands);
      assert.deepEqual(await sample.locator('canvas[data-cwb-owned]').evaluate(c=>[c.width,c.height]),[640*deviceScaleFactor,480*deviceScaleFactor]);await context.close();
    }
    await writeFile(`${evidence}/synthetic.json`,JSON.stringify({passed:true,fade,videoStatus,upgrades,syntheticFixturesOnly:true,checks:['observed-shell-selectors','preserved-composer-and-content','input-and-click','320ms-crossfade','image-and-video-failure-preserve-frame','cancel-superseded-decode','rapid-generation-switch','single-canvas','zoom-and-both-pan-axes','new-and-existing-chat-fixtures','collapsed-sidebar-fixture','resize','decoded-WebM','restoration','atomic-legacy-upgrade','same-version-controller-takeover','DPR-1-1.25-1.5-2']},null,2));
    console.log('Visual acceptance passed: targeted shell cleanup, preserved controls, crossfade/failure/zoom/pan, WebM, single canvas, responsive fixtures and four DPRs.');
  } finally { await browser.close(); }
}
