# Codex local product shell implementation plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make OpenBrush a local, automatic Codex plugin with a small design-focused interface, real ui-sdk primitives, durable automatic history, and no multiplayer or manual file workflow.

**Architecture:** Keep the native Rust/WASM editable scene and the internal MCP Apps transport. Build only the DOM shell with pinned ui-sdk Web/Core packages and bundle it locally; the Node runtime stays dependency-free. Introduce a consistent Codex host policy for paint, hit testing, shortcuts and background services. Keep up to ten local Codex agents and show activity only while agents actually work.

**Tech Stack:** Rust, CanvasKit/WASM, Node 22+, local ui-sdk Web/Core, Bun for client-only bundling, native gesture handling guided by the requested gestures skill.

## Global constraints

- Always save automatically to this chat's project and retain version history. No user Save/Save As/file import controls, path dialogs or provider setup.
- Agent history, resource acquisition and project document tools remain available. They are internal operations, not instructions for the user to connect MCP.
- Disable human multiplayer UI and polling/network room services in Codex. Keep local subagents, cursor indicators and ownership scopes.
- Open browser prototypes and use ChatGPT Sites only after an explicit request. Do not publish or expose a LAN server as part of this work.
- Preserve existing designs, independent input gestures, explicit context/comment targets, and the previous stable runtime for rollback.
- No CDN, runtime npm installation, additional account, subscription or React rewrite.

## Task 1: Audit and native host policy

Files: `crates/op-editor-ui/src/widgets/top_bar*.rs`, Codex embed parser/policy, `crates/op-host-web/src/collab_sync.rs`, web command dispatch and shortcuts.

- [x] Find all file commands, collaboration/auth/provider surfaces, menu paint/hit regions and keyboard routes; record which belong to standalone editor versus Codex.
- [x] Write tests for Codex: file/import/export/provider/account/room controls neither paint nor hit-test; standalone editor remains independently usable. Verify local agent indicators still work.
- [x] Use one policy from geometry, painting and input paths; disable collaboration polling and remote service discovery before timers start in Codex.
- [x] Run relevant Rust tests and build native/WASM with the existing bundle gate.

## Task 2: Automatic persistence and agent history

Files: `plugins/openpencil/ui/native-editor.js`, `panel.js`, `native.html`, `panel.html`, `scripts/canvas-persistence.mjs`, persistence tests.

- [x] Remove path dialogs and manual save handlers. Legacy Save/Save As shortcuts must silently flush the normal autosave path instead of downloading or asking for a path.
- [x] Add bounded-delay autosave for continuous edits, visibility/teardown boundaries and queued changes during a save. Distinguish a known pre-write stale snapshot from an uncertain write; never retry an uncertain mutation.
- [x] Test continuous editing, in-flight edits, startup readiness, reconnect/conflicts, automatic initial path, history deduplication and reopen on isolated projects.
- [x] Remove history/import/project-switch buttons from the user shell; retain agent APIs and minimal real failure status.

## Task 3: ui-sdk shell and gesture rules

Files: new client entry/build script, `native-workspace.js`, `native-workspace.css`, `native.html`, package manifest/lock, generated local bundle and third-party notices.

- [x] Read installed Web docs and only the selected primitive pages. Compose toolbar, drawer and asynchronous buttons from supported ui-sdk entries; name every control and style stable state attributes.
- [x] Replace the current custom drawer/focus/key handling with the library primitive. Avoid a second independent dialog or focus manager.
- [x] Apply gestures principles to actual draggable surfaces: direct tracking, explicit touch-action, cancellation, interruption and reduced motion. No gratuitous gesture, bounce or new motion.
- [x] Verify keyboard navigation, Escape/focus return and selection comments/context in a browser harness; verify local agent scopes in integration tests and expose the SDK's agent interface for the DOM shell without another model connection.
- [x] Vendor a pinned bundle and licenses. No network resource is needed to load the installed shell.

## Task 4: Workflow and release verification

Files: design/setup skill references, product audit report and plugin/runtime version metadata.

- [x] Make ui-sdk and gesture rules the basis of generated interactive UI and design-system handoff. State the Rust canvas/DOM behavior boundary clearly.
- [x] Remove automatic editor-browser/publication fallbacks from the default workflow. Reuse code conversion and Sites tooling only when the user asks to test/share a prototype.
- [x] Run package checks, full plugin suite, relevant Rust tests, isolated native smoke and browser UI acceptance. Preserve the real project document and verify autosave/history after reopening.
- [ ] Install the release, verify tool/resource discovery and installed-file hashes. Report which behavior is already active and which needs a new Codex session.
