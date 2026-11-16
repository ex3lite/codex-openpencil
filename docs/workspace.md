# Project workspaces in 0.5

The original Rust/CanvasKit editor runs inside the Codex MCP App. Codex owns the
conversation and model; no second provider is configured in the canvas.

## Open and switch documents

Call `open_canvas` with the current Codex workspace's absolute `projectRoot` and,
optionally, a registered `documentId` or an in-project `.op` file. Omitting both
document selectors creates a new project draft. Calling the opener again in the
same session returns its current canvas. To switch, use the project menu or
`canvas_document_open` after flushing the editor snapshot.

The project owns `.openpencil/catalog.json`, recovery files and comment journals.
External files must be explicitly imported as copies into `designs/`. The original
file is preserved. Saves reject external modifications and existing Save As
destinations. Code panel results must belong to the captured project and document.

Only one parent session writes each document. Subagents join that parent's canvas
instead of opening the file independently. Graceful shutdown releases ownership.
After a process crash, a stale writer record is reported without removing it
automatically. Verify the recorded process has stopped before removing that
document's `.openpencil/writers/<documentId>.json`; preserve its recovery file.

## Comments and visible context

Select a layer, then click **Комментировать**. The panel shows the selected layers
and document version before submission. **Отправить в Codex** persists the comment
and sends one message to the current chat. Changing selection does not retarget it.
If delivery is uncertain, the journal preserves that status and does not resend.

**Контекст** shows the project, document, selection and unresolved comments being
published to Codex. Selection sharing can be disabled. Context updates do not start
model turns; explicit comment submission does. Empty selection means no target.

## Up to ten independent Codex agents

The main agent creates disjoint subtree assignments using `canvas_agent_assign`.
Each returned lease includes a canvas ID, project root, page, roots, name and color.
Pass these values to a Codex subagent. The child uses `canvas_agent` to read, apply,
renew and release its assignment. It must not open a separate canvas or call the
editor's provider-based `spawn_agents` tool.

Edits preserve unrelated nodes and use the native document version. A conflict
requires reading the new version and explicitly rebasing the proposed change;
there is no automatic mutation retry. Indicators travel through the original
Rust agent relay and use the editor's own colored cursors. The agent list shows
assignments and their latest activity; an assigned lease does not prove that a
Codex subagent is currently executing. Release each lease when its task finishes.

## Display mode

Both expand controls request `ui/request-display-mode` and reflect the host's
confirmed mode. Embedded mode does not call DOM or operating-system fullscreen.
Hosts without this capability receive a clear explanation. **Уместить** invokes
the original editor's fit-to-content action within the actual canvas viewport.

## Verification boundaries

Unit tests cover scoped writes, ten-agent limits, conflicting versions, comment
targets, project paths, writer ownership, document replacement ordering and
codegen binding. Isolated Rust smoke tests cover native edits, PNG, save and reopen.
The local MCP App harness verifies UI transport and rendered controls. It does not
prove that a particular Codex release expands its native panel correctly; perform
that acceptance in the actual host after it loads the new plugin version.
