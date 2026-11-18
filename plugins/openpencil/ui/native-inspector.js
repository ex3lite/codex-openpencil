// Values and changes come from the active Rust selection, including undo and autosave.
const nativeInspector = (() => {
  const body = document.getElementById('workspace-text-properties');
  const switcher = document.getElementById('workspace-property-mode');
  const fields = [...body.querySelectorAll('[data-property]')];
  const palette=document.getElementById('inspector-color-palette');
  let selection, advanced = false, edit;
  function paint() {
    const available = Boolean(selection?.fields);
    body.hidden = !available || advanced;
    if(body.hidden && palette.matches(':popover-open'))palette.hidePopover();
    switcher.hidden = !available;
    switcher.textContent = advanced ? 'Основные свойства текста' : 'Все свойства текста';
    if (!available) return;
    for (const input of fields) {
      const key = input.dataset.property;
      if (edit?.input !== input) input.value = selection.fields[key];
    }
    const bindings = selection.fields.bindings || [];
    document.getElementById('workspace-style-binding').textContent = bindings.join(', ') || 'Локальные значения';
    const fill = selection.fields.fill;
    body.style.setProperty('--inspected-color', /^#[a-f\d]{6,8}$/i.test(fill) ? fill : 'transparent');
  }
  switcher.onclick = () => { advanced = !advanced; paint(); };
  for(const choice of palette.querySelectorAll('[data-color-token]')){
    choice.onclick=()=>{
      if(!selection?.fields)return;
      const value=getComputedStyle(choice).getPropertyValue('--ob-'+choice.dataset.colorToken).trim();
      if(!/^#[a-f0-9]{6}$/i.test(value))return;
      nativeEditor.send({type:'op-bridge/edit-text-property',id:selection.id,page:selection.page,generation:selection.generation,
        field:'fill',before:selection.fields.fill,value:value+selection.fields.fill.slice(7)});
    };
  }
  for (const input of fields) {
    input.addEventListener('focus', () => {
      if (!selection?.fields) return;
      const field = input.dataset.property;
      edit = {input, field, id:selection.id, generation:selection.generation, page:selection.page, before:selection.fields[field]};
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { input.value = edit?.before ?? input.value; input.blur(); }
      else if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    });
    input.addEventListener('blur', () => {
      if (edit?.input !== input) return;
      const {input:control, ...intent} = edit;
      const value = control.value.trim();
      edit = undefined;
      if (value === intent.before) {paint();return;}
      if (!value || !control.checkValidity()) {
        nativeEditor.status('Проверьте значение поля «' + control.getAttribute('aria-label') + '».', true);
        paint(); return;
      }
      nativeEditor.send({type:'op-bridge/edit-text-property',...intent,value});
    });
  }
  nativeEditor.onEvent(event => {
    if (event.type === 'op-shell/property-rejected') {
      nativeEditor.status('Свойство или выделение изменилось. Проверьте текущее значение.',true);
    }
    if (event.type !== 'op-shell/text-properties') return;
    if (event.id !== selection?.id || event.page !== selection?.page || event.generation !== selection?.generation || !event.fields) {
      edit = undefined;
      if(palette.matches(':popover-open'))palette.hidePopover();
      if (body.contains(document.activeElement)) document.activeElement.blur();
      body.scrollTop = 0; advanced = false;
    }
    selection = event; paint();
  });
})();

// Apply the authored compact layout once on entry. Later clicks belong to the user.
(() => {
  const compact = matchMedia('(max-width: 1040px)');
  const narrow = matchMedia('(max-width: 660px)');
  let panels, pendingInspector = compact.matches, pendingLayers = narrow.matches;
  function apply() {
    if (!panels || !nativeEditor.ready || document.documentElement.dataset.preview === 'true') return;
    const actions = [];
    if (pendingInspector && compact.matches && panels.inspector) actions.push('toggle-inspector');
    if (pendingLayers && narrow.matches && panels.layers) actions.push('toggle-sidebar');
    pendingInspector = pendingLayers = false;
    for (const action of actions) nativeEditor.send({type:'op-bridge/'+action});
  }
  compact.addEventListener('change',()=>{pendingInspector=compact.matches;queueMicrotask(apply);});
  narrow.addEventListener('change',()=>{pendingLayers=narrow.matches;queueMicrotask(apply);});
  nativeEditor.onEvent(event=>{
    if(event.type==='op-shell/panels-state') panels=event;
    if(event.type==='op-shell/panels-state'||event.type==='op-bridge/ready')queueMicrotask(apply);
  });
})();
