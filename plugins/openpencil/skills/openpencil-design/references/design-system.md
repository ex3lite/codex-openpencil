# Required project design system

Every UI project starts with foundations and a UI Kit. New project documents
already contain editable pages, semantic color/type/spacing variables, button,
field and card masters, and canonical `ref` examples. Adapt these to the brief
and chosen references; the neutral preset is a starting point, not a finished
visual direction. Preserve an existing project's own system.

For older documents, read `canvas_design_system_audit`, then use
`canvas_design_system_init(expectedVersion, accent?, fontFamily?)` if a system is
missing. This preserves existing pages and refuses conflicts. Do not initialize
again to repair a component: edit its existing master.

Compose screens with `type: "ref"`, the master ID in `ref`, and per-instance
changes in `descendants[masterId]` / `descendants[labelId]`. The legacy
`instantiate_component` tool clones trees; it does not create a linked instance.
Use the actual native schemas. A master's x/y is its position on the UI Kit board;
product instances use their own position or the containing auto layout. Do not
copy the master's board coordinates to flow instances. Button labels inside
horizontal/vertical auto layout must omit x/y; keep symmetric padding, centered
alignment and content sizing. Never compensate with arbitrary pixel offsets.

Define default, hover, pressed, focused and disabled visuals and behavior.
Native input widgets support `states`. Custom frame controls use node-local
`state`, `$self` bindings and hover/press/cancel/focus/blur events. `$state` is an
alias for global `$app`, so using it for independent button state is incorrect.
Read shared design variables via `$vars['token-name']` in expressions.
Use visible keyboard focus and meaningful semantics. Verify disabled controls
cannot activate and interactions on one instance do not change another.

Declare short `transition` durations and explicit paint properties. Use native
mount/inView animations only when the experience needs them. Do not animate
layout width/height or add motion to every decorative layer. Preview with full
and reduced host motion: reduced motion must reach the final state immediately.

Before completion call `canvas_design_system_audit`; `finalize_design` refuses
an incomplete system before running its native mutation. A passing static audit
is not visual or interaction acceptance. Render both product and UI Kit, inspect
button text centering at real size, test a master/token edit propagating to
instances, exercise states and keyboard focus, verify reduced motion, autosave
and reopen. Preserve intentional design geometry; do not blindly run global
repair/finalization over approved artwork.
