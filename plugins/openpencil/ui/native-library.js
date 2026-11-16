// Local assets retain their source and license. Community discovery runs in Codex.
const nativeLibrary = (() => {
  async function open({show,drawer,make,button}) {
    show('library','Общая библиотека');
    drawer.append(make('p','Ресурсы всех проектов хранятся здесь один раз. Агент сам подбирает, скачивает и разбирает нужное для текущей задачи.'));
    const settings=await nativeEditor.call('canvas_community_settings',{scope:'global'});
    const details=make('details',null,'library-settings'),summary=make('summary','Настройки библиотеки');
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
    details.append(summary,label,make('p','Если выключено, ресурсы с неизвестной лицензией добавляются на вашу ответственность. Источник и известные условия сохраняются.'));
    const autoLabel=make('label',null,'toggle'),auto=document.createElement('input');
    auto.type='checkbox';auto.checked=settings.autonomous!==false;
    auto.setAttribute('aria-label','Автоподбор ресурсов агентом');
    auto.onchange=async()=>{auto.disabled=true;try{await nativeEditor.call('canvas_community_settings',{scope:'global',autonomous:auto.checked});}catch(error){auto.checked=!auto.checked;nativeEditor.status(error.message,true);}finally{auto.disabled=false;}};
    autoLabel.append(auto,make('span','Автоподбор ресурсов агентом'));details.append(autoLabel);
    drawer.append(details);
    if(typeof nativeFonts!=='undefined')await nativeFonts.section({drawer,make,button});
    let scope='global';
    const scopes=make('div',null,'library-scopes');
    const all=button('Вся библиотека',()=>setScope('global')),project=button('В этом проекте',()=>setScope('project'));
    async function setScope(next){scope=next;all.setAttribute('aria-pressed',String(next==='global'));project.setAttribute('aria-pressed',String(next==='project'));await load();}
    all.setAttribute('aria-pressed','true');project.setAttribute('aria-pressed','false');scopes.append(all,project);drawer.append(scopes);
    const search=make('div',null,'library-search'), input=document.createElement('input');
    input.type='search';input.placeholder='Найти в библиотеке';input.setAttribute('aria-label','Поиск ресурсов');
    const results=make('div',null,'library-grid');let queryVersion=0;
    async function load() {
      const version=++queryVersion;
      const data=await nativeEditor.call('canvas_community_search',{scope,query:input.value,limit:50,previews:true});
      if(version!==queryVersion)return;
      results.replaceChildren();
      if(!data.assets.length)results.append(make('p','Ресурсов пока нет. Найдите нужное в Community через Codex или добавьте стартовые иконки.'));
      for(const asset of data.assets.slice().sort((a,b)=>(a.kind==='ui-kit'?-1:0)-(b.kind==='ui-kit'?-1:0)||Number(!!b.cover)-Number(!!a.cover))){
        const item=make('article',null,'library-card');
        const cover=make('div',null,'library-cover');
        if(asset.coverDataUrl){const preview=document.createElement('img');preview.src=asset.coverDataUrl;preview.alt=`Обложка ${asset.name}`;preview.className='library-cover-image';cover.append(preview);}
        else cover.append(make('span','Оригинальная обложка недоступна','library-cover-empty'));
        item.append(cover);
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
    search.append(input,button('Найти',load));drawer.append(search);
    const request=async(seed=false)=>{
      if(!nativeBridge.capabilities.message?.text)throw Error('Напишите запрос на поиск ресурсов в этом чате.');
      const settings=await nativeEditor.call('canvas_community_settings');
      const autonomy=settings.autonomous!==false?'Самостоятельно выбери подходящие ресурсы, скачай, разбери и добавь нужные компоненты в текущий проект. Не спрашивай подтверждение каждого выбора.':'Предложи подходящие ресурсы для выбора.';
      const policy=settings.verifyLicenses===false?'Проверка лицензий отключена пользователем: сохраняй известные лицензии, неизвестные явно отмечай как ответственность пользователя. Не придумывай разрешения.':'Проверь источник и сохрани подтверждение лицензии.';
      const text=seed?'Добавь стартовые иконки Lucide в локальную библиотеку OpenBrush этого проекта через canvas_community_seed.':'Найди в Figma Community '+(input.value.trim()||'подходящие иконки и UI Kit для текущего проекта')+'. '+autonomy+' '+policy+' Ищи широко среди публичных Community-ресурсов, официальных сайтов авторов и репозиториев. Скачай оригинальную обложку с Community-страницы (og:image) вместе с источником; не подменяй её рендером содержимого. Скачай доступные ресурсы в локальный датасет OpenBrush этого проекта. Используй workflow Community из навыка OpenBrush. Не ограничивайся ссылками.';
      const result=await nativeBridge.request('ui/message',{role:'user',content:[{type:'text',text}]});
      if(result?.isError)throw Error('Codex не принял запрос.');
      nativeEditor.status('Запрос передан в этот чат');
    };
    drawer.append(button('Найти в Figma Community',()=>request()),button('Добавить иконки Lucide',()=>request(true)),button('Обновить библиотеку',load),results);
    await load();
  }
  return {open};
})();
