# Architecture — independent playback development

Current closeout: 186 tests/syntax and five actual-Codex failure/stop cases passed. Failed sources restore the original appearance; settings saves are serialized; termination timeout retains owned process/runtime identity and reports pending cleanup. See [closeout and unfinished scope](CLOSEOUT-0.3.0.zh-CN.md). The 179-test/endurance baseline below is historical evidence. Local scope is accepted; full PRD remains false.

This document describes the unpublished 0.3.0 local candidate, updated 2026-10-19. 179 tests, syntax, physical six-source two-window playback/cleanup and normal/maximized/restored text-free composites passed. The 3735.771-second loop completed 24 source cycles and 351 samples, including nine Videos, four Sheep cycles and separate-volume Scene. Original resource gates passed; 42 workers exited, 36 runtimes were removed and all source/environment baselines were retained. Earlier 32-case/685-second records, failures and candidates remain historical evidence. Packages reuse the same eight tested native binaries with newly frozen production inputs; final package checks are in [closeout record](CLOSEOUT-0.3.0.zh-CN.md). `fullPrdAccepted:false` remains: one hour does not prove all-day, cross-monitor or arbitrary project/hardware compatibility.

## Data flow and ownership

The user's revised requirements replace desktop following with an independent Codex selection. Production selection never queries Monitor0 to choose a wallpaper. The library reads Steam registry/VDF roots, Workshop, local and built-in metadata and covers, including packed `scene.pkg` projects.

```text
WinForms manager -> authenticated loopback control -> Node coordinator
  selected project + per-project display/properties -> source generation
    Video -> original File -> muted Chromium decoder in each Codex renderer
    Scene/native Web -> private, pre-muted WE -> shared captured image source
    compatible Web -> isolated muted Edge + real host interfaces -> shared frames
    reviewed Sheep -> owned application worker + private audio configuration
    unknown engine/application -> explicit rejection
  one canvas per Codex window -> Cover + zoom/position -> first-frame crossfade
  generation/visibility/lease checks -> bounded recovery and owned cleanup
```

The native host supplies manager/tray UI, process/window metadata and capture. CDP targets must belong to recognized official Codex processes and supported app page paths; version and structural contracts both apply. Auxiliary targets are skipped independently. Explicit connection-mode launch uses an independent Bridge profile without copying login data. No official installation files are modified, and no conversation or work-file contents are read.

The separate control API uses a random loopback port, a 256-bit token inherited through the parent environment, Origin rejection, host checks, a 16 KiB request limit and serialized mutations. Tokens are not persisted or logged. Private players receive an allowlisted OS environment rather than Bridge tokens, Node options or unrelated proxy/API settings.

## Source isolation and audio

### Source changes

`source-watch.mjs` establishes a whole-project metadata baseline before an observed source becomes available for staging. Recursive events are coalesced over 100 ms. Relative paths, object kinds, device/inode, mode, file size/mtimeNs and link targets determine material changes; ctime/link counts and directory timestamps do not. Creating or removing a private hardlink view therefore does not restart playback. The scan reads no media contents and does not traverse symbolic links. Steady observations reuse the baseline; failed watchers fall back to metadata polling at a three-second bound. Events arriving during a scan or source description remain pending/dirty. Source switches and close fence out late callbacks and scans.

### Private Wallpaper Engine

`src/isolated-player.mjs` and `native/IsolatedWallpaperHost.cs` own the Scene/native Web path. Only the reviewed WE 2.8.0.42 x64 executable hash is accepted. A private engine directory, configuration and WinForms host HWND are prepared before the suspended process resumes; `videoaudiooutput:false` is already set. Launch uses `-screensaver -host <HWND> -preview -silent`. Audio safety does not depend on detecting an audio session later or sending a global mute command.

Each runtime has a unique token, marker and named kill-on-close Job. Process path, PID/creation time, Job membership and HWND identity constrain capture, input and termination. Private engine dependencies are staged separately from the desktop instance; wallpaper assets remain referenced at their original locations. Cleanup validates owned paths and markers, removes registered junction references first and never recursively traverses the original asset target.

The local independent playback matrix passed all 29 Scene, two Web and one reviewed Sheep projects. The Scene cases produced 383 private cache files with changing frames and advancing GPU sequences. Original source contents, metadata and pre-existing caches were unchanged, and owned runtime directories were removed. Scene hardlinks always remain on the source volume: same-volume sources use the installed engine's private view base; separate-volume sources use `.bridge-scene-runtime/<token>` in the writable source parent. Canonical paths, complete manifests, token and device/inode identities fence staging and deletion; source directories are never linked and media is not copied. A D-volume engine/E-volume authored Scene passed real Codex two-window playback and both runtime cleanups. This finite evidence does not establish arbitrary filesystem/project/GPU compatibility.

No global WE wallpaper, mute, volume or pause command is used. The user's desktop process is not selected as the capture/input source or terminated as cleanup.

### Video

All background Video uses the original File-backed Codex Chromium decoder. CDP binds the selected file to a detached Bridge file input, so it cannot emit Codex attachment events. Playback is muted before assigning `src`. There is no full-file Node transfer, transcode, wallpaper script injection or JPEG frame replacement. Each Codex renderer has its own decoder; shared native Video decoding is not claimed. Original source dimensions and physical display pixels are retained up to the 16 MP safety bound.

A separately requested WE preview must still pass its current private-engine startup checks. The older no-audio-track proof and playInWindow gate no longer define current background Video support.

### Web

Native Web uses the private WE/CEF instance to retain native author interfaces. Loopback CDP connections are accepted only after the listener PID is proved to belong to the owned Job, including cached-input calls. The exact authored navigation, current frame/loader and connected document are checked. Same-document history routes are discovery candidates, not an identity bypass. Browser-backed navigation evidence is read in a private isolated world so author replacements in the default page world cannot forge the proof.

The fallback runs project scripts in a private, muted Edge context over inherited DevTools pipes. Its host integration supplies real WASAPI stereo spectrum data and GSMTC metadata, cover, playback and timeline information. File/directory properties, random-file requests, directory changes, general FPS and pause/resume callbacks are implemented. Unsupported interfaces such as unimplemented queries report failure rather than fabricated data.

Fallback resource access is confined to project roots and explicit property grants through capability URLs, bounded reads and disabled caches/downloads. An authored external default path does not grant access. The manager records file/directory paths only after explicit selection; the control layer validates existence and type when saving. Directory change and random-file callbacks use the authorized resource set.

### Reviewed application

`src/silent-unity-application.mjs` and the owned application player accept only the reviewed built-in Sheep / Unity 2017.2.0f3 layout and content. Sheep contains audio effects. Before launch, a private 48,436-byte `globalgamemanagers` copy changes the reviewed audio-disable flag at offset 6424; original and patched bytes are hash-checked. Original authored files are not patched. Other code/data staging and hardlink/junction references remain subject to exact layout and cleanup validation.

Dynamic pixels, startup mute and real interaction have now passed targeted Sheep acceptance. Scoped DPI-aware geometry/capture fixed the former crop: surface and capture are consistently 640×360. The final no-focus-hook run `da76f861` exercised five real clicks with visible new sheep and a 640-white-pixel increase, with the physical cursor and foreground unchanged; source, desktop configuration and owned cleanup checks all passed.

The corrected-coordinate WM-only control `eba2ccd6` produced only 12 additional white pixels and no new sheep. Window mouse messages alone are insufficient for this reviewed Unity build: private cursor-poll virtualization is required. No focus hook or window-activation notification is used. This replaces the earlier unresolved DPI/focus hypotheses, but remains specific to the reviewed Sheep executable and input helpers. Unknown applications stay rejected. Unified-build dynamic/audio checks passed; physical Codex integration and endurance remain separate.

## Pointer and rendering contracts

The Codex runtime observes trusted pointer coordinates and left-button clicks without intercepting chat events. Cover, zoom and position are inverted into source coordinates. Keyboard, dragging and modifier gestures are excluded. Visibility, focus, source generation and the original receive timestamp fence input; stale queued events cannot regain a fresh lifetime.

Scene input virtualization is limited to the token/Job/path-validated private engine. Targeted Scene tests prove move, down/release and repeated `cursorClick` edges; the reviewed WE polling behavior requires `GetKeyState(VK_LBUTTON)` to return `0xff80` while pressed. Native Web input uses the private CEF CDP endpoint. Neither path implements interaction by moving the system cursor or activating an unrelated window. Application input compatibility is tracked separately.

Renderer runtime V5 owns one canvas, stylesheet, media and Blob URLs per window. Contract-defined sidebar/top/footer surfaces become transparent; composer surfaces, selected rows, foreground fonts, official layout and event handlers remain under Codex control. Prepared sources commit after a valid first frame and crossfade over 320 ms. Replaced/stale ImageBitmaps and crossfade backing canvases are released.

Native frames use `frame-fetch.mjs`: a random target-local Fetch interception under an existing CSP-allowed static origin receives a JPEG through `Fetch.fulfillRequest`. Only the small frame ticket enters renderer JavaScript arguments. The handler never continues private requests to the service and never intercepts other app resources. Credentials, caching and redirects are excluded. Each single-use ticket is bounded to 4.5 MiB, the owned root frame/document, current generation and a five-second lifetime. The independent response proof is not part of the request URL or headers; an ordinary remote response after debugger loss cannot be accepted as a wallpaper frame. Wrong proofs cancel the response body before decoding. Invalidation, navigation and Restore revoke pending frames and interception. The page CSP and official installation remain unchanged.

The earlier fixed-function JPEG argument path remains available to non-socket test fixtures. In the real current Codex, 1,200 authored-frame diagnostics measured approximately 56 MiB private growth for binary transport alone versus 1,357 MiB for large data arguments; full Blob/bitmap drawing measured 592 versus 2,674 MiB. These burst diagnostics are not a permanent-leak proof or integrated endurance acceptance. Forced-GC readings are retained separately and do not determine the normal-operation result.

D3D11 uses the ABI v2/CWB2 shared map with an acknowledgement at byte 80: only one unread image may be outstanding, and its sequence identifies the copied pixels. Bounded staging/readback and reused buffers avoid an unbounded capture queue. BGRA/RGBA and FP16 linear-to-SDR conversion are supported; lossless or HDR-equivalent fidelity is not claimed. Native Web may use GDI pixels with sequence 0; acceptance must evaluate visible content rather than apply the Scene sequence rule to every backend.

## Scheduling, defaults and recovery

| Setting | Current policy |
| --- | --- |
| Initial background / startup | off / off; startup opt-in |
| Opacity / blur / brightness / contrast | 1 / 0 px / 1 / 1; saved values preserved |
| UI FPS choices / default | 30, 60, 120, automatic / 60 |
| Performance / balanced / quality ceilings | 30 / 120 / 120 |
| Image width / JPEG quality | 960/65, 1280/78, 1920/88 |
| Image pixel budgets | 921600 / 2073600 / 3686400 |
| Video | original File decoder; 16 MP canvas safety bound |
| Auto adjustment | measured load can halve delivery FPS; spatial/encoding budgets stay fixed |
| Windows | shared image source, independent Video decoders; no window-count-only FPS penalty |
| Metrics | CPU/RSS/private bytes/handles, decoder and canvas counters; unavailable GPU metrics remain unavailable |

These are ceilings and budgets, not guaranteed throughput. Source identity includes size, preview mode and properties. Transient load throttling does not repeatedly restart a private engine at a different user ceiling. Each consumer has at most one pending frame.

Generations and lifecycle epochs fence start, capture, input and late attachment. Settings saves run in invocation order and block ticks until all queued saves finish. Stop revokes the lifecycle immediately, including loading workers. When all clients are hidden, owned Scene/Web/Application sources are released and later rebuilt; no desktop pause command is sent. Source failure restores the original Codex appearance and uses bounded 2/4/8/16/32/60-second retries, then waits for an environment/source change or user action. Termination timeout is an error: retain owned worker/session/runtime identities and retry cleanup only after confirming exit.

Exit removes owned page objects. A crashed controller's page lease restores appearance; private jobs/workers and identity-checked cleanup reclaim owned sources. Cleanup reports must distinguish released surface/session handles from retained workers and directories. A cleanup failure keeps the owned runtime identity available for retry; PID alone never authorizes process-tree termination.

## Manager, packaging and evidence

The manager retains the existing navigation, cover grid, right-side properties and fixed actions. Its coordinate baseline is 96 DPI. Fixed performance choices establish their scaled width after initial autoscale; numeric slider values size to the text to prevent 144 DPI collapse/wrapping. File/directory editors require explicit selection and have read-only path displays.

The final UI fixture passed 126 checks at virtualized 96 DPI and the single physical monitor's actual 144 DPI, including normal/minimum sizes and screen captures. Evidence is in `.local-evidence/ui-dpi-fix-2026-10-18T00-29-46-443Z/summary.json`. This covers manager/editor behavior, not API calls, file chooser dialogs, playback or physical Codex integration. UI fixtures must not overlap physical Codex window tests because they can change activation.

The current-user installer, ownership inventory, stable launcher/install lease and atomic settings recovery remain. Uninstall restores appearance and removes inventoried product files while preserving personal data and unknown files. Updates verify Ed25519 payload signatures, HTTPS origin, hash/size and validity, then stage, health-check and roll back failures.

The main build now calls `scripts/build-app-input.ps1`. The reviewed Sheep input path requires an i686 Windows MinGW-w64 GCC/Clang compiler, selected through `BRIDGE_I686_CC` or the standalone script's `-Compiler <absolute path>` parameter. The script validates `-dumpmachine` and does not download/install a compiler. It produces the managed `BridgeApplicationInput.dll` and native `BridgeApplicationInputHook32.dll`.

The new 0.3.0 candidates reuse the exact eight validated native artifacts. The first archive audit matched all 186 source entries and 82 runtime entries, content hashes and four SHA sidecars. Production uninstall covers 15 added runtime files plus locked-file failure, self-removal, unknown/outside data preservation and repeat removal. Final same-input archive checks and the complete x64/x86 source build under a path with spaces are recorded in the development ledger. Earlier candidates and 0.2.4 artifacts are preserved; no public release has occurred. Public update hosting/signing identity is not configured by default.

## Historical evidence

0.2.4 delivered the manager, icon, installer/uninstaller and the then-supported playback paths. Its Codex 26.1007.9446.0 / WE 2.8.0.42 physical two-window and roughly eleven-minute endurance results remain in [acceptance records](ACCEPTANCE.zh-CN.md). They do not validate this expanded private-engine/application implementation or a newer Codex build.

The 0.1 desktop-following/current-HWND capture and early 0.2 playInWindow/no-audio-content gates are historical engineering paths. They are not the current source-selection or audio-safety architecture. Only one physical display is available; cross-monitor DPI, all-day endurance and universal wallpaper/GPU support remain unclaimed.
