// Local assets retain provenance. Remote Community search uses direct MCP.
const nativeLibrary = (() => {
  // The SDK drawer listens on the document. Its nested modal owns Escape first.
  if(typeof window!=='undefined') window.addEventListener('keydown',event=>{
    if(event.key!=='Escape') return;
    const modal=document.querySelector('dialog.resource-detail[open]');
    if(!modal){
      const popover=document.querySelector('.library-preferences:popover-open');
      if(!popover)return;
      event.preventDefault();event.stopImmediatePropagation();popover.hidePopover();return;
    }
    event.preventDefault();event.stopImmediatePropagation();modal.close();
  },true);
  async function open({show,drawer,make,button}) {
    show('library','Библиотека');
    const content = make('div',null,'library-content');
    drawer.append(content);
    drawer = content; // Late requests can only update this particular library view.
    drawer.append(make('p','Общие ресурсы для ваших проектов','library-intro'));
    const settings=await nativeEditor.call('canvas_community_settings',{scope:'global'});
    const details=make('section',null,'library-preferences');
    details.setAttribute('popover','auto');details.setAttribute('aria-label','Настройки библиотеки');
    const summary=make('div',null,'resource-heading');
    summary.append(make('h2','Настройки библиотеки'),button('Закрыть',()=>details.hidePopover()));
    const preferences=button('Настройки библиотеки',()=>details.showPopover());
    const tools=make('div',null,'library-tools');tools.append(preferences);
    details.append(summary,make('p','Общие для всех проектов'));
    const label=make('label',null,'toggle'),verify=document.createElement('input');
    verify.type='checkbox';verify.checked=settings.verifyLicenses!==false;
    verify.setAttribute('aria-label','Проверять лицензию перед добавлением');
    verify.onchange=async()=>{
      verify.disabled=true;
      try {await nativeEditor.call('canvas_community_settings',{scope:'global',verifyLicenses:verify.checked});}
      catch(error){verify.checked=!verify.checked;nativeEditor.status(error.message,true);}
      finally{verify.disabled=false;}
    };
    label.append(verify,make('span','Проверять лицензию перед добавлением'));
    details.append(label,make('p','Если выключено, ресурсы с неизвестной лицензией добавляются на вашу ответственность. Источник и известные условия сохраняются.'));
    const autoLabel=make('label',null,'toggle'),auto=document.createElement('input');
    auto.type='checkbox';auto.checked=settings.autonomous!==false;
    auto.setAttribute('aria-label','Автоподбор ресурсов агентом');
    auto.onchange=async()=>{auto.disabled=true;try{await nativeEditor.call('canvas_community_settings',{scope:'global',autonomous:auto.checked});}catch(error){auto.checked=!auto.checked;nativeEditor.status(error.message,true);}finally{auto.disabled=false;}};
    autoLabel.append(auto,make('span','Автоподбор ресурсов агентом'));details.append(autoLabel);
    const remote=make('section',null,'library-remote');
    remote.hidden=true;
    const catalog=typeof nativeCommunityCatalog!=='undefined'?await nativeCommunityCatalog.section({drawer:remote,make,button,onAcquire:load,onLocal:()=>setScope('global')}):null;
    let scope='global';
    const scopes=make('div',null,'library-scopes');
    const all=button('Вся библиотека',()=>setScope('global')),project=button('В этом проекте',()=>setScope('project'));
    async function setScope(next){remote.hidden=true;results.hidden=false;scope=next;all.setAttribute('aria-pressed',String(next==='global'));project.setAttribute('aria-pressed',String(next==='project'));await load();}
    all.setAttribute('aria-pressed','true');project.setAttribute('aria-pressed','false');scopes.append(all,project);
    const search=make('div',null,'library-search'), input=document.createElement('input');
    input.type='search';input.placeholder='Найти UI Kit, иконки или референс';input.setAttribute('aria-label','Поиск ресурсов');
    const results=make('div',null,'library-grid');let queryVersion=0;
    async function load() {
      const version=++queryVersion;
      const data=await nativeEditor.call('canvas_community_search',{scope,query:input.value,limit:50,previews:true});
      if(version!==queryVersion)return;
      results.replaceChildren();
      if(!data.assets.length)results.append(make('p','По этому запросу в библиотеке ничего нет.'));
      for(const asset of data.assets.slice().sort((a,b)=>(a.kind==='ui-kit'?-1:0)-(b.kind==='ui-kit'?-1:0)||Number(!!b.cover)-Number(!!a.cover))){
        const compactIcon=asset.kind==='icon'&&asset.previewDataUrl;
        const item=make('article',null,'library-card'+(compactIcon?' library-icon-card':''));
        const cover=make('div',null,'library-cover');
        if(compactIcon){const preview=document.createElement('img');preview.src=asset.previewDataUrl;preview.alt=asset.name;preview.className='asset-preview';cover.append(preview);}
        else if(asset.coverDataUrl){const preview=document.createElement('img');preview.src=asset.coverDataUrl;preview.alt=`Обложка ${asset.name}`;preview.className='library-cover-image';cover.append(preview);}
        else cover.append(make('span','Оригинальная обложка недоступна','library-cover-empty'));
        const inspect=button('Сведения о ресурсе',()=>{
          const dialog=document.createElement('dialog');dialog.className='resource-detail';dialog.setAttribute('aria-label',asset.name);
          const heading=make('div',null,'resource-heading');
          heading.append(make('h2',asset.name),button('Закрыть',()=>dialog.close()));
          const preview=cover.cloneNode(true);preview.querySelector('.library-inspect')?.remove();
          dialog.append(heading,preview,make('p',asset.author||'Автор не указан'),make('p',asset.license?.spdx||'Лицензия не указана'));
          if(asset.native?.pageCount) dialog.append(make('p',asset.native.pageCount+' стр. · '+asset.native.nodeCount+' слоёв'));
          dialog.append(source.cloneNode(true));drawer.append(dialog);
          dialog.addEventListener('close',()=>{
            dialog.remove();
            inspect.querySelector('button')?.focus();
          },{once:true});
          dialog.showModal();
        });
        inspect.className='library-inspect';
        inspect.setAttribute('aria-label','Сведения о ресурсе '+asset.name);
        cover.append(inspect);item.append(cover);
        const body=make('div',null,'library-card-body'),actions=make('div',null,'library-card-actions');
        const kinds={'ui-kit':'UI Kit',icon:'Иконки',reference:'Референс',document:'Документ'};
        body.append(make('small',`${kinds[asset.kind]||'Ресурс'} · ${asset.format.toUpperCase()}`,'library-card-kind'),make('strong',asset.name,'library-card-title'),make('small',asset.author,'library-card-author'));
        const licenseLabel=asset.license?.status==='unknown'?'Лицензия неизвестна · ответственность пользователя':asset.license?.spdx||'Лицензия не указана';
        const license=make(asset.license?.url?'a':'small',licenseLabel,'library-card-license');
        if(asset.license?.url){license.href=asset.license.url;license.target='_blank';license.rel='noopener noreferrer';}
        body.append(license);
        if(asset.native?.pageCount)body.append(make('small',`${asset.native.pageCount} страниц · ${asset.native.nodeCount.toLocaleString('ru-RU')} слоёв · разобран локально`,'library-card-index'));
        item.append(body,actions);
        const source=document.createElement('a');source.textContent='Источник';source.className='source-link';source.href=asset.communityUrl||asset.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';actions.append(source);
        if(asset.available!==false && ['fig','op'].includes(asset.format))actions.append(button('Открыть набор в проекте',async()=>{
          nativeEditor.status('Подготовка полного набора…');
          const snapshot=await nativeEditor.flush();
          const result=await nativeEditor.call('canvas_community_import',{assetId:asset.id,docJson:snapshot.docJson});
          if(result.documentId && result.filePath)nativeEditor.rebind(result);
          nativeEditor.status('Полный набор открыт. Все страницы доступны в панели слева.');
        }));
        else if(asset.available!==false && asset.importMode!=='reference-only')actions.append(button('Добавить на холст',async()=>{
          await nativeEditor.flush();const current=await nativeEditor.call('canvas_status');
          const args={assetId:asset.id,expectedVersion:current.version,pageId:current.selection.pageId};
          if(asset.importMode==='image'){
            if(current.selection.count!==1)throw Error('Выделите один слой изображения для замены.');
            args.nodeId=current.selection.nodeIds[0];
          }
          await nativeEditor.call('canvas_community_import',args);
          nativeEditor.status('Ресурс добавлен в проект');
        }));
        else body.append(make('small',asset.available===false?'Лицензия или файл повреждены. Повторите получение ресурса через Codex.':'Файл сохранён локально. Для редактирования нужен поддерживаемый импорт формата.'));
        results.append(item);
      }
    }
    search.append(input);
    let queryTimer;
    input.oninput=()=>{clearTimeout(queryTimer);queryVersion++;queryTimer=setTimeout(()=>setScope(scope).catch(error=>nativeEditor.status(error.message,true)),180);};
    input.onkeydown=event=>{if(event.key==='Enter'){clearTimeout(queryTimer);void setScope(scope).catch(error=>nativeEditor.status(error.message,true));}};
    const request=async()=>{
      if(!nativeBridge.capabilities.message?.text)throw Error('Напишите запрос на добавление стартовых иконок в этом чате.');
      const text='Добавь стартовые иконки Lucide в локальную библиотеку OpenBrush этого проекта через canvas_community_seed.';
      const result=await nativeBridge.request('ui/message',{role:'user',content:[{type:'text',text}]});
      if(result?.isError)throw Error('Codex не принял запрос.');
      nativeEditor.status('Запрос передан в этот чат');
    };
    scopes.append(button('Найти в Community',()=>{
      if(!catalog)throw Error('Каталог Community недоступен.');
      remote.hidden=false;results.hidden=true;
      all.setAttribute('aria-pressed','false');project.setAttribute('aria-pressed','false');
      return catalog.search(input.value.trim()||'UI Kit');
    }));
    drawer.append(search,scopes,results,remote,tools,details);
    const extras=make('details',null,'library-settings');
    extras.append(make('summary','Шрифты и наборы иконок'));drawer.append(extras);
    let loading=false;
    extras.ontoggle=async()=>{
      if(!extras.open || loading)return;
      loading=true;
      const section=make('div');extras.append(section);
      try{
        if(typeof nativeFonts!=='undefined')await nativeFonts.section({drawer:section,make,button});
        if(typeof nativeIconPacks!=='undefined')await nativeIconPacks.section({drawer:section,make,button});
        section.append(button('Добавить иконки Lucide',request));
      }catch(error){section.remove();loading=false;nativeEditor.status(error.message,true);}
    };
    await load();
  }
  return {open};
})();
