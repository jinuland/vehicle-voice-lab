import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {initialState,executePlan} from '../vehicle.mjs';
import {variants,cases,holdout} from './vehicle-benchmark-cases.mjs';
const catalog=JSON.parse(await readFile('model-catalog.json','utf8')),base=process.env.BENCH_BASE||'http://localhost:8787/api/';
const isHoldout=process.env.BENCH_SUITE==='holdout',suite=isHoldout?holdout:variants,reportDir=process.env.BENCH_REPORT_DIR||(isHoldout?'research/vehicle-holdout':'research/vehicle-benchmark');const requested=process.argv.slice(2);const models=catalog.models.filter(m=>requested.includes(m.id));await mkdir(reportDir,{recursive:true});
export function canonicalActions(actions){return actions.flatMap(a=>a.type==='temperature'&&a.zone==='both'?[{...a,zone:'driver'},{...a,zone:'passenger'}]:[a]).map(a=>JSON.stringify(Object.fromEntries(Object.entries(a).sort()))).sort();}
export function stateEqual(a,b){if(!a||!b)return false;const{revision:ar,...aa}=a,{revision:br,...bb}=b;return JSON.stringify(aa)===JSON.stringify(bb);}
async function session(){return(await fetch(base+'session',{method:'POST'})).json();}
async function turn(model,s,c){
 const audio=await readFile(`output/vehicle-benchmark/${c.id}.wav`),endpoint=model.role==='sllm'?'turn':model.id==='minicpm-o45'?'minicpm-control':'audio-control';
 const start=performance.now(),events=[];let firstAudioMs=null,bytes=0,responseAudio;
 try{
  const r=await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':s.id},body:JSON.stringify({audio:audio.toString('base64'),plannerId:model.id,audioModelId:model.id,ttsProvider:'polly',inputMode:'file',asrId:process.env.BENCH_ASR||'nemotron',promptVersion:process.env.BENCH_PROMPT||'full-v1',generationProfile:process.env.BENCH_GENERATION||'deterministic'}),signal:AbortSignal.timeout(420000)});
  if(!r.ok)throw new Error(await r.text());const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
  for(;;){const{value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary;
   while((boundary=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const event=block.match(/^event: (.*)/m)?.[1],data=JSON.parse(block.match(/^data: (.*)/m)?.[1]||'{}');
    if(event==='audio'){firstAudioMs??=Math.round(performance.now()-start);const b=Buffer.from(data.audio,'base64');bytes+=b.length;responseAudio??=b;}else events.push({event,data});
   }
  }
  const error=events.find(e=>e.event==='error')?.data,metrics=events.find(e=>e.event==='done')?.data.metrics,reply=events.find(e=>e.event==='reply')?.data;
  if(responseAudio&&['passenger-25','defrost-on'].includes(c.id))await writeFile(`output/vehicle-benchmark/${model.id}-${c.id}-reply.wav`,responseAudio);
  return{metrics,reply,error,firstAudioMs,audioBytes:bytes,audioValid:!!responseAudio&&responseAudio.toString('ascii',0,4)==='RIFF'&&responseAudio.length>1000,elapsedMs:Math.round(performance.now()-start),heard:metrics?.input||events.find(e=>['understood','transcript'].includes(e.event))?.data.text};
 }catch(error){return{error:{error:error.message,failureStage:'transport'},elapsedMs:Math.round(performance.now()-start)};}
}
for(const model of models){
 let report={modelId:model.id,name:model.name,repo:model.repo,revision:model.revision,size:model.size,startedAt:new Date().toISOString(),status:'running',asrId:process.env.BENCH_ASR||'nemotron',promptVersion:process.env.BENCH_PROMPT||'full-v1',generationProfile:process.env.BENCH_GENERATION||'deterministic',quantization:model.quantization||'bf16',syntheticAudio:true,pipeline:model.role==='sllm'?`${process.env.BENCH_ASR==='whisper'?'Whisper turbo':'Nemotron'} ASR → selected sLLM → vehicle executor → Polly`:`${model.name} direct audio → vehicle executor → Polly`,rows:[]};
 const file=`${reportDir}/${model.id}.json`;await writeFile(file,JSON.stringify(report,null,2));
 const warm=await turn(model,await session(),cases[1]);report.warmup={elapsedMs:warm.elapsedMs,modelLoadMs:warm.metrics?.modelLoadMs,error:warm.error};
 console.log(JSON.stringify({model:model.id,warmup:report.warmup}));
 if(warm.error){report.status="failed";await writeFile(file,JSON.stringify(report,null,2));throw Error(`Warmup failed for ${model.id}; repair serving before measuring model quality: ${JSON.stringify(warm.error)}`);}
 for(const c of suite){
  let s=await session(),before=initialState(),previous=null,preludeCorrect=true;
  if(c.prelude){const p=cases.find(x=>x.id===c.prelude),r=await turn(model,s,p);const expected=executePlan(before,previous,{intent:'control',actions:p.actions,reply:''});preludeCorrect=!!r.metrics&&stateEqual(r.metrics.state,expected.state)&&JSON.stringify(canonicalActions(r.metrics.actions))===JSON.stringify(canonicalActions(p.actions));before=expected.state;previous=expected.previous;}
  const r=await turn(model,s,c);let expected=executePlan(before,previous,{intent:c.intent||'control',actions:c.actions,reply:''}).state;
  const actionCorrect=!!r.metrics&&JSON.stringify(canonicalActions(r.metrics.actions))===JSON.stringify(canonicalActions(c.actions)),stateCorrect=stateEqual(r.metrics?.state,expected);
  const answerCorrect=!c.answer||new RegExp(c.answer+'|이십이|스물두').test(r.metrics?.reply||'');
  const intentCorrect=!c.intent||r.metrics?.intent===c.intent||(c.intent==='clarify'&&r.metrics?.intent==='question'&&/목적지|어디|장소/.test(r.metrics?.reply||''));
  const denialCorrect=!c.denial||/불가|못|않|지원|범위|16|30|없|어려|조절할 수/.test(r.metrics?.reply||'')&&!/설정했|바꿨|맞췄/.test(r.metrics?.reply||'');
  const passed=!r.error&&r.audioValid&&preludeCorrect&&actionCorrect&&stateCorrect&&answerCorrect&&intentCorrect&&denialCorrect;
  const row={id:c.id,text:c.text,variant:c.variant,expectedActions:c.actions,expectedState:expected,preludeCorrect,passed,actionCorrect,stateCorrect,answerCorrect,intentCorrect,denialCorrect,heard:r.heard,modelProposedActions:r.metrics?.modelProposedActions,quantization:r.metrics?.quantization,plannerMemory:r.metrics?.plannerMemory,modelReply:r.metrics?.modelReply,rawTranscript:r.metrics?.rawTranscript,asrModel:r.metrics?.asrModel,actualActions:r.metrics?.actions,actualState:r.metrics?.state,reply:r.metrics?.reply,asrMs:r.metrics?.asrMs,llmMs:r.metrics?.llmMs,ttsMs:r.metrics?.ttsMs,modelLoadMs:r.metrics?.modelLoadMs,firstAudioMs:r.firstAudioMs,elapsedMs:r.elapsedMs,audioValid:r.audioValid,audioBytes:r.audioBytes,guardReason:r.metrics?.guardReason,validationError:r.metrics?.validationError,error:r.error,failureCategory:r.error?.failureStage||(!preludeCorrect?'context-prelude':!actionCorrect||!stateCorrect||!answerCorrect||!intentCorrect||!denialCorrect?'understanding-or-planning':!r.audioValid?'speech-output':null),actualPlanner:r.metrics?.planner,actualRevision:r.metrics?.plannerRevision};
  report.rows.push(row);await writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({model:model.id,case:c.id,passed,ms:r.firstAudioMs,heard:r.heard,actions:r.metrics?.actions,error:r.error}));
 }
 report.status='complete';report.completedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2));
}
