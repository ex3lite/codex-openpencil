# Figma Community MCP Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Search Figma Community directly through MCP, inspect resources and retain originals in OpenBrush without a search engine or another model.

**Architecture:** A deterministic, Figma-only reader in the existing browser extension owns its temporary catalog tab. A private native bridge transports structured public card metadata and bounded original-image chunks. Dependency-free OpenBrush MCP tools validate results, retain Community identity/license/source revisions and acquire resources through the existing global library.

**Tech Stack:** TypeScript Chrome extension; Node 22+ MCP bridge; existing global library.

## Global Constraints

- No Perplexity or model invocation in catalog search.
- No cookie/token extraction or private Figma session API scraping.
- Catalog tab visits only public Figma Community paths; public covers come from DOM-verified Figma CDN URLs.
- Preserve unrelated dirty work, user tabs and all existing project documents.
- Never present an image reference as an editable .fig/UI Kit.
- Existing source, license and update guards remain active.
- Plugin runtime is dependency-free, source files under 800 lines.

### Task 1: Browser reader

Files: Kakadu `lib/figma-community.ts`, `lib/mcp-contract.ts`, `lib/extension-mcp.ts`, tests.

- [x] Implement bounded public DOM search, card detail and cover chunks with a dedicated owned tab.
- [x] Add narrow typed commands and capability status; keep all generic agent behavior unchanged.
- [x] Unit/type/build checks, then reload only the updated extension and verify real catalog results.

### Task 2: OpenBrush MCP

Files: `community-browser.mjs`, `community-catalog.mjs`, controller/broker/tools, configuration script, tests.

- [x] Validate private bridge configuration and peer frames; expose status/search/get/acquire/check tools.
- [x] Return exact Community IDs, source cards/covers, author and known terms; retain revision fingerprints.
- [x] Reuse existing checksum-verified global ingestion/conversion for actual supported originals.
- [x] Test malformed results, corrupt chunks, unsupported downloads, source updates and no external search fallback.

### Task 3: Product integration and acceptance

Files: library UI, docs/skill, plugin metadata, smoke/evidence.

- [x] Search Community in the library UI through MCP directly, without sending a chat prompt.
- [x] Verify real search → detail → acquired original/reference → global library/project links.
- [x] Install and verify Codex loader: 0.11.0, all 85 installed files match, new resource URI and catalog tools present. Package checks, 308 tests and isolated native smoke passed.
- [x] Continue the requested editable Apple-style page using the new catalog tools; report source versus editable layers precisely.

Acceptance evidence lives outside the source repository in the active workspace under `outputs/openbrush/0.11.0/`. Live direct MCP search/get/acquire/check passed for public Community ID 1382343443870598429. UI search and original covers were visually verified in a separate local MCP App harness, with zero chat messages and empty explicit attachments. A fresh Codex loader read the installed resource; the running old chat still needs reconnecting before native-host 0.11 UI acceptance. The Apple-style page has 109 editable nodes, including 60 text layers and a library-imported SVG, and was saved/reopened without modifying its source.
