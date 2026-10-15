# Development and recovery

Production has no npm dependencies. Build needs Windows x64, Node.js 22.15+, Framework 4.8 C# compiler, Windows WinMetadata and MinGW-w64 GCC with C11. MinHook source/license is vendored. Edge is a runtime prerequisite for Web; Video uses Codex's native decoder. Optional Playwright is development-only.

~~~powershell
npm test
npm run check
npm run build
powershell.exe -NoProfile -File scripts/build.ps1 -Package
~~~

## Records and ownership

Current-user data: %LOCALAPPDATA%/CodexWallpaperBridge. Settings schema/defaults are defined in src/config.mjs. Files include settings.json, settings.json.previous, PID-only instance.lock, bounded logs, local diagnostics export, update-trust.json and updates transactions. codex-profile is used only by explicitly requested official Codex launch. It is never copied, scanned or exported.

Installation: %LOCALAPPDATA%/Programs/CodexWallpaperBridge, plus a stable sibling launcher. Installer, uninstaller and updater share an install lease. They validate paths, ownership and reparse points. Unknown files and preferences/logs survive uninstall. Interrupted activation is recovered from a journal before starting a known version.

MSIX may redirect logical AppData across volumes. Node/native code resolve physical directories before atomic rename and target comparisons.

## Restore

Use the tray restore or exit action. A crashed controller's page lease removes its owned layer in about 15 seconds. Reloading the page also clears runtime state. No official package/config is overwritten. Corrupt preferences recover from the prior valid file with background disabled.

Native capture/helper/browser children belong to Bridge's kill-on-close job. Explicit official Codex launch and updater use restricted breakaway paths so user Codex survives Bridge exit and the updater survives activation. Tested managed launch retained the existing chat process and survived Bridge exit.

Do not change WindowsApps ACLs, copy login data, patch security policies or downgrade Codex as a recovery workaround.

## Tests and their effects

| Command | Scope / side effects |
| --- | --- |
| npm test / npm run check | Unit/integration fixtures and syntax |
| npm run test:service | Native metadata plus isolated disabled service/API/export/exit |
| npm run test:shared-video | Reads current Video via ranges; private browser; no selection change |
| npm run test:web | Authored Web animation; private muted browser |
| npm run test:application | WE opens/closes one uniquely named authored Application pop-out; desktop selection checked |
| npm run test:graphics | Authored D3D11 program; verifies frames and unhook on stop/helper death |
| node scripts/graphics-backend-smoke.mjs --float | FP16 linear-to-SDR conversion fixture |
| npm run test:scene | Temporarily selects stock Scene on Monitor0; restores original source/properties |
| npm run test:codex | Starts only independent official Codex test profiles; checks structure, own canvas, fonts/layout, owned input, effects and restore |
| node scripts/codex-acceptance-smoke.mjs --types | Adds production-coordinator four-type switching; temporarily changes Monitor0 and restores it |
| node scripts/codex-acceptance-smoke.mjs --single --performance --seconds=600 | Actual original-quality 4K Video, three measured modes and bounded endurance; only own test profiles/counters |
| node scripts/codex-acceptance-smoke.mjs --windows=2 --performance --seconds=120 --types | Final combined local acceptance; temporarily shows only owned test windows above other windows without activating input; requires ordinary active desktop |
| npm run test:managed-launch | Isolated tray/profile; proves existing Codex retained and managed Codex survives Bridge exit |
| npm run test:install-update | Current-user install/HTTPS signed activation/broken-version rollback/uninstall; refuses existing installation/preferences |
| node scripts/install-update-preserving-data.mjs | Same test, with reversible whole-directory rename of existing preferences; refuses an installed/running Bridge; restoration journal in private evidence |

Use the scene show-desktop option only during attended testing: it toggles desktop visibility and restores it. Original child-window WGC experiments remain diagnostic failures and are not hidden as skipped unit tests.

Ignored .local-evidence contains private test profiles and local signing/TLS fixtures. Never package or publish it. No diagnostic may read chat/input values except an explicitly authored test input; no user work files or credentials may be collected.

Browser tests can locate optional Playwright through BRIDGE_PLAYWRIGHT_MODULE and Edge through BRIDGE_BROWSER_PATH. Test fixtures/compiler paths should be adjusted to installed tools; production distribution bundles Node.

Packaging pins Node 24.19.0 to match the reviewed bundled license. Installer/update acceptance additionally requires OpenSSL on PATH or BRIDGE_OPENSSL_PATH to create a disposable local TLS certificate; graphics fixtures use GCC on PATH or BRIDGE_GCC_PATH. These are development dependencies only. Update-test archives are built with Windows' standard ZIP library. No personal tool paths or signing keys belong in the source archive.

## Release

Use scripts/sign-release.mjs with an externally stored Ed25519 private key. Never ship a private key. Users configure a trusted HTTPS source/public key; public hosting and code signing are not supplied by a development build. Final release still requires the full acceptance/performance matrix and clean standard-user reproduction. No source, PR, tag or release has been published.
