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
resource retrieval or the browser preview.

In 0.4.2, the original Save/Save As commands use the existing snapshot/conflict
protocol before writing. A later edit stays dirty; replacing a document detaches
its old save destination. Source conflicts never overwrite the changed file.
Selection is restored after document pushes and published through the host's
model-context capability. Code-panel requests reuse the existing captured-target
and version guards, hand off through `ui/message` when supported, and consume
`canvas_codegen_complete` results. A missing acknowledgement never replays a
mutation or a chat message.

`scripts/native-host-harness.mjs FILE.op` exercises the actual MCP Apps JSON-RPC
transport with an isolated daemon. Its iframe and `/direct` diagnostic view
are local test hosts, not Codex. Save/reopen, model context and Code-panel handoff
must be checked there before desktop acceptance. The harness records messages
instead of sending them to an AI provider. Existing tests cover stale snapshots,
concurrent saves, document replacement and cancellation.
