// Paired replay of the original 31-case vehicle benchmark, including preludes.
import WebSocket from 'ws';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {initialState,executePlan} from '../vehicle.mjs';
import {cases,variants} from './vehicle-benchmark-cases.mjs';
import {sonicWavPCM} from '../sonic-asr.mjs';
const base=new URL(process.env.TEST_BASE||'http://localhost:8787').origin;
const originHeaders=process.env.TEST_ORIGIN_KEY?{'X-Vehicle-Origin-Key':process.env.TEST_ORIGIN_KEY}:{};
const origin=process.env.TEST_WS_ORIGIN||base,mode=process.env.TEST_MODE||'native',runtime=process.env.TEST_RUNTIME||'direct';
const dir=process.env.TEST_OUT||'output/vehicle-sonic-modes',fixtureDir=process.env.TEST_FIXTURES||'output/vehicle-benchmark';await mkdir(dir,{recursive:true});
if(!['native','whisper','transcribe'].includes(mode)||!['direct','agentcore'].includes(runtime))throw Error('Invalid mode');
function canon(actions){return actions.flatMap(a=>a.type==='temperature'&&a.zone==='both'?[{...a,zone:'driver'},{...a,zone:'passenger'}]:[a]).map(a=>JSON.stringify(Object.fromEntries(Object.entries(a).sort()))).sort();}
function equal(a,b){if(!a)return false;const{revision:ar,...aa}=a,{revision:br,...bb}=b;return JSON.stringify(aa)===JSON.stringify(bb);}
async function open(session){const url=new URL('/api/sonic',base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('session',session.id);url.searchParams.set('language','ko');url.searchParams.set('runtime',runtime);if(mode==='transcribe')url.searchParams.set('input','transcribe');const ws=new WebSocket(url,{origin,headers:originHeaders});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Connection timeout')),45000);ws.on('message',function ready(raw){const{event,data}=JSON.parse(raw);if(event==='ready'){clearTimeout(timer);ws.off('message',ready);resolve();}if(event==='error'){clearTimeout(timer);reject(Error(data.error));}});ws.once('error',reject);});return ws;}
async function turn(ws,session,c){
 const raw=await readFile(`${fixtureDir}/${c.id}.wav`),pcm=sonicWavPCM(raw);if(!pcm)throw Error('Invalid fixture '+c.id);
 let endedAt,firstAudio,heard='',reply='',audioBytes=0,actions=[],toolErrors=[],done=false,keepalive;const start=performance.now();
 await new Promise((resolve,reject)=>{
  let settled=false;const timer=setTimeout(()=>finish(Error('Turn timeout')),55000);
  function finish(e){if(settled)return;settled=true;clearTimeout(timer);clearInterval(keepalive);ws.off('message',message);ws.off('error',finish);e?reject(e):resolve();}
  function message(raw){const {event,data}=JSON.parse(raw);if(event==='asr-final')heard=data.rawText;if(event==='text'){if(data.role==='USER'&&mode==='native')heard+=data.text;else if(data.role==='ASSISTANT')reply+=data.text;}
   if(event==='audio'){firstAudio??=performance.now();audioBytes+=Buffer.from(data.audio,'base64').length;}
   if(event==='tool'){actions.push(...(data.actions||[]));if(data.ok===false)toolErrors.push(data.error);}
   if(event==='error'||event==='asr-error')finish(Error(data.error||data.code));if(event==='done'&&audioBytes){done=true;if(endedAt)finish();}}
  ws.on('message',message);ws.once('error',finish);
  void(async()=>{
   if(mode==='whisper'){
    keepalive=setInterval(()=>{if(ws.readyState===1)ws.send(Buffer.alloc(3200));},100);endedAt=performance.now();
    const r=await fetch(base+'/api/sonic-asr',{method:'POST',headers:{...originHeaders,'Content-Type':'application/json','X-Session-Id':session.id},body:JSON.stringify({audio:raw.toString('base64'),language:'ko'}),signal:AbortSignal.timeout(12000)});const data=await r.json();if(!r.ok)throw Error(`Whisper ${r.status}: ${data.code}`);heard=data.rawText;ws.send(JSON.stringify({type:'text',text:data.text}));
   }else{
    ws.send(JSON.stringify(mode==='transcribe'?{type:'asr-start',mode:'file'}:{type:'mode',mode:'file'}));const at=performance.now();
    for(let pos=0;pos<pcm.length&&!settled;pos+=3200){const part=pcm.subarray(pos,pos+3200);await sleep(Math.max(0,at+(pos+part.length)/32-performance.now()));if(!settled)ws.send(part);}
    if(settled)return;endedAt=performance.now();ws.send(JSON.stringify({type:mode==='transcribe'?'asr-end':'audio-end'}));if(mode==='native')keepalive=setInterval(()=>{if(ws.readyState===1)ws.send(Buffer.alloc(3200));},100);if(done&&audioBytes)finish();
   }
  })().catch(finish);
 });
 const snapshot=await(await fetch(base+'/api/export',{headers:{...originHeaders,'X-Session-Id':session.id}})).json();
 return{heard,reply,actualActions:actions,actualState:snapshot.state,firstAudioMs:endedAt&&firstAudio?Math.round(firstAudio-endedAt):null,elapsedMs:Math.round(performance.now()-start),audioValid:audioBytes>0,audioBytes,toolErrors};
}
const report={mode,runtime,syntheticAudio:true,startedAt:new Date().toISOString(),rows:[]};
for(const c of variants){let ws,row;try{
 const r=await fetch(base+'/api/session',{method:'POST',headers:originHeaders});if(!r.ok)throw Error(`Session ${r.status}`);const session=await r.json();ws=await open(session);let before=initialState(),previous=null,preludeCorrect=true;
 if(c.prelude){const p=cases.find(x=>x.id===c.prelude),v=await turn(ws,session,p),e=executePlan(before,null,{intent:'control',actions:p.actions,reply:''});preludeCorrect=equal(v.actualState,e.state)&&JSON.stringify(canon(v.actualActions))===JSON.stringify(canon(p.actions));before=e.state;previous=e.previous;}
 const v=await turn(ws,session,c),expected=executePlan(before,previous,{intent:c.intent||'control',actions:c.actions,reply:''}).state;
 const actionCorrect=JSON.stringify(canon(v.actualActions))===JSON.stringify(canon(c.actions)),stateCorrect=equal(v.actualState,expected),answerCorrect=!c.answer||/22|이십이|스물두/.test(v.reply),intentCorrect=!c.intent||/어디|목적지|알려|정해|장소/.test(v.reply),denialCorrect=!c.denial||/불가|못|않|지원|범위|16|30|없|어려|조절할 수/.test(v.reply)&&!/설정했|바꿨|맞췄/.test(v.reply);
 row={id:c.id,text:c.text,variant:c.variant,expectedActions:c.actions,expectedState:expected,preludeCorrect,actionCorrect,stateCorrect,answerCorrect,intentCorrect,denialCorrect,...v,passed:preludeCorrect&&actionCorrect&&stateCorrect&&answerCorrect&&intentCorrect&&denialCorrect&&v.audioValid&&!v.toolErrors.length};
 }catch(e){row={id:c.id,text:c.text,passed:false,error:e.message};}finally{ws?.close();}
 report.rows.push(row);console.log(JSON.stringify({mode,runtime,id:c.id,passed:row.passed,ms:row.firstAudioMs,error:row.error}));await writeFile(`${dir}/${runtime}-${mode}.json`,JSON.stringify(report,null,2));
}
const times=report.rows.map(r=>r.firstAudioMs).filter(x=>x!=null&&x>=0).sort((a,b)=>a-b);report.summary={n:report.rows.length,passed:report.rows.filter(r=>r.passed).length,completed:report.rows.filter(r=>!r.error&&r.audioValid).length,firstAudioMedianMs:times.length?Math.round((times[(times.length-1)>>1]+times[times.length>>1])/2):null,firstAudioP95Ms:times[Math.ceil(times.length*.95)-1]??null,timed:times.length,earlyAudio:report.rows.filter(r=>r.firstAudioMs<0).length};report.completedAt=new Date().toISOString();await writeFile(`${dir}/${runtime}-${mode}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary));
