import { MAX_DOCUMENT_BYTES, DOCUMENT_ENVELOPE_BYTES } from './document-limits.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { durableWrite } from './atomic-files.mjs';

const DIRECTORY = '.openpencil';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export class ProjectCatalogError extends Error {
  constructor(code, message) { super(message); this.name = 'ProjectCatalogError'; this.code = code; }
}
const fail = (code, message) => { throw new ProjectCatalogError(code, message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
const missing = error => error?.code === 'ENOENT';
const now = () => new Date().toISOString();

async function canonicalRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('PROJECT_ROOT_REQUIRED', 'Укажите полный путь к папке проекта.');
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isDirectory()) fail('INVALID_PROJECT_ROOT', 'Корень проекта должен быть папкой.');
  return canonical;
}

// Only an explicit root or roots supplied by the MCP host can establish ownership.
// The bridge process cwd is never sufficient evidence of the user's project.
export async function resolveProjectRoot({ projectRoot, roots, resolveRoots, cwd } = {}) {
  if (projectRoot !== undefined) {
    const root = await canonicalRoot(projectRoot);
    return { projectRoot: root, projectId: hash(root).slice(0, 24), source: 'explicit' };
  }
  if (roots === undefined && resolveRoots) roots = await resolveRoots();
  if (roots !== undefined && !Array.isArray(roots)) fail('INVALID_PROJECT_ROOTS', 'Список папок проекта имеет неверный формат.');
  const candidates = [];
  for (const entry of roots || []) {
    let path;
    try {
      const url = new URL(entry?.uri);
      if (url.protocol !== 'file:' || url.search || url.hash) throw new Error();
      path = fileURLToPath(url);
    } catch { fail('INVALID_PROJECT_ROOTS', 'Список папок проекта должен содержать адреса локальных папок.'); }
    const root = await canonicalRoot(path);
    if (!candidates.includes(root)) candidates.push(root);
  }
  if (!candidates.length) fail('PROJECT_ROOT_REQUIRED', 'Codex не передал папку текущего чата. Откройте холст из сообщения в чате проекта.');
  let selected = candidates;
  if (selected.length > 1 && cwd) {
    let current;
    try { current = await canonicalRoot(cwd); } catch { /* An unknown cwd cannot select a project. */ }
    if (current) selected = selected.filter(root => inside(root, current));
  }
  if (selected.length !== 1) fail('PROJECT_ROOT_AMBIGUOUS', 'Доступно несколько проектов. Укажите нужную папку проекта.');
  return { projectRoot: selected[0], projectId: hash(selected[0]).slice(0, 24), source: 'mcp-roots' };
}

async function canonicalPath(path, allowMissing) {
  try { return await realpath(path); }
  catch (error) {
    if (!allowMissing || !missing(error)) throw error;
    try {
      if ((await lstat(path)).isSymbolicLink()) fail('UNRESOLVED_SYMBOLIC_LINK', 'Путь к документу содержит неработающую символическую ссылку. Выберите существующую папку проекта.');
    } catch (entryError) { if (!missing(entryError)) throw entryError; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent, true), basename(path));
  }
}

async function regularBytes(path, limit = MAX_DOCUMENT_BYTES) {
  if ((await lstat(path)).isSymbolicLink()) fail('INVALID_DOCUMENT', 'Сохранённый документ не может быть символической ссылкой.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail('INVALID_DOCUMENT', 'Выберите обычный файл допустимого размера.');
    const bytes = await handle.readFile();
    if (bytes.length > limit) fail('INVALID_DOCUMENT', 'Файл превышает допустимый размер.');
    return bytes;
  } finally { await handle.close(); }
}

function documentBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length > MAX_DOCUMENT_BYTES) fail('INVALID_DOCUMENT', 'Размер документа OpenPencil не должен превышать 256 МиБ.');
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch { fail('INVALID_DOCUMENT', 'Документ OpenPencil содержит некорректный JSON.'); }
  if (!document || Array.isArray(document) || typeof document !== 'object' ||
      (!Array.isArray(document.children) && !Array.isArray(document.pages))) {
    fail('INVALID_DOCUMENT', 'В документе OpenPencil отсутствует список слоёв или страниц.');
  }
  return bytes;
}

const displayName = (name, path) => {
  if (name === undefined) return path ? basename(path) : 'Без названия';
  if (typeof name !== 'string' || !name.trim() || name.length > 200) fail('INVALID_DOCUMENT_NAME', 'Название документа должно содержать от 1 до 200 символов.');
  return name.trim();
};
const safeRelative = value => typeof value === 'string' && value.length > 0 &&
  !isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '..' || part === '' || part === '.') && !value.includes('\0');

export class ProjectCatalog {
  static async open(options = {}) {
    const binding = await resolveProjectRoot(options);
    const catalog = new ProjectCatalog(binding);
    await catalog.ensureDirectories();
    try { await catalog.readManifest(); }
    catch (error) {
      if (!missing(error)) throw error;
      await catalog.mutate(() => {});
    }
    return catalog;
  }

  constructor(binding) {
    this.projectRoot = binding.projectRoot;
    this.projectId = binding.projectId;
    this.bindingSource = binding.source;
    this.directory = join(this.projectRoot, DIRECTORY);
    this.catalogPath = join(this.directory, 'catalog.json');
    this.recoveryDirectory = join(this.directory, 'recovery');
  }

  async ensureDirectories() {
    if (await realpath(this.projectRoot) !== this.projectRoot) fail('PROJECT_ROOT_CHANGED', 'Папка проекта изменилась. Выберите проект заново перед продолжением.');
    for (const path of [this.directory, this.recoveryDirectory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path) {
        fail('UNSAFE_CATALOG_PATH', 'Служебные папки проекта и восстановления не могут быть символическими ссылками.');
      }
    }
  }

  async resolveDocumentPath(filePath, { allowMissing = false } = {}) {
    if (typeof filePath !== 'string' || !isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.op')) {
      fail('INVALID_DOCUMENT_PATH', 'Укажите полный путь к файлу .op внутри этого проекта.');
    }
    const path = await canonicalPath(filePath, allowMissing);
    if (!inside(this.projectRoot, path) || path === this.projectRoot) {
      fail('DOCUMENT_OUTSIDE_PROJECT', 'Документ находится за пределами выбранного проекта. Импортируйте его копию в этот проект.');
    }
    if (inside(this.directory, path)) fail('CATALOG_PATH_RESERVED', 'Сохраните макет в обычную папку проекта, вне служебной папки .openpencil.');
    try {
      if (!(await lstat(path)).isFile()) fail('INVALID_DOCUMENT_PATH', 'Путь к документу должен указывать на обычный файл.');
    } catch (error) { if (!allowMissing || !missing(error)) throw error; }
    return path;
  }

  async validateSavePath(filePath) {
    await this.ensureDirectories();
    return this.resolveDocumentPath(filePath, { allowMissing: true });
  }

  emptyManifest() {
    return { schemaVersion: 1, projectId: this.projectId, projectRoot: this.projectRoot, documents: [] };
  }

  validateManifest(value) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.documents)) fail('INVALID_CATALOG', 'Каталог макетов проекта повреждён. Сохраните его копию и восстановите каталог перед продолжением.');
    if (value.projectRoot !== this.projectRoot || value.projectId !== this.projectId) fail('PROJECT_CATALOG_MISMATCH', 'Этот каталог макетов принадлежит другой папке проекта. Импортируйте нужные документы в текущий проект.');
    const ids = new Set(), paths = new Set();
    for (const entry of value.documents) {
      if (!entry || !UUID.test(entry.id) || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200 ||
          typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string' ||
          (entry.relativePath !== null && (!safeRelative(entry.relativePath) || !entry.relativePath.toLowerCase().endsWith('.op') || paths.has(entry.relativePath))) ||
          (entry.recovery !== null && (!entry.recovery || entry.recovery.relativePath !== `recovery/${entry.id}.op` ||
            typeof entry.recovery.updatedAt !== 'string' || (entry.recovery.sourceHash !== null && !HASH.test(entry.recovery.sourceHash))))) {
        fail('INVALID_CATALOG', 'Каталог проекта содержит некорректные сведения о документах.');
      }
      ids.add(entry.id);
      if (entry.relativePath !== null) paths.add(entry.relativePath);
    }
    return value;
  }

  async readManifest() {
    await this.ensureDirectories();
    let value;
    try { value = JSON.parse((await regularBytes(this.catalogPath, MAX_MANIFEST_BYTES)).toString('utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) fail('INVALID_CATALOG', 'Каталог проекта содержит некорректный JSON. Файлы не изменены.');
      throw error;
    }
    return this.validateManifest(value);
  }

  async atomicWrite(path, bytes) {
    await durableWrite(path, bytes);
  }

  async mutate(change) {
    await this.ensureDirectories();
    const lockPath = join(this.directory, 'catalog.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') fail('CATALOG_BUSY', 'Другой редактор обновляет каталог проекта. Повторите действие после его завершения. После сбоя мог остаться файл .openpencil/catalog.lock.');
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }) + '\n');
      let manifest;
      try { manifest = await this.readManifest(); }
      catch (error) { if (!missing(error)) throw error; manifest = this.emptyManifest(); }
      const result = await change(manifest);
      this.validateManifest(manifest);
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      if (bytes.length > MAX_MANIFEST_BYTES) fail('CATALOG_FULL', 'Каталог макетов проекта превышает допустимый размер.');
      await this.atomicWrite(this.catalogPath, bytes);
      return result;
    } finally { await lock.close(); await rm(lockPath, { force: true }); }
  }

  findEntry(manifest, documentId) {
    const entry = manifest.documents.find(item => item.id === documentId);
    if (!entry) fail('DOCUMENT_NOT_FOUND', 'Выберите документ из списка макетов этого проекта.');
    return entry;
  }

  async summary(entry) {
    const path = entry.relativePath === null ? null : join(this.projectRoot, entry.relativePath);
    let status = path ? 'available' : 'untitled';
    if (path) {
      try {
        if (await this.resolveDocumentPath(path) !== path) fail('DOCUMENT_PATH_CHANGED', 'Сохранённый путь документа теперь указывает на другой файл. Выберите или импортируйте нужный документ заново.');
      }
      catch (error) {
        if (missing(error)) status = 'missing';
        else if (['DOCUMENT_OUTSIDE_PROJECT', 'DOCUMENT_PATH_CHANGED'].includes(error.code)) status = 'blocked';
        else throw error;
      }
    }
    const recoveryPath = entry.recovery ? join(this.directory, entry.recovery.relativePath) : null;
    let canRecover = false;
    if (recoveryPath) {
      try { const stat = await lstat(recoveryPath); canRecover = stat.isFile() && !stat.isSymbolicLink(); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return { id: entry.id, name: entry.name, path, relativePath: entry.relativePath,
      status, recoveryPath: canRecover ? recoveryPath : null, canRecover,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, lastOpenedAt: entry.lastOpenedAt || null };
  }

  async listDocuments() {
    const manifest = await this.readManifest();
    return { projectId: this.projectId, projectRoot: this.projectRoot,
      documents: await Promise.all(manifest.documents.map(entry => this.summary(entry))) };
  }

  async getDocument(documentId) {
    return this.summary(this.findEntry(await this.readManifest(), documentId));
  }

  async registerDocument({ filePath = null, name } = {}) {
    const path = filePath === null ? null : await this.resolveDocumentPath(filePath);
    if (path) documentBytes(await regularBytes(path));
    const relativePath = path === null ? null : relative(this.projectRoot, path);
    const entry = await this.mutate(manifest => {
      let item = relativePath === null ? null : manifest.documents.find(value => value.relativePath === relativePath);
      if (!item) {
        const timestamp = now();
        item = { id: randomUUID(), name: displayName(name, path), relativePath,
          createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: timestamp, recovery: null };
        manifest.documents.push(item);
      } else { item.lastOpenedAt = now(); if (name !== undefined) item.name = displayName(name, path); }
      return item;
    });
    return this.summary(entry);
  }

  async bindDocument({ documentId, filePath, name } = {}) {
    const path = await this.resolveDocumentPath(filePath);
    documentBytes(await regularBytes(path));
    const relativePath = relative(this.projectRoot, path);
    const entry = await this.mutate(manifest => {
      const item = this.findEntry(manifest, documentId);
      if (manifest.documents.some(other => other.id !== documentId && other.relativePath === relativePath)) fail('DOCUMENT_ALREADY_REGISTERED', 'Этот путь уже закреплён за другим документом проекта.');
      item.relativePath = relativePath; item.name = displayName(name, path); item.updatedAt = now();
      return item;
    });
    return this.summary(entry);
  }

  async writeRecovery({ documentId, bytes, sourceHash = null } = {}) {
    const data = documentBytes(bytes);
    if (sourceHash !== null && !HASH.test(sourceHash)) fail('INVALID_SOURCE_HASH', 'Контрольная сумма исходного файла для восстановления должна иметь формат SHA-256.');
    const entry = await this.mutate(async manifest => {
      const item = this.findEntry(manifest, documentId);
      const relativePath = `recovery/${item.id}.op`;
      await this.atomicWrite(join(this.directory, relativePath), data);
      item.recovery = { relativePath, sourceHash, updatedAt: now() }; item.updatedAt = item.recovery.updatedAt;
      return item;
    });
    return this.summary(entry);
  }

  async recordRecovery({ documentId, recoveryPath, sourceHash = null } = {}) {
    if (typeof recoveryPath !== 'string' || !isAbsolute(recoveryPath)) fail('INVALID_RECOVERY_PATH', 'Укажите полный путь к файлу восстановления.');
    return this.writeRecovery({ documentId, bytes: await regularBytes(recoveryPath), sourceHash });
  }

  async reopenDocument(documentId, { preferRecovery = true } = {}) {
    const entry = this.findEntry(await this.readManifest(), documentId);
    const storedPath = entry.relativePath === null ? null : join(this.projectRoot, entry.relativePath);
    const sourcePath = storedPath === null ? null : await this.resolveDocumentPath(storedPath, { allowMissing: true });
    if (sourcePath !== storedPath) fail('DOCUMENT_PATH_CHANGED', 'Сохранённый путь документа теперь указывает на другой файл. Выберите или импортируйте нужный документ заново.');
    if (preferRecovery && entry.recovery) {
      const recoveryPath = join(this.directory, entry.recovery.relativePath);
      documentBytes(await regularBytes(recoveryPath));
      return { documentId, filePath: recoveryPath, sourcePath, baseline: entry.recovery.sourceHash, recovered: true };
    }
    if (!sourcePath) fail('DOCUMENT_HAS_NO_RECOVERY', 'У этого документа без названия ещё нет черновика для восстановления.');
    const bytes = documentBytes(await regularBytes(sourcePath));
    return { documentId, filePath: sourcePath, sourcePath, baseline: hash(bytes), recovered: false };
  }

  async importDocument({ sourcePath, filePath, name } = {}) {
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || !sourcePath.toLowerCase().endsWith('.op')) fail('INVALID_DOCUMENT_PATH', 'Укажите полный путь к исходному файлу .op для импорта.');
    const source = await realpath(sourcePath);
    const bytes = documentBytes(await regularBytes(source));
    const destination = await this.validateSavePath(filePath);
    if (source === destination) fail('IMPORT_REQUIRES_COPY', 'Выберите другой путь для импортируемой копии.');
    displayName(name, destination);
    const entry = await this.mutate(async manifest => {
      const relativePath = relative(this.projectRoot, destination);
      if (manifest.documents.some(item => item.relativePath === relativePath)) fail('DOCUMENT_ALREADY_REGISTERED', 'Файл назначения уже зарегистрирован в этом проекте.');
      let handle;
      try { handle = await open(destination, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('IMPORT_DESTINATION_EXISTS', 'Файл назначения уже существует. Выберите другое имя; существующий файл не изменён.'); throw error; }
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const timestamp = now();
      const item = { id: randomUUID(), name: displayName(name, destination), relativePath,
        createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: timestamp, recovery: null };
      manifest.documents.push(item);
      return item;
    });
    return this.summary(entry);
  }
}
