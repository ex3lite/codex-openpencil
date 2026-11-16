import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function communitySettings(directory, changes = {}) {
  if(changes.verifyLicenses !== undefined && typeof changes.verifyLicenses !== 'boolean') throw Error('verifyLicenses must be a boolean.');
  if (Object.keys(changes).some(key => key !== 'verifyLicenses') ||
      (changes.verifyLicenses !== undefined && typeof changes.verifyLicenses !== 'boolean')) throw Error('Invalid Community settings.');
  const path = join(directory,'settings.json');
  let settings = {verifyLicenses:true};
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
    if (raw.schemaVersion !== 1 || typeof raw.verifyLicenses !== 'boolean') throw Error('Invalid Community settings file.');
    settings={verifyLicenses:raw.verifyLicenses};
  } catch (error) { if(error.code!=='ENOENT') throw error; }
  if (changes.verifyLicenses === undefined) return settings;
  const lockPath=join(directory,'.settings-lock');
  let lock;
  try { lock=await open(lockPath,'wx',0o600); }
  catch(error) { if(error.code==='EEXIST') throw Error('Another Community settings writer is active.'); throw error; }
  const temp=join(directory,`settings.${randomUUID()}.tmp`);
  try {
    settings.verifyLicenses=changes.verifyLicenses;
    const file=await open(temp,'wx',0o600);
    try { await file.writeFile(JSON.stringify({schemaVersion:1,...settings})+'\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temp,path);
    return settings;
  } finally { await rm(temp,{force:true}); await lock.close(); await rm(lockPath,{force:true}); }
}
