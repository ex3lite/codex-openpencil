// Values and changes come from the active Rust selection, including undo and autosave.
const nativeInspector = (() => {
  const body = document.getElementById('workspace-text-properties');
  const switcher = document.getElementById('workspace-property-mode');
  const fields = [...body.querySelectorAll('[data-property]')];
  const palette = document.getElementById('inspector-color-palette');
  const choices = [...palette.querySelectorAll('[data-color-token]')];
  const empty = document.getElementById('workspace-inspector-empty');
  const binding = document.getElementById('workspace-style-binding');
  let selection, advanced = false, edit;

  function hexColor(value) {
    const digits = String(value).trim().replace(/^#/, '');
    return /^(?:[a-f0-9]{6}|[a-f0-9]{8})$/i.test(digits) ? '#' + digits.toUpperCase() : '';
  }
  function paintColor(fill, alpha) {
    const color = hexColor(fill);
    body.style.setProperty('--inspected-color', color || 'transparent');
    body.style.setProperty('--inspected-opacity', String(Number(alpha) / 100));
    for (const choice of choices) {
      const swatch = getComputedStyle(choice).getPropertyValue('--swatch');
      choice.setAttribute('aria-pressed', String(hexColor(swatch) === color.slice(0, 7)));
    }
  }
  function paint() {
    const values = selection?.fields;
    body.hidden = !values || advanced;
    if (body.hidden && palette.matches(':popover-open')) palette.hidePopover();
    switcher.hidden = !values;
    switcher.textContent = advanced ? 'Основные свойства текста' : 'Все свойства текста';
    if (!values) return;
    for (const input of fields) {
      if (edit?.input === input) continue;
      const key = input.dataset.property;
      input.value = key === 'fill' ? values.fill.replace(/^#/, '') : values[key];
    }
    const bindings = values.bindings || [];
    binding.textContent = bindings.join(', ') || 'Локальные значения';
    binding.dataset.linked = String(bindings.length > 0);
    const draft = edit?.input;
    const validDraft = draft && draft.value !== '' && draft.validity.valid;
    paintColor(validDraft && edit.field === 'fill' ? draft.value : values.fill,
      validDraft && edit.field === 'alpha' ? draft.value : values.alpha);
  }
  switcher.onclick = () => { advanced = !advanced; paint(); };
  document.getElementById('inspector-empty-close').onclick = () => nativeEditor.send({type:'op-bridge/toggle-inspector'});
  for (const choice of choices) {
    choice.onclick = () => {
      if (!selection?.fields) return;
      const swatch = hexColor(getComputedStyle(choice).getPropertyValue('--swatch'));
      if (!swatch) return;
      const before = selection.fields.fill;
      const value = swatch + hexColor(before).slice(7);
      if (value === hexColor(before)) return;
      nativeEditor.send({type:'op-bridge/edit-text-property', id:selection.id, page:selection.page,
        generation:selection.generation, field:'fill', before, value});
    };
  }
  for (const input of fields) {
    input.addEventListener('focus', () => {
      if (!selection?.fields) return;
      const field = input.dataset.property;
      edit = {input, field, id:selection.id, generation:selection.generation, page:selection.page, before:selection.fields[field]};
    });
    if (['fill', 'alpha'].includes(input.dataset.property)) input.addEventListener('input', paint);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        edit = undefined;
        paint();
        input.blur();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      if (edit?.input !== input) return;
      const {input:control, ...intent} = edit;
      const value = intent.field === 'fill' ? hexColor(control.value) : control.value.trim();
      edit = undefined;
      if (value === intent.before) { paint(); return; }
      if (!value || !control.checkValidity()) {
        nativeEditor.status('Проверьте значение поля «' + control.getAttribute('aria-label') + '».', true);
        paint(); return;
      }
      nativeEditor.send({type:'op-bridge/edit-text-property', ...intent, value});
    });
  }
  nativeEditor.onEvent(event => {
    if (event.type === 'op-shell/panels-state') {
      empty.hidden = !event.inspector || event.inspectorVisible;
    }
    if (event.type === 'op-shell/property-rejected') {
      paint();
      nativeEditor.status('Свойство или выделение изменилось. Проверьте текущее значение.', true);
    }
    if (event.type !== 'op-shell/text-properties') return;
    if (event.id !== selection?.id || event.page !== selection?.page || event.generation !== selection?.generation || !event.fields) {
      edit = undefined;
      if (palette.matches(':popover-open')) palette.hidePopover();
      if (body.contains(document.activeElement)) document.activeElement.blur();
      body.scrollTop = 0; advanced = false;
    }
    selection = event;
    paint();
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
