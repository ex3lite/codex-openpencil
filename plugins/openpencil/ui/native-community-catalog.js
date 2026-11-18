// Remote catalog queries and originals stay in MCP. The one library search box
// drives both scopes, including the search and recovery actions below.
const nativeCommunityCatalog = (() => {
  async function section({drawer, make, button, onAcquire, onLocal, focusQuery}) {
    const section = make('section', null, 'community-catalog');
    const announcement = make('div', null, 'community-announcement');
    announcement.setAttribute('role', 'status');
    const results = make('div', null, 'library-grid');
    section.append(announcement, results);
    drawer.append(section);
    let serial = 0;
    const title = 'Figma Community';
    function close() {
      ++serial;
      results.replaceChildren();
      if (onLocal) return onLocal();
    }
    function state(options) {
      announcement.textContent = '';
      results.replaceChildren(nativeLibraryState({make, button}, {title, onClose:close, ...options}));
    }
    async function search(query) {
      const current = ++serial;
      state({kind:'search', query, heading:'Ищем в Community…',
        description:'Обложки и сведения поступают\nиз оригинального каталога Figma.', progress:true});
      let response;
      try {
        response = await nativeEditor.call('canvas_community_catalog_search', {query, limit:8});
      } catch (error) {
        if (current !== serial) return;
        const reason = make('details', null, 'catalog-error-detail');
        reason.append(make('summary', 'Подробности'), make('p', error.message), button('Повторить поиск', () => search(query)));
        const actions = [];
        if (onLocal) actions.push(button('Локальная библиотека', onLocal));
        // A source or validation error alone does not establish a network outage.
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false ||
          /fetch failed|network|offline|ENOTFOUND|EAI_AGAIN|ECONN|timed? ?out/i.test(error.message);
        state({kind:'offline', badge:offline ? 'Нет соединения' : 'Ошибка каталога', heading:'Каталог пока недоступен',
          description:'Скачанные ресурсы доступны локально.\nК поиску можно вернуться позже.', actions});
        results.append(reason);
        return;
      }
      if (current !== serial) return;
      if (!response.results.length) {
        state({kind:'empty', heading:'По этому запросу ничего нет',
          description:'Попробуйте название системы, автора\nили тип ресурса: UI Kit, icons, dashboard.',
          actions:focusQuery ? [button('Изменить запрос', focusQuery)] : []});
        return;
      }
      results.replaceChildren();
      announcement.textContent = 'Найдено ресурсов: ' + response.results.length;
      const previews = [];
      for (const resource of response.results) {
        const card = make('article', null, 'library-card'), cover = make('div', null, 'library-cover');
        const body = make('div', null, 'library-card-body'), actions = make('div', null, 'library-card-actions');
        cover.append(make('span', 'Загружаем обложку Figma…', 'library-cover-empty'));
        body.append(make('strong', resource.title, 'library-card-title'));
        if (resource.author) body.append(make('small', resource.author, 'library-card-author'));
        body.append(make('small', 'Figma Community · ' + resource.resourceId, 'library-card-index'));
        const link = make('a', 'Источник', 'source-link');
        link.href = resource.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        let acquiring = false;
        actions.append(button('Сохранить референс', async () => {
          if (acquiring) return;
          acquiring = true;
          announcement.textContent = 'Получаем оригинал и условия использования…';
          try {
            const acquired = await nativeEditor.call('canvas_community_catalog_acquire', {resourceId:resource.resourceId, mode:'reference'});
            nativeEditor.status('Сохранён референс «' + acquired.card.title + '»');
            if (current === serial) announcement.textContent = 'Референс сохранён в общей библиотеке и добавлен в проект.';
            if (onAcquire) await onAcquire();
          } catch (error) {
            if (current === serial) announcement.textContent = 'Сохранение не подтверждено.';
            throw error;
          } finally { acquiring = false; }
        }), link);
        card.append(cover, body, actions);
        results.append(card);
        previews.push({resource, cover});
      }
      for (const {resource, cover} of previews) {
        if (current !== serial) return;
        try {
          const preview = await nativeEditor.call('canvas_community_catalog_cover', {resourceId:resource.resourceId});
          if (current !== serial) return;
          const image = make('img', null, 'library-cover-image');
          image.src = preview.coverDataUrl; image.alt = 'Обложка ' + resource.title;
          cover.replaceChildren(image);
        } catch {
          if (current === serial) cover.replaceChildren(make('span', 'Оригинальная обложка недоступна', 'library-cover-empty'));
        }
      }
    }
    return {search, invalidate() { ++serial; }};
  }
  return {section};
})();
