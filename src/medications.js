import { t } from './i18n.js';
import { PROFILES, SOURCES } from './pk.js';
import catalog from './medication-catalog.json' with { type: 'json' };

const links = {
  feminizing:{title:'UCSF 女性化 GAHT 制剂与证据',url:'https://transcare.ucsf.edu/guidelines/feminizing-hormone-therapy'},
  masculinizing:{title:'UCSF 男性化 GAHT 制剂与证据',url:'https://transcare.ucsf.edu/guidelines/masculinizing-therapy'},
  evOral:{title:'Progynova 戊酸雌二醇口服片 SmPC',url:'https://www.medicines.org.uk/emc/product/1417/smpc'},
  spray:{title:'Lenzetto 雌二醇喷雾 SmPC',url:'https://www.medicines.org.uk/emc/product/11175/smpc'},
  cpa:{title:'Androcur 醋酸环丙孕酮 SmPC',url:'https://www.medicines.org.uk/emc/product/15996/smpc'},
  e2:{title:'Zumenon 雌二醇片 SmPC',url:'https://www.medicines.org.uk/emc/product/1174/smpc'},
  depot:SOURCES.depot,
};
export const ADMINISTRATIONS=Object.freeze(catalog.administrations.map(a=>Object.freeze({...a,get name(){return t(a.name);}})));
export const MEDICATIONS=Object.freeze(catalog.items.map(item=>{
  const p=PROFILES.find(p=>p.id===item.id),a=ADMINISTRATIONS.find(a=>a.id===item.administrationId);
  return Object.freeze({model:'record-only',defaults:Object.freeze({}),unit:'mg',doseUnit:'mg',offLabel:false,...p,...item,
    get name(){return `${t(item.drugName)} · ${a.name}`;},get drugName(){return t(item.drugName);},get brands(){return t(item.brands);},icon:a.icon,
    get note(){return [item.note?t(item.note):'',p?.note,!p?t('该组合暂未核准浓度模型；支持记录与提醒。'):''].filter(Boolean).join(' ');},get evidence(){return p?.evidence || '';},
    get sources(){return (p?.sources??[links[item.sourceKey]].filter(Boolean)).map(source=>({...source,title:t(source.title)}));}});
}));
export const getMedication=id=>MEDICATIONS.find(p=>p.id===id)??null;
export const medicationsForAdministration=id=>MEDICATIONS.filter(p=>p.administrationId===id);
