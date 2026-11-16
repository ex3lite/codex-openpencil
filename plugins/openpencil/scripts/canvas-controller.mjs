import { NATIVE_URI, nativeHtml, nativeRequest, nativeTools } from './native-canvas.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanvasComments } from './canvas-comments.mjs';
import { CanvasAgents } from './canvas-agents.mjs';
import { startCanvasAgentBroker, callCanvasAgent } from './canvas-agent-broker.mjs';
import { workspaceTools } from './canvas-workspace-tools.mjs';
import { bindProject, attachProjectSession, projectSummary, projectDocuments, switchProjectDocument, detachProjectDocument, importProjectDocument } from './canvas-projects.mjs';
import { EditorSession } from './editor-session.mjs';
import { startPanel } from './canvas-panel.mjs';
import { forward, errorReply } from './transport.mjs';
import { readCanvasSelection } from './canvas-selection.mjs';
import { importCanvasImage } from './canvas-images.mjs';
import { prepareCanvasBrowser, browserLaunchStatus } from './browser-launch.mjs';
import { prepareCodegen, completeCodegen, pollCodegen, cancelCodegen, codegenSummary, frameworks } from './canvas-codegen.mjs';

export const CANVAS_URI = NATIVE_URI;
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const filePath = { type: 'string', description: 'Absolute .op path; omit to create or reopen this session’s canvas.' };
export const canvasTools = [
  ...workspaceTools,
  { name: 'canvas_detach_source', description: 'App-only: detach the previous save destination after a successful New/Open/import. Does not write or delete any file.',
    inputSchema: schema({}), annotations: { destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } },
  ...nativeTools,
  { name: 'open_canvas', title: 'OpenPencil Canvas', description: 'Open the editable Rust canvas entrypoint: direct full Rust/CanvasKit editor inside Codex MCP Apps. Optional filePath loads an existing .op into an isolated managed session. All subsequent OpenPencil tools target this canvas until the bridge closes. Omit the path for a new document. Returns the same local panel URL as canvas_open_browser.',
    inputSchema: schema({ filePath, projectRoot: {type:'string',description:'Absolute Codex workspace root. Required on first open; never use a global latest document.'}, documentId:{type:'string',description:'Registered document ID inside this project.'} }), annotations: { destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: CANVAS_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }], preferredModelDisplayMode: 'fullscreen' } } },
  { name: 'canvas_open_browser', description: 'Open or reconnect this chat’s managed editable canvas and return its local panelUrl. Show this URL in the Codex built-in browser with open_in_codex (browser target) or @Browser. Preserve any supplied theme/launch fragment. Use an external browser only when the user explicitly requests it. Use this when the host hides the open_canvas UI entrypoint or cannot embed local HTTP frames. All subsequent OpenPencil tools target this same canvas.',
    inputSchema: schema({ filePath, projectRoot:{type:'string'}, documentId:{type:'string'} }), annotations: { destructiveHint: false, openWorldHint: false } },
  { name: 'canvas_prepare_browser', description: 'Prepare this conversation’s existing canvas URL and short-lived ready receipt for opening through the current Codex chat. Does not launch a browser or send a message. Never accepts a URL or file path; the host controls in-app browser navigation.',
    inputSchema: { ...schema({ theme: { type: 'string', enum: ['light', 'dark'] } }), required: ['theme'] },
    annotations: { destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } },
  { name: 'canvas_launch_status', description: 'Read whether the browser canvas for this launch has actually connected.',
    inputSchema: { ...schema({ launchId: { type: 'string' } }), required: ['launchId'] },
    annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } },
  { name: 'canvas_status', description: 'Read managed canvas file, recovery path, document version and selection.', inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'canvas_selection', description: 'Read the current managed canvas selection: exact node IDs, names, types, parents, active page and document version. Call before modifying selected elements from a chat prompt; read these nodes with batch_get, then edit only their subtrees. Empty selection means no target, never the entire page.',
    inputSchema: schema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'canvas_import_image', description: 'Embed a local PNG/JPEG/WebP (at most 8 MiB) into an existing image node in the managed canvas. Reads file bytes directly without putting base64 in chat. Requires the current document version and active page; preserves node ID, geometry and unrelated nodes. Clears acquisition hints after import. Does not generate images, call a provider, or save the source .op. After import inspect the native preview, canvas_save and verify reopen; never automatically retry an uncertain write.',
    inputSchema: { ...schema({ filePath: { type: 'string', description: 'Absolute path to a local image asset.' },
      nodeId: { type: 'string', minLength: 1 }, pageId: { type: 'string', minLength: 1 },
      expectedVersion: { type: 'integer', minimum: 0 } }), required: ['filePath', 'nodeId', 'pageId', 'expectedVersion'] },
    annotations: { destructiveHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['model'] } } },
  { name: 'canvas_save', description: 'Save the managed canvas to its original path or a new absolute .op path. Refuses external changes or an existing Save As destination. UI must flush its snapshot first; never automatically retry.',
    inputSchema: schema({ filePath, docJson: { type: 'string', description: 'UI-only flushed document snapshot, used to reject stale saves.' } }),
    annotations: { destructiveHint: true, openWorldHint: false } },
  { name: 'canvas_checkpoint', description: 'Persist a recovery draft of the managed canvas without overwriting its source.', inputSchema: schema({}),
    annotations: { destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } },
  { name: 'canvas_codegen_prepare', description: 'Capture the Code panel target after flushing browser edits and export baseline source. Does not call a model or write project files.',
    inputSchema: { ...schema({ uiRequestId: { type: 'string' }, framework: { type: 'string', enum: frameworks }, pageId: { type: 'string' },
      nodeIds: { type: 'array', items: { type: 'string' } }, docJson: { type: 'string' } }), required: ['uiRequestId', 'framework', 'pageId', 'nodeIds', 'docJson'] },
    annotations: { destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } },
  { name: 'canvas_codegen_status', description: 'Read the latest Code panel conversion request, its fixed page/node IDs, design version, baseline source and handoff prompt. Use this before implementing a Code panel request; later selection changes do not change its target.',
    inputSchema: schema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'canvas_codegen_complete', description: 'Return the primary implemented source file to the Code panel preview, copy and download actions. Pass the requestId from canvas_codegen_status and an absolute codePath after implementing and verifying the project. Reads the file; never writes it or changes the design. Rejects superseded requests and changed design versions.',
    inputSchema: { ...schema({ requestId: { type: 'string' }, codePath: { type: 'string' } }), required: ['requestId', 'codePath'] },
    annotations: { destructiveHint: false, openWorldHint: false } },
  { name: 'canvas_codegen_cancel', description: 'Cancel the matching panel request without replaying a host message.', inputSchema: { ...schema({ uiRequestId: { type: 'string' } }), required: ['uiRequestId'] },
    annotations: { destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } },
  { name: 'canvas_codegen_poll', description: 'Read a changed Code panel result.', inputSchema: schema({ afterRevision: { type: 'integer' } }),
    annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } } },
];

const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

export class CanvasController {
  constructor(options = {}) { this.options = options; this.queue = Promise.resolve(); this.session = null; this.panel = null; }
  enqueue(work) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  async ensurePanel() { if (!this.panel) this.panel = await startPanel(this); return this.panel; }
  async open(args = {}) {
    const {filePath,projectRoot,documentId} = args;
    const panel = await this.ensurePanel();
    if (this.session && this.project) await bindProject(this,args);
    if (this.session && !this.project && filePath && filePath !== this.session.source && filePath !== this.session.draft) {
      throw new Error('This conversation already has a canvas. Save it, then open the other document in a new conversation.');
    }
    if (!this.session) {
      try {
      const binding = await bindProject(this, {projectRoot,documentId,filePath});
      this.session = await EditorSession.start({ filePath:binding.initialFilePath, allowOrigin: panel.origin, runtimeRoot: this.options.runtimeRoot });
      this.session.source=binding.sourcePath; this.session.baseline=binding.baseline;
      await attachProjectSession(this);
      await this.session.checkpoint();
      await this.resetDocumentServices();
      await this.options.onToolsChanged?.();
      } catch(error) {
        await this.quiesceDocumentAgents().catch(()=>{});
        if(this.session) await this.session.close().catch(()=>{});
        this.session=null;
        await this.releaseProjectLease?.();
        throw error;
      }
    } else if(!this.project && projectRoot) {
      throw Error('Холст закреплён за другим проектом. Откройте его в соответствующем чате Codex.');
    }
    this.session.assertLive();
    const value = { filePath: this.session.source, recoveryPath: this.recoveryPath(), panelUrl: panel.url, version: this.session.version,
      project:projectSummary(this),documentId:this.documentId,canvasId:this.agents?.canvasId };
    return { ...toolResult(value), _meta: { canvas: { editorOrigin: `http://127.0.0.1:${this.session.port}`,
      token: this.session.token, panelUrl: panel.url } } };
  }
  recoveryPath() { return this.project ? join(this.project.recoveryDirectory,this.documentId+'.op') : this.session.draft; }
  async resetDocumentServices() {
    await this.quiesceDocumentAgents();
    this.codegenJob=null;
    this.agents=new CanvasAgents({session:this.session});
    const agents=this.agents;
    this.agentBroker=await startCanvasAgentBroker(agents,{projectRoot:this.project.projectRoot,
      dispatch:(action,args)=>this.enqueue(()=>agents.dispatch(action,args))});
    this.comments=new CanvasComments({session:this.session,filePath:join(this.project.directory,'comments',this.documentId+'.json'),
      identity:{projectId:this.project.projectId,documentId:this.documentId,canvasId:this.agents.canvasId}});
  }
  async quiesceDocumentAgents() {
    if(this.agentBroker) {await this.agentBroker.close();this.agentBroker=null;}
    if(this.agents) {await this.agents.queue;this.agents.leases.clear();}
  }
  async call(name, args) {
    if(name==='canvas_agent') {
      const {projectRoot,canvasId,action,...operation}=args;
      if(canvasId===this.agents?.canvasId) {
        if(projectRoot!==this.project.projectRoot) throw Error('Агент назначен другому проекту.');
        return toolResult(await this.agents.dispatch(action,operation));
      }
      return toolResult(await callCanvasAgent(canvasId,action,operation,{projectRoot}));
    }
    if (name === 'canvas_native_request') return nativeRequest(this,args);
    if (name === 'open_canvas' || name === 'canvas_open_browser') return this.open(args);
    if (!this.session) throw new Error('Open a managed canvas with canvas_open_browser or open_canvas first.');
    if(this.projectSwitchUncertain && !['canvas_status','canvas_selection','canvas_documents','canvas_comments','canvas_agents'].includes(name)) throw Error('Переключение макета не подтверждено. Изменения остановлены; откройте сохранённый проект заново.');
    if(name==='canvas_documents') return toolResult(await projectDocuments(this));
    if(name==='canvas_document_open') return toolResult(await switchProjectDocument(this,args));
    if(name==='canvas_document_import') return toolResult(await importProjectDocument(this,args));
    if(name==='canvas_comment_create') return toolResult(await this.comments.create(args));
    if(name==='canvas_comments') return toolResult(await this.comments.list());
    if(name==='canvas_comment_update') return toolResult(await this.comments.update(args));
    if(name==='canvas_agents') return toolResult(this.agents.status());
    if(name==='canvas_agent_assign') return toolResult({...await this.agents.acquire(args),projectRoot:this.project.projectRoot});
    if (name === 'canvas_prepare_browser') return toolResult(prepareCanvasBrowser(this, args));
    if (name === 'canvas_launch_status') return toolResult(browserLaunchStatus(this, args));
    if (name === 'canvas_launch_ready') return toolResult(browserLaunchStatus(this, args, true));
    if (name === 'canvas_import_image') return toolResult(await importCanvasImage(this.session, args));
    if (name === 'canvas_detach_source') {
      if(this.project) return toolResult(await detachProjectDocument(this));
      this.session.source = null; this.session.baseline = null; this.codegenJob = null;
      return toolResult({ filePath: null });
    }
    if (name === 'canvas_save') return toolResult(await this.session.save(args));
    if (name === 'canvas_checkpoint') return toolResult(await this.session.checkpoint());
    if (name === 'canvas_codegen_prepare') return toolResult(await prepareCodegen(this, args));
    if (name === 'canvas_codegen_status') return toolResult(this.codegenJob || null);
    if (name === 'canvas_codegen_complete') return toolResult(await completeCodegen(this, args));
    if (name === 'canvas_codegen_cancel') return toolResult(cancelCodegen(this, args));
    if (name === 'canvas_codegen_poll') return toolResult(pollCodegen(this, args));
    const current = await readCanvasSelection(this.session);
    return toolResult({ filePath: this.session.source, recoveryPath: this.recoveryPath(), version: current.live.version, selection: current.selection, codegen: codegenSummary(this),
      project:projectSummary(this),documentId:this.documentId,canvasId:this.agents?.canvasId,agents:this.agents?.status(),comments:this.comments?await this.comments.list():[] });
  }
  async resource() {
    return { contents: [{ uri: CANVAS_URI, mimeType: 'text/html;profile=mcp-app', text: await (this.options.nativeHtmlLoader ? this.options.nativeHtmlLoader() : nativeHtml(this.options.runtimeRoot)),
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: ['blob:', 'data:'], frameDomains: [] } },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } }] };
  }
  async dispatch(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (Object.hasOwn(message, 'id') && message.id !== null && !['string','number'].includes(typeof message.id))) {
      return errorReply(null, -32600, 'Expected a JSON-RPC 2.0 request or notification.');
    }
    const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
    try {
      if (message.method === 'resources/read' && message.params?.uri === CANVAS_URI) return reply(await this.resource());
      if (message.method === 'resources/list') return reply({ resources: [{ uri: CANVAS_URI, name: 'OpenPencil Canvas', mimeType: 'text/html;profile=mcp-app' }] });
      if (message.method === 'tools/call' && canvasTools.some(tool => tool.name === message.params?.name)) {
        return reply(await this.call(message.params.name, message.params.arguments || {}));
      }
      if (this.session && message.method === 'tools/call' && message.params?.name === 'save_document') {
        if (message.params.arguments?.sourceFilePath) throw new Error('Source-copy save is unavailable while a managed canvas is active.');
        return reply(await this.call('canvas_save', message.params.arguments || {}));
      }
      if(this.session && message.method==='tools/call') {
        if(this.projectSwitchUncertain) throw Error('Переключение документа не подтверждено; откройте проект заново.');
        const name=message.params.name, args={...message.params.arguments};
        if(['open_document','new_document','spawn_agents'].includes(name)) throw Error('Use project document controls or canvas_agent_assign for this managed canvas.');
        if(args.sourceFilePath) throw Error('Source file routing is unavailable inside a project canvas.');
        if(args.filePath) {
          if(!['live://canvas','live://canvas/current',this.session.source,this.session.draft].includes(args.filePath)) throw Error('This tool can only edit the active project document. Import another document explicitly.');
          delete args.filePath;
        }
        message={...message,params:{...message.params,arguments:args}};
      }
      if(!this.session && !this.options.port && message.method==='tools/call') throw Error('Сначала откройте холст с open_canvas(projectRoot). Глобальный случайный документ не выбран.');
      const upstream = this.session ? await this.session.forward(message) : await forward(message, this.options);
      if (!Object.hasOwn(message, 'id')) return null;
      if (message.method === 'initialize') {
        const result = upstream?.result || { protocolVersion: message.params?.protocolVersion || '2025-11-25', serverInfo: { name: 'codex-openpencil', version: '0.5.0' } };
        result.capabilities = { ...result.capabilities, tools: { listChanged: true }, resources: {} };
        return reply(result);
      }
      if (message.method === 'tools/list') return reply({ ...upstream?.result, tools: [...(upstream?.result?.tools || []), ...canvasTools] });
      return upstream;
    } catch (error) {
      if (!Object.hasOwn(message, 'id')) return null;
      if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: error.message }], isError: true,
        ...(error.code ? { structuredContent: { code: error.code } } : {}) });
      return errorReply(message.id, -32000, error.message);
    }
  }
  async close() {
    await this.queue;
    await this.quiesceDocumentAgents();
    try { if (this.session) await this.session.close(); } finally {
      try { await this.releaseProjectLease?.(); } finally { if (this.panel) await this.panel.close(); }
    }
  }
}
