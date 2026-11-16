import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function communitySettings(directory, changes = {}, defaults = {verifyLicenses:true,autonomous:true}) {
  if(changes.verifyLicenses !== undefined && typeof changes.verifyLicenses !== 'boolean') throw Error('verifyLicenses must be a boolean.');
  if (Object.keys(changes).some(key => !['verifyLicenses','autonomous'].includes(key)) ||
      (changes.verifyLicenses !== undefined && typeof changes.verifyLicenses !== 'boolean')) throw Error('Invalid Community settings.');
  if(changes.autonomous !== undefined && typeof changes.autonomous !== 'boolean') throw Error('autonomous must be a boolean.');
  const path = join(directory,'settings.json');
  let settings = {...defaults}, stored = {};
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid Community settings file.');
    const file = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let raw;
    try {
      const current=await file.stat();
      if(current.ino!==info.ino || current.dev!==info.dev || current.size>4096) throw Error('Community settings changed while opening.');
      raw=JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (raw.schemaVersion !== 1 || (raw.verifyLicenses !== undefined && typeof raw.verifyLicenses !== 'boolean')) throw Error('Invalid Community settings file.');
    if(raw.autonomous!==undefined && typeof raw.autonomous!=='boolean') throw Error('Invalid Community settings file.');
    stored={...(raw.verifyLicenses!==undefined && {verifyLicenses:raw.verifyLicenses}),...(raw.autonomous!==undefined && {autonomous:raw.autonomous})};
    settings={...defaults,...stored};
  } catch (error) { if(error.code!=='ENOENT') throw error; }
  if (!Object.keys(changes).length) return settings;
  const lockPath=join(directory,'.settings-lock');
  let lock;
  try { lock=await open(lockPath,'wx',0o600); }
  catch(error) { if(error.code==='EEXIST') throw Error('Another Community settings writer is active.'); throw error; }
  const temp=join(directory,`settings.${randomUUID()}.tmp`);
  try {
    settings={...settings,...changes};
    const file=await open(temp,'wx',0o600);
    try { await file.writeFile(JSON.stringify({schemaVersion:1,...stored,...changes})+'\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temp,path);
    return settings;
  } finally { await rm(temp,{force:true}); await lock.close(); await rm(lockPath,{force:true}); }
}
