(async()=>{
 const status=document.getElementById('boot-status'),canvas=document.getElementById('op');
 const fail=e=>{status.textContent=String(e?.message||e);document.documentElement.dataset.opNative='error';};
 try{
  const host=await nativeBridge.init();
  status.textContent='Подключение к холсту этого чата…';
  const session=await nativeBridge.openSession();
  const theme=['light','dark'].includes(host.hostContext?.theme)?host.hostContext.theme:'dark';
  document.documentElement.dataset.theme=theme;
  status.textContent='Загрузка редактора OpenBrush…';
  const url=new URL(location.href);url.searchParams.set('locale','ru');url.searchParams.set('theme',theme);url.searchParams.set('chat','host');url.searchParams.set('embed','codex');
  history.replaceState(null,'',url);
  const uiFont = localFetch('/pkg/assets/fonts/Inter-VF.ttf')
   .then(response => response.ok ? response.arrayBuffer() : Promise.reject(Error('Inter unavailable')))
   .then(bytes => new FontFace('Inter', bytes, {weight:'100 900'}).load())
   .then(font => document.fonts.add(font)).catch(() => {});
  const [engineBytes,ckBytes]=await Promise.all([unpack(OP_BINARIES.engine),unpack(OP_BINARIES.canvaskit)]);
  // CanvasKit and the wasm-bindgen module are the exact existing runtime.
  const initializeCanvasKit=window.CanvasKitInit;
  window.CanvasKitInit=options=>initializeCanvasKit({...options,wasmBinary:new Uint8Array(ckBytes)});
  const resize=()=>{const box=document.getElementById('editor-viewport');const w=box.clientWidth,h=box.clientHeight;const dpr=Math.min(devicePixelRatio||1,Math.max(1,Math.sqrt(4000000/(w*h))));canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+'px';canvas.style.height=h+'px';window.__opCanvasScale=dpr;};
  resize();await OpenPencilEngine.init({module_or_path:engineBytes});
  nativeEditor.configure(session);
  status.textContent='Запуск полного редактора…';
  await OpenPencilEngine.mount('op');
  await uiFont;
  document.documentElement.dataset.opNative='ready';document.getElementById('boot').hidden=true;

 }catch(e){fail(e);}
})();
