# PRD traceability — 2026-10-15

PRD v1.0 is authoritative. All FR-01–FR-24 have implemented production paths. The verified support set is Windows 11 x64 / Codex 26.1007.9446.0 / WE 2.8.0.42, with per-project checks. Implemented functions, executed acceptance and universal compatibility are separate claims.

| FR | Implementation and executed evidence | Verification boundary |
| --- | --- | --- |
| 01 | Authoritative WE current query through ConPTY; exact selected-profile/monitor fallback | No independent wallpaper library or persistent source override |
| 02 | One owned full-window canvas; sidebar/main/composer transparency verified in two real Codex windows | Additional app panels remain subject to structural contract |
| 03 | Centered aspect-preserving Cover; resize; authored light/dark DPR 1/1.25/1.5/2 checks passed | Physical movement across different-DPI monitors not exercised |
| 04 | Video/Web/Scene/Application production coordinator switches all four in two real Codex windows | Verified projects/interfaces listed in NON_VIDEO_PROTOTYPE.md; arbitrary projects unverified |
| 05 | Source/property/resource fingerprints, current-project watcher, bounded polling, generation-fenced commit | Rapid obsolete-load and source-before-renderer tests passed; long playlist stress remains |
| 06 | Reference/range reads and in-memory frames only; no resource copies/library | Own Codex profile is not scanned/exported; browser transient profile cleaned |
| 07 | Opt-in current-user startup, metadata discovery, waiting/reconnect, explicit official connection-mode launch | Startup enable/disable tested; managed launch keeps existing Codex and survives Bridge exit |
| 08 | Tray, independent settings, enable/restore/export/exit, close-to-tray | Native UI construction and service exit passed |
| 09 | Three modes, FPS cap, load-based adjustment preserving spatial quality, hidden pause, source/frame sharing | Native Video retains original source/display pixels; image budgets documented; performance record in ACCEPTANCE.md |
| 10 | Four bounded effects, reset defaults, atomic preferences/previous copy | Real Codex effects and persisted preference recovery passed |
| 11 | Background-only effects; no foreground/font/layout/event-handler writes; canvas input-transparent | Actual structure/layout/owned-input and synthetic click/light/dark tests passed; no user conversation inspected |
| 12 | Independent window attach/detach; discovery/configure/frame close-race isolation; no window-count FPS penalty | Two real windows verified; four-window hardware stress not claimed |
| 13 | Muted native video; Web startup mute; Scene/Application transfer only pixels, create no audio playback | WE properties restored/unchanged; audible sample matrix for every third-party project not claimed |
| 14 | Removal-based restore, 15–18s page lease, six bounded retries, compatibility fencing, changed-environment recovery | Delayed attach/frame cancellation, live lease expiry and signed-update failure recovery passed |
| 15 | Windows x64 | Tested Windows 11 build 26200; no universal OS/GPU/driver claim |
| 16 | Owned runtime/CSS only, exact source-window scope; no official-file rollback overwrite | Repeated apply/restore, controller-death lease and graphics helper-death unload passed |
| 17 | Full source/build/tests/config/docs/licenses and separate source archive | Source archive extracted into a new directory with spaces and compiled successfully |
| 18 | Current-user Setup, Start menu, optional desktop/startup, bundled runtime, stable launcher, uninstall | Installed with unprivileged token; PATH without development tools; unknown-file preservation passed; no separate clean Windows account |
| 19 | Default Normal structured lifecycle/source/connection/background/error events with correlation ID | Event ID independent of context reason; duplicate suppression and bounds tested |
| 20 | Advanced Debug app/window/adapter/source/load/module/recovery, safe stack locations, CPU/RSS/handles/decoder/FPS, export | GPU explicitly unavailable; no fabricated metrics; exports exclude private app/profile content |
| 21 | Auto-check/notify, configurable trusted feed, confirmed download/install, Ed25519/HTTPS/hash/size, restart/health/rollback | Successful signed activation and intentionally broken activation rollback passed; public feed/signing identity is an owner release decision |
| 22 | Package/runtime versions separate; exact verified adapter plus per-window structure | Unknown version or incompatible structure safely waits; candidate opt-in is explicit |
| 23 | WE version/type/resource/properties/window capability checks; versioned Scene gate | Project compatibility separate from application compatibility; unsupported APIs/windows fail clearly |
| 24 | Ordinary asInvoker operation, no silent elevation, scoped metadata, credential-property rejection, filtered export | Current process is not elevated; no advanced elevation operation is implemented or needed |

The implementation does not remove a required type. Remaining acceptance expansion includes physical multi-monitor DPI, separate clean-account reproduction, audio-bearing third-party project combinations and longer 1/2/4-window endurance. These are documented limits, so the runtime's fullPrdAccepted flag remains false until the broader DoD has evidence. Current functional completion must not be presented as universal compatibility or full PRD acceptance.
