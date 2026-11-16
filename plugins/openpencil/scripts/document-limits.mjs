// Shared raw document budget, independent of bounded MCP message/chunk budgets.
export const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;
export const DOCUMENT_ENVELOPE_BYTES = MAX_DOCUMENT_BYTES + 64 * 1024;
export const TRANSFER_CHUNK_BYTES = 192 * 1024;
