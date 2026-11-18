// Groups stay global; selecting an icon materializes only that SVG in a project.
const nativeIconPacks=(()=>{
  async function section({drawer,make,button,selectedPack}) {
    const section=make('section',null,'library-packs'),heading=make('h3','Пакеты иконок'),groups=make('div',null,'library-grid'),browser=make('div',null,'pack-browser');
    section.append(heading,make('p','Пакеты общие для всех проектов. В макет добавляются только выбранные иконки.'),groups,browser);drawer.append(section);
    const call=(name,args={})=>nativeEditor.call(name,args);
    async function add(packId,key) {
      const asset=await call('canvas_icon_pack_select',{packId,key});
      const assetId=asset.id || asset.asset?.id;if(!assetId)throw Error('Иконка не подготовлена. Обновите поиск.');
      await nativeEditor.flush();const current=await call('canvas_status');
      await call('canvas_community_import',{assetId,pageId:current.selection.pageId,expectedVersion:current.version});
      nativeEditor.status('Иконка добавлена редактируемыми слоями');
    }
    async function browse(pack) {
      browser.replaceChildren(make('h3',pack.name));
      const query=document.createElement('input');query.type='search';query.placeholder='Название: arrow, search, menu…';query.setAttribute('aria-label','Найти иконку в '+pack.name);
      const controls=make('div',null,'library-search'),style=document.createElement('select'),radius=document.createElement('select');
      style.setAttribute('aria-label','Стиль иконок');radius.setAttribute('aria-label','Форма углов');
      for(const name of pack.styles || []){const option=document.createElement('option');option.value=name;option.textContent=name;style.append(option);}
      for(const name of pack.radii || []){const option=document.createElement('option');option.value=name;option.textContent=name;radius.append(option);}
      if((pack.styles || []).includes('line'))style.value='line';if((pack.radii || []).includes('regular'))radius.value='regular';
      const results=make('div',null,'pack-icons'),count=make('p');let offset=0,requestVersion=0;
      const next=button('Следующие иконки',async()=>{offset+=24;await search();});next.hidden=true;
      async function search() {
        const version=++requestVersion;
        const result=await call('canvas_icon_pack_search',{packId:pack.id,query:query.value,style:style.value,radius:radius.value,offset,limit:24,previews:true});
        if(version!==requestVersion)return;
        results.replaceChildren();count.textContent=`Найдено: ${result.total} · Figma ID ${pack.originalCommunityId}`;
        for(const icon of result.icons) {
          const card=make('article',null,'pack-icon');
          if(icon.previewDataUrl){const image=document.createElement('img');image.src=icon.previewDataUrl;image.alt=icon.name;image.className='asset-preview';card.append(image);}
          card.append(make('small',icon.name),button('Добавить',()=>add(pack.id,icon.key)));results.append(card);
        }
        next.hidden=offset+result.icons.length>=result.total;
      }
      const reset=async()=>{offset=0;await search();};style.onchange=reset;radius.onchange=reset;
      query.onkeydown=event=>{if(event.key==='Enter')void reset().catch(error=>nativeEditor.status(error.message,true));};
      controls.append(query,style,radius,button('Найти',reset));browser.append(controls,count,results,next);await search();
    }
    async function load() {
      const result=await call('canvas_icon_pack_list',{previews:true});groups.replaceChildren();
      for(const pack of result.packs) {
        const card=make('article',null,'library-card'),cover=make('div',null,'library-cover');
        if(pack.coverDataUrl){const image=document.createElement('img');image.src=pack.coverDataUrl;image.alt='Обложка '+pack.name;image.className='library-cover-image';cover.append(image);}
        else cover.append(make('span','Оригинальная обложка недоступна','library-cover-empty'));
        const body=make('div',null,'library-card-body'),actions=make('div',null,'library-card-actions');
        body.append(make('small','Пакет иконок · '+(pack.licenseSpdx || 'источник проверяется'),'library-card-kind'),make('strong',pack.name,'library-card-title'));
        if(pack.installed)body.append(make('small',`${pack.iconCount?.toLocaleString('ru-RU')} иконок · ${pack.count?.toLocaleString('ru-RU')} вариантов · ${pack.revision}`,'library-card-index'));
        body.append(make('small','Figma ID '+pack.originalCommunityId,'library-card-author'));
        const source=document.createElement('a');source.textContent='Figma Community';source.href=pack.communityUrl;source.target='_blank';source.rel='noopener noreferrer';source.className='source-link';actions.append(source);
        if(pack.installed&&pack.available!==false) {
          actions.append(button('Найти иконку',()=>browse(pack)),button('Проверить обновления',async()=>{
            const update=await call('canvas_icon_pack_check',{packId:pack.id});
            if(!update.updateAvailable){nativeEditor.status('Установлена актуальная версия '+update.currentRevision);return;}
            nativeEditor.status('Доступна версия '+update.latestRevision);
            actions.append(button('Обновить библиотеку',async()=>{await call('canvas_icon_pack_update',{packId:pack.id,expectedRevision:update.currentRevision});await load();nativeEditor.status('Библиотека обновлена. Слои проектов сохранены.');}));
          }));
        } else if(pack.preset)actions.append(button('Скачать пакет',async()=>{nativeEditor.status('Загружаем полный пакет '+pack.name+'…');await call('canvas_icon_pack_acquire',{pack:pack.id});await load();nativeEditor.status('Пакет доступен во всех проектах');}));
        else body.append(make('small',pack.error || 'Источник недоступен'));
        card.append(cover,body,actions);groups.append(card);
      }
    }
    if (selectedPack) {
      groups.hidden = true;
      await browse(selectedPack);
    } else await load();
  }
  return {section};
})();
