// Remote catalog queries stay in MCP; browsing does not attach data to chat.
const nativeCommunityCatalog=(()=>{
  async function section({drawer,make,button,onAcquire}) {
    const section=make('section',null,'community-catalog'),heading=make('h3','Figma Community'),form=make('div',null,'library-search'),input=document.createElement('input');
    input.type='search';input.placeholder='UI Kit, Apple landing page, icons…';input.setAttribute('aria-label','Поиск в Figma Community');
    const state=make('p','Поиск по настоящему каталогу Figma. Найденное можно сохранить в общую библиотеку.'),results=make('div',null,'library-grid');let serial=0;
    async function search(){
      const current=++serial;state.textContent='Ищем в Figma Community…';results.replaceChildren();
      try {
        const response=await nativeEditor.call('canvas_community_catalog_search',{query:input.value.trim(),limit:8});
        if(current!==serial)return;
        state.textContent=response.results.length?'Найдено ресурсов: '+response.results.length:'По этому запросу ресурсов не найдено.';
        const previews=[];
        for(const resource of response.results){
          const card=make('article',null,'library-card'),cover=make('div',null,'library-cover'),body=make('div',null,'library-card-body'),actions=make('div',null,'library-card-actions');
          cover.append(make('span','Загружаем обложку Figma…','library-cover-empty'));
          body.append(make('small','Figma Community · '+resource.resourceId,'library-card-kind'),make('strong',resource.title,'library-card-title'));
          if(resource.author)body.append(make('small',resource.author,'library-card-author'));
          const link=make('a','Источник','source-link');link.href=resource.url;link.target='_blank';link.rel='noopener noreferrer';actions.append(link);
          actions.append(button('Сохранить референс',async()=>{
            state.textContent='Получаем оригинал и условия использования…';
            const acquired=await nativeEditor.call('canvas_community_catalog_acquire',{resourceId:resource.resourceId,mode:'reference'});
            state.textContent='Референс сохранён в общей библиотеке и добавлен в проект.';nativeEditor.status('Сохранён референс «'+acquired.card.title+'»');if(onAcquire)await onAcquire();
          }));
          card.append(cover,body,actions);results.append(card);previews.push({resource,cover});
        }
        for(const {resource,cover} of previews){
          if(current!==serial)return;
          try {const preview=await nativeEditor.call('canvas_community_catalog_cover',{resourceId:resource.resourceId});if(current!==serial)return;const image=document.createElement('img');image.src=preview.coverDataUrl;image.alt='Обложка '+resource.title;image.className='library-cover-image';cover.replaceChildren(image);}
          catch {cover.replaceChildren(make('span','Оригинальная обложка недоступна','library-cover-empty'));}
        }
      }catch(error){if(current===serial)state.textContent=error.message;}
    }
    form.append(input,button('Искать в Community',search));input.onkeydown=event=>{if(event.key==='Enter')void search();};
    section.append(heading,form,state,results);drawer.append(section);
    return {search(query){input.value=query;return search();}};
  }
  return {section};
})();
