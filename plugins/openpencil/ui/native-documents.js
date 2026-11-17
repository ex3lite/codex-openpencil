// Project-local document navigation. Opening never sends a model message.
const nativeDocuments = (() => {
  let opening = false, epoch = 0;
  async function open({show,drawer,make,button,close}) {
    const turn = ++epoch;
    show('documents', 'Макеты проекта');
    const loading = make('p', 'Загружаем макеты…'); drawer.append(loading);
    const data = await nativeEditor.call('canvas_documents');
    if (turn !== epoch || !drawer.contains(loading)) return;
    drawer.replaceChildren();
    drawer.append(make('p', `Только макеты проекта «${data.project.name}». Изменения сохраняются автоматически.`));
    const label = make('label', 'Найти макет'); label.htmlFor = 'documents-search';
    const search = make('input'); search.id = 'documents-search'; search.type = 'search'; search.placeholder = 'Название макета';
    const notice = make('p'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live','polite');
    const list = make('div', null, 'documents-grid');
    drawer.append(label, search, notice, list);
    const documents = [...data.documents].sort((a,b) => Number(b.id===data.documentId)-Number(a.id===data.documentId) ||
      String(b.lastOpenedAt||b.updatedAt).localeCompare(String(a.lastOpenedAt||a.updatedAt)));
    function render() {
      list.replaceChildren();
      const matches = documents.filter(d=>d.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      if (!matches.length) list.append(make('p', search.value ? 'Ничего не найдено. Попробуйте другое название.' : 'В этом проекте пока нет макетов.'));
      for (const doc of matches) {
        const current = doc.id === data.documentId;
        const available = doc.status !== 'blocked' && (doc.status === 'available' || doc.canRecover);
        const item = make('article', null, 'document-card'); item.dataset.current=String(current);
        item.append(make('span', current ? 'Открыт сейчас' : 'Макет', 'document-badge'), make('strong', doc.name),
          make('small', doc.relativePath || 'Локальный черновик'));
        const action = button(current ? 'На холсте' : 'Открыть', async () => {
          if (opening || current) return;
          opening = true; render(); search.disabled = true;
          notice.textContent = 'Сохраняем текущие изменения и открываем макет…';
          try {
            await nativeEditor.switchDocument(doc.id);
            close();
          } catch (error) {
            notice.textContent = error.message;
          } finally { opening = false; search.disabled = false; render(); }
        }, current ? '' : 'primary');
        action.disabled = current || opening || !available || Boolean(data.switchUncertain);
        if (!available) item.append(make('small', 'Файл недоступен'));
        item.append(action); list.append(item);
      }
    }
    search.oninput = render; render();
  }
  return {open};
})();
