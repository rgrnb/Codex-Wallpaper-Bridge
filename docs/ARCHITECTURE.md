# Architecture and engineering policy

PRD v1.0 governs requirements; the report and upstream provide technical reference. Verified support is scoped by application version, project and rendering interface.

```text
WinForms tray/settings -> authenticated loopback control -> Node coordinator
  native process/TCP metadata -> Codex version + structural contract
  WE ConPTY current-source query / selected config / watcher -> generation
    Video: original File -> native Chromium decoder in each Codex window
    Web: private muted Edge pipe -> shared in-memory image frames
    Scene: exact existing D3D11 HWND -> bounded shared memory -> frames
    Application: current WE-owned EXE/HWND -> WGC / exact-window pixels
  one owned canvas/window -> centered Cover + background-only effects
  failure -> remove owned layer -> bounded reconnect / compatibility wait
```

## Boundaries

The native host provides settings, tray, process/window metadata and capture. No window titles, conversation text, authentication profiles or work-file contents are read. WE state comes from its CLI over ConPTY, with selected-user/monitor configuration fallback. A failed CLI backs off 30 seconds rather than being permanently disabled. Only current-project/config watchers and bounded polls run; there is no resource-library scan. Source fingerprints include current file stat, supported scalar properties and project revision. Credential-named properties are excluded; Web projects requiring them are rejected.

One monitor, default Monitor0, supplies every Codex window. The verified Scene path requires one unambiguous current renderer on Monitor0. Application windows require both exact selected executable identity and ancestry under current WE. An unrelated same-EXE process is excluded. Ambiguous sources fail safely.

CDP sockets must belong to recognized official Codex processes and exact app://-/index.html or detached-window.html page targets on the same loopback port. Version and structure checks both apply. Auxiliary pages are skipped independently. An explicit user action starts the installed official Codex with an independent Bridge profile/listener; existing Codex remains running and no login data is copied. Local CDP lacks per-client authentication; other code running as the same user remains a platform risk.

The separate Bridge API uses a random loopback port, 256-bit token inherited through the parent environment, Origin rejection, host checks, 16 KiB request limit and serial mutations. Tokens are never persisted or logged.

## Rendering and quality

Presentation owns per-window connections; the page runtime owns one canvas, stylesheet, media and Blob URLs. The stylesheet changes contract-defined surface backgrounds only. Foreground fonts, layout, official styles, input handlers and focus remain under Codex control. One coordinate system spans sidebar/main/composer, with centered Cover.

Production Video binds the authoritative current file to a **detached** Bridge file input object via CDP. Chromium streams its File-backed Blob URL through its native media decoder. No file copy, full-file Node transfer, transcode, HTTP CSP change or wallpaper script injection is involved. The detached input cannot emit events into Codex attachment handlers. Playback is muted before assigning src. requestVideoFrameCallback paces drawing with rAF fallback. The original source dimensions and display's physical pixels are retained up to a 16 MP safety bound in all modes. Each Codex renderer has its own native decoder; shared native decoding is not claimed. The old shared-Edge Video path remains diagnostic only.

Web scripts execute only in a private incognito Edge context over inherited DevTools pipes, launched with mute-audio and an allowlisted OS environment. Root-contained capability URLs, no-store/range reads, disabled caches/downloads and bounded metadata prevent resource-library behavior. Supported scalar/general properties are forwarded. Unavailable WE-specific APIs produce explicit fallback.

Scene captures only the current D3D11 swap chain's exact HWND. MinHook detours use bounded double staging/nonblocking readback and a 64 MiB map. BGRA/RGBA and FP16 linear-to-SDR are supported; HDR highlight fidelity is not claimed. Application uses WGC or exact-window PrintWindow for eligible existing windows. Scene/Application create no audio session and do not launch another wallpaper instance.

Web/Scene/Application use the mode-specific JPEG/image budgets below. The smoothness update does not reduce these budgets or encoding quality. These paths are not described as lossless or HDR-equivalent.

## Lifecycle and recovery

A monotonically increasing generation fences every load/frame. The old canvas stays visible until a prepared replacement commits. Each window/helper has at most one pending frame; no growing queue. Windows detach independently, including close races during discovery/configure/frame delivery. A lifecycle epoch prevents delayed attach after Restore.

App absence is a waiting state. A source announced before its renderer receives a bounded 15-second discovery window. Failure removes owned layers and stops helpers, then retries at 2/4/8/16/32/60 seconds. After six attempts it waits for source/environment change or user action. Incompatible identities are fenced; user-disabled state survives reconnect.

Exit removes owned CSS/canvas/media. A crashed controller's page lease self-restores after about 15–18 seconds. Helpers/private browsers belong to a kill-on-close job; graphics hooks also self-unload on owner death. Explicit official Codex launch and updater have restricted breakaway lifecycles. No official files are rewritten, so restore cannot overwrite a newer official update.

## Defaults and limits

These are engineering choices, including the user's latest visibility/smoothness feedback.

| Setting | Policy |
| --- | --- |
| Initial background / startup | off / off; startup opt-in |
| Wallpaper opacity | 0.60; 0–1 |
| Blur / brightness / contrast | 0 px / 1 / 1; ranges 0–30 / 0.1–2 / 0.1–2 |
| Performance / Balanced / Quality FPS | 30 / 60 / 60 ceilings |
| User FPS ceiling | 1–60 |
| Image width / JPEG quality | 960/65, 1280/78, 1920/88 |
| Image canvas pixels | 921600 / 2073600 / 3686400 |
| Native Video canvas | physical display pixels, 16 MP safety bound in every mode |
| Auto adjustment | halve FPS under measured Bridge-tree CPU >0.25 core; keep pixel/encoding quality |
| Multiple windows | no square-root FPS penalty; image capture shared |
| Hidden windows | pause own video/canvas; continue source observation |
| Discovery / observation | 5 s / 3 s; watcher wake after at least 500 ms |
| Logs | active 1 MiB + four 1 MiB archives; identical-event suppression 30 s |
| Metrics | Bridge-tree CPU/RSS/private bytes/handles; decoder counters and canvas FPS; GPU explicitly unavailable |

FPS controls pace painting; native decoding may continue at source rate. Bridge-tree metrics exclude independent Codex cost; acceptance measures that tree separately.

## Installation and updates

The current-user installer bundles Node/native helpers, checks archive paths/limits/required files and ownership, stages activation, and creates standard shortcuts/uninstall registration. Startup and desktop shortcut are opt-in. Uninstall first restores appearance, then removes only inventoried product files. Unknown files/preferences/logs survive. Updates retain unknown files in the previous installation directory without opening/copying their contents.

Settings are validated and atomically written with a prior valid copy. Physical AppData parents are resolved before rename for MSIX redirection. Installer/worker/launcher share an install lease. The stable launcher recovers interrupted swaps from its journal.

Updates verify Ed25519 over exact UTF-8 payload, HTTPS same-origin archive URL, size/SHA-256 and validity dates. Automatic checks notify; archive download/install requires confirmation. The worker stages, swaps, restarts and health-checks. Failure restores the prior Bridge/settings and disables the background. Public release hosting/key selection remains an owner decision; no public feed is configured by default.
