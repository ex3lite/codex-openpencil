// OpenCode starts a separate local MCP server in each project directory.
import { serve } from '../plugins/openpencil/scripts/mcp-bridge.mjs';

await serve({ client: 'opencode', projectRoot: process.cwd(), runtimeRoot: process.env.OPENPENCIL_EDITOR_RUNTIME_DIR });
