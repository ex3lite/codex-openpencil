# OpenBrush 0.14.0 — project navigation and floating editor

The editor has a persistent **Макеты** action. It lists only documents registered
in the current chat's project, supports search, marks the current document and
opens another document after flushing and autosaving the current one. A failed or
uncertain save blocks switching. Opening a document does not send a model message.
A cold App launch first calls `open_canvas` directly using MCP roots. Hosts that do
not supply an unambiguous project root still need the existing chat binding flow;
the plugin never guesses a project from another conversation.

The Codex header and both native panels float above the full canvas with 16 px
outer gaps and rounded corners. The canvas remains visible behind the gaps.
Painting, pointer targeting, inspector fields, scrolling, text selection and IME
use the same panel geometry. Fit/zoom and the shape picker account for the panels.
Library, comments and document drawers use the bundled ui-sdk primitives.

**К чату** requests inline display mode from the Codex host. The fullscreen chat
shown in the editable interface design is a placement prototype, not an embedded
copy of real conversation history. The available MCP Apps host contract does not
expose that history to the editor.

Authored prototypes retain linked components, mount transitions and reduced
motion. Preview hit testing follows the first-sibling-on-top design paint order,
so a deep background control cannot intercept a tap on the foreground modal.
Ordinary Jian runtime consumers keep their previous hit-test order by default.

Validation covers project document switching and save failure, no model messages,
fullscreen-to-inline acknowledgement, floating inspector hit/scroll behavior,
modal tap routing on the authored design, and reduced motion. Browser acceptance
runs in an isolated local MCP Apps harness; it does not automate the Codex window.
