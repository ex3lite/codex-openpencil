// Local assets retain their source and license. Community discovery runs in Codex.
const nativeLibrary = (() => {
  async function open({show,drawer,make,button}) {
    show('library','Библиотека проекта');
    drawer.append(make('p','Иконки, UI Kit и референсы из Figma Community. Скачанные ресурсы доступны локально вместе с источником и лицензией.'));
    const settings=await nativeEditor.call('canvas_community_settings');
    const details=make('details',null,'library-settings'),summary=make('summary','Настройки библиотеки');
    const label=make('label',null,'toggle'),verify=document.createElement('input');
    verify.type='checkbox';verify.checked=settings.verifyLicenses!==false;
    verify.setAttribute('aria-label','Проверять лицензию перед добавлением');
    verify.onchange=async()=>{
      verify.disabled=true;
      try {await nativeEditor.call('canvas_community_settings',{verifyLicenses:verify.checked});}
      catch(error){verify.checked=!verify.checked;nativeEditor.status(error.message,true);}
      finally{verify.disabled=false;}
    };
    label.append(verify,make('span','Проверять лицензию перед добавлением'));
    details.append(summary,label,make('p','Если выключено, ресурсы с неизвестной лицензией добавляются на вашу ответственность. Источник и известные условия сохраняются.'));
    drawer.append(details);
    const search=make('div',null,'library-search'), input=document.createElement('input');
    input.type='search';input.placeholder='Найти в библиотеке';input.setAttribute('aria-label','Поиск ресурсов');
    const results=make('div',null,'library-grid');let queryVersion=0;
    async function load() {
      const version=++queryVersion;
      const data=await nativeEditor.call('canvas_community_search',{query:input.value,limit:50,previews:true});
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
        body.append(license);item.append(body,actions);
        const source=document.createElement('a');source.textContent='Источник';source.className='source-link';source.href=asset.communityUrl||asset.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';actions.append(source);
        if(asset.available!==false && asset.format==='fig')actions.append(button('Импортировать Figma',async()=>{
          await nativeEditor.flush();
          const result=await nativeBridge.call('canvas_community_file',{assetId:asset.id});
          const file=result._meta?.communityFile;if(!file)throw Error('Не удалось прочитать исходник Figma.');
          const bytes=Uint8Array.from(atob(file.body),c=>c.charCodeAt(0));
          const transfer=new DataTransfer();transfer.items.add(new File([bytes],file.name,{type:'application/octet-stream'}));
          document.getElementById('op').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
          nativeEditor.status('Исходник передан импортёру Figma. Дождитесь результата на холсте.');
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
      const policy=settings.verifyLicenses===false?'Проверка лицензий отключена пользователем: сохраняй известные лицензии, неизвестные явно отмечай как ответственность пользователя. Не придумывай разрешения.':'Проверь источник и сохрани подтверждение лицензии.';
      const text=seed?'Добавь стартовые иконки Lucide в локальную библиотеку OpenBrush этого проекта через canvas_community_seed.':'Найди в Figma Community '+(input.value.trim()||'подходящие иконки и UI Kit для текущего проекта')+'. '+policy+' Ищи широко среди публичных Community-ресурсов, официальных сайтов авторов и репозиториев. Скачай оригинальную обложку с Community-страницы (og:image) вместе с источником; не подменяй её рендером содержимого. Скачай доступные ресурсы в локальный датасет OpenBrush этого проекта. Используй workflow Community из навыка OpenBrush. Не ограничивайся ссылками.';
      const result=await nativeBridge.request('ui/message',{role:'user',content:[{type:'text',text}]});
      if(result?.isError)throw Error('Codex не принял запрос.');
      nativeEditor.status('Запрос передан в этот чат');
    };
    drawer.append(button('Найти в Figma Community',()=>request()),button('Добавить иконки Lucide',()=>request(true)),button('Обновить библиотеку',load),results);
    await load();
  }
  return {open};
})();
