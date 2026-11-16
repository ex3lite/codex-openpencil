// Local assets retain their source and license. Community discovery runs in Codex.
const nativeLibrary = (() => {
  async function open({show,drawer,make,button}) {
    show('library','Библиотека проекта');
    drawer.append(make('p','Иконки, UI Kit и референсы из Figma Community. Скачанные ресурсы доступны локально вместе с источником и лицензией.'));
    const search=make('div',null,'library-search'), input=document.createElement('input');
    input.type='search';input.placeholder='Найти в библиотеке';input.setAttribute('aria-label','Поиск ресурсов');
    const results=make('div');let queryVersion=0;
    async function load() {
      const version=++queryVersion;
      const data=await nativeEditor.call('canvas_community_search',{query:input.value,limit:50,previews:true});
      if(version!==queryVersion)return;
      results.replaceChildren();
      if(!data.assets.length)results.append(make('p','Ресурсов пока нет. Найдите нужное в Community через Codex или добавьте стартовые иконки.'));
      for(const asset of data.assets){
        const item=make('article',null,'item');
        if(asset.previewDataUrl){const preview=document.createElement('img');preview.src=asset.previewDataUrl;preview.alt='';preview.className='asset-preview';item.append(preview);}
        item.append(make('strong',asset.name),make('small',`${asset.format.toUpperCase()} · ${asset.author} · ${asset.license.spdx}`));
        const source=document.createElement('a');source.textContent='Источник';source.className='source-link';source.href=asset.communityUrl||asset.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';item.append(source);
        if(asset.available!==false && asset.format==='fig')item.append(button('Импортировать Figma',async()=>{
          await nativeEditor.flush();
          const result=await nativeBridge.call('canvas_community_file',{assetId:asset.id});
          const file=result._meta?.communityFile;if(!file)throw Error('Не удалось прочитать исходник Figma.');
          const bytes=Uint8Array.from(atob(file.body),c=>c.charCodeAt(0));
          const transfer=new DataTransfer();transfer.items.add(new File([bytes],file.name,{type:'application/octet-stream'}));
          document.getElementById('op').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
          nativeEditor.status('Исходник передан импортёру Figma. Дождитесь результата на холсте.');
        }));
        else if(asset.available!==false && asset.importMode!=='reference-only')item.append(button('Добавить на холст',async()=>{
          await nativeEditor.flush();const current=await nativeEditor.call('canvas_status');
          const args={assetId:asset.id,expectedVersion:current.version,pageId:current.selection.pageId};
          if(asset.importMode==='image'){
            if(current.selection.count!==1)throw Error('Выделите один слой изображения для замены.');
            args.nodeId=current.selection.nodeIds[0];
          }
          await nativeEditor.call('canvas_community_import',args);
          nativeEditor.status('Ресурс добавлен в проект');
        }));
        else item.append(make('small',asset.available===false?'Лицензия или файл повреждены. Повторите получение ресурса через Codex.':'Файл сохранён локально. Для редактирования нужен поддерживаемый импорт формата.'));
        results.append(item);
      }
    }
    search.append(input,button('Найти',load));drawer.append(search);
    const request=async(seed=false)=>{
      if(!nativeBridge.capabilities.message?.text)throw Error('Напишите запрос на поиск ресурсов в этом чате.');
      const text=seed?'Добавь стартовые иконки Lucide в локальную библиотеку OpenBrush этого проекта через canvas_community_seed.':'Найди в Figma Community '+(input.value.trim()||'подходящие иконки и UI Kit для текущего проекта')+'. Проверь источник и лицензию, скачай доступные ресурсы в локальный датасет OpenBrush этого проекта. Используй workflow Community из навыка OpenBrush. Не ограничивайся ссылками.';
      const result=await nativeBridge.request('ui/message',{role:'user',content:[{type:'text',text}]});
      if(result?.isError)throw Error('Codex не принял запрос.');
      nativeEditor.status('Запрос передан в этот чат');
    };
    drawer.append(button('Найти в Figma Community',()=>request()),button('Добавить иконки Lucide',()=>request(true)),button('Обновить библиотеку',load),results);
    await load();
  }
  return {open};
})();
