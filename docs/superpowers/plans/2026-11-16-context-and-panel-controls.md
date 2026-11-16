# Explicit context and independent panel controls

- [x] Add a direct attach-selection toolbar action, with empty-selection disabled state, pinned target preview and acknowledged delivery.
- [x] Stop context publication on polling/selection. Keep UI polling data in private MCP metadata so layer names and selection are absent from model-visible tool content.
- [x] Add independent layer and inspector toggles, actual post-paint state acknowledgements and a visible inspector close button. Preserve selection and geometry when hiding panels.
- [x] Add regression checks for explicit context, private panel state, visibility predicates and state labels. Build and verify the runtime once all engine changes are complete.
- [x] Verify autosave and real concurrent Codex agents on the existing isolated canvas; verify comments through the actual MCP App, record any host/tool limits.
- [x] Package/install the fix and distinguish actual Codex results from local harness validation.
- [x] After the desktop reload, verify the 0.13.1 controls in a newly opened native MCP App. Current-chat `canvas_status` reports 0.13.1; the user confirmed all three UI checks in the native Codex panel. Computer use was unavailable after restart, so this is user-confirmed UI acceptance.
