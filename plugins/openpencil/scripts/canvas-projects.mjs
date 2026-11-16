import { newDesignDocument } from './design-system-preset.mjs';
import { nativeDocumentHttp } from './native-document-http.mjs';
import { MAX_DOCUMENT_BYTES, DOCUMENT_ENVELOPE_BYTES } from './document-limits.mjs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ProjectCatalog, resolveProjectRoot } from './project-catalog.mjs';
import { sourceBytes, validateDocument } from './editor-session.mjs';
import { transportDocument, snapshotMatches } from './document-format.mjs';
import { acquireProjectWriter } from './project-writer-lease.mjs';

const attached = Symbol('project-session');
const emptyDocument = newDesignDocument;
const fail = (code, message) => Object.assign(new Error(message), { code });
const unknownSwitch = () => fail('PROJECT_SWITCH_UNCERTAIN', 'Редактор не подтвердил переключение. Откройте документ заново и проверьте холст перед следующими изменениями.');

function requireProject(controller) {
  if (!controller.project) throw fail('PROJECT_ROOT_REQUIRED', 'Сначала выберите папку проекта.');
  if (controller.projectSwitchUncertain) throw unknownSwitch();
  return controller.project;
}

function requireSession(controller) {
  requireProject(controller);
  if (!controller.session) throw fail('CANVAS_REQUIRED', 'Сначала откройте холст проекта.');
  controller.session.assertLive();
  return controller.session;
}

async function assertNoAgents(controller) {
  const status = await controller.agents?.status?.();
  if (status?.active || status?.agents?.length) throw fail('PROJECT_AGENTS_ACTIVE', 'Завершите работу агентов перед переключением документа.');
}

async function acquireWriter(controller, catalog, documentId) {
  controller.projectWriterLeases ||= new Map();
  if (!controller.releaseProjectLease) controller.releaseProjectLease = async () => {
    const failures = [];
    for (const id of [...controller.projectWriterLeases.keys()]) {
      try { await releaseWriter(controller, id); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  };
  let lease = controller.projectWriterLeases.get(documentId);
  if (lease) await lease.assertOwned();
  else {
    lease = await acquireProjectWriter(catalog, documentId);
    controller.projectWriterLeases.set(documentId, lease);
  }
  return lease;
}

async function releaseWriter(controller, documentId) {
  const lease = controller.projectWriterLeases?.get(documentId);
  if (!lease) return;
  await lease.release(); controller.projectWriterLeases.delete(documentId);
}

export async function assertCurrentWriter(controller) {
  const lease = controller.projectWriterLeases?.get(controller.documentId);
  if (!lease) throw fail('PROJECT_WRITER_REQUIRED', 'Документ не закреплён за этим сеансом. Откройте его заново.');
  await lease.assertOwned();
}

export function projectSummary(controller) {
  if (!controller.project) return null;
  return { projectId: controller.project.projectId, projectRoot: controller.project.projectRoot,
    name: basename(controller.project.projectRoot) || controller.project.projectRoot };
}

export async function bindProject(controller, { projectRoot, documentId, filePath } = {}) {
  const existing = controller.project;
  if (controller.projectSwitchUncertain) throw unknownSwitch();
  if (existing && projectRoot !== undefined) {
    const selected = await resolveProjectRoot({ projectRoot });
    if (selected.projectId !== existing.projectId) throw fail('PROJECT_ALREADY_BOUND', 'Этот холст закреплён за другим проектом. Откройте новый холст для другой папки.');
  }
  if (existing && controller.session) {
    if ((documentId && documentId !== controller.documentId) ||
        (filePath && await existing.resolveDocumentPath(filePath) !== controller.session.source)) {
      throw fail('DOCUMENT_ALREADY_OPEN', 'Выберите другой документ через список проекта: текущие изменения сначала сохранятся в черновик.');
    }
    return controller.projectBinding;
  }
  if (documentId && filePath) throw fail('DOCUMENT_SELECTION_AMBIGUOUS', 'Укажите документ из списка или путь к файлу.');
  const catalog = existing || await ProjectCatalog.open({
    projectRoot: projectRoot ?? controller.options?.projectRoot,
    roots: controller.options?.roots, resolveRoots: controller.options?.resolveRoots, cwd: controller.options?.cwd,
  });
  let selection;
  if (!documentId) {
    const entry = await catalog.registerDocument({ filePath: filePath || null });
    documentId = entry.id;
    if (!filePath) selection = { filePath: null, sourcePath: null, baseline: null };
  }
  await acquireWriter(controller, catalog, documentId);
  try { selection ||= await catalog.reopenDocument(documentId); }
  catch (error) { await releaseWriter(controller, documentId); throw error; }
  const binding = { initialFilePath: selection.filePath, sourcePath: selection.sourcePath,
    baseline: selection.baseline, documentId };
  controller.project = catalog; controller.documentId = documentId; controller.projectBinding = binding;
  return binding;
}

async function persistRecovery(controller, result) {
  const entry = await controller.project.recordRecovery({ documentId: controller.documentId,
    recoveryPath: controller.session.draft, sourceHash: controller.session.baseline });
  return { ...result, recoveryPath: entry.recoveryPath, documentId: controller.documentId, project: projectSummary(controller) };
}

export function attachProjectSession(controller) {
  const session = requireSession(controller);
  if (session[attached]) return;
  const binding = controller.projectBinding;
  if (!binding || !controller.documentId) throw fail('DOCUMENT_NOT_BOUND', 'Документ не закреплён за проектом.');
  session.source = binding.sourcePath; session.baseline = binding.baseline;
  const checkpoint = session.checkpoint.bind(session), save = session.save.bind(session);
  let saving = false;
  session.checkpoint = async () => {
    requireProject(controller);
    await assertCurrentWriter(controller);
    const result = await checkpoint();
    if (saving) return result;
    const recovery = await persistRecovery(controller, result);
    controller.persistence?.changed();
    return recovery;
  };
  session.save = async (args = {}) => {
    const catalog = requireProject(controller);
    await assertCurrentWriter(controller);
    const entry = await catalog.getDocument(controller.documentId);
    const title = entry.name === 'Без названия' ? 'untitled' : entry.name.replace(/\.op$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100);
    const requested = args.filePath || session.source || join(catalog.projectRoot, `${title || 'untitled'}-${controller.documentId.slice(0, 8)}.op`);
    let path = await catalog.validateSavePath(requested);
    if (!args.filePath && session.source && path !== session.source) throw fail('SOURCE_PATH_CHANGED', 'Путь исходного файла изменился. Выберите новый путь сохранения явно.');
    const { documents } = await catalog.listDocuments();
    if (documents.some(entry => entry.id !== controller.documentId && entry.path === path)) throw fail('DOCUMENT_ALREADY_REGISTERED', 'Этот файл принадлежит другому документу проекта. Выберите другое имя.');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    path = await catalog.validateSavePath(path);
    let result;
    saving = true;
    try { result = await save({ ...args, filePath: path }); }
    finally { saving = false; }
    await catalog.bindDocument({ documentId: controller.documentId, filePath: path });
    controller.projectBinding = { initialFilePath: path, sourcePath: path, baseline: session.baseline, documentId: controller.documentId };
    await persistRecovery(controller, {});
    return { ...result, documentId: controller.documentId, project: projectSummary(controller) };
  };
  session[attached] = true;
}

export async function projectDocuments(controller) {
  if (!controller.project) throw fail('PROJECT_ROOT_REQUIRED', 'Сначала выберите папку проекта.');
  const { documents } = await controller.project.listDocuments();
  return { project: projectSummary(controller), documentId: controller.documentId || null, documents,
    ...(controller.projectSwitchUncertain ? { switchUncertain: true } : {}) };
}

export async function writeReplacement(controller, document, baseVersion) {
  const session = controller.session;
  const body = JSON.stringify({ document: transportDocument(document), baseVersion,
    activePageIndex: document.editorMeta?.activePageIndex ?? 0,
    preserveAuthoredGeometry: document.editorMeta?.preserveAuthoredGeometry ?? true,
    ...(document.editorMeta?.scenario != null ? { scenario: document.editorMeta.scenario } : {}) });
  if (Buffer.byteLength(body) > DOCUMENT_ENVELOPE_BYTES) throw fail('DOCUMENT_TOO_LARGE', 'Документ превышает 256 МиБ.');
  let response, value;
  try {
    response = await nativeDocumentHttp(session.port, { method: 'POST', token: session.token, body });
    value = await response.json();
  } catch {
    controller.projectSwitchUncertain = true;
    controller.persistence?.fail(unknownSwitch());
    throw unknownSwitch();
  }
  if (response.status === 409) throw fail('VERSION_CONFLICT', 'Холст изменился во время переключения. Обновите документ и выберите его заново.');
  if (!response.ok || value.ok !== true) {
    if (response.status >= 500) { controller.projectSwitchUncertain = true; controller.persistence?.fail(unknownSwitch()); throw unknownSwitch(); }
    throw fail('DOCUMENT_SWITCH_REJECTED', 'Редактор отклонил переключение документа. Текущий документ остаётся закреплён за проектом.');
  }
  if (!Number.isSafeInteger(value.version) || value.version < baseVersion) {
    controller.projectSwitchUncertain = true; controller.persistence?.fail(unknownSwitch()); throw unknownSwitch();
  }
  return value.version;
}

export async function switchProjectDocument(controller, { documentId, create = false, docJson, name } = {}) {
  const session = requireSession(controller), catalog = controller.project;
  await assertCurrentWriter(controller);
  if (create && documentId) throw fail('DOCUMENT_SELECTION_AMBIGUOUS', 'Создайте новый документ или выберите существующий.');
  if (!create && !documentId) throw fail('DOCUMENT_NOT_FOUND', 'Выберите документ в этом проекте.');
  if (!create && documentId === controller.documentId) {
    const live = await session.document(), entry = await catalog.getDocument(documentId);
    return { ...await projectDocuments(controller), filePath: session.source,
      recoveryPath: entry.recoveryPath, version: live.version };
  }
  await assertNoAgents(controller);
  if (typeof docJson !== 'string') throw fail('DOCUMENT_SNAPSHOT_REQUIRED', 'Перед переключением дождитесь синхронизации текущего холста.');
  const live = await session.document();
  if (!snapshotMatches(validateDocument(docJson), live)) throw fail('DOCUMENT_SNAPSHOT_STALE', 'Холст изменился. Дождитесь синхронизации и выберите документ заново.');
  const previousId = controller.documentId;
  let target, document, acquired = false, confirmed = false;
  try {
    if (!create) {
      await acquireWriter(controller, catalog, documentId); acquired = true;
      target = await catalog.reopenDocument(documentId);
      document = validateDocument(await sourceBytes(target.filePath));
    }
    await controller.persistence?.boundary();
    await session.checkpoint();
    if (create) {
      const entry = await catalog.registerDocument({ name }); documentId = entry.id;
      await acquireWriter(controller, catalog, documentId); acquired = true;
      document = emptyDocument();
      await catalog.writeRecovery({ documentId, bytes: JSON.stringify(document) });
      target = { sourcePath: null, baseline: null };
    }
    const version = await writeReplacement(controller, document, live.version);
    confirmed = true;
    controller.documentId = documentId;
    session.source = target.sourcePath; session.baseline = target.baseline; session.selectionSnapshot = null;
    controller.projectBinding = { initialFilePath: target.filePath || null, sourcePath: target.sourcePath,
      baseline: target.baseline, documentId };
    await controller.resetDocumentServices?.();
    await session.checkpoint();
    return { ...await projectDocuments(controller), filePath: session.source, recoveryPath: (await catalog.getDocument(documentId)).recoveryPath, version };
  } finally {
    if (confirmed) await releaseWriter(controller, previousId);
    else if (acquired && !controller.projectSwitchUncertain) await releaseWriter(controller, documentId);
  }
}

// The native replacement event must be queued before its subsequent document POST.
// At this point the daemon still has the old document; the browser has the new one.
export async function detachProjectDocument(controller, { name } = {}) {
  const session = requireSession(controller);
  await assertCurrentWriter(controller);
  if (controller.quiesceDocumentAgents) await controller.quiesceDocumentAgents();
  else await assertNoAgents(controller);
  await controller.persistence?.boundary();
  await session.checkpoint();
  const entry = await controller.project.registerDocument({ name });
  await acquireWriter(controller, controller.project, entry.id);
  const previousId = controller.documentId;
  controller.documentId = entry.id; session.source = null; session.baseline = null; session.selectionSnapshot = null;
  controller.projectBinding = { initialFilePath: null, sourcePath: null, baseline: null, documentId: entry.id };
  try { await controller.resetDocumentServices?.({ deferPersistence: true }); }
  finally { await releaseWriter(controller, previousId); }
  return { filePath: null, documentId: entry.id, project: projectSummary(controller) };
}

export async function importProjectDocument(controller, { sourcePath, filePath, name, docJson } = {}) {
  const catalog = requireProject(controller);
  if (typeof sourcePath !== 'string') throw fail('INVALID_DOCUMENT_PATH', 'Выберите исходный файл .op для импорта.');
  let destination = filePath;
  if (!destination) {
    destination = join(catalog.projectRoot, basename(sourcePath));
    await catalog.validateSavePath(destination);
    try {
      await lstat(destination);
      destination = join(dirname(destination), `${basename(sourcePath, '.op')}-${randomUUID().slice(0, 8)}.op`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  destination = await catalog.validateSavePath(destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const imported = await catalog.importDocument({ sourcePath, filePath: destination, name });
  const result = docJson === undefined ? await projectDocuments(controller)
    : await switchProjectDocument(controller, { documentId: imported.id, docJson });
  return { ...result, imported };
}
