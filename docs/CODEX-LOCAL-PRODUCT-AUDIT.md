# OpenBrush 0.13.0: local Codex product audit

## Product boundaries

The Rust/WASM scene, editable `.op` model, layout and preview runtime remain the
original fork. The Codex host now owns the visible 40px toolbar. It occupies the
existing native chrome inset, so there is no second header or coordinate offset.
Internal MCP Apps transport carries tool calls, exact session identity and local
synchronization. Users do not configure MCP, accounts, providers or model keys.
The installed Node runtime has no npm dependencies; ui-sdk is built beforehand
into one local client bundle with the Apache-2.0 license included.

## Findings and changes

| Finding | Change |
| --- | --- |
| Two independent toolbars exposed file/account/provider/room controls. | Codex native chrome does not paint, hit-test or return tooltips. One host toolbar remains. Standalone and VS Code retain their own UI policy. |
| Save/Save As, path dialogs, project chooser, manual import and history restoration were user workflows. | Removed from the Codex shell and legacy outer panel. Agent project/resource/history APIs remain. Save shortcuts request normal autosave without a file dialog or download. |
| A continuous stream of edits could reset the debounce forever. | A fixed 2s deadline bounds postponement in both UI and backend, with 700ms idle debounce. Writes still serialize through the owner queue. |
| History checkpoints could also be postponed by uninterrupted edits. | A 10s deadline bounds history coalescing; close/switch boundaries commit pending history. Existing immutable versions and retention remain. |
| UI input could also nudge/delete canvas nodes or paste clipboard data onto the canvas. | Host DOM controls own their keyboard and clipboard event path. SDK toolbar arrow navigation never reaches scene shortcuts. |
| Closing a comment discarded its text and reopening could silently select another target. | Draft text keeps its captured page, nodes, version and request identity. Retargeting is explicit. |
| Opening a custom side panel resized the canvas and changed its camera geometry. | A non-modal ui-sdk Drawer overlays the scene; opening/closing it does not resize the canvas. SDK owns focus, Escape, gestures and reduced-motion behavior. |
| Auth, credential and human room services ran without a visible use in Codex. | Their timers/bootstrap requests are disabled in Codex, including the auth refresh after bridge init and credential propagation during repaint. |
| Legacy resource and DESIGN.md import panels duplicated the host library. | It routes to the same global/project library. Codex skips standalone template-library pumping and its eager document/cover downloads. |
| Empty agent and permanent saved labels added noise. | Agent activity appears only when local agents actually work. Persistence status appears for pending writes or real errors. |
| Preview and fullscreen were mixed with browser window behavior. | Preview uses the native runtime with acknowledged mode state and Escape exit; expand uses the Codex app display-mode request. Browser fullscreen is not invoked. |

## Persistence and safety contract

Every managed document gets a project file automatically. Successful native/agent
checkpoints feed autosave and automatic history. The editor is marked clean only
for the acknowledged generation/revision. An edit arriving during a write remains
pending. Startup's temporary document is never autosaved over the real project.

External source changes, uncertain writes and synchronization conflicts stop
writes and expose an error. No failed mutation is retried automatically. A stale
snapshot requires a distinct synchronized edit or explicit agent recovery with a
fresh verified snapshot. Agent history and restore are retained; restoration is
version checked and keeps current work in history.

Human network rooms are disabled. Up to ten local Codex subagents retain exact
parent-canvas identity, assignment scopes, named cursor indicators and CAS writes.
Resource discovery/downloads and font acquisition remain on-demand agent tools;
local operation does not imply that acquiring a new Community resource is offline.

## Interaction foundation

The host shell uses pinned `@ui-sdk/web` / `@ui-sdk/core` 0.1.0-beta.3:
Toolbar for roving keyboard focus, Drawer for panels, Button for pending actions,
and the SDK agent snapshot/query/act adapter. The packaged client has no CDN or
runtime package installation. SDK agent calls do not implicitly attach layers to
chat context or create another model connection.

The requested gestures skill is installed globally. Generated interactive UI uses
ui-sdk behavior primitives and semantic project tokens. Gesture rules preserve
pointer tracking, cancellation and interruption, apply physics after release, and
respect reduced motion. The Rust scene is not reimplemented in DOM components.

Browser prototype testing and ChatGPT Sites sharing are explicit-request workflows.
This release does not automatically launch browsers, publish, expose LAN services,
or upload designs. A local editor diagnostic URL is not a hosted mockup.

## Verification

See the release acceptance evidence in the working project's
`outputs/openbrush/local-shell-v013/` and `outputs/openbrush/stability-check-v013/`.
Package checks, full plugin suite, Rust web-host and chrome regression tests,
WASM import/size gate, native MCP smoke, isolated reopen/component propagation,
and browser keyboard/comment/library/preview checks are required before install.
A protocol harness verifies the browser implementation, not actual rendering in
the Codex desktop host. A fresh host loader verifies installed tools and resources;
the existing chat's loaded plugin process needs a Codex restart to adopt the release.

### Installed acceptance

- Plugin 0.13.0; implementation commit `0594cea`.
- Engine `239ce67934368439793b5ada8d97a0af51fcb7df`.
- `npm run check`: pass. Plugin tests: 326 passed, zero failures.
- Rust web-host suite and 55 related chrome tests: pass.
- WASM: zero `env.*` imports; gzip 5,346,278 bytes, below the 6 MiB gate.
- Isolated native smoke: 232 tools; create/read/layout/lint/PNG/save/reopen pass.
- Isolated project: three pages, linked master/token propagation and reopen pass.
- Browser: clipboard/arrow isolation, fixed comment target, draft/focus return,
  drawer swipe, unified library and preview/Escape confirmation verified.
  No console warnings/errors or account/room/standalone-template requests.
- Codex fresh loader: 59 plugin tools, resource `ui://openbrush/native/v0.13.0.html`.
- Installed package: all 92 source files byte-identical.
- Original user's design SHA remained unchanged. QA used separate copies.
- The already running Codex chat was not restarted during execution. Native
  Codex rendering after restart remains a user-host check, distinct from the
  verified local browser protocol harness and fresh loader.
