import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sameSelection } from './canvas-selection.mjs';
import { snapshotMatches } from './document-format.mjs';

// Comments capture a fixed target. A later selection never retargets feedback.
export class CanvasComments {
  constructor({ session, filePath, identity }) {
    Object.assign(this, { session, filePath, identity });
  }
  async list() {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(data) || data.some(c => c.documentId !== this.identity.documentId)) throw Error('Invalid comment journal');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async persist(comments) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = this.filePath + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(comments, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, this.filePath);
  }
  async create({ requestId, text, pageId, nodeIds, expectedVersion, docJson }) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) throw Error('Invalid comment request ID');
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw Error('Напишите комментарий длиной до 8000 символов.');
    const comments = await this.list(), existing = comments.find(c => c.id === requestId);
    if (existing) {
      if (existing.text !== text.trim() || !sameSelection(existing, { pageId, nodeIds })) throw Error('Этот ID уже принадлежит другому комментарию.');
      return existing;
    }
    if (comments.length >= 500) throw Error('В документе уже 500 комментариев.');
    const live=await this.session.document();
    if(!Array.isArray(nodeIds)||!nodeIds.length||nodeIds.length>100||nodeIds.some(id=>typeof id!=='string')||new Set(nodeIds).size!==nodeIds.length)throw Error('Некорректная цель комментария.');
    const pages=live.document.pages;
    const page=pages?.length?pages.find(page=>page.id===pageId):pageId==='0'?live.document:null;
    if(!page)throw Error('Страница закреплённого элемента больше не существует.');
    const index=new Map(),stack=[{children:page.children||[],parentId:null}];
    while(stack.length){const {children,parentId}=stack.pop();for(const node of children){
      index.set(node.id,{id:node.id,name:node.name||node.type,type:node.type,parentId});
      if(node.children?.length)stack.push({children:node.children,parentId:node.id});
    }}
    if(nodeIds.some(id=>!index.has(id)))throw Error('Закреплённый слой больше не существует.');
    if (live.version !== expectedVersion || !snapshotMatches(JSON.parse(docJson), live)) throw Error('Макет изменился. Обновите цель комментария перед отправкой.');
    const comment = { id: requestId, ...this.identity, version: live.version, pageId, nodeIds: [...nodeIds],
      nodes: nodeIds.map(id=>index.get(id)), text: text.trim(), status: 'draft', createdAt: new Date().toISOString() };
    comments.push(comment); await this.persist(comments); return comment;
  }
  async update({ commentId, status }) {
    if (!['sent', 'uncertain', 'resolved'].includes(status)) throw Error('Invalid comment status');
    const comments = await this.list(), comment = comments.find(c => c.id === commentId);
    if (!comment) throw Error('Комментарий не найден в этом документе.');
    if (comment.status === 'resolved' && status !== 'resolved') throw Error('Комментарий уже завершён.');
    comment.status = status; comment.updatedAt = new Date().toISOString();
    await this.persist(comments); return comment;
  }
}
