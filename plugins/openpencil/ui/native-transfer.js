// Binary payloads use app-only, authenticated canvas sessions in bounded chunks.
const nativeTransfer = (() => {
  const threshold = 192 * 1024;
  const progress=(label,part,total)=>{if(typeof nativeEditor!=='undefined')nativeEditor.status(`${label} · ${Math.min(100,Math.floor(part/total*100))}%`);};
  const complete=()=>{if(typeof nativeEditor!=='undefined')nativeEditor.status('');};
  const encode = bytes => {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text);
  };
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  const value = result => result._meta?.transfer || result.structuredContent;
  async function upload(call, text, kind) {
    const raw = new TextEncoder().encode(text);
    const bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const start = value(await call('canvas_transfer', { action: 'start', kind, bytes: bytes.length, rawBytes: raw.length, sha256: await hash(bytes) }));
    try {
      progress('Синхронизация набора',0,bytes.length);
      for (let offset = 0, index = 0; offset < bytes.length; offset += start.chunkBytes, index++) {
        await call('canvas_transfer', { action: 'append', id: start.id, index, data: encode(bytes.subarray(offset, offset + start.chunkBytes)) });
        progress('Синхронизация набора',Math.min(bytes.length,offset+start.chunkBytes),bytes.length);
      }
      await call('canvas_transfer', { action: 'finish', id: start.id });
      complete(); return start.id;
    } catch (error) {
      // Cleanup only; never resend a failed upload chunk or consuming mutation.
      await call('canvas_transfer', { action: 'dispose', id: start.id }).catch(() => {}); throw error;
    }
  }
  async function prepare(call, name, args) {
    if (name === 'canvas_transfer') return args;
    let next = args;
    if (typeof args.docJson === 'string' && new Blob([args.docJson]).size > threshold) {
      next = { ...next, docJson: '', snapshotToken: await upload(call, args.docJson, 'snapshot') };
    }
    if (name === 'canvas_native_request' && typeof args.body === 'string' && new Blob([args.body]).size > threshold) {
      next = { ...next, body: '', bodyToken: await upload(call, args.body, 'body') };
    }
    return next;
  }
  async function download(call, transfer) {
    if (transfer.encoding !== 'gzip' || !Number.isSafeInteger(transfer.bytes) || transfer.bytes < 1 || transfer.bytes > 256 * 1024 * 1024 + 65536) throw Error('Некорректный размер документа.');
    const bytes = new Uint8Array(transfer.bytes);
    try {
      progress('Загрузка набора',0,bytes.length);
      for (let offset = 0, index = 0; offset < bytes.length; offset += transfer.chunkBytes, index++) {
        const chunk = value(await call('canvas_transfer', { action: 'read', id: transfer.id, index }));
        const decoded = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
        if (chunk.index !== index || decoded.length !== Math.min(transfer.chunkBytes, bytes.length - offset)) throw Error('Документ передан не полностью.');
        bytes.set(decoded, offset);
        progress('Загрузка набора',Math.min(bytes.length,offset+decoded.length),bytes.length);
      }
      if (await hash(bytes) !== transfer.sha256) throw Error('Контрольная сумма документа не совпадает.');
      // Count decompressed bytes before exposing a complete response to Rust/WASM.
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const parts = []; let size = 0;
      for (;;) {
        const { value: chunk, done } = await reader.read(); if (done) break;
        size += chunk.length;
        if (size > transfer.rawBytes) { await reader.cancel(); throw Error('Документ превышает заявленный размер.'); }
        parts.push(chunk);
      }
      if (size !== transfer.rawBytes) throw Error('Документ передан не полностью.');
      complete(); return new Blob(parts);
    } finally { await call('canvas_transfer', { action: 'dispose', id: transfer.id }).catch(() => {}); }
  }
  return { prepare, download };
})();
