# Native Codex editor (local development)

The 0.4 plugin embeds the existing Rust OpenPencil CanvasKit/WASM application in
an MCP App HTML resource. The native scene graph, widgets, layout, interaction,
history and document synchronization remain in OpenPencil. JavaScript only
adapts the editor's loopback HTTP requests to the app-only MCP transport.

`embed=codex&chat=host` selects host-owned AI. It hides the editor's internal
chat/provider controls and retains editor preferences. It is distinct from
VS Code mode so file and clipboard actions do not use the VS Code protocol.

Build the Rust fork's WASM bundle first. Stage a separate, integrity-checked
runtime using `scripts/localize-runtime.mjs`, preserving the original runtime.
Run `node scripts/build-native-editor.mjs /absolute/runtime/root` to generate
the corresponding JS glue. Both the glue and WASM hashes are pinned by the
plugin. Configure that runtime before installing this local plugin build.
No user documents or licensed local UI kits belong in a distributable package.

Use `open_canvas` and its MCP App entrypoint. `canvas_open_browser` and
`scripts/native-preview.mjs` are separate fallback/diagnostic surfaces, not
proof that the native Codex panel renders. A plugin upgrade does not replace
an in-flight turn's old MCP transport. Reload the host if that transport is
closed, then call `open_canvas` again with the intended recovery file.

Verified locally: Rust host-owned chat tests, plugin tests, real daemon
edit/render/save/reopen smoke, and actual Codex resource retrieval. Native
Codex sandbox rendering is still an acceptance step; do not infer it from
resource retrieval or the browser preview. The original host-message paths
for Code-panel replies and acknowledged Save are not yet adapted to the new
transport. Successful editor document pushes checkpoint the recovery draft;
manual source-file saving still requires an observed synchronized snapshot.
