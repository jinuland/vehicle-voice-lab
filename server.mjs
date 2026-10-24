import express from 'express';
import {mountGame} from './game-api.mjs';
import {randomUUID} from 'node:crypto';
import {mkdir,appendFile,readFile} from 'node:fs/promises';
import {initialState,systemPrompt,parsePlan,executePlan} from './vehicle.mjs';
import {PollyClient,SynthesizeSpeechCommand} from '@aws-sdk/client-polly';
import {awsCredentials} from './aws-auth.mjs';
import {allowedRequest,startSse,cloudMode} from './web-access.mjs';
import {WebSocketServer} from 'ws';
import {SonicSession,SONIC_MODEL,SONIC_REGION} from './sonic.mjs';
import {guardExplicitBounds} from './plan-guards.mjs';
import {compactPlannerPrompt,compactKoreanPlannerPrompt} from './planner-prompt-v2.mjs';
import {normalizeTranscript} from './transcript.mjs';
import {guardMiniPlan} from './minicpm-tools.mjs';
import {inferAssistant,executeAssistant,toolCatalog,radioStations} from './assistant-service.mjs';

const app=express(), port=Number(process.env.PORT||8787);
const compactServing=process.env.COMPACT_SERVING==='1';
const core=process.env.CORE_URL||'http://127.0.0.1:19101', tts=process.env.TTS_URL||'http://127.0.0.1:19102';
const corePool=(process.env.CORE_URLS||core).split(',').map(url=>url.trim()).filter(Boolean).map(url=>({url,active:0,requests:0}));let coreCursor=0;
const whisper=process.env.WHISPER_URL||'http://127.0.0.1:19105';
const whisperPool=(process.env.WHISPER_URLS||whisper).split(',').map(url=>url.trim()).filter(Boolean).map(url=>({url,active:0,requests:0}));let whisperCursor=0;
const mini=process.env.MINICPM_URL||'http://127.0.0.1:19103';
const speechWorker=process.env.SPEECH_URL||'http://127.0.0.1:19104';
const catalog=JSON.parse(await readFile(new URL('./model-catalog.json',import.meta.url),'utf8'));
const plannerModels=catalog.models.filter(m=>m.role==='sllm'&&m.status==='ready');
const sessions=new Map(), active=new Map(), sonicConnections=new Map();
const polly=new PollyClient({region:process.env.AWS_REGION||'ap-northeast-2',...awsCredentials});
function pcmWav(pcm){
  const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
async function synthesize(text,provider,signal,{voiceId='Seoyeon',engine='neural'}={}){
  if(provider==='polly'){
    const start=performance.now();
    const result=await polly.send(new SynthesizeSpeechCommand({Engine:engine,VoiceId:voiceId,LanguageCode:'ko-KR',OutputFormat:'pcm',SampleRate:'16000',TextType:'text',Text:text}),{abortSignal:signal});
    const pcm=Buffer.from(await result.AudioStream.transformToByteArray());return{bytes:pcmWav(pcm),elapsedMs:Math.round(performance.now()-start)};
  }
  const response=await remote(tts+'/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})},signal);
  return{bytes:Buffer.from(await response.arrayBuffer()),elapsedMs:Number(response.headers.get('x-inference-ms'))};
}
app.use((req,res,next)=>{
  const host=req.headers.host;
  if(!allowedRequest(req,port))return res.status(403).json({error:'Request origin rejected'});
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${cloudMode?process.env.PUBLIC_ORIGIN.replace('https:','wss:'):`ws://localhost:${port} ws://127.0.0.1:${port}`}; media-src 'self' blob: https://ice2.somafm.com https://ice1.somafm.com https://ice4.somafm.com https://antares.dribbcast.com; worker-src 'self'; object-src 'none'; frame-ancestors 'none'`);
  next();
});
app.use(express.json({limit:'3mb'}));
// CloudFront appends the actual viewer IP to X-Forwarded-For. The origin
// verification above ensures these requests arrived through our distribution.
const budgets=new Map();
app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(cloudMode&&req.method==='POST'){
 const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',').at(-1).trim(),now=Date.now(),b=budgets.get(ip);
 if(!b||now-b.start>60000)budgets.set(ip,{start:now,count:1});else if(++b.count>90){res.setHeader('Retry-After','60');return res.status(429).json({error:'요청이 많아요. 잠시 후 다시 시도해 주세요.'});}
 }next();});setInterval(()=>{for(const[ip,b]of budgets)if(Date.now()-b.start>60000)budgets.delete(ip);},60000).unref();
mountGame(app,{recognize:recognizeOnWhisper,synthesize,cloud:cloudMode});
app.use(express.static('public'));
app.get('/api/catalog',async(req,res)=>res.json(JSON.parse(await readFile('model-catalog.json','utf8'))));
app.get('/api/benchmark-csv',(req,res)=>res.download('vehicle-model-comparison.csv','vehicle-model-comparison.csv',{root:'research'}));
app.get('/api/benchmark',async(req,res)=>{
  try{const report=JSON.parse(await readFile('research/vehicle-benchmark-summary.json','utf8'));
    if(compactServing){report.method='L40S 과거 비교표입니다. 현재 L4 실측과 비용 비교는 /costs.html 에서 확인하세요. '+report.method;report.defaultPlannerId=catalog.defaultPlannerId;for(const model of report.models||[]){model.available=model.id==='sonic'||catalog.models.some(m=>m.id===model.id&&m.status==='ready');if(!model.available)model.recommended=false;}}
    res.json(report);}
  catch{res.json({status:'pending',models:[],method:'동일 한국어 음성으로 차량 데모 평가 중'});}
});
app.get('/api/benchmark-audio/:modelId/:sampleId',(req,res)=>{
  if(!catalog.models.some(m=>m.id===req.params.modelId)||!['passenger-25','defrost-on'].includes(req.params.sampleId))return res.sendStatus(404);
  res.sendFile(`${req.params.modelId}-${req.params.sampleId}-reply.wav`,{root:'public/benchmark-audio'},error=>{if(error&&!res.headersSent)res.sendStatus(404);});
});
function session(req){
  const id=req.headers['x-session-id'];
  if(typeof id!=='string'||!sessions.has(id))throw new Error('세션을 다시 시작해 주세요.');
  return sessions.get(id);
}
async function remote(url,options={},signal,timeoutMs=120000){
  const r=await fetch(url,{...options,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw new Error(`GPU 모델 오류 (${r.status}): ${(await r.text()).slice(0,220)}`);
  return r;
}
async function planOnCore(body,signal){
  const least=Math.min(...corePool.map(worker=>worker.active));let worker;
  for(let i=0;i<corePool.length;i++){const index=(coreCursor+i)%corePool.length;if(corePool[index].active===least){worker=corePool[index];coreCursor=(index+1)%corePool.length;break;}}
  worker.active++;worker.requests++;
  try{return await(await remote(worker.url+'/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},signal)).json();}
  finally{worker.active--;}
}
async function recognizeOnWhisper(form,signal){
  const least=Math.min(...whisperPool.map(worker=>worker.active));let worker;
  for(let i=0;i<whisperPool.length;i++){const index=(whisperCursor+i)%whisperPool.length;if(whisperPool[index].active===least){worker=whisperPool[index];whisperCursor=(index+1)%whisperPool.length;break;}}
  worker.active++;worker.requests++;
  try{return await(await remote(worker.url+'/asr',{method:'POST',body:form},signal)).json();}
  finally{worker.active--;}
}
app.get('/api/health',async(req,res)=>{
  const result=await Promise.allSettled([Promise.all(corePool.map(async worker=>{try{return await(await fetch(worker.url+'/health',{signal:AbortSignal.timeout(2000)})).json();}catch{return{ready:false,error:'GPU 연결 대기'};}})).then(replicas=>({...replicas[0],ready:replicas.every(r=>r.ready),replicas:replicas.map((r,i)=>({...r,index:i,active:corePool[i].active,requests:corePool[i].requests}))})),fetch(tts+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()),fetch(mini+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()),fetch(speechWorker+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()),Promise.all(whisperPool.map(async worker=>{try{return await(await fetch(worker.url+'/health',{signal:AbortSignal.timeout(2000)})).json();}catch{return{ready:false};}})).then(replicas=>({...replicas[0],ready:replicas.every(r=>r.ready),replicas:replicas.map((r,i)=>({...r,index:i,active:whisperPool[i].active,requests:whisperPool[i].requests}))}))]);
  const states=result.map(r=>r.status==='fulfilled'?r.value:{ready:false,error:'GPU 연결 대기'}),workers=states.slice(0,2);
  res.json({ready:compactServing?!!(states[0].ready&&states[4].ready):workers.every(w=>w.ready),workers,researchWorkers:{minicpm:states[2],speech:states[3]},asrWorkers:{whisper:states[4]},minicpmControl:!compactServing,region:'ap-northeast-2',profile:process.env.AWS_PROFILE||'default',instanceType:process.env.INSTANCE_TYPE||'g6e.2xlarge',servingProfile:compactServing?'compact':'comparison',mode:'발화 단위 ASR · 문장 단위 음성 응답',simulated:true,deployment:{kind:cloudMode?'cloudfront':'local',gpuKeepRunning:true},sonic:{model:SONIC_MODEL,region:SONIC_REGION,koreanSupported:false}});
});
app.post('/api/session',(req,res)=>{
  if(sessions.size>=1000)return res.status(503).json({error:'공유 데모 접속이 많습니다. 잠시 후 다시 시도해 주세요.'});
  const id=randomUUID();sessions.set(id,{id,miniConversation:randomUUID(),state:initialState(),previous:null,history:[],turns:[],updated:Date.now()});
  res.json({id,state:sessions.get(id).state});
});
app.get('/api/tools',async(req,res)=>res.json(await toolCatalog()));
app.post('/api/location',(req,res)=>{
 try{const s=session(req),{latitude,longitude}=req.body;if(!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180)throw Error('Invalid coordinates');s.location={latitude:Math.round(latitude*1e4)/1e4,longitude:Math.round(longitude*1e4)/1e4};s.updated=Date.now();res.json({location:s.location});}catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/tools/run',async(req,res)=>{
 let s;try{s=session(req);}catch(e){return res.status(400).json({error:e.message});}
 active.get(s.id)?.controller.abort();sonicConnections.get(s.id)?.stop();
 const controller=new AbortController(),task={controller,turnId:randomUUID()};active.set(s.id,task);
 res.on('close',()=>{if(!res.writableEnded)controller.abort();});
 try{const r=await executeAssistant(req.body,s,{signal:controller.signal});s.updated=Date.now();res.json(r);}catch(e){if(!controller.signal.aborted)res.status(502).json({ok:false,error:e.message});}finally{if(active.get(s.id)===task)active.delete(s.id);}
});
app.post('/api/radio/station',(req,res)=>{
 try{const s=session(req),station=radioStations.find(x=>x.id===req.body.stationId);if(!station)throw Error('Unknown station');s.updated=Date.now();res.json(station);}catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/cancel',(req,res)=>{
  try {const s=session(req);const a=active.get(s.id);if(a)a.controller.abort();const sonic=sonicConnections.get(s.id);sonic?.stop();res.json({cancelled:!!a||!!sonic,state:s.state});}catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/reset',(req,res)=>{
  try{const s=session(req);active.get(s.id)?.controller.abort();sonicConnections.get(s.id)?.stop();s.miniConversation=randomUUID();s.state=initialState();s.previous=null;s.history=[];s.turns=[];s.notes=[];s.timers=[];res.json({state:s.state});}catch(e){res.status(400).json({error:e.message});}
});
app.post(['/api/turn','/api/minicpm-control','/api/audio-control','/api/audio-native','/api/s2s'],async(req,res,next)=>{
  // Voice-only comparison requires an explicit opt-out. Default routes execute
  // the selected model's own audio plan through the common vehicle executor.
  if(['/api/audio-native','/api/s2s'].includes(req.path)&&req.body.comparisonOnly===true)return next();
  const miniControl=['/api/minicpm-control','/api/s2s'].includes(req.path);
  const otherAudio=['/api/audio-control','/api/audio-native'].includes(req.path),audioControl=miniControl||otherAudio;
  const audioModel=otherAudio?catalog.models.find(m=>m.id===req.body.audioModelId&&m.status==='ready'&&m.audioPlanner):null;
  if(otherAudio&&!audioModel)return res.status(400).json({error:'이 음성 모델은 차량 명령 판단을 지원하지 않습니다. 제어 가능한 모델을 선택하거나 제어 없는 음성 비교를 명시적으로 켜 주세요.',failureStage:'unsupported-capability',vehicleTools:false});
  let s;try{s=session(req);}catch(e){return res.status(400).json({error:e.message});}
  if(typeof req.body.text!=='string'&&typeof req.body.audio!=='string')return res.status(400).json({error:'음성 또는 텍스트가 필요합니다.'});
  if(req.body.text?.length>500||req.body.audio?.length>2700000)return res.status(413).json({error:'입력이 너무 깁니다.'});
  if(audioControl&&(typeof req.body.audio!=='string'||req.body.text))return res.status(400).json({error:'이 차량 제어 모드는 음성으로 테스트해 주세요.'});
  const planner=plannerModels.find(m=>m.id===(req.body.plannerId||catalog.defaultPlannerId||'qwen35-4b'));
  if(!audioControl&&!planner)return res.status(400).json({error:'연결된 판단 모델을 선택해 주세요.'});
  active.get(s.id)?.controller.abort();
  sonicConnections.get(s.id)?.stop();
  const controller=new AbortController(),turnId=randomUUID(),revision=s.state.revision,start=performance.now();
  const task={controller,turnId};active.set(s.id,task);
  startSse(res);
  const send=(event,data)=>{if(!controller.signal.aborted&&!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify({...data,turnId})}\n\n`);};
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  let record,failureStage='recognition';
  try{
    let text=req.body.text?.trim(),asrMs=0,rawTranscript=null,asrModel=null;const asrId=req.body.asrId||planner?.demoConfig?.asrId||'whisper';if(!['whisper','nemotron'].includes(asrId))throw new Error('지원하지 않는 음성 인식 모델입니다.');
    send('stage',{stage:audioControl?'audioPlanning':'recognizing',model:audioModel?.name||'MiniCPM'});
    if(!text&&!audioControl){
      const audio=Buffer.from(req.body.audio,'base64');
      const form=new FormData();form.append('file',new Blob([audio],{type:'audio/wav'}),'speech.wav');
      const data=asrId==='whisper'?await recognizeOnWhisper(form,controller.signal):await(await remote(core+'/asr',{method:'POST',body:form},controller.signal)).json();rawTranscript=data.text;text=normalizeTranscript(data.text);asrMs=data.elapsedMs;asrModel=data.model;
    }
    if(!text&&!audioControl)throw new Error('음성을 인식하지 못했어요. 다시 말씀해 주세요.');
    if(!audioControl){send('transcript',{text,rawText:rawTranscript,asrMs,asrModel});send('stage',{stage:'thinking'});}
    const currentState=structuredClone(s.state);const requestedPrompt=req.body.promptVersion||(miniControl?'compact-v2':audioModel?.demoConfig?.promptVersion||planner?.demoConfig?.promptVersion||'compact-v2');const promptVersion=['compact-v2','korean-compact-v2'].includes(requestedPrompt)?requestedPrompt:'full-v1';const selectedPrompt=promptVersion==='korean-compact-v2'?compactKoreanPlannerPrompt:promptVersion==='compact-v2'?compactPlannerPrompt:systemPrompt;
    const messages=[{role:'system',content:selectedPrompt+'\n현재 차량 상태: '+JSON.stringify(currentState)+(audioControl?'\nJSON에 heard 문자열 필드를 추가하여 음성에서 이해한 요청을 적어라. 형식: {"heard":"이해한 요청","intent":"control|question|clarify","actions":[],"reply":"짧은 답변"}. 사용자는 차량 시뮬레이터를 조작할 수 있다. 지원 동작을 수행하지 못한다고 거절하지 마라.':'' )},...s.history.slice(-12)];
    let data;failureStage='model-planning';
    const requestedAssistant=!audioControl?inferAssistant(text):null;
    if(requestedAssistant){data={text:JSON.stringify({intent:'question',actions:[],reply:''}),elapsedMs:0,model:'Application tool router',loadMs:0};}
    else if(audioControl){
      const form=new FormData();form.append('file',new Blob([Buffer.from(req.body.audio,'base64')],{type:'audio/wav'}),'speech.wav');form.append('messages',JSON.stringify(messages));
      if(otherAudio){form.append('model_id',audioModel.id);form.append('generation_profile',req.body.generationProfile==='official'?'official':'deterministic');}
      data=await(await remote((otherAudio?speechWorker:mini)+'/plan-audio',{method:'POST',body:form},controller.signal,otherAudio?360000:120000)).json();
    }else{
      messages.push({role:'user',content:text});data=await planOnCore({messages,model_id:planner.repo,quantization:planner.quantization||'bf16',generation_profile:req.body.generationProfile==='official'?'official':'deterministic'},controller.signal);
    }
    failureStage='plan-format';let plan=parsePlan(data.text),miniGate;const modelProposedActions=structuredClone(plan.actions),modelReply=plan.reply;
    if(miniControl){miniGate=guardMiniPlan(plan,currentState);plan=miniGate.plan;}
    const boundsGate=guardExplicitBounds(audioControl?plan.heard:text,plan);plan=boundsGate.plan;
    if(audioControl){text=typeof plan.heard==='string'?plan.heard.slice(0,500):'[음성 요청 · 모델의 원문 전사 없음]';send('understood',{text,model:audioModel?.name||'MiniCPM'});}
    let assistantResult;const assistantCall=requestedAssistant||(audioControl&&!plan.actions.length?inferAssistant(text):null);
    if(assistantCall){
      failureStage='assistant-tool';send('stage',{stage:'tool',tool:assistantCall.operation});
      try{assistantResult=await executeAssistant({...assistantCall,language:'ko'},s,{signal:controller.signal});}
      catch(e){controller.signal.throwIfAborted();assistantResult={ok:false,operation:assistantCall.operation,reply:'정보 조회가 제한 시간 안에 완료되지 않았어요. 잠시 후 다시 시도해 주세요.',error:e.message,sources:[]};}
      plan={intent:'question',actions:[],reply:assistantResult.reply?.slice(0,350)||'조회 결과를 확인하지 못했어요.'};send('assistant',assistantResult);
    }
    controller.signal.throwIfAborted();
    if(active.get(s.id)!==task||s.state.revision!==revision)throw new Error('새로운 요청으로 차량 상태가 바뀌었습니다. 다시 말씀해 주세요.');
    failureStage='vehicle-validation';let result,validationError=boundsGate.reason,proposedActions=boundsGate.proposedActions;try{result=executePlan(s.state,s.previous,plan);}catch(error){validationError=error.message;proposedActions=plan.actions;plan={...plan,intent:'clarify',actions:[],reply:'설정을 적용하지 않았어요. '+validationError};result=executePlan(s.state,s.previous,plan);}
    s.state=result.state;s.previous=result.previous;s.updated=Date.now();
    s.history.push({role:'user',content:text},{role:'assistant',content:result.reply});
    const ttsProvider=req.body.ttsProvider==='qwen'?'qwen':'polly';
    record={id:turnId,at:new Date().toISOString(),intent:plan.intent,modelProposedActions,modelReply,generationProfile:data.generationProfile,validationError,proposedActions,promptVersion,engine:otherAudio?'audio-control':miniControl?'minicpm-control':'cascade',audioModelId:audioModel?.id,quantization:data.quantization,plannerId:planner?.id,plannerMemory:data.memory,input:text,rawTranscript,asrModel,asrId:audioControl?null:asrId,inputMeaning:audioControl?'model-understanding-not-verbatim-transcript':'transcript',reply:result.reply,actions:plan.actions,results:result.results,state:structuredClone(s.state),asrMs:audioControl?null:asrMs,llmMs:data.elapsedMs,planner:data.model,plannerRevision:data.revision,modelLoadMs:data.loadMs||0,vehicleTools:true,plannerPasses:data.plannerPasses||1,ttsProvider,ttsMeasurement:ttsProvider==='polly'?'aws-api-round-trip':'gpu-inference',inputMode:req.body.text?'text':['microphone','file'].includes(req.body.inputMode)?req.body.inputMode:'audio',feedback:null};
    s.turns.push(record);
    if(assistantResult){record.assistant=assistantResult;record.toolMs=assistantResult.elapsedMs;record.planner='Application tool router';}
    if(miniGate?.reason){record.guardReason=miniGate.reason;record.proposedActions=miniGate.proposedActions;}
    send('reply',{reply:result.reply,actions:plan.actions,results:result.results,state:s.state,asrMs,llmMs:data.elapsedMs,planner:data.model,modelLoadMs:data.loadMs||0,decisionMs:Math.round(performance.now()-start),vehicleTools:true,intent:plan.intent,guardReason:miniGate?.reason,validationError,assistant:assistantResult,diagnosis:assistantResult?'assistant-tool':validationError?'validation-rejected':result.results.length?'executed':miniGate?.reason?'guard-clarification':'no-action-proposed'});
    if(req.body.speak===false){record.ttsMs=0;record.audioDisabled=true;send('done',{metrics:record});return;}
    failureStage='speech-output';send('stage',{stage:'speaking'});
    const sentences=result.results.length>1?result.results:[result.reply];
    record.ttsMs=0;record.ttsCharacters=0;record.plannerQueueMs=data.queueMs??null;
    for(let index=0;index<sentences.length;index++){
      record.ttsCharacters+=sentences[index].length;
      const audioResponse=await synthesize(sentences[index],ttsProvider,controller.signal);
      const bytes=audioResponse.bytes;
      record.ttsMs+=audioResponse.elapsedMs;
      if(index===0)record.serverAudioReadyMs=Math.round(performance.now()-start);
      send('audio',{audio:bytes.toString('base64'),ttsMs:record.ttsMs,serverAudioReadyMs:record.serverAudioReadyMs,index,total:sentences.length});
    }
    send('done',{metrics:record});
  }catch(e){
    if(record&&controller.signal.aborted)record.interrupted=true;
    if(!controller.signal.aborted)send('error',{error:e.message,state:s.state,failureStage,vehicleTools:true});
  }finally{if(active.get(s.id)===task)active.delete(s.id);res.end();}
});
app.post('/api/audio-native',async(req,res)=>{
  let s;try{s=session(req);}catch(e){return res.status(400).json({error:e.message});}
  const chosen=catalog.models.find(m=>m.id===req.body.audioModelId&&m.status==='ready'&&m.nativeAudio&&m.id!=='minicpm-o45');
  if(!chosen)return res.status(400).json({error:'연결된 음성 모델을 선택해 주세요.'});
  if(typeof req.body.audio!=='string'||req.body.audio.length>2700000)return res.status(400).json({error:'30초 이하 음성으로 테스트해 주세요.'});
  active.get(s.id)?.controller.abort();sonicConnections.get(s.id)?.stop();
  const controller=new AbortController(),turnId=randomUUID(),task={controller,turnId};active.set(s.id,task);
  startSse(res);
  const send=(event,data)=>{if(!controller.signal.aborted&&!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify({...data,turnId})}\n\n`);};
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
    send('stage',{stage:'nativeSpeech',model:chosen.name});
    const form=new FormData();form.append('file',new Blob([Buffer.from(req.body.audio,'base64')],{type:'audio/wav'}),'speech.wav');form.append('model_id',chosen.id);form.append('language',req.body.language==='en'?'en':'ko');
    const d=await(await remote(speechWorker+'/s2s',{method:'POST',body:form},controller.signal,360000)).json();
    controller.signal.throwIfAborted();if(active.get(s.id)!==task)throw new Error('새로운 음성 요청이 시작됐어요.');
    const record={id:turnId,at:new Date().toISOString(),engine:'audio-native',audioModelId:chosen.id,model:d.model,modelRevision:d.revision,quantization:d.quantization,input:'[음성 입력 · 별도 전사 없음]',reply:d.text,actions:[],results:[],state:structuredClone(s.state),vehicleTools:false,ttsProvider:'native',inputMode:req.body.inputMode||'file',totalMs:d.elapsedMs,modelLoadMs:d.loadMs||0,koreanSupported:d.koreanSupported,feedback:null};s.turns.push(record);
    send('reply',{reply:d.text,actions:[],results:[],state:s.state,planner:d.model,modelLoadMs:d.loadMs||0});send('audio',{audio:d.audio,index:0,total:1});send('done',{metrics:record});
  }catch(e){if(!controller.signal.aborted)send('error',{error:e.message,state:s.state});}
  finally{if(active.get(s.id)===task)active.delete(s.id);res.end();}
});
app.post('/api/s2s',async(req,res)=>{
  let s;try{s=session(req);}catch(error){return res.status(400).json({error:error.message});}
  if(typeof req.body.audio!=='string'||req.body.audio.length>2700000)return res.status(400).json({error:'MiniCPM은 30초 이하 음성 입력으로 테스트해 주세요.'});
  active.get(s.id)?.controller.abort();sonicConnections.get(s.id)?.stop();
  const controller=new AbortController(),turnId=randomUUID(),task={controller,turnId},started=performance.now();active.set(s.id,task);
  const record={id:turnId,at:new Date().toISOString(),engine:'minicpm',model:'openbmb/MiniCPM-o-4_5',input:'[음성 입력 · 별도 전사 없음]',reply:'',actions:[],results:[],state:structuredClone(s.state),inputMode:req.body.inputMode||'file',ttsProvider:'minicpm-native',vehicleTools:false,koreanSupported:false,feedback:null};s.turns.push(record);
  startSse(res);
  const send=(event,data)=>{if(!controller.signal.aborted&&!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify({...data,turnId})}\n\n`);};
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
    send('stage',{stage:'s2s'});const form=new FormData();form.append('file',new Blob([Buffer.from(req.body.audio,'base64')],{type:'audio/wav'}),'speech.wav');form.append('language',req.body.language==='ko'?'ko':'en');form.append('conversation_id',s.miniConversation);
    const response=await remote(mini+'/s2s',{method:'POST',body:form},controller.signal),reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const{value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary;
      while((boundary=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,boundary);buffer=buffer.slice(boundary+1);if(!line)continue;const data=JSON.parse(line);
        if(data.event==='error')throw new Error(data.error);
        if(data.event==='audio'){record.reply+=data.text||'';record.serverAudioReadyMs??=Math.round(performance.now()-started);send('s2sText',{text:data.text||''});send('audio',{audio:data.audio,serverAudioReadyMs:record.serverAudioReadyMs});}
        if(data.event==='done'){record.completed=true;record.modelRevision=data.revision;record.totalMs=data.totalMs;record.integrationVersion=data.integrationVersion;record.conversationContinued=data.conversationContinued;record.inputSamples=data.inputSamples;record.paddedSamples=data.paddedSamples;s.updated=Date.now();send('done',{metrics:record});}
      }
    }
    if(!record.completed)throw new Error('MiniCPM 응답이 완료되지 않았어요.');
  }catch(error){if(controller.signal.aborted)record.interrupted=true;else send('error',{error:error.message,state:s.state});}
  finally{if(active.get(s.id)===task)active.delete(s.id);res.end();}
});
app.post('/api/feedback',async(req,res)=>{
  try{
    const s=session(req),turn=s.turns.find(t=>t.id===req.body.turnId);
    if(!turn||!['good','recognition','answer','slow'].includes(req.body.rating))throw new Error('평가할 대화를 선택해 주세요.');
    turn.feedback={rating:req.body.rating,note:String(req.body.note||'').slice(0,1000),at:new Date().toISOString()};
    await mkdir('.runtime',{recursive:true});await appendFile('.runtime/feedback.jsonl',JSON.stringify(turn)+'\n');
    res.json({saved:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/metrics',(req,res)=>{
  try{
    const s=session(req),turn=s.turns.find(t=>t.id===req.body.turnId);
    const ms=req.body.firstPlaybackMs;
    if(!turn||typeof ms!=='number'||!Number.isFinite(ms)||ms<0||ms>180000)throw new Error('잘못된 측정값입니다.');
    turn.firstPlaybackMs=Math.round(ms);turn.measurementBasis=String(req.body.basis).slice(0,30);
    res.json({saved:true});
  }catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/export',(req,res)=>{
  try{const s=session(req);res.setHeader('Content-Disposition','attachment; filename="vehicle-voice-session.json"');res.json({exportedAt:new Date().toISOString(),simulation:true,models:{asr:{whisper:'openai/whisper-large-v3-turbo',nemotron:'nvidia/nemotron-3.5-asr-streaming-0.6b'},defaultPlanner:'Qwen/Qwen3.5-4B',defaultPlannerId:catalog.defaultPlannerId||'qwen35-4b',planners:plannerModels.map(m=>({id:m.id,model:m.repo,revision:m.revision,quantization:m.quantization||'bf16'})),minicpmControl:{model:'openbmb/MiniCPM-o-4_5',vehicleTools:true,output:'selected Korean TTS; hybrid'},minicpm:{model:'openbmb/MiniCPM-o-4_5',revision:catalog.models.find(m=>m.id==='minicpm-o45').revision,vehicleTools:false,koreanSupported:false},audioModels:catalog.models.filter(m=>m.role==='s2s'&&m.status==='ready'&&(m.nativeAudio||m.audioPlanner)).map(m=>({id:m.id,model:m.repo,revision:m.revision,nativeAudio:!!m.nativeAudio,defaultVehicleTools:!!m.audioPlanner,nativeComparisonVehicleTools:false,audioPlanner:!!m.audioPlanner,controlOutput:'selected Korean TTS; hybrid'})),tts:{polly:'Amazon Polly neural / Seoyeon',qwen:'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'},sonic:{id:SONIC_MODEL,region:SONIC_REGION,koreanSupported:false}},state:s.state,turns:s.turns});}catch(e){res.status(400).json({error:e.message});}
});
setInterval(()=>{for(const[id,s]of sessions)if(Date.now()-s.updated>8*3600000&&!active.has(id)&&!sonicConnections.has(id))sessions.delete(id);},60000).unref();
const server=app.listen(port,process.env.BIND_HOST||'127.0.0.1',()=>console.log(`Vehicle voice lab listening on ${port} (${cloudMode?'CloudFront':'local'})`));
const wss=new WebSocketServer({noServer:true,maxPayload:32768});
server.on('upgrade',(req,socket,head)=>{
  const host=req.headers.host;
  const url=new URL(req.url,'http://localhost');
  if(!allowedRequest(req,port,{websocket:true})||url.pathname!=='/api/sonic'||!sessions.has(url.searchParams.get('session'))){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req,url));
});
wss.on('connection',(ws,req,url)=>{
  const s=sessions.get(url.searchParams.get('session'));sonicConnections.get(s.id)?.stop();active.get(s.id)?.controller.abort();
  let record,recordStart=0,stopped=false,idleTimer;
  const send=(event,data)=>{if(ws.readyState===1)ws.send(JSON.stringify({event,data}));};
  const newRecord=(text='',mode='microphone')=>{
    record={id:randomUUID(),at:new Date().toISOString(),input:text,reply:'',actions:[],modelProposedActions:[],vehicleTools:true,results:[],state:structuredClone(s.state),engine:'sonic',model:SONIC_MODEL,region:SONIC_REGION,ttsProvider:'sonic',koreanSupported:false,inputMode:mode,feedback:null};
    recordStart=performance.now();s.turns.push(record);send('turn',{turnId:record.id});return record;
  };
  const stop=()=>{if(stopped)return;stopped=true;clearTimeout(idleTimer);clearTimeout(lifetime);if(record&&!record.completed)record.interrupted=true;sonic.close();if(sonicConnections.get(s.id)?.stop===stop)sonicConnections.delete(s.id);if(ws.readyState===1)ws.close();};
  const sonic=new SonicSession({state:s.state,language:url.searchParams.get('language')==='en'?'en':'ko',executeTool:args=>{
    if(stopped||sonicConnections.get(s.id)?.stop!==stop)throw new Error('취소된 차량 명령입니다.');
    const proposedPlan=parsePlan(JSON.stringify({intent:args.actions?.length?'control':'question',actions:args.actions,reply:''}));const gate=guardExplicitBounds(normalizeTranscript(record?.input||''),proposedPlan),plan=gate.plan;
    const result=executePlan(s.state,s.previous,plan);s.state=result.state;s.previous=result.previous;s.updated=Date.now();
    if(!record||record.completed)newRecord();record.modelProposedActions.push(...proposedPlan.actions);if(gate.reason)record.validationError=gate.reason;record.actions.push(...plan.actions);record.results.push(...result.results);record.state=structuredClone(s.state);
    return{ok:true,state:s.state,reply:result.reply,results:result.results,actions:plan.actions};
  },executeAssistantTool:async(args,signal)=>{
    if(stopped||sonicConnections.get(s.id)?.stop!==stop)throw Error('Canceled assistant tool');
    if(!record||record.completed)newRecord();const currentRecord=record;
    const result=await executeAssistant(args,s,{signal});
    if(stopped||currentRecord!==record)throw Error('Canceled assistant result');
    currentRecord.assistant=result;currentRecord.toolMs=result.elapsedMs;s.updated=Date.now();return result;
  },emit:(event,data)=>{
    s.updated=Date.now();
    if(event==='text'){
      if(data.role==='USER'){if(!record||record.completed)newRecord();record.input+=data.text;}
      else if(record)record.reply+=data.text;
    }
    if(event==='audio'&&record&&record.serverAudioReadyMs==null){record.serverAudioReadyMs=Math.round(performance.now()-recordStart);record.serverTimingBasis='ASR transcript arrival or text submission';}
    if(event==='done'&&record){record.completed=true;s.history.push({role:'user',content:record.input},{role:'assistant',content:record.reply});}
    if(event==='usage'&&record)record.usage=data;
    if(event==='interrupted'&&record)record.interrupted=true;
    send(event,{...data,turnId:record?.id});
    if(event==='error'||event==='closed')stop();
  }});
  const lifetime=setTimeout(()=>{send('closed',{reason:'15분 세션 제한 · 다시 시작해 주세요.'});stop();},15*60*1000);
  const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>{send('closed',{reason:'60초간 입력이 없어 Sonic 연결을 종료했어요.'});stop();},60000);};touch();
  sonicConnections.set(s.id,{stop});
  ws.on('message',(raw,binary)=>{
    try{
      if(binary){if(raw.length>6400||raw.length%2)throw new Error('잘못된 PCM 입력');sonic.audio(raw);if(raw.some(byte=>byte!==0))touch();}
      else{const data=JSON.parse(raw.toString());
        if(data.type==='text'&&typeof data.text==='string'&&data.text.trim()&&data.text.length<=500){touch();newRecord(data.text.trim(),'text');sonic.text(data.text.trim());}
        else if(data.type==='metrics'&&record&&Number.isFinite(data.firstPlaybackMs)&&data.firstPlaybackMs>=0&&data.firstPlaybackMs<300000){record.firstPlaybackMs=data.firstPlaybackMs;record.firstPlaybackBasis=String(data.basis||'').slice(0,100);}
        else if(data.type==='mode'&&['file','microphone'].includes(data.mode)){touch();if(!record||record.completed)newRecord('',data.mode);}
        else if(data.type==='stop')stop();else throw new Error('지원하지 않는 Sonic 입력');
      }
    }catch(error){send('error',{error:error.message});stop();}
  });
  ws.on('close',stop);ws.on('error',stop);void sonic.start();
});
