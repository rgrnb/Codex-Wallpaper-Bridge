# Third-party notices

The implementation is a separate Windows-only bridge, not a full copy of the reference product.

- Codex-Dynamic-Skin, CCDawn, reference commit `5a0e74043b63ed9518ab37cdcf6865340a57006c`:
  https://github.com/CCDawn/Codex-Dynamic-Skin/tree/5a0e74043b63ed9518ab37cdcf6865340a57006c
  MIT license. Contract selectors in `config/adapter.json` are adapted from this reference.
  The full notice is retained in `third_party/Codex-Dynamic-Skin-LICENSE.txt`.
  Its theme library, managed Codex configuration modifications, resource proxy files and GPL scene sidecar are not included.
- Packaged Node.js runtime: v24.19.0 for the build produced here. Full Node.js and bundled-component license text in
  `third_party/Node-LICENSE.txt`, sourced from https://github.com/nodejs/node/blob/v24.19.0/LICENSE.
  Packaging another Node version requires the matching license and dependency review.
- MinHook v1.3.4, Tsuda Kageyu: https://github.com/TsudaKageyu/minhook/tree/v1.3.4.
  Used by the D3D11 presentation bridge. Vendored source is in third_party/minhook;
  its full LICENSE.txt retains the MinHook BSD terms and HDE/component notices.
  No wallpaper resources or third-party Scene viewer are included.
- .NET Framework, Windows WinRT/Direct3D and WinForms are operating-system prerequisites, not bundled application binaries.
- Playwright is optional development tooling, not included in the application distribution.
- No Codex binaries, Wallpaper Engine binaries, wallpaper project resources or user authentication data are distributed.

Public license and publication of the new Bridge code remain the owner's decision (PRD D-10).
No public release or code-signing identity is implied by this development build.
