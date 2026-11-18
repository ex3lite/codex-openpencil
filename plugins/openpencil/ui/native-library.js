// The library uses the same status surface for catalog searches, imports and fonts.
function libraryCloseButton(button, action) {
  const close = button('Закрыть', action, 'library-close');
  const control = close.querySelector?.('button');
  if (control) {
    const icon = document.createElement('i');
    icon.setAttribute('data-ob-icon', 'close');
    icon.setAttribute('aria-hidden', 'true');
    control.setAttribute('aria-label', 'Закрыть');
    control.replaceChildren(icon);
  }
  return close;
}

function nativeLibraryState({make, button}, {kind, title, badge, heading, description, query, progress, footnote, actions = [], onClose}) {
  const card = make('section', null, 'library-state library-state-' + kind);
  card.setAttribute('aria-label', title);
  const header = make('header', null, 'library-state-header');
  header.append(make('h3', title));
  if (onClose) header.append(libraryCloseButton(button, onClose));
  const body = make('div', null, 'library-state-body');
  if (query) body.append(make('div', query, 'library-state-query'));
  if (badge) body.append(make('span', badge, 'library-state-badge'));
  const status = make('h4', heading);
  status.setAttribute('role', 'status');
  body.append(status, make('p', description, 'library-state-description'));
  const footer = make('div', null, 'library-state-footer');
  if (progress) {
    const track = make('progress');
    track.setAttribute('aria-label', heading);
    footer.append(track);
  }
  if (footnote) footer.append(make('small', footnote));
  footer.append(...actions);
  card.append(header, body, footer);
  return card;
}

const nativeLibrary = (() => {
  // The floating drawer handles Escape after its nested, top-layer surfaces.
  if (typeof window !== 'undefined') window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const modal = document.querySelector('dialog.resource-detail[open]');
    const popover = document.querySelector('.library-preferences:popover-open');
    if (!modal && !popover) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (modal) modal.close();
    else popover.hidePopover();
  }, true);

  let importPending = false;
  const kinds = {'ui-kit':'UI Kit', icon:'Иконка', reference:'Референс', document:'Документ'};
  const number = value => value.toLocaleString('ru-RU');
  function pageCount(count) {
    const form = new Intl.PluralRules('ru-RU').select(count);
    return number(count) + ' ' + ({one:'страница', few:'страницы', many:'страниц'}[form] || 'страниц');
  }

  function settingsPopover({make, button}, settings) {
    const details = make('section', null, 'library-preferences');
    details.setAttribute('popover', 'auto');
    details.setAttribute('aria-label', 'Настройки библиотеки');
    const heading = make('div', null, 'resource-heading');
    const close = libraryCloseButton(button, () => details.hidePopover());
    heading.append(make('h2', 'Настройки библиотеки'), close);
    const trigger = button('Настройки библиотеки', () => {
      details.showPopover();
      close.querySelector('button').focus();
    });
    details.ontoggle = event => {
      if (event.newState === 'closed' && !details.contains(document.activeElement) &&
          document.activeElement !== document.body) return;
      if (event.newState === 'closed') trigger.querySelector('button').focus();
    };
    details.append(heading, make('p', 'Общие для всех проектов', 'library-preferences-subtitle'));
    function setting(key, name, description) {
      const group = make('div', null, 'library-preference');
      const row = make('label'), input = make('input');
      input.type = 'checkbox';
      input.checked = settings[key] !== false;
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-describedby', 'library-help-' + key);
      const help = make('p', description);
      help.id = 'library-help-' + key;
      const responsibility = 'Ресурсы с неизвестной лицензией добавляются на вашу ответственность.';
      function syncHelp() {
        help.textContent = key === 'verifyLicenses' && !input.checked ? responsibility : description;
      }
      syncHelp();
      input.onchange = async () => {
        input.disabled = true;
        try {
          await nativeEditor.call('canvas_community_settings', {scope:'global', [key]:input.checked});
        } catch (error) {
          input.checked = !input.checked;
          nativeEditor.status(error.message, true);
        } finally {
          input.disabled = false;
          syncHelp();
        }
      };
      row.append(make('span', name), input);
      group.append(row, help);
      details.append(group);
    }
    setting('verifyLicenses', 'Проверять лицензию', 'Учитывать условия автора перед добавлением.');
    setting('autonomous', 'Автоподбор ресурсов', 'Агент сам ищет и загружает нужное\nв общую локальную библиотеку.');
    return {details, trigger};
  }

  async function open({show, drawer, make, button}) {
    show('library', 'Библиотека');
    const content = make('div', null, 'library-content');
    drawer.append(content);
    const ui = {make, button};
    const results = make('div', null, 'library-grid');
    results.tabIndex = 0;
    results.setAttribute('role', 'region');
    results.setAttribute('aria-label', 'Ресурсы библиотеки');
    const rowObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const first = results.firstElementChild;
      if (!first?.classList.contains('library-card')) return;
      const row = first.getBoundingClientRect().height;
      if (row) results.style.setProperty('--library-row-height', row + 'px');
      results.style.setProperty('--library-scroll-gutter', (results.offsetWidth - results.clientWidth) + 'px');
    });
    const remote = make('section', null, 'library-remote');
    remote.hidden = true;
    const operation = make('div', null, 'library-operation');
    const search = make('div', null, 'library-search');
    const input = make('input');
    input.type = 'search';
    input.placeholder = 'Найти UI Kit, иконки или референс';
    input.setAttribute('aria-label', 'Поиск ресурсов');
    const searchIcon = make('i');
    searchIcon.setAttribute('data-ob-icon', 'search');
    searchIcon.setAttribute('aria-hidden', 'true');
    search.append(searchIcon, input);
    const scopes = make('div', null, 'library-scopes');
    function iconButton(text, action, iconName, buttonClass) {
      const root = button(text, action, buttonClass);
      const control = root.querySelector?.('button');
      if (control) {
        const icon = make('i');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('data-ob-icon', iconName);
        control.replaceChildren(icon, make('span', text));
      }
      return root;
    }
    const resourceButton = (text, action) => iconButton(text, action, 'resource-arrow', 'library-resource-action');
    let scope = 'global', version = 0, timer;
    function focusQuery() {
      input.focus();
      input.select();
    }
    const all = button('Вся библиотека', () => setScope('global'));
    const project = button('В этом проекте', () => setScope('project'));
    const community = iconButton('Найти в Community', () => setScope('community'), 'library');
    function markScopes() {
      for (const [target, value] of [[all,'global'], [project,'project'], [community,'community']]) {
        const pressed = String(scope === value);
        target.setAttribute('aria-pressed', pressed);
        target.querySelector?.('button')?.setAttribute('aria-pressed', pressed);
      }
    }
    scopes.append(all, project, community);
    markScopes();
    const projectSummary = make('div', null, 'library-project-summary');
    const footer = make('footer', null, 'library-footer');
    footer.append(make('strong', 'Исходники и авторство сохранены'),
      make('p', 'Обложка не выдаётся за редактируемый UI Kit. Формат и доступность слоёв видны до добавления.'), projectSummary);
    const packs = typeof nativeIconPacks !== 'undefined' ? nativeEditor.call('canvas_icon_pack_list', {previews:true})
      .then(data => data.packs.filter(pack => pack.installed && pack.available !== false))
      .catch(error => { nativeEditor.status(error.message, true); return []; }) : Promise.resolve([]);
    async function refreshProject() {
      const data = await nativeEditor.call('canvas_community_search', {scope:'project', query:'', limit:3, previews:false});
      projectSummary.replaceChildren(make('strong', 'Для текущего проекта'), make('p',
        data.assets.map(asset => asset.name).join('  /  ') + (data.total > data.assets.length ? '  /  +' + (data.total - data.assets.length) : '') || 'Пока нет ресурсов'));
      if (Number.isInteger(data.total)) project.querySelector('button').textContent = 'В проекте · ' + number(data.total);
    }
    const catalog = typeof nativeCommunityCatalog === 'undefined' ? null :
      await nativeCommunityCatalog.section({drawer:remote, make, button, focusQuery,
        onAcquire:refreshProject, onLocal:() => setScope('global')});
    async function setScope(next) {
      if (next === 'community' && !catalog) throw Error('Каталог Community недоступен.');
      if (timer !== undefined) clearTimeout(timer);
      ++version;
      catalog?.invalidate();
      scope = next;
      remote.hidden = scope !== 'community';
      results.hidden = scope === 'community';
      footer.hidden = scope === 'community';
      markScopes();
      if (scope === 'community') return catalog.search(input.value.trim() || 'UI Kit');
      await load();
    }

    function coverFor(asset) {
      const cover = make('div', null, 'library-cover');
      const icon = asset.kind === 'icon' && asset.previewDataUrl;
      if (icon || asset.coverDataUrl) {
        const preview = make('img');
        preview.src = icon || asset.coverDataUrl;
        preview.alt = icon ? asset.name : 'Обложка ' + asset.name;
        preview.className = icon ? 'asset-preview' : 'library-cover-image';
        cover.append(preview);
      } else cover.append(make('span', 'Оригинальная обложка недоступна', 'library-cover-empty'));
      return cover;
    }
    function sourceFor(asset, label) {
      const url = asset.communityUrl || asset.sourceUrl;
      if (!url) return make('small', 'Источник не указан');
      const link = make('a', label, 'source-link');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }
    function provenance(asset) {
      const line = make('div', null, 'library-card-author');
      const licenseLabel = asset.license?.status === 'unknown' ? 'Лицензия неизвестна · ответственность пользователя' :
        asset.license?.spdx || 'Лицензия не указана';
      const license = make(asset.license?.url ? 'a' : 'span', licenseLabel, 'library-card-license');
      if (asset.license?.url) {
        license.href = asset.license.url;
        license.target = '_blank';
        license.rel = 'noopener noreferrer';
      }
      line.append(make('span', (asset.author || 'Автор не указан') + ' · '), license);
      return line;
    }
    function format(asset) {
      if (asset.available === false) return 'Лицензия или файл повреждены. Повторите получение ресурса через Codex.';
      if (asset.native?.pageCount) return pageCount(asset.native.pageCount) + ' · редактируемые слои';
      if (asset.kind === 'reference' && asset.coverDataUrl) return 'Референс · исходная обложка' + (asset.originalCommunityId ? ' Figma' : '');
      if (asset.importMode === 'reference-only') return 'Референс · ' + asset.format.toUpperCase();
      return (kinds[asset.kind] || 'Ресурс') + ' · ' + asset.format.toUpperCase();
    }
    function isDocument(asset) { return ['fig', 'op'].includes(asset.format); }
    function canImport(asset) { return asset.available !== false && (isDocument(asset) || asset.importMode !== 'reference-only'); }
    async function importAsset(asset) {
      if (importPending) return;
      importPending = true;
      const documentKit = isDocument(asset);
      const dismiss = () => operation.replaceChildren();
      operation.replaceChildren(nativeLibraryState(ui, {kind:'import', title:asset.name, badge:documentKit ? 'Разбираем слои' : 'Добавление',
        heading:documentKit && asset.native?.pageCount ? 'Обрабатываем ' + pageCount(asset.native.pageCount) : documentKit ? 'Открываем полный набор' : 'Добавляем ресурс',
        description:documentKit ? 'Все страницы сохранятся в общей библиотеке.\nХолст остаётся доступен для работы.' : 'Оригинал остаётся в общей библиотеке.',
        footnote:documentKit ? 'Шрифты → компоненты → страницы' : null, progress:true, onClose:dismiss}));
      let copyId;
      try {
        const args = {assetId:asset.id};
        if (!documentKit) {
          await nativeEditor.flush();
          const current = await nativeEditor.call('canvas_status');
          args.expectedVersion = current.version;
          args.pageId = current.selection.pageId;
          if (asset.importMode === 'image') {
            if (current.selection.count !== 1) throw Error('Выделите один слой изображения для замены.');
            args.nodeId = current.selection.nodeIds[0];
          }
        }
        const result = await nativeEditor.call('canvas_community_import', args);
        if (documentKit) {
          copyId = result.imported?.id;
          if (!copyId) throw Error('Импорт не вернул идентификатор макета. Проверьте список макетов проекта.');
          // Use the same autosave and Rust replacement acknowledgement as the document picker.
          await nativeEditor.switchDocument(copyId);
        }
        const count = result.conversion?.pageCount || asset.native?.pageCount;
        const heading = documentKit ? (count ? pageCount(count) + (new Intl.PluralRules('ru-RU').select(count) === 'one' ? ' доступна' : ' доступны') + ' для работы' : 'Полный набор открыт') : 'Ресурс добавлен в проект';
        const go = button(documentKit ? 'Перейти к набору' : 'Перейти к холсту', () => {
          dismiss();
          nativeUI.closePanel();
          document.getElementById('op')?.focus();
        }, 'primary');
        operation.replaceChildren(nativeLibraryState(ui, {kind:'added', title:asset.name, badge:'В проекте', heading,
          description:documentKit ? 'Страницы доступны в панели слоёв.\nОригинал остаётся в общей библиотеке.' : 'Оригинал остаётся в общей библиотеке.', actions:[go], onClose:dismiss}));
        nativeEditor.status(heading);
        void refreshProject().catch(error => nativeEditor.status(error.message, true));
      } catch (error) {
        operation.replaceChildren(nativeLibraryState(ui, {kind:'error', title:asset.name, badge:'Ошибка', heading:copyId ? 'Набор скопирован в проект' : 'Добавление не подтверждено',
          description:error.message, actions:copyId ? [button('Открыть макеты', () => {
            dismiss();
            nativeUI.closePanel();
            document.getElementById('workspace-documents')?.click();
          })] : [], onClose:dismiss}));
        throw error;
      } finally { importPending = false; }
    }
    function card(asset) {
      const item = make('article', null, 'library-card' + (asset.kind === 'icon' ? ' library-icon-card' : ''));
      const cover = coverFor(asset);
      function inspectAsset() {
        const invoker = document.activeElement;
        const dialog = make('dialog', null, 'resource-detail');
        dialog.setAttribute('aria-label', asset.name);
        const heading = make('div', null, 'resource-heading');
        heading.append(make('h2', asset.name), libraryCloseButton(button, () => dialog.close()));
        const sourceLabel = asset.originalCommunityId ? 'Figma Community / ' + asset.originalCommunityId : 'Источник';
        dialog.append(heading, coverFor(asset), provenance(asset), make('p', format(asset), 'resource-detail-format'),
          sourceFor(asset, sourceLabel), make('p', 'Источник и авторство остаются в библиотеке.', 'resource-detail-note'));
        if (canImport(asset)) dialog.append(button(isDocument(asset) ? 'Открыть UI Kit' : 'Добавить на холст',
          () => { dialog.close(); return importAsset(asset); }, 'primary'));
        dialog.addEventListener('close', () => {
          dialog.remove();
          if (invoker?.isConnected) invoker.focus();
        }, {once:true});
        content.append(dialog);
        dialog.showModal();
      }
      const opener = button('Сведения о ресурсе ' + asset.name, inspectAsset);
      opener.className = 'library-inspect';
      cover.append(opener);
      const body = make('div', null, 'library-card-body'), actions = make('div', null, 'library-card-actions');
      body.append(make('strong', asset.name, 'library-card-title'), provenance(asset), make('small', format(asset), 'library-card-index'));
      if (canImport(asset) && asset.kind !== 'reference') actions.append(resourceButton(isDocument(asset) ? 'Открыть набор в проекте' : 'Добавить на холст', () => importAsset(asset)));
      else actions.append(resourceButton('Посмотреть ' + (asset.kind === 'reference' ? 'референс' : 'сведения'), inspectAsset));
      item.append(cover, body, actions);
      return item;
    }
    function packCard(pack) {
      const item = make('article', null, 'library-card');
      const body = make('div', null, 'library-card-body'), actions = make('div', null, 'library-card-actions');
      const count = pack.iconCount?.toLocaleString('ru-RU');
      const info = [count && 'Иконок: ' + count, pack.styles?.length && 'Стилей: ' + pack.styles.length].filter(Boolean).join(' · ');
      body.append(make('strong', pack.name, 'library-card-title'), make('small', [pack.author, pack.licenseSpdx].filter(Boolean).join(' · '), 'library-card-author'),
        make('small', info, 'library-card-index'));
      actions.append(resourceButton('Открыть набор', async () => {
        ++version;
        const section = make('div', null, 'library-pack-view');
        results.replaceChildren(section);
        section.append(button('В библиотеку', () => setScope(scope)));
        await nativeIconPacks.section({drawer:section, make, button, selectedPack:pack});
      }));
      item.append(coverFor(pack), body, actions);
      return item;
    }
    async function load() {
      const current = ++version;
      const search = {scope, query:input.value || '', limit:12, order:'library', previews:true};
      const data = await nativeEditor.call('canvas_community_search', {...search, offset:0});
      const query = search.query.trim().toLowerCase();
      const matches = scope === 'global' ? (await packs).filter(pack =>
        [pack.name, pack.author, pack.id, 'иконки icons'].join(' ').toLowerCase().includes(query)) : [];
      if (current !== version) return;
      const assets = data.assets;
      const visibleIds = new Set(assets.map(asset => asset.id));
      let offset = assets.length;
      function appendPager(total) {
        if (offset >= total || !Number.isInteger(total)) return;
        let pending = false;
        const more = button('Показать ещё', async () => {
          if (pending || current !== version) return;
          pending = true;
          more.setAttribute('aria-busy', 'true');
          try {
            const page = await nativeEditor.call('canvas_community_search', {...search, offset});
            if (current !== version) return;
            const moveFocus = more.contains(document.activeElement);
            more.remove();
            const next = [];
            for (const asset of page.assets) {
              if (visibleIds.has(asset.id)) continue;
              visibleIds.add(asset.id);
              next.push(card(asset));
            }
            results.append(...next);
            offset += page.assets.length;
            if (page.assets.length) appendPager(page.total);
            if (moveFocus) (next[0]?.querySelector('button') || results).focus();
          } catch (error) {
            if (current === version) throw error;
          } finally {
            pending = false;
            more.removeAttribute('aria-busy');
          }
        }, 'library-load-more');
        more.classList.add('library-pager');
        results.append(more);
      }
      rowObserver?.disconnect();
      results.replaceChildren(...matches.map(packCard), ...assets.map(card));
      results.scrollTop = 0;
      if (results.firstElementChild && rowObserver) rowObserver.observe(results.firstElementChild);
      if (assets.length) appendPager(data.total);
      if (!assets.length && !matches.length) results.append(nativeLibraryState(ui, {kind:'empty', title:'Библиотека',
        heading:input.value ? 'По этому запросу ничего нет' : 'Здесь пока нет ресурсов',
        description:'Попробуйте название системы, автора\nили тип ресурса: UI Kit, icons, dashboard.',
        actions:[button('Изменить запрос', focusQuery)], onClose:() => { results.replaceChildren(); focusQuery(); }}));
    }
    input.oninput = () => {
      clearTimeout(timer);
      ++version;
      catalog?.invalidate();
      timer = setTimeout(() => setScope(scope).catch(error => nativeEditor.status(error.message, true)), 180);
    };
    input.onkeydown = event => {
      if (event.key === 'Enter') void setScope(scope).catch(error => nativeEditor.status(error.message, true));
    };
    content.append(make('p', 'Общие ресурсы для ваших проектов', 'library-intro'), search, scopes, results, remote, operation, footer);
    const tools = make('div', null, 'library-tools');
    const extras = make('details', null, 'library-settings');
    extras.append(make('summary', 'Шрифты и наборы иконок'));
    content.append(tools, extras);
    const preferences = nativeEditor.call('canvas_community_settings', {scope:'global'}).then(settings => {
      const {details, trigger} = settingsPopover(ui, settings);
      tools.append(trigger, details);
    }).catch(error => nativeEditor.status(error.message, true));
    let loaded = false;
    extras.ontoggle = async () => {
      if (!extras.open || loaded) return;
      loaded = true;
      const section = make('div');
      extras.append(section);
      try {
        if (typeof nativeFonts !== 'undefined') await nativeFonts.section({drawer:section, make, button});
        if (typeof nativeIconPacks !== 'undefined') await nativeIconPacks.section({drawer:section, make, button});
        section.append(button('Добавить иконки Lucide', async () => {
          if (!nativeBridge.capabilities.message?.text) throw Error('Напишите запрос на добавление стартовых иконок в этом чате.');
          const text = 'Добавь стартовые иконки Lucide в локальную библиотеку OpenBrush этого проекта через canvas_community_seed.';
          const result = await nativeBridge.request('ui/message', {role:'user', content:[{type:'text',text}]});
          if (result?.isError) throw Error('Codex не принял запрос.');
          nativeEditor.status('Запрос передан в этот чат');
        }));
      } catch (error) {
        section.remove();
        loaded = false;
        nativeEditor.status(error.message, true);
      }
    };
    await Promise.all([load(), preferences, refreshProject().catch(error => nativeEditor.status(error.message, true))]);
  }
  return {open};
})();
