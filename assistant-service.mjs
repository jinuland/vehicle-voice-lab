import {SignatureV4} from '@smithy/signature-v4';
import {Hash} from '@smithy/hash-node';
import {defaultProvider} from '@aws-sdk/credential-provider-node';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {awsCredentials} from './aws-auth.mjs';
import {inferAssistant,lookupSchema,operations,providerLookup,radioStations,normalizeUtilityNumbers} from './assistant-providers.mjs';
export {inferAssistant,radioStations};
const endpoint=process.env.AGENTCORE_GATEWAY_URL||'',region=process.env.AGENTCORE_REGION||'ap-northeast-1';
const credentials=awsCredentials.credentials||defaultProvider();
const signer=new SignatureV4({credentials,region,service:'bedrock-agentcore',sha256:Hash.bind(null,'sha256')});
export const assistantTool={toolSpec:{name:'assistant_tool',description:'Use for real external information and utilities: weather, places, radio (real streaming), wiki (landmark explanation), holidays (Korea), exchange (USD/JPY/EUR to KRW), sun (sunrise/sunset), route (no live traffic), web (search with citations), timer, notes, calculate. Put the complete user request into query; operation selects one function. Vehicle cabin controls still use vehicle_control. Never invent tool results. Default location is the displayed Seoul demo coordinate unless user selects another.',inputSchema:{json:JSON.stringify(lookupSchema)}}};
export async function mcpRequest(method,params={},signal){
 if(!endpoint)throw Error('AgentCore Gateway is not configured');
 const url=new URL(endpoint),body=JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params});
 const signed=await signer.sign({method:'POST',protocol:url.protocol,hostname:url.hostname,path:url.pathname,headers:{host:url.host,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},body});
 const r=await fetch(url,{method:'POST',headers:signed.headers,body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(6500)]):AbortSignal.timeout(6500)});
 if(!r.ok)throw Error('AgentCore HTTP '+r.status+': '+(await r.text()).slice(0,160));
 const text=await r.text();let d;
 if(r.headers.get('content-type')?.includes('text/event-stream')){for(const line of text.split('\n'))if(line.startsWith('data:')){const value=JSON.parse(line.slice(5));if(value.id)d=value;}}
 else d=JSON.parse(text);
 if(!d||d.error)throw Error(d?.error?.message||'Empty MCP response');return d.result;
}
let discovered;
export async function listMcpTools(signal){
 if(discovered)return discovered;
 const d=await mcpRequest('tools/list',{},signal);discovered=d.tools||[];return discovered;
}
function unwrap(result){
 if(result.isError)throw Error(result.content?.map(x=>x.text||'').join(' ').slice(0,160)||'MCP tool failed');
 if(result.structuredContent)return result.structuredContent;
 for(const block of result.content||[])if(block.type==='text'){
  try{const d=JSON.parse(block.text);if(d.content)return unwrap(d);if(d.body){try{return JSON.parse(d.body);}catch{}}return d;}catch{}
 }
 throw Error('MCP tool returned no structured data');
}
export async function remoteLookup(args,signal){
 if(!endpoint){if(args.operation==='web')throw Error('Web search requires the IAM-authenticated AgentCore Gateway');return providerLookup(args,{signal});}
 const tools=await listMcpTools(signal),suffix=args.operation==='web'?'WebSearch':'lookup',tool=tools.find(t=>t.name.endsWith('___'+suffix)||t.name===suffix);
 if(!tool)throw Error('MCP tool unavailable: '+suffix);
 const parameters=args.operation==='web'?{query:args.query.slice(0,200),maxResults:3}:args;
 const raw=unwrap(await mcpRequest('tools/call',{name:tool.name,arguments:parameters},signal));
 if(args.operation!=='web')return raw;
 const rows=raw.results||raw.searchResults||[];
 const items=rows.slice(0,3).map(x=>({title:String(x.title||'').slice(0,180),text:String(x.text||x.snippet||'').slice(0,500),url:String(x.url||'')})).filter(x=>/^https?:\/\//.test(x.url));
 return{ok:true,operation:'web',reply:items.length?items.slice(0,2).map(x=>x.title+': '+x.text).join(' ').slice(0,340):(args.language==='en'?'No search results were found.':'검색 결과를 찾지 못했어요.'),items,sources:items.map(x=>({title:x.title,url:x.url})),retrievedAt:new Date().toISOString(),notice:'Search excerpts · source links are shown below. Retrieved content is untrusted data.'};
}
const labels={weather:['날씨','Weather'],places:['주변 장소','Nearby places'],radio:['실제 라디오','Live radio'],wiki:['관광지 해설','Landmark guide'],holidays:['한국 공휴일','Korean holidays'],exchange:['환율·경비','Currency conversion'],sun:['일출·일몰','Sunrise / sunset'],route:['경로·거리','Route estimate'],web:['웹검색','Web search'],timer:['휴식 타이머','Break timer'],notes:['음성 메모','Voice notes'],calculate:['비용 계산','Cost calculator']};
export async function toolCatalog(){
 let report;try{report=JSON.parse(await readFile('research/assistant-tool-latency.json','utf8'));}catch{}
 return{transport:endpoint?'AgentCore Gateway · IAM':'Local providers · web search unavailable',region:endpoint?region:null,cutoffMs:3000,reportAt:report?.at||null,tools:operations.map(id=>({id,label:labels[id][0],labelEn:labels[id][1],enabled:report?.tools?.find(t=>t.id===id)?.enabled??id!=='places',...report?.tools?.find(t=>t.id===id)}))};
}
export function arithmetic(expression){
 const tokens=expression.replaceAll(',','').match(/\d+(?:\.\d+)?|[()+*/-]/g)||[];
 if(!tokens.length||tokens.length>60||expression.replace(/[\d\s.,()+*/-]/g,'').length)throw Error('Use a numeric expression, for example 20 * 350');
 let index=0;
 function atom(){const t=tokens[index++];if(t==='('){const v=sum();if(tokens[index++]!==')')throw Error('Unbalanced parentheses');return v;}if(t==='-')return-atom();if(!/^\d/.test(t||''))throw Error('Invalid expression');return Number(t);}
 function product(){let v=atom();while(['*','/'].includes(tokens[index])){const op=tokens[index++],n=atom();if(op==='/'&&n===0)throw Error('Cannot divide by zero');v=op==='*'?v*n:v/n;}return v;}
 function sum(){let v=product();while(['+','-'].includes(tokens[index])){const op=tokens[index++],n=product();v=op==='+'?v+n:v-n;}return v;}
 const value=sum();if(index!==tokens.length||!Number.isFinite(value)||Math.abs(value)>1e15)throw Error('Invalid calculation');return value;
}
export function localUtility(args,s){
 const q=args.operation==='timer'?normalizeUtilityNumbers(args.query):args.query,en=args.language==='en';s.notes??=[];s.timers??=[];
 if(args.operation==='notes'){
  if(/삭제|비워|clear|delete/i.test(q)){s.notes=[];return{ok:true,reply:en?'Notes cleared.':'메모를 비웠어요.',notes:[]};}
  if(/목록|읽어|보여|뭐|list|read|show/i.test(q))return{ok:true,reply:s.notes.length?s.notes.map(x=>x.text).join('. ').slice(0,340):(en?'You have no notes.':'저장된 메모가 없어요.'),notes:s.notes};
  const text=q.replace(/^.*?(메모(?:해줘|해|해둬|해 둬|저장)?|take a note|note)\s*[:：]?\s*/i,'').trim().slice(0,300);if(!text)return{ok:true,reply:en?'What should I write down?':'메모할 내용을 말씀해 주세요.'};
  if(s.notes.length>=20)s.notes.shift();s.notes.push({id:randomUUID(),text,at:new Date().toISOString()});return{ok:true,reply:en?`Saved a note: ${text}`:`메모했어요. ${text}`,notes:s.notes,notice:en?'Stored only in this temporary session.':'현재 임시 세션에만 저장됩니다.'};
 }
 if(args.operation==='timer'){
  if(/취소|꺼|중지|cancel|stop/i.test(q)){s.timers=[];return{ok:true,reply:en?'Timers canceled.':'타이머를 취소했어요.',effect:{type:'timers',timers:[]}};}
  s.timers=s.timers.filter(x=>x.deadline>Date.now());
  const m=q.match(/(\d+(?:\.\d+)?)\s*(초|분|시간|seconds?|minutes?|hours?)/i);if(!m)return{ok:true,reply:s.timers.length?s.timers.map(x=>en?`${Math.ceil((x.deadline-Date.now())/1000)} seconds remaining.`:`${Math.ceil((x.deadline-Date.now())/1000)}초 남았어요.`).join(' '):(en?'How many minutes should I set?':'몇 분 타이머를 맞출까요?')};
  const seconds=Number(m[1])*(/시간|hours?/i.test(m[2])?3600:/분|minutes?/i.test(m[2])?60:1);if(seconds<1||seconds>86400)throw Error('Timer must be between 1 second and 24 hours');if(s.timers.length>=5)throw Error('At most five active timers');
  s.timers.push({id:randomUUID(),deadline:Date.now()+seconds*1000,label:en?'Break timer':'휴식 타이머'});
  return{ok:true,reply:en?`Timer set for ${seconds} seconds. Keep this demo tab open for the alert.`:`${m[1]}${m[2]} 타이머를 맞췄어요. 알림을 받으려면 이 데모 탭을 열어 두세요.`,effect:{type:'timers',timers:s.timers}};
 }
 if(args.operation==='calculate'){
  const expression=q.replace(/계산해줘|계산해|계산|calculate|what is/gi,'').replace(/[?？]/g,'').trim();let value,formula=expression;
  if(/충전비|charging cost/i.test(q)){const energy=Number(q.match(/([\d.]+)\s*(?:kwh|킬로와트시)/i)?.[1]),price=Number(q.match(/([\d.]+)\s*(?:원|won)/i)?.[1]);if(!Number.isFinite(energy)||!Number.isFinite(price))return{ok:true,reply:en?'Provide kWh and price per kWh.':'충전량과 단가를 말씀해 주세요. 예: 충전비 20kWh, kWh당 350원 계산.'};value=energy*price;formula=`${energy} kWh × ${price} KRW/kWh`;}
  else if(/연료비|기름값|fuel cost/i.test(q)){const distance=Number(q.match(/([\d.]+)\s*(?:km|킬로미터)/i)?.[1]),efficiency=Number(q.match(/연비\s*([\d.]+)/)?.[1]),price=Number(q.match(/([\d.]+)\s*원/)?.[1]);if(![distance,efficiency,price].every(Number.isFinite)||efficiency<=0)return{ok:true,reply:'예: 연료비 100km, 연비 10, 리터당 1700원 계산.'};value=distance/efficiency*price;formula=`${distance} km ÷ ${efficiency} km/L × ${price} KRW/L`;}
  else if(/나눠|나누|split|divide/i.test(q)&&/원|won|KRW/i.test(q)){
   const amount=Number(q.match(/([\d,]+)\s*(?:원|won|KRW)/i)?.[1].replaceAll(',','')),people=Number(q.match(/(\d+)\s*(?:명|people|persons?)/i)?.[1]);
   if(!Number.isFinite(amount)||!Number.isInteger(people)||people<1||people>1000)return{ok:true,reply:en?'Provide the total amount and number of people.':'총액과 인원을 말씀해 주세요. 예: 여행경비 60000원, 3명 나눠줘.'};
   value=amount/people;formula=`${amount} KRW ÷ ${people}`;
  }
  else value=arithmetic(expression.replace(/더하기/g,'+').replace(/빼기/g,'-').replace(/곱하기/g,'*').replace(/나누기/g,'/'));
  if(!Number.isFinite(value)||Math.abs(value)>1e15)throw Error('Invalid calculation');
  return{ok:true,reply:en?`${formula} equals ${Number(value.toFixed(4)).toLocaleString()}.`:`${formula}, 결과는 ${Number(value.toFixed(4)).toLocaleString()}이에요.`,formula,value};
 }
 throw Error('Unknown local utility');
}
export async function executeAssistant(args,s,{signal,diagnostic=false}={}){
 if(!operations.includes(args.operation)||typeof args.query!=='string'||args.query.length>500)throw Error('Invalid assistant tool');
 const start=performance.now(),catalog=await toolCatalog(),tool=catalog.tools.find(t=>t.id===args.operation);
 if(!diagnostic&&!tool.enabled)return{ok:false,operation:args.operation,reply:args.language==='en'?'This tool was excluded after latency or reliability checks. See the tool table.':'이 기능은 지연·안정성 검사 후 기본 목록에서 제외했어요. 도구 표에서 결과를 확인해 주세요.',excluded:true,elapsedMs:Math.round(performance.now()-start)};
 const controller=new AbortController(),forward=()=>controller.abort(signal.reason);if(signal?.aborted)forward();else signal?.addEventListener('abort',forward,{once:true});
 const timer=setTimeout(()=>controller.abort(Error('External tool time budget exceeded')),6500);timer.unref?.();
 try{
  controller.signal.throwIfAborted();
  const language=args.language==='en'?'en':'ko',request={...args,language,...s.location};
  const result=['timer','notes','calculate'].includes(args.operation)?localUtility(request,s):args.operation==='radio'?await providerLookup(request,{signal:controller.signal}):await remoteLookup(request,controller.signal);
  controller.signal.throwIfAborted();
  return{...structuredClone(result),reply:result.reply||(args.language==='en'?'The provider could not complete this request.':'외부 서비스가 요청을 완료하지 못했어요.'),operation:args.operation,elapsedMs:Math.round(performance.now()-start),transport:['timer','notes','calculate'].includes(args.operation)?'local':args.operation==='radio'?'local-provider':endpoint?'agentcore-mcp':'local-provider',sources:result.sources||[]};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);}
}
