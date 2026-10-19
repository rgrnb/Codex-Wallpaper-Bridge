# Validation record — 0.3.0 local candidate, 2026-10-18

## 2026-10-19 local-scope closeout

186 tests and syntax passed. Actual Codex checks cover missing material, owned-player startup failure/crash, user stop/exit and re-enable with original styles and input restored. PID-only lock termination risk is excluded; stop-timeout resource retention and overlapping saves were fixed and regression-tested. See [closeout and unfinished scope](CLOSEOUT-0.3.0.zh-CN.md). `localScopeAccepted:true`, `fullPrdAccepted:false`. Later sections are historical; multi-monitor/all-day/extensions are outside this closeout, and publishing/installing/committing/pushing is deferred.

## 2026-10-19 source continuation

179 tests and syntax passed. `independent-acceptance-0c45c4b163d6774c` passed six physical two-window sources: Video, same-volume Scene, native Web, packed Scene, reviewed Sheep and an authored separate-volume Scene (D engine/E source). All 14 source trees retained content/metadata, 15 workers exited and 14 runtimes were removed; desktop, user processes, settings and screen-saver baselines were retained.

Text-free composed pixels and unchanged numeric layout/font/composer styles passed at 837x700, native-maximized 1707x1019, and restored 837x700. Screenshot clips are serialized and their temporary metrics cleared; expected colors account for retained UI alpha with the original four-level RGB tolerance. Earlier concurrent clip results and failed probes are retained without claiming strict pixel proof.

`independent-acceptance-7ae9a3c09826c7ab` passed the complete 3735.771-second run: 24 source cycles, 351 two-window samples, nine Videos, four Sheep cycles, two separate-volume Scene cycles, hidden release/recreation, reload, resize and close-one/continue-other. Original gates passed over 34 comparable identities: private bytes +155291648, handles +227, Node RSS +118626304, renderer round-trip p95 9.1888ms. No forced GC, lower image budget or relaxed tolerance. All 14 source trees and desktop/user/environment baselines were retained; all 42 workers exited and 36 runtimes were removed. Package checks are recorded in the development ledger. Cross-monitor, all-day and universal compatibility remain unverified.

## 2026-10-18 retained candidate results

The final source passed 174 Node tests and syntax checks. The physical two-window run `independent-acceptance-9a03f5e95587a388` completed 685.553 seconds, 24 switches and 67 samples, including all nine Videos, four Sheep cycles, Scene/Sheep both-hidden release/recreation, page reload and close-one/continue-other. All original resource gates passed: 32 comparable identities, private bytes +356,390,912, handles +67, Node RSS +69,871,616, renderer round-trip p95 9.422 ms. No forced GC, lower image budget or relaxed tolerance was used.

That original JSON remains a failed cleanup report: its old final sampler admitted a recycled historical helper PID as an owned process. The helper's original start was `639279217906763262`; the unrelated conhost's was `639279218443378456`, under the existing user's Codex node_repl. No unrelated process was terminated. Read-only supplement `cleanup-identity-audit-cee93ec8-e440-448a-8b16-0c8e178b16ff` verified the unchanged report SHA and all 118 originally measured identities gone, 34 runtimes removed, 40 workers exited and all source/config/user-process checks retained. The replacement ledger admits only historical exact identities and current original live child handles, with regression coverage for reuse and exit during sampling.

After the final initial-frame controller-takeover guard, current-source physical rerun `independent-acceptance-83dd162f7e48d988` passed all five playback cases and cleanup, using the binary response path for every native case. Its evidence saves only the Bridge canvas pixels. Browser lifecycle passed 120.413 seconds before that guard and another 30.099 seconds after it; the guard also has a reproduced failing regression and passing test. Thus the long-run evidence, its explicit cleanup supplement and the final-source rerun are distinct records, not a rewritten PASS.

The unchanged eight native artifacts also retain the 32/32 local non-Video matrix (29 Scene, two Web, one Sheep), 383 private Scene cache files and the targeted audio/input/DPI evidence. The manager retains its 126 checks at 96 and actual 144 DPI. Local support is Codex 26.1013.4894.0 / reviewed WE 2.8.0.42 on one physical display; old adapter entries are historical frontend-contract evidence. Universal Application/engine/GPU compatibility, cross-monitor DPI and all-day stability remain unverified. `fullPrdAccepted:false` remains.

Packaging and final artifact audits are recorded in the current [closeout record](CLOSEOUT-0.3.0.zh-CN.md); early candidates and all failures are preserved. No public release is authorized or performed.

## Earlier 0.3.0 checkpoints

The latest source has 162 passing Node tests and passing JavaScript syntax checks. Eight unified native build artifacts retain their previously validated SHA256 identities. The local independent playback matrix passed 32/32 cases: 29 Scene, two Web and one reviewed Sheep, with source content/metadata, private shader cache and runtime cleanup evidence. Manager tests passed 126 checks at each of 96 and actual 144 DPI. These results do not replace integrated physical-window endurance.

Source-watch regression and a separate C-drive diagnostic now prove that private Scene hardlink staging/removal leaves revision/fingerprint unchanged, while real nested edits are detected. A metadata baseline precedes staging; late events survive observation/scanning, and obsolete watcher completions cannot affect another source. No media content is hashed during production observation.

Physical attempt `independent-acceptance-a9dc5564459ec748` demonstrated six distinct frames in each Video and Scene window, a stable Scene generation, revision zero and exactly one initial engine launch. It failed later because the performance helper sampled an empty process list during an FPS-policy rebuild; all 13 original project trees retained their content and strict metadata. Cleanup diagnostics also identified separately installed Codex runtime descendants. The test helper continues to terminate only the fenced package tree; outside descendants are held by identity and must exit naturally. Positive and negative fixtures prove this boundary. The failed report is retained; a new 600-second physical run is in progress.

Early 0.3.0 installer/portable/source candidates, production uninstall fixtures and a source build under a path with spaces passed their earlier scoped checks. Those candidates predate the latest watcher fix and must be replaced by newly verified packages before handoff. Historical 0.2.4 artifacts and failed evidence are retained. No public release is authorized or performed. `fullPrdAccepted:false` remains; cross-monitor DPI, all-day stability, arbitrary engines/applications and universal GPU support are unverified.

# Historical validation record — 0.2.4, 2026-10-16

Current summary: [Chinese acceptance record](ACCEPTANCE.zh-CN.md). 49 unit tests and syntax checks passed. The redesigned manager passed 61 fixture checks separately at 96 and actual 144 DPI. The final physical dual-window loop ran 679.598 s / 20 source switches / 60 samples, exercised all nine installed videos plus repeated reviewed silent Scene/Web, and passed the original declared resource tolerances. Same-identity mean handles −5.5, private bytes +584,925,184, Node RSS +10,115,072 and renderer round-trip p95 9.59 ms. Both-hidden source release/recreation, resize, reload, authored composer input/clear, closing one root and continuing in the other passed. All 54 measured process identities were gone after cleanup; user Codex, desktop WE, selection/properties and original settings were retained.

The earlier 683 s and 673 s loops failed the comparable private-byte gate (+1,051,711,488 / +921,929,728 bytes) and remain recorded. V3 explicitly closes native ImageBitmap resources and sends image bytes as Runtime.callFunctionOn arguments. A bounded authored transport test did not reproduce permanent script-cache retention after forced GC; no proven permanent-cache-leak or zero-growth claim is made. Latest short Scene deliveries were 20.51 / 26.85 / 29.22 FPS at 30 / 60 / 120 caps, not a stable-throughput guarantee.

Only one physical monitor is available, confirmed by the user. Arbitrary native Scene audio, Application playback, special Web APIs and chat-window pointer forwarding retain the limitations below. The complete nprd is not accepted.

## Historical 0.2.2 validation

The current user nprd governs this release. This is an implemented independent-library upgrade with explicit remaining native playback limits; the complete nprd is **not** marked accepted. Historical 0.1 desktop-following evidence below does not establish 0.2 independence.

| Current check | Result and boundary |
| --- | --- |
| Unit suite and syntax | 48 unit tests passed; independent selection/profiles, source fencing, retained-frame failure, metadata containment, native audio gate, scoped commands, atomic runtime upgrade, security and update regression; Restore wins at every pending lifecycle boundary; native-to-compatibility switches release the source |
| Library on reference PC | 40 projects: 28 Scene, 9 Video, 2 Web, 1 Application; no scan errors; includes 12 Workshop projects with scene.pkg instead of scene.json; original files not written/copied |
| Native independent source | WE 2.8.0.42: exact reviewed silent stock Scene, exact authored silent Web, Workshop video 2648290826 with video-only MP4 tracks; each produced 6 distinct frames while offscreen and closed cleanly |
| Desktop isolation | Selectedwallpapers and all Monitor-scoped properties remained identical after native playback, parameter command and cleanup; no global mute/pause used |
| Native parameters | Stock Scene glow location-targeted command succeeded and frames continued; author Web callback evidence separately confirms property delivery. Not every wallpaper property effect was visually verified |
| Native crash cleanup | Killing only the owned test Node controller removed its exact native HWND and lease observer in about 1.8 s; WE and desktop remained running |
| Current client visual repair | Actual sidebar/top/footer computed fills and gradients removed with one existing canvas; root/main/composer geometry and fonts unchanged; no chat input/navigation performed. Before/after screenshots retained privately |
| Current client smoothness | User-running 0.2.1, unchanged 2560×1440 original video, physical 2561×1529 canvas: 20 three-second samples averaged 59.92 reported canvas FPS (range 33.65–64.64); decoded counter +3440, dropped counter +171 between first/last sample. Muted/defaultMuted=true and volume=0 throughout. Heartbeat also resets the per-sample FPS counter; this is not guaranteed stable 60 FPS or zero-drop playback |
| Browser visual integration | New/existing authored layouts, collapse, resizing, DPR 1/1.25/1.5/2, input/click, actual WebM, zoom/pan, intermediate crossfade pixels, bad first-frame retention and stale decode cancellation passed |
| Runtime takeover | 121 browser samples during legacy replacement and 117 during V2 reconnect retained one opaque canvas; old generation 99 can yield to a new controller generation 1 |
| Management UI | 50 real WinForms fixture checks passed, including three tabs, paging and cover release, five property types, fixed action footers at default/minimum size, verified-native labels and opacity reset. Seven screenshots inspected; 96 DPI only, simulated library data |
| Actual dual independent clients | Passed for two actual Codex 26.1007.9446.0 instances at DPR 1.5: Video, reviewed silent stock Scene and authored silent native Web each produced six changing canvas samples in each naturally visible window. Native HWND attribution used PID/start-time plus a causal viewport/client-rectangle resize. Resize, minimize/resume and typing/clearing an exact marker in initially empty composers passed; no message sent. Both canvases/styles restored to zero owned nodes; all owned roots, frame helpers and lease observers exited; user PIDs and desktop selection/Monitor/audio properties retained |
| Shared capture performance | 0.2.2 stock Scene, two visible Codex windows, three separate 3.2-second samples: approximately 19.94 / 33.11 / 38.94 delivered FPS at requested caps 30 / 60 / 120. Before the fix the 120-cap sample delivered about 3.73 FPS. This is a short reference-system test, not stable 60/120 FPS, a long endurance gate, or a universal Scene result. Helper CPU was unavailable on its first counter sample; memory values are scoped to helpers, not whole-system cost |
| Final native cleanup regression | A reviewed silent stock Scene started and stopped after the owner guard change; WE PID and desktop selection were unchanged. Closing after a missing/restarted WE is also tested to issue no new control process |
| Control service | Authenticated actual library/search/type filter, independent empty default, missing-ID rejection, preview close, setting validation, private export and graceful exit passed with isolated preferences |
| 0.2.1 video correction | The user-running 0.2.0 video capture path measured 8.64–10.03 FPS over six three-second samples. All background Video now uses the original File-backed decoder; native WE preview remains separately gated. Video-only tracks no longer select the slow screenshot path |
| Two-renderer lifecycle supplement | Two headless Chromium contexts with authored audio/video fixtures: 120.426 s, 40 samples, about 29.97–45.18 FPS, zero dropped frames. File-backed mute before src, no input-event leakage, resize/DPR, input click, bad-file retention, reload/reconnect, closing/new renderer, and complete owned-node/media/Blob-URL release passed. This is not physical Codex multiwindow or a stable-60-FPS claim |
| Independent uninstall | Test-only compiled fixture install, Windows registration/menu, locked/read-only/redirected/foreign/duplicate/traversal rejection, damaged portable-package isolation, installed/portable self-removal, temporary cleanup and repeated removal passed. Personal data, user additions and original wallpaper sentinels retained; no real user install was removed |
| Production package uninstall | Production BridgeArchive extracted the actual 0.2.1 ZIP into a unique fixture; generated inventory was unique and packaged/standalone uninstaller hashes matched. Production locked-file refusal, self-removal/temporary cleanup, unknown/outside sentinels and repeated removal passed using only explicit portable fixture paths |
| Live upgrade isolation/resources | Graceful 0.2.0 → 0.2.1 restart preserved byte-identical settings, current selected project and the hash of WE selectedwallpapers/Monitor properties. Old capture/lease helpers exited; Codex and WE stayed running. Bridge process-tree CPU fell from about 0.82 to 0.019 core equivalents and RSS from about 270 to 123 MiB in separate short samples. Codex/WE decoding/GPU cost is excluded, and these are not whole-system benchmarks |
| 0.2.2 capture handoff | D3D11 mapping ABI v2 retains at most one unread frame and acknowledges the exact copied sequence. This removes high-rate writer starvation and live-sequence mislabelling. Mapped bytes and contiguous bitmap pixels use bounded native copies; already-sized opaque RGB skips a redundant redraw. Resolution/JPEG quality budgets unchanged. Real GPU fixtures verified one-unread-frame retention, flip/FP16 and blt/BGRA changing frames, normal unload and owner-death unload |
| Test environment restoration | User authorized temporary test-environment changes. SystemParametersInfo setters refused changes, so settings remained untouched: active=1, timeout=60 seconds, secure=0 before/after. A temporary Default-desktop-only idle helper kept the test session active, then stopped. The existing Bridge was gracefully stopped to prevent it from auto-attaching to test ports and restarted with byte-identical settings after every isolated run |

Major implementation files: `src/library.mjs` (read-only discovery/index), `src/native-player.mjs` (native safety, unique source and cleanup), `src/coordinator.mjs` (independent selection and lifecycle epochs), `src/config.mjs` (per-project profiles/FPS), `src/control.mjs` + `src/main.mjs` (authenticated management API), `src/renderer.js` + `src/presentation.mjs` + `config/adapter.json` (continuous canvas and safe takeover), `native/BridgeHost.cs`/`WeConsole.cs` (manager/capture/cleanup observer), and `assets`/`scripts/build-icon.ps1`/`scripts/build.ps1` (new icon and packaging).

The 0.2 EXE, portable ZIP and source ZIP are built with the existing build script. The Setup payload verification and packaged bundled-Node service smoke passed; this does not claim a fresh-account installation/endurance test. Reproduction commands are in README. Private evidence paths in this workspace: `.local-evidence/visual-acceptance`, `native-independent-probe.json`, `native-lease-crash.json`, `manager-ui-layout-report.json`. User-content screenshots are deliberately excluded from distribution/source packages.

Remaining limits: arbitrary Workshop Scene packages cannot be guaranteed muted on creation; the official CLI's mute command is global and open-with-properties is not atomic in this version. All nine Video projects use the explicitly labelled original-file muted client decoder in 0.2.1. General Web uses isolated muted Edge, with WE-specific interface restrictions. Application independent playback is blocked. Native previews permit direct interaction, but chat-window pointer forwarding is not implemented. Physical multi-monitor/DPI moves, maximum-load endurance, arbitrary audio-responsive projects and every native parameter remain unverified. Selecting 120 FPS never constitutes a claim of 120 FPS throughput.

---

## Historical 0.1 results (desktop-following design)

# Validation record — 2026-10-15

Requirements: user PRD v1.0. The report/upstream are technical references. All four types have working production paths in the tested project/version matrix. This does not claim universal project compatibility or completion of every broader DoD experiment.

## Reference environment

Windows 11 x64 build 26200; Intel Core i7-14650HX (16 cores / 24 logical processors), 16 GB RAM; NVIDIA GeForce RTX 5060 Laptop GPU, driver 32.0.16.1742, desktop 2560×1600 at 300 Hz; Intel UHD driver 32.0.101.6647 also installed. Node 24.19.0, Framework compiler 4.0.30319, GCC 16.2. Codex MSIX 26.1007.9446.0 / Chromium runtime 155.0.8059.40; WE 2.8.0.42.

The executing token is not elevated. Actual tests use independent official Codex profiles. Existing user Codex PID is retained. No conversation text, login data, work-file content or user-content screenshots are collected; only structural booleans, styles/geometry, authored input, owned wallpaper-canvas hashes and process counters.

## Executed checks

| Check | Result | Boundary |
| --- | --- | --- |
| Unit suite | 34 passed, zero skipped; JavaScript syntax passed | Auth, path confinement, source generations, late cancellation, close races, hidden resume, unsupported compatibility, project-controlled diagnostic value filtering, settings recovery, logging, process identity, signed/offline/disk-failure updates |
| Actual dual Codex / Video | Both windows showed 12 changing frame hashes; original 3840×2160 File-backed native decode, about 59.65 FPS, zero dropped frames in the recorded short slice | No transcode, full-file transfer or wallpaper copy; physical-resolution canvas; codecs depend on installed Codex |
| Actual dual Codex / all types | Video → Web → Scene → Application → original Video followed automatically without restart; every type changed in both windows | Authored Web and WE-launched WinForms Application; actual stock Shimmering Particles Scene |
| Actual foreground preservation | Sidebar/main/composer full continuous canvas, unchanged fonts/layout, authored typing, background effects, exact restore passed | User conversation interaction/content was not inspected |
| Close-one window | Remaining actual window retained the same generation and connection | Two independent official processes |
| Original desktop restoration | Source, selected properties and pre-existing window states restored after four-type tests | Selection tests are temporary test-only operations, not production behavior |
| Browser integration | Animated WebM, Cover, resize, input/click, stale-generation rejection, repeat apply/restore and real controller-death lease passed | Authored synthetic pages; light/dark at emulated DPR 1/1.25/1.5/2 |
| Web backend | Private muted Edge pipes, dynamic frames, pause/resize and cleanup passed | Special WE audio/media/random-file/query APIs are explicit unsupported paths |
| Application ownership | Existing WE-launched exact EXE gave changing frames; unrelated same-EXE window excluded and direct capture rejected | Arbitrary Unity/multiprocess/multiwindow projects not claimed |
| Scene graphics | Actual desktop Scene plus D3D11 flip/blt/FP16 fixtures passed; normal stop/helper death unloaded DLL while source stayed alive | FP16 converts to SDR and may clip highlights; no HDR parity claim |
| Managed official launch | New official Codex survives Bridge exit; pre-existing Codex retained | Independent Bridge-owned profile; no auth copying |
| Installer/update | Per-user install; development tools removed from PATH; opt-in startup enable/disable; signed 0.1.1 activation; deliberately broken 0.1.2 rollback; interrupted-swap recovery; uninstall/unknown-file preservation all passed | Fresh test data in current unprivileged MSIX session; original preferences restored by whole-directory rename without reading contents |
| Source reproduction | Source archive extracted into a new directory containing spaces and compiled successfully | Same reference machine; new-account/clean-OS reproduction remains |
| Service | Native discovery, authenticated API, disabled defaults, invalid input rejection, filtered export, graceful exit passed | Isolated data directory |
| Original desktop-child WGC | Failed with E_INVALIDARG | Retained failed experiment; production replacement paths do not depend on it |

The final combined performance/four-type run passed with two exact supported Codex instances: Video [12,12], Web [12,12], Scene [6,6], Application [12,12] changing hashes. Both windows retained original 3840×2160 native Video decoding. The original source/properties/window states were restored; the remaining window retained its generation after the other closed. All measured test children exited, verified by PID plus start identity; cleanup audit completed in 586 ms. Earlier unsuccessful attempts remain private evidence.

## Performance and endurance

Opacity is now 0.60, brightness 1, FPS ceiling 60; modes cap 30/60/60. Native Video always retains original codec/dimensions and display pixels. Multiple windows no longer incur an automatic square-root FPS reduction; measured overload adjusts FPS only.

A real dual-window 183-second visible sample recorded:
- Original 3840×2160 native Video; Performance around 28.5–30.4 FPS, Balanced around 57.9–60.0, Quality around 59.8–60.3.
- Minimize/resume passed; renderer round-trip p95 0.7315 ms.
- Bridge Node RSS approximately 65.4 → 66.3 MB, with unchanged active-resource categories/counts.
- Aggregate independent Codex tree grew from 37 to 39 processes; early/late mean handles increased by 950 and private bytes by approximately 269 MiB. The total-handle 5% engineering gate failed. This is recorded as a failed endurance gate; stable Bridge Node resources are not a substitute for investigating aggregate growth.

A subsequent per-process run explained the aggregate increase: two new Codex child processes contributed 1,049 handles while the existing process identities' aggregate handles decreased. The raw-total failure is retained above; it compared changing process sets and was not evidence of a growing Bridge handle pool. The measurement gate was refined to compare matching PID/start identities, retain raw totals/new child metadata, separately bound Bridge Node RSS, and audit every measured child's exit. Parent-child ancestry now also rejects children older than a recycled parent PID.

The final combined run recorded 123 seconds / 37 visible samples and **passed** the refined bounded gates:
- Performance 28.35–30.61 FPS; Balanced 59.36–60.41; Quality 59.92–60.46. Every mode retained the original 3840×2160 source and the same physical canvas size.
- Renderer round-trip p95 0.8002 ms; native minimize/resume passed.
- Comparable-process mean handle change −126.58; raw total change +754.67. Two new ordinary Codex child processes were reported separately, then confirmed gone after test shutdown.
- Aggregate private-byte increase approximately 210.6 MiB, within the declared tolerance. Bridge Node RSS stayed within its 32 MiB growth tolerance and active resources remained bounded.

These are proposed reference-system engineering tolerances, not historical PRD promises or a long-term zero-leak proof: measured FPS within 65–118% of cap during visible samples, p95 renderer round-trip <250 ms, private-byte growth below max(128 MiB, 15%), comparable-identity handle growth below max(150, 5%), Bridge Node RSS growth <32 MiB, and no measured test children remaining after bounded shutdown. GPU metrics remain explicitly unavailable.

Benchmark privacy boundaries are the same as runtime. Temporary test-only topmost windows keep owned samples visible without activating input; the helper requires the ordinary active input desktop and rejects secure/unavailable desktops. Nothing disables screen locking or changes desktop audio. Test shutdown closes only directly spawned test roots.

## Bugs found and fixed during acceptance

- Actual Codex blocks ordinary loopback HTTP Video under media CSP. Detached File-backed native playback works without CSP changes or document upload events.
- Existing Scene uses RGBA16_FLOAT; bounded linear-to-SDR conversion enabled its actual changing frames.
- Auxiliary/unready pages and close races no longer reset other windows. Hidden media waits for visibility and resumes the newest source.
- Leaving Web/native capture now releases its previous backend.
- MSIX redirected AppData returned E_INVALIDARG for .NET File.Replace during interrupted-update recovery. The launcher resolves the physical parent and uses flushed atomic replacement via MoveFileEx. Interrupted activation now passes the full installed test.
- Uninstall keeps its identity/manifest until cleanup commits; recovery errors expose safe stage/type/HRESULT metadata.

## Remaining DoD expansion

Physical movement across different-DPI monitors, a separate clean Windows account, broader audio-bearing third-party projects, and longer 1/2/4-window source/window churn remain unverified. The local bounded performance/resource gates and full two-window four-type run passed; they do not substitute for that broader matrix. Public hosting, signing identity and publication are owner release decisions; no source/PR/release has been published. The runtime fullPrdAccepted flag stays false until the broader DoD has evidence.

Private profiles, TLS/signing fixtures and detailed evidence are ignored and never packaged. Some empty test residue and an owned test launcher were retained under renamed acceptance-residue names after automatic approval blocked a cleanup deletion. No rejected deletion ran, and no wallpaper/user-work resource was removed.
