# Explicit chat context

OpenBrush adds layers to Codex context only after **Добавить в контекст** in the
context panel. Each attachment records the chosen page, node IDs, short names
and types, and the version when the user attached it. Later selection changes,
edits, comments, autosaves, and history entries do not change those snapshots or
produce model context updates. The default payload only identifies the current
project and document.

The panel lists all pinned attachments, supports individual removal and clearing
all, and exposes the exact JSON sent through `ui/update-model-context` under
**Что именно получает Codex**. Delivery status means host acknowledgement of that
payload, not an assistant response. Context updates do not submit a user prompt.
Removing an attachment changes subsequent context; it does not erase information
already present in earlier chat turns. Switching documents resets attachments.

```json
{
  "schemaVersion": 1,
  "project": { "id": "project-id", "name": "Project" },
  "document": { "id": "document-id", "canvasId": "canvas-id", "filePath": "project/design.op" },
  "attachments": [
    {
      "id": "stable-attachment-key",
      "pageId": "page-id",
      "nodeIds": ["node-id"],
      "nodes": [{ "id": "node-id", "name": "Button", "type": "FRAME" }],
      "capturedVersion": 12
    }
  ]
}
```

When status cannot be read, the outgoing payload sets `unavailable: true` and
clears outgoing attachments once. Local pins remain visible and recover when
the same document becomes available. Context replacements are serialized so a
slow prior request cannot overwrite a later removal. An unconfirmed identical
update is not replayed every second; the panel offers an explicit retry.
Anchored comments retain their separate explicit delivery and target version.

This follows familiar explicit attachment patterns: Cursor's
[@ mentions](https://cursor.com/docs/agent/prompting) select known relevant
context, while Claude's [file upload controls](https://support.claude.com/en/articles/8241126-upload-files-to-claude)
attach content to a chat or project. OpenBrush adapts those principles to pinned
canvas targets rather than treating every live selection as a new attachment.
