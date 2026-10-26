import { id } from './calculations.js';
const KEY='cardFlipHQ.v1', VERSION=1;
const defaults={version:VERSION, settings:{startingCapital:0, currency:'USD', targetProfit:2000, reserve:0, fees:{eBay:13.25,Whatnot:10,Local:0}}, inventory:[],watchlist:[],transactions:[],lastBackup:null};
// JSON cloning avoids relying on structuredClone, which is unavailable on some older Mobile Safari versions.
const clone = value => JSON.parse(JSON.stringify(value));
export function load(){try { const raw=localStorage.getItem(KEY); if(!raw)return clone(defaults); const d=JSON.parse(raw); if(!d||typeof d!=='object'||Array.isArray(d))throw Error('Invalid data'); return migrate(d); }catch(e){ throw new Error('Could not read Card Flip HQ data. '+e.message); }}
function migrate(d){
  const version=Number(d.version || 1);
  if(!Number.isInteger(version) || version>VERSION) throw Error('This backup was created by a newer version of Card Flip HQ.');
  // Future migrations should transform a cloned object here, one version at a time.
  const result={...clone(defaults),...d,version:VERSION,settings:{...defaults.settings,...d.settings,fees:{...defaults.settings.fees,...d.settings?.fees}}};
  ['inventory','watchlist','transactions'].forEach(key=>{ if(!Array.isArray(result[key])) result[key]=[]; });
  return result;
}
export function save(data){try {data.version=VERSION; localStorage.setItem(KEY,JSON.stringify(data)); return true;}catch(e){throw new Error('Could not save data (storage may be unavailable or full). '+e.message);}}
export function validImport(raw){
  let d; try{d=JSON.parse(raw)}catch{throw Error('This file is not valid JSON.')}
  if(!d||typeof d!=='object'||Array.isArray(d)||!Array.isArray(d.inventory)||!Array.isArray(d.transactions)||!Array.isArray(d.watchlist)) throw Error('Backup is missing required Card Flip HQ arrays.');
  for(const key of ['inventory','watchlist','transactions']) {
    const ids=new Set();
    d[key].forEach((record,index)=>{
      if(!record||typeof record!=='object'||Array.isArray(record)) throw Error(`${key} record ${index + 1} is invalid.`);
      if(record.id) { if(typeof record.id!=='string') throw Error(`${key} record ${index + 1} has an invalid ID.`); if(ids.has(record.id)) throw Error(`Backup contains a duplicate ${key} ID: ${record.id}.`); ids.add(record.id); }
    });
  }
  return migrate(d);
}
export function merge(existing,incoming){const result=clone(existing); ['inventory','watchlist','transactions'].forEach(k=>{const used=new Set(result[k].map(x=>x.id)); incoming[k].forEach(x=>{const copy={...x};if(!copy.id||used.has(copy.id))copy.id=id(k.slice(0,3));used.add(copy.id);result[k].push(copy);});});result.settings={...result.settings,...incoming.settings};return result;}
export const backupName=()=>`card-flip-hq-backup-${new Date().toISOString().slice(0,10)}.json`;
