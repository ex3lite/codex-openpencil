# OpenBrush 0.13.1: explicit context and independent panels

## Changes

- A direct **В контекст** toolbar action captures the current native selection before attaching it. Empty selection disables the action. The drawer lists the pinned targets and acknowledges delivery.
- Ordinary selection/status polling does not call `ui/update-model-context`. The app-only `canvas_panel_state` response carries UI state in private `_meta.panelState`, with an empty model-visible content array.
- Layers and properties have independent, acknowledged visibility controls. The properties inspector has an explicit close button; hiding it preserves selection. Its widget is removed from both painting and hit testing.
- Comment composition captures only selection. Submission synchronizes the document and validates the original pinned IDs against the current canonical page. A later selection does not redirect or block the comment. An open comment list refreshes when an agent resolves a comment.

## Verification

- `npm run check`: passed.
- `npm test`: 332 passed, 0 failed. Local loopback listeners require execution outside the restricted network sandbox.
- Native isolated smoke: 233 tools; initialize, create, read, layout, lint, PNG, save and reopen passed.
- Engine core: 1263 passed. Independent inspector test preserves selection and layers.
- Inspector widget regression: reproduced the hidden widget before the constructor guard; passed after the fix.
- Web host tests and official WASM bundle gates passed. Gzip size: 5,346,638 bytes; zero env imports.
- Staged runtime source: `d8dbaeab100e35068e46369ab53d3d39bc7cb4d5`; all 288 runtime files verified.

## Actual Codex acceptance, performed on 0.13.0 before the patch

The native MCP App was expanded inside Codex. A dedicated copy, `OpenBrush-0.13.0-Check.op`, protected the original product design.

Three real Codex subagents joined the same canvas with separate exclusive sibling scopes. The native UI showed **Агенты · 3**. All three changed only their assigned node names. Concurrent stale writes were rejected; fresh reads preceded explicit new attempts. All changes reached the file and immutable history without calling Save or autosave manually. All leases were released afterward. Ten simultaneous model agents were not exercised in this acceptance run.

A comment was submitted through the native editor, read through the model tool, resolved by the agent, and observed as **Выполнен · n9 · версия 17** in the native editor. Its pinned target remained page `n109`, node `n9`. The comment ID was `a4762321-03ce-4979-afeb-461c51975cad`.

The Layers action hid the tree in the native accessibility snapshot. The old toolbar lacked a direct attach action and an independent inspector close button. A later explicit status read returned `SELECTION_STALE`; that observation is recorded rather than claimed as successful selection verification.

Native MCP App screenshot capture timed out, so native evidence consists of DOM snapshots and tool/file/history results. A browser harness screenshot is not native Codex proof. The new 0.13.1 controls require a freshly loaded plugin resource before live acceptance can be claimed.
