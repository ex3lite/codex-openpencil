# Code panel → Codex implementation

Use this workflow when the user requests conversion to code, clicks Generate in
the managed canvas's Code panel, or says “continue converting to code”. Selection
reminders alone never authorize implementation.

1. Read `canvas_codegen_status` when continuing a panel request. Its `requestId`,
   framework, page ID, node IDs and expected document version are fixed. Match its
   request ID to the triggering message; stop if superseded or cancelled. Read
   `canvas_status` and compare versions before work. If the design changed, ask
   the user to generate a fresh request; do not silently convert another target.
   A later selection change alone does not change the captured target.
2. Read the captured nodes with `batch_get`, inspect their native screenshot,
   and inspect the current workspace. Follow the project's framework, components,
   tokens and asset conventions. A conflicting framework choice needs clarification.
   With no implementation project, create a small runnable project in the current
   workspace. Do not overwrite unrelated files.
3. The panel request includes deterministic `codegen_export` baseline source.
   Use it as a structural starting point, not a claim of production readiness.
   Inspect text, spacing, fonts, images, states, responsive behavior and accessibility.
   Reuse image assets from the design; export required local assets into the project.
   For a chat-only conversion without a panel request, call `codegen_export` with
   the explicitly requested framework, page and node IDs.
4. Use the selected OpenBrush frame as the implementation reference. Inspect the
   resolved bounds, spacing, tokens, fonts, vector assets and shared component
   states. Record the viewport and the layer IDs for each screen and state.
   Keep the reference image and these measurements available while implementing.
   Use ui-sdk behavior primitives with the project's semantic design tokens.
5. Render the working implementation at the authored viewport. Compare it with
   the native OpenBrush render, including panel placement, spacing, text and
   states. Exercise the controls, keyboard focus and reduced motion with real
   data. Fix visible differences or record the exact host constraint, with the
   affected UI named. Preserve the .op source. Use ChatGPT Sites only on an
   explicit publishing request.
6. For a panel request, call `canvas_codegen_complete` with its `requestId` and the
   absolute `codePath` of the primary source file after verification. The extension
   must match the requested framework (`.tsx`/`.jsx`, `.vue`, `.svelte`, `.html`,
   `.dart`, `.swift`, or `.kt`). It must be a regular UTF-8 file at most 2 MiB.
   The bridge rechecks the design version and request identity. A refusal retains
   the previous preview; do not retry against a different request automatically.
7. Return links to the runnable project and primary source, launch instructions,
   checks performed and remaining limitations. The panel previews/copies/downloads
   one primary source; supporting files and the full project remain in the workspace.

The embedded wrapper sends an explicit Generate request through MCP Apps
`ui/message` only when the host advertises it. An acknowledgment means the message
was handed off, not that implementation succeeded. Standalone browser panels and
hosts without messaging keep the baseline source and tell the user to say “继续转代码”
in the current Codex chat. Check status rather than inventing a request or claiming
that an unsupported host submitted one. Failed or uncertain messages are never
replayed automatically.
