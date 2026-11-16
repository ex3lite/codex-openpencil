# Editable prototypes and motion

Call `canvas_prototype_audit` before claiming a prototype is complete. This is a
static inventory, not a runtime check. Native `update_node` / `batch_design` can
author the fields below; use their live schema, preserve existing events and
component overrides, and verify the resulting canonical nodes.

A top-level frame's `screen` is its unique route, e.g. `/` or `/library`.
A button navigates with `events.onTap: [{push: '"/library"'}]`. The inner quoted
string is an expression literal. Native Preview runs these routes. A board
labelled "Prototype" without routes and events is only an illustration.
For a linked instance, put root overrides in `descendants[masterId]`; retain the
master's hover/press/cancel/focus handlers when adding `onTap`.

Use `transition: {durationMs:120,easing:"ease_out",properties:["fill","opacity"]}`
for state changes. Node `animations` supports mount/inView keyframes, delay,
duration, easing and iterations. For example:

```json
{"animations":[{"trigger":"mount","durationMs":160,"easing":"ease_out",
  "keyframes":{"from":{"opacity":0},"to":{"opacity":1}}}]}
```

Event-driven motion uses an `animate` action with target, property, from/to,
durationMs, delayMs, easing, iterations, direction and fillMode. Keep gestures
interruptible and preserve reduced motion. Supported paint properties are
opacity, translateX/Y, scaleX/Y, rotation, fill, stroke and cornerRadius. Do not
promise a visual timeline editor, arbitrary spring curves or width/height
animation; those are not part of this integration's verified contract.

Run the prototype through the toolbar's **Прототип** action, click its routes,
check motion completion/cancellation and reduced motion. The model does not have
a tool that remotely presses that toolbar or proves the user's panel is open.
A native PreviewSession test verifies the engine; distinguish it from actual
Codex-panel visual acceptance.

Community covers are catalogue artwork. A `reference` raster is not editable
source. For component reuse acquire editable `.fig`/`.op`/`.svg`, inspect pages
and actual nodes, import the native document, then preserve component references,
tokens and source IDs when copying selected elements. The current import tool
copies whole kits as project documents; it does not yet extract dependency-closed
subtrees into another document. Report that limit instead of substituting covers.

ui-sdk supplies HTML behavior primitives in the Codex shell (toolbar, drawer,
button and agent API). Rust/CanvasKit scene controls and `.op` component masters
are not ui-sdk components. Use ui-sdk by default for new HTML/codegen controls;
do not describe a canvas drawing as an SDK implementation.
