# Four-type integration — 2026-10-15

All four production paths have shown changing content in **two actual official Codex windows**, automatically switching without restarting Codex/Bridge. Evidence is scoped to the tested versions and projects.

| Type | Production path | Executed evidence | Verified scope |
| --- | --- | --- | --- |
| Video | Original File-backed Blob → native Chromium decoder → physical-resolution canvas | Original 3840×2160 MP4; both windows changing; visible short test around 59–60 FPS | Installed Codex-supported codecs; no media copy/transcode |
| Web | Private muted Edge pipe → root-contained no-store server → shared frames | Authored dynamic Web project in both real Codex windows; pause/resize/cleanup | Scalar properties; WE audio visualizer/media/random-file/query APIs explicitly unavailable |
| Scene | Current exact D3D11 HWND → Present/Present1 → shared memory → frames | Actual stock Shimmering Particles in both Codex windows; original source/properties restored | WE 2.8.0.42, x64, one unambiguous Monitor0 renderer; BGRA/RGBA/FP16-to-SDR |
| Application | Existing selected WE-owned EXE/HWND → WGC / exact-window PrintWindow | WE-launched authored WinForms animation in both windows; unrelated same-EXE process excluded | Single exact EXE descendant of current WE; arbitrary Unity/multiprocess projects unverified |

## Resolved blockers

Desktop-child WGC failed with E_INVALIDARG. Production Video/Web avoid it; Scene uses exact-surface D3D11 capture. Actual Scene then exposed FP16 output; half-float-to-sRGB conversion resolved that case. A paused/screensaver desktop can submit no frames and is reported paused. No screensaver was terminated or bypassed.

Codex rejects ordinary local HTTP Video under its media CSP. A detached Bridge input plus File-backed Blob works without changing CSP or triggering Codex file-upload handlers. Production no longer uses JPEG re-encoding or the old whole-file 256 MiB transfer limit for Video.

An extra WE pop-out can emit audio before properties apply. Production does not create one. Video/Web start muted; Scene/Application transfer pixels only from existing renderers. No Windows or desktop WE audio setting changes.

## Safety and limits

Scene validates process/class/HWND and exact swap-chain output, captures no monitor, saves no frames and hooks no audio. Bounds are 64 MiB shared memory and 16 MP source pixels. Authored D3D11 flip/blt/FP16 fixtures passed normal stop and helper-death DLL unload while source remained alive. FP16 converts to SDR and may clip highlights; HDR fidelity is unverified.

Application discovery and capture verify executable plus current WE ancestry. Web starts with an allowlisted OS environment and rejects credential-named project properties. Unsupported/ambiguous projects restore appearance with useful status; they are not labelled compatible.

## Reproduce

~~~powershell
npm run test:web
npm run test:application
npm run test:graphics
node scripts/graphics-backend-smoke.mjs --float
node scripts/scene-backend-smoke.mjs --show-desktop
node scripts/codex-acceptance-smoke.mjs --types
~~~

Scene/type tests temporarily select controlled projects on Monitor0 and restore source/properties in finally. To respect WE's maximized-window pause policy, the type test may temporarily minimize pre-existing maximized Codex windows; exact PID/start/HWND state is journaled and restored. Only independent official test profiles, structural booleans and owned-canvas hashes are inspected; no conversation content or user-content screenshots.

Private evidence stays ignored under .local-evidence. Native runtime evidence came from shell diagnostics because REA Windows runtime capture was unavailable; no REA runtime evidence ID is claimed.
