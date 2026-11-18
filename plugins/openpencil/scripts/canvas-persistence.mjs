import { readFile } from 'node:fs/promises';
import { CanvasHistory } from './canvas-history.mjs';
import { sha256 } from './editor-runtime.mjs';
import { sourceBytes, validateDocument } from './editor-session.mjs';
import { diskDocument, snapshotMatches } from './document-format.mjs';

/** Owns one document only. Uncertain writes stop until explicit recovery/reopen. */
export class CanvasPersistence {
  constructor(controller, { debounceMs = 700, historyMs = 2000, maxWaitMs = 2000 } = {}) {
    this.controller = controller; this.session = controller.session; this.documentId = controller.documentId;
    this.maxWaitMs = maxWaitMs; this.debounceMs = debounceMs; this.historyMs = historyMs;
    this.history = new CanvasHistory({ catalog: controller.project, documentId: this.documentId });
    this.state = 'pending'; this.queue = Promise.resolve(); this.disposed = false;
  }
  assertCurrent() {
    if (this.disposed || this.controller.documentId !== this.documentId || this.controller.projectSwitchUncertain) {
      throw Object.assign(new Error('Persistence stopped because the active document changed or its write is uncertain.'), { code: 'AUTOSAVE_STOPPED' });
    }
  }
  status() {
    const failure = this.error || this.rejection?.error;
    return { state: this.error ? 'error' : this.state, filePath: this.session.source,
      savedAt: this.savedAt || null, lastSavedVersion: this.lastSavedVersion ?? null,
      ...(failure && { error: failure.message, code: failure.code || 'AUTOSAVE_FAILED',
        recoverable: !this.error }) };
  }
  enqueue(work) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  async initialize() {
    return this.enqueue(async () => {
      this.assertCurrent();
      try {
        if (this.session.source) await this.history.record(await sourceBytes(this.session.source), { source: 'initial' });
        return await this.persist();
      } catch (error) { this.fail(error); throw error; }
    });
  }
  changed() {
    if (this.error || this.disposed) return;
    this.state = 'pending'; clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.enqueue(() => this.flush()).catch(() => {}), this.debounceMs);
    this.timer.unref?.();
    this.deadline ??= setTimeout(() => this.controller.enqueue(() => this.flush()).catch(() => {}), this.maxWaitMs);
    this.deadline.unref?.();
  }
  fail(error) { this.error = error; this.state = 'error'; clearTimeout(this.timer); clearTimeout(this.deadline); this.deadline=null; clearTimeout(this.historyTimer); clearTimeout(this.historyDeadline); this.historyDeadline=null; }
  async persist({ docJson, source = 'edit', restoredFrom, forceHistory = false } = {}) {
    this.assertCurrent();
    if (this.error) throw this.error;
    try {
      const live = await this.session.document();
      // A checkpoint for the rejected revision is not a new edit. Do not turn
      // it into an automatic retry; an explicit agent recovery can present a verified fresh snapshot.
      if (docJson === undefined && this.rejection?.version === live.version) {
        this.state = 'snapshot-rejected'; throw this.rejection.error;
      }
      if (docJson !== undefined && !snapshotMatches(validateDocument(docJson), live)) {
        throw Object.assign(new Error('Canvas changed before autosave. No file was written; synchronize the canvas before saving again.'),
          { code: 'DOCUMENT_SNAPSHOT_STALE', writeAttempted: false, version: live.version });
      }
      const bytes = Buffer.from(JSON.stringify(diskDocument(live), null, 2) + '\n');
      const hash = sha256(bytes);
      if (hash !== this.savedHash || !this.session.source) {
        // Keep one canonical disk representation across App and agent autosaves.
        const result = await this.session.save({ docJson: bytes.toString('utf8') });
        this.savedHash = result.sha256; this.savedAt = new Date().toISOString(); this.lastSavedVersion = result.version;
      } else if (sha256(await sourceBytes(this.session.source)) !== this.session.baseline) {
        throw Object.assign(new Error('Source changed outside this canvas. Autosave stopped.'), { code: 'SOURCE_CHANGED' });
      }
      this.rejection = null; this.state = 'saved';
      const historyBytes = await readFile(this.session.source);
      const changedHistory = this.pendingHistory ? sha256(this.pendingHistory.bytes) !== sha256(historyBytes) : true;
      this.pendingHistory = { bytes: historyBytes, version: this.lastSavedVersion, source, restoredFrom };
      if (forceHistory || !(await this.history.list()).entries.length) await this.commitHistory(forceHistory);
      else if (changedHistory || !this.historyTimer) {
        clearTimeout(this.historyTimer);
        this.historyTimer = setTimeout(() => this.controller.enqueue(() => this.enqueue(() => this.commitHistory())).catch(error => this.fail(error)), this.historyMs);
        this.historyTimer.unref?.();
        this.historyDeadline ??= setTimeout(() => this.controller.enqueue(() => this.enqueue(() => this.commitHistory())).catch(error => this.fail(error)), 10000);
        this.historyDeadline.unref?.();
      }
      return { ...this.session.lastSave, filePath: this.session.source, sha256: this.savedHash,
        version: this.lastSavedVersion, documentId: this.documentId, autosave: this.status() };
    } catch (error) {
      if (error.code === 'DOCUMENT_SNAPSHOT_STALE' && error.writeAttempted === false) {
        this.rejection = { error, version: error.version };
        this.state = 'snapshot-rejected'; clearTimeout(this.timer); clearTimeout(this.deadline); this.deadline=null;
      } else this.fail(error);
      throw error;
    }
  }
  async commitHistory(force = false) {
    this.assertCurrent(); if (this.error) throw this.error;
    clearTimeout(this.historyTimer); clearTimeout(this.historyDeadline); this.historyDeadline=null; this.historyTimer = null;
    await this.controller.projectWriterLeases?.get(this.documentId)?.assertOwned();
    if (!this.pendingHistory) return this.history.list();
    const pending = this.pendingHistory;
    const result = await this.history.record(pending.bytes, { ...pending, force });
    this.pendingHistory = null; return result;
  }
  retryAccess(documentId, docJson) {
    return this.enqueue(async () => {
      this.assertCurrent();
      if (documentId !== this.documentId || typeof docJson !== 'string') throw Error('Обновите состояние текущего макета.');
      if (!['EACCES', 'EPERM'].includes(this.error?.code) || this.error.uncertain) {
        throw Error('Повтор доступен только после отказа в доступе к папке проекта.');
      }
      await this.controller.projectWriterLeases?.get(documentId)?.assertOwned();
      // persist rechecks the live snapshot and disk baseline before publication.
      this.error = null;
      return this.persist({ docJson, forceHistory: true });
    });
  }
  flush(args = {}) {
    clearTimeout(this.timer); clearTimeout(this.deadline); this.deadline=null;
    return this.enqueue(() => this.persist(args));
  }
  async boundary() { await this.flush(); return this.enqueue(() => this.commitHistory()); }
  async list() {
    const value = await this.history.list();
    return { ...value, documentId: this.documentId, filePath: this.session.source, autosave: this.status() };
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); clearTimeout(this.deadline); this.deadline=null; clearTimeout(this.historyTimer); clearTimeout(this.historyDeadline); this.historyDeadline=null; }
}
