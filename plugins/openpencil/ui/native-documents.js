const nativeDocuments = (() => {
  let opening = false;
  let epoch = 0;

  function invalidate() { epoch++; }

  async function open({drawer, make, button, describe, close}) {
    const turn = ++epoch;
    describe('');
    const loading = make('p', 'Загружаем макеты…');
    drawer.replaceChildren(loading);
    const data = await nativeEditor.call('canvas_documents');
    if (turn !== epoch) return;
    describe(`${data.project.name} · Все изменения сохраняются автоматически`);
    const search = make('input');
    search.type = 'search';
    search.placeholder = 'Найти макет по названию';
    search.setAttribute('aria-label', search.placeholder);
    const notice = make('p', '', 'documents-notice');
    notice.setAttribute('role', 'status');
    const list = make('div', '', 'documents-grid');
    drawer.replaceChildren(search, notice, list, make('p', 'Макеты привязаны к папке этого чата.', 'documents-note'));

    const documents = [...data.documents].sort((a, b) =>
      Number(b.id === data.documentId) - Number(a.id === data.documentId) ||
      String(b.lastOpenedAt || b.updatedAt).localeCompare(String(a.lastOpenedAt || a.updatedAt)));

    function render() {
      list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      const matches = documents.filter(doc => doc.name.toLocaleLowerCase().includes(query));
      if (!matches.length) {
        const empty = make('div', '', 'documents-empty');
        if (query) {
          empty.append(make('strong', 'Ничего не найдено'),
            make('p', 'Попробуйте другое название.\nСписок ограничен текущим проектом.'),
            button('Сбросить поиск', () => { search.value = ''; render(); search.focus(); }));
        } else {
          empty.append(make('strong', 'В этом проекте пока нет макетов'));
        }
        list.append(empty);
      }

      for (const doc of matches) {
        const current = doc.id === data.documentId;
        const available = doc.status !== 'blocked' && (doc.status === 'available' || doc.canRecover);
        const item = make('article', '', 'document-card');
        item.dataset.current = String(current);
        item.append(make('span', 'МАКЕТ', 'document-badge'), make('strong', doc.name),
          make('small', current ? 'Открыт сейчас' : available ? doc.relativePath || 'Локальный черновик' : 'Файл недоступен'));
        const action = button(current ? 'На холсте' : 'Открыть', async () => {
          if (opening || current || !available || data.switchUncertain) return;
          opening = true;
          search.disabled = true;
          render();
          notice.textContent = 'Сохраняем текущие изменения и открываем макет…';
          try {
            await nativeEditor.switchDocument(doc.id);
            close();
          } catch (error) {
            notice.textContent = error.message;
          } finally {
            opening = false;
            search.disabled = false;
            if (turn === epoch) render();
          }
        }, 'primary');
        action.disabled = current || opening || !available || Boolean(data.switchUncertain);
        item.append(action);
        list.append(item);
      }
    }
    search.oninput = render;
    render();
  }
  return {open, invalidate};
})();
