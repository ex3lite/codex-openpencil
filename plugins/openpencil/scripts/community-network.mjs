import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export function publicHttpsUrl(value, label = 'URL') {
  let url;
  try { url = new URL(value); } catch { throw Error(`Invalid ${label}.`); }
  if (typeof value !== 'string' || value.length > 8192 || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw Error(`Use a public HTTPS ${label} without credentials, a port or a fragment.`);
  }
  return url;
}
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // Only global unicast; exclude documentation, transition and special-use ranges.
  const [first,second = '0'] = address.toLowerCase().split(':');
  const a = parseInt(first || '0',16), b = parseInt(second || '0',16);
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && a !== 0x3fff;
}
async function addressesFor(url, lookupImpl) {
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  const records = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await lookupImpl(hostname,{all:true,verbatim:true});
  if (!records.length || records.some(record => !isPublicAddress(record.address))) throw Error('Public downloads cannot access private, loopback or reserved network addresses.');
  return records;
}
function request(url, records, signal) {
  return new Promise((resolve,reject) => {
    // Pin the validated DNS answer to the connection, preventing DNS rebinding.
    const req = https.get(url,{signal,agent:false,lookup(_hostname,options,callback) {
      if(options.all) callback(null,records);
      else callback(null,records[0].address,records[0].family);
    },headers:{Accept:'application/octet-stream,text/html,image/*,text/plain','User-Agent':'OpenBrush-Community/1.0'}},response => {
      const headers = new Headers();
      for (const [key,value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key,Array.isArray(value)?value.join(', '):value);
      resolve({status:response.statusCode,ok:response.statusCode>=200 && response.statusCode<300,headers,body:response});
    });
    req.once('error',reject);
  });
}
export async function fetchPublicBytes(input,{limit=32*1024*1024,lookupImpl=lookup,fetchImpl,redirects=4}={}) {
  let url = publicHttpsUrl(input), remaining = redirects;
  const signal = AbortSignal.timeout(30000);
  while (true) {
    const records = await addressesFor(url,lookupImpl);
    const response = fetchImpl ? await fetchImpl(url.href,{redirect:'manual',signal,credentials:'omit',headers:{Accept:'application/octet-stream,text/html,image/*,text/plain'}}) : await request(url,records,signal);
    if ([301,302,303,307,308].includes(response.status)) {
      if (response.body?.destroy) response.body.destroy(); else await response.body?.cancel?.();
      if (remaining-- <= 0 || !response.headers.get('location')) throw Error('Public download redirect limit exceeded.');
      url = publicHttpsUrl(new URL(response.headers.get('location'),url).href);
      continue;
    }
    if (!response.ok) { response.body?.destroy?.(); throw Error(`Public asset download failed: HTTP ${response.status}.`); }
    if (Number(response.headers.get('content-length')) > limit) {
      if(response.body?.destroy) response.body.destroy(); else await response.body?.cancel?.();
      throw Error('Download exceeds its size limit.');
    }
    const chunks=[]; let size=0;
    for await (const chunk of response.body || []) {
      size+=chunk.length;
      if(size>limit) { response.body?.destroy?.(); throw Error('Download exceeds its size limit.'); }
      chunks.push(chunk);
    }
    if (!size) throw Error('Public download returned an empty file.');
    return {bytes:Buffer.concat(chunks),url:url.href,contentType:response.headers.get('content-type') || ''};
  }
}
