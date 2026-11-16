# OpenBrush canvas performance and project design system

## Goal
Measure the native editor and Codex bridge separately, fix demonstrated hot paths, and make reusable tokens, components, interaction states and motion a required project deliverable. Preserve the existing Apple-style document and its editable layers.

## Work
- [x] Capture baseline and comparable browser CanvasKit timings on the original 109-node document; measure selection bookkeeping on a 100,000-node fixture separately from browser frame time.
- [x] Add red-green regression tests for text-cache thrashing, grid batching, selection indexing, component placement and button-label geometry. Bound caches and preserve accessibility.
- [x] Add native project foundations/UI Kit initialization and the `canvas_design_system_audit` tool. Expand instance overrides, detect shared local-state mistakes and unsupported layout motion. Block incomplete finalization before mutation.
- [x] Update design workflow instructions, preserving project scope and distinguishing static checks from actual preview acceptance.
- [x] Add foundations and UI Kit to the existing Apple-style document. Four product buttons use canonical linked refs; five state samples use the same master. Preserve intentional artwork and layout.
- [x] Verify token/master propagation, per-instance interaction state, focus, disabled visuals, reduced motion, geometric centering, autosave and reopen on isolated fixtures. Inspect all three native page renders.
- [x] Run package checks, full plugin tests, relevant Rust suites, native/WASM builds and isolated MCP smoke. Package the new runtime.
- [x] Install the new plugin and verify fresh Codex tool/resource discovery: 0.12.0, 59 tools, new resource URI, all 89 installed files match source.

## Measured results
- Warm same-content fit frame: 237 ms before, 13 ms after (319 text draw calls in each). These are instrumented CanvasKit paint/flush durations, not end-to-end FPS.
- Grid: 7,728 per-dot draw calls become one batched draw.
- Node selection bookkeeping, 100,000 nodes, unchanged empty selection median: 11.52 ms before, 0.0028 ms after. Initial selected-node index construction remains O(nodes).
- Font cache: a 400-run page over three passes shapes 400 paragraphs instead of 1,200. LRU eviction removes one paragraph; registration correctly invalidates the cache. Maximum 1,024 cached paragraph handles.
- Cold font registration/shaping remains measurable and is not covered by the warm-frame improvement.

## Constraints
No external search service was substituted for the Figma Community tools. No second writer touched the user document. Benchmarking and reopen/propagation checks used separate copies. No global finalizer rewrote approved artwork. Static audit success is not presented as interactive acceptance.
