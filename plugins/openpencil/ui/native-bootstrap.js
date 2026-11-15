(async()=>{
 const status=document.getElementById('boot-status'),canvas=document.getElementById('op');
 const fail=e=>{status.textContent=String(e?.message||e);document.documentElement.dataset.opNative='error';};
 try{
  const host=await nativeBridge.init();
  const session=await nativeBridge.call('open_canvas',{});
  const theme=['light','dark'].includes(host.hostContext?.theme)?host.hostContext.theme:'dark';
  document.documentElement.dataset.theme=theme;
  status.textContent='Загрузка исходного движка OpenPencil…';
  const url=new URL(location.href);url.searchParams.set('locale','ru');url.searchParams.set('theme',theme);url.searchParams.set('chat','host');url.searchParams.set('embed','codex');
  history.replaceState(null,'',url);
  const [engineBytes,ckBytes]=await Promise.all([unpack(OP_BINARIES.engine),unpack(OP_BINARIES.canvaskit)]);
  // CanvasKit and the wasm-bindgen module are the exact existing runtime.
  const initializeCanvasKit=window.CanvasKitInit;
  window.CanvasKitInit=options=>initializeCanvasKit({...options,wasmBinary:new Uint8Array(ckBytes)});
  const resize=()=>{const dpr=Math.min(devicePixelRatio||1,Math.max(1,Math.sqrt(4000000/(innerWidth*innerHeight))));canvas.width=Math.round(innerWidth*dpr);canvas.height=Math.round(innerHeight*dpr);canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px';window.__opCanvasScale=dpr;};
  resize();await OpenPencilEngine.init({module_or_path:engineBytes});
  nativeEditor.configure(session);
  status.textContent='Запуск полного редактора…';
  await OpenPencilEngine.mount('op');
  document.documentElement.dataset.opNative='ready';document.getElementById('boot').hidden=true;

 }catch(e){fail(e);}
})();
