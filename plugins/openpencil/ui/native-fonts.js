// Font files live in the shared cache; this panel shows readiness, not binaries.
const nativeFonts = (()=>{
  async function section({drawer,make,button}) {
    const details=make('details',null,'library-fonts'),summary=make('summary','Шрифты');
    const state=make('p','Шрифты определяются по макету и подключаются автоматически.'),rows=make('div'),saved=make('div');
    details.append(summary,state,rows);
    function render(data) {
      const labels={checking:'Проверяем шрифты макета…',loading:'Загружаем и подключаем нужные шрифты…',ready:'Шрифты макета подключены',partial:'Некоторые начертания или символы недоступны',disabled:'Автозагрузка отключена в настройках библиотеки',unsupported:'Обновите runtime для автоподгрузки шрифтов',error:'Не удалось подключить часть шрифтов',idle:'Шрифты определяются автоматически'};
      state.textContent=labels[data.status] || 'Состояние шрифтов неизвестно';
      if(data.error)state.append(make('span',' · '+data.error));
      if(data.native?.browser && data.status==='ready'&&!data.native.browser.ready)state.append(make('span',' · холст загружает файлы'));
      rows.replaceChildren();
      for(const family of data.families || []) {
        if (family.status === 'partial' || family.status === 'unavailable') {
          const missing = (family.missingFaces || []).map(face => face.weight + (face.style === 'italic' ? ' курсив' : ''));
          const fallback = make('div', null, 'library-font-substitutions');
          fallback.hidden = true;
          for (const face of family.nearestFaces || []) fallback.append(make('p',
            family.family + ' · ' + face.requestedWeight + ' → ' + face.availableWeight + (face.style === 'italic' ? ' · курсив' : '')));
          const actions = [];
          if (family.nearestFaces?.length) {
            const reveal = button('Показать замену', () => {
              fallback.hidden = !fallback.hidden;
              reveal.querySelector('button').setAttribute('aria-expanded', String(!fallback.hidden));
            });
            reveal.querySelector('button').setAttribute('aria-expanded', 'false');
            actions.push(reveal, fallback);
          }
          const description = ['Исходное название шрифта сохранено.'];
          if (missing.length) description.push('Недоступные начертания: ' + missing.join(', ') + '.');
          if (family.missingCodepointCount) description.push('Недоступно символов: ' + family.missingCodepointCount + '.');
          if (family.error) description.push(family.error);
          let panel;
          panel = nativeLibraryState({make, button}, {kind:'font', title:'Шрифты макета', badge:'Нужна замена',
            heading:family.status === 'unavailable' ? family.family + ' недоступен' : 'Частично доступен ' + family.family,
            description:description.join('\n'), actions, onClose:() => { panel.remove(); summary.focus(); }});
          rows.append(panel);
          continue;
        }
        const row=make('p');row.append(make('strong',family.family),make('span',family.status==='ready'?' · готов':' · '+(family.status==='disabled'?'автозагрузка отключена':'ожидание')));
        if(family.missingFaces?.length)row.append(make('small',' Не найдены: '+family.missingFaces.map(f=>`${f.weight} ${f.style==='italic'?'курсив':''}`).join(', ')));
        rows.append(row);
      }
    }
    details.append(button('Проверить шрифты макета',async()=>{state.textContent='Определяем нужные шрифты…';render(await nativeEditor.call('canvas_fonts_prepare'));}),
      button('Обновить состояние',async()=>render(await nativeEditor.call('canvas_fonts_status'))));
    let offset=0;
    const list=async()=>{
      const result=await nativeEditor.call('canvas_fonts_library',{offset,limit:32});
      if(!offset)saved.replaceChildren();
      for(const family of result.families || [])saved.append(make('p',`${family.family} · файлов: ${family.availableFaces} · ${family.license?.spdx || 'источник недоступен'}`));
      offset+=result.families?.length || 0;
      if(!result.total)saved.append(make('p','Шрифты появятся здесь после первого использования.'));
      next.hidden=!result.hasMore;
    };
    const next=button('Ещё шрифты',list);next.hidden=true;
    details.append(button('Шрифты в общей библиотеке',async()=>{offset=0;await list();}),saved,next);
    drawer.append(details);
    try {render(await nativeEditor.call('canvas_fonts_status'));}catch(error){state.textContent=error.message;}
  }
  return {section};
})();
