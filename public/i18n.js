import {english,fragments} from './i18n-strings.js';
const replacements=Object.entries({...fragments,...english}).sort((a,b)=>b[0].length-a[0].length);
// Match original UI copy in one pass. Never translate translated output again.
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const matcher=new RegExp(replacements.map(([s])=>escape(s)).join('|'),'g');
const dictionary=new Map(replacements);
export function translate(text,locale='ko'){
 if(locale!=='en')return text;
 const trimmed=text.trim();
 if(english[trimmed])return text.replace(trimmed,english[trimmed]);
 text=text.replace(/^(.+) 내장 음성을 생성하고 있어요 · 첫 로딩은 수 분 걸릴 수 있어요$/, '$1 is generating native audio · First loading may take a few minutes')
  .replace(/^(.+)이 음성을 이해하고 차량 명령을 판단하고 있어요 · 첫 로딩은 수 분 걸릴 수 있어요$/, '$1 is interpreting audio and planning vehicle commands · First loading may take a few minutes')
  .replace(/^(음성|판단) 모델 전환·로딩에 ([0-9.]+)초 걸렸어요. 다음 요청부터는 로딩 시간을 제외하고 비교할 수 있어요\.$/, (_,kind,seconds)=>`${kind==='음성'?'Audio':'Planner'} model loading took ${seconds} s. Subsequent requests can be compared without loading time.`);
 return text.replace(matcher,s=>dictionary.get(s))
  .replace(/(\d+(?:\.\d+)?)점/g,'$1 pts').replace(/(\d+(?:\.\d+)?)초/g,'$1 s')
  .replace(/(\d+)단/g,'Level $1').replace(/(\d+)건/g,'$1 cases');
}
export function initialLocale(search='',saved=null){const query=new URLSearchParams(search).get('lang');return ['ko','en'].includes(query)?query:['ko','en'].includes(saved)?saved:'ko';}

if(typeof document!=='undefined'){
 let saved;try{saved=localStorage.getItem('vehicle-voice-ui-language');}catch{}
 let locale=initialLocale(location.search,saved),scheduled=false;
 const originals=new WeakMap(),attributeOriginals=new WeakMap();
 const attributes=['aria-label','title','placeholder','data-label'];
 function excluded(element){
  if(!element||element.closest('script,style,[data-no-translate],.evaluation-detail'))return true;
  const message=element.closest('.bubble.user,.bubble.assistant');
  if(message&&!element.closest('.label,.tool-result'))return true;
  // A destination is user data; only the initial UI placeholder is translated.
  if(element.id==='destination'&&!['어디로 갈까요?','Where to?'].includes(element.textContent))return true;
  return false;
 }
 function apply(){
  scheduled=false;
  document.documentElement.lang=locale;
  document.title=translate('온 · 차량 음성 랩',locale);
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
   const node=walker.currentNode;if(excluded(node.parentElement)||!node.data.trim())continue;
   const previous=originals.get(node),source=previous&&node.data===previous.output?previous.source:node.data;
   const output=translate(source,locale);originals.set(node,{source,output});if(node.data!==output)node.data=output;
  }
  for(const element of document.querySelectorAll('[aria-label],[title],[placeholder],[data-label]')){
   if(excluded(element))continue;
   let states=attributeOriginals.get(element);if(!states){states={};attributeOriginals.set(element,states);}
   for(const name of attributes){if(!element.hasAttribute(name))continue;const value=element.getAttribute(name),old=states[name],source=old&&old.output===value?old.source:value,output=translate(source,locale);states[name]={source,output};if(value!==output)element.setAttribute(name,output);}
  }
  const select=document.getElementById('ui-language');if(select)select.value=locale;
 }
 function schedule(){if(!scheduled){scheduled=true;queueMicrotask(apply);}}
 // UI is rendered by several independent modules and streaming status updates.
 // Keep original copy per text node so switches are reversible without reloads,
 // state resets or modification of user/model conversation data. The app listens
 // for explicit locale changes to reconnect speech with the selected language.
 new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:attributes});
 document.getElementById('ui-language')?.addEventListener('change',event=>{
  locale=event.target.value==='en'?'en':'ko';try{localStorage.setItem('vehicle-voice-ui-language',locale);}catch{}
  const url=new URL(location.href);url.searchParams.set('lang',locale);history.replaceState(null,'',url);apply();
  document.dispatchEvent(new CustomEvent('vehicle-ui-language',{detail:{locale}}));
 });
 apply();
}
