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
