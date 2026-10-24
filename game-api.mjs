import {randomBytes,randomUUID} from 'node:crypto';
import {newGame,opening,snapshot,dispatch,gameMessages,tick,validatePlan,say,capabilities} from './game-engine.mjs';
import {gameModels,defaultGameModel,gameInference} from './game-models.mjs';
import {characterTool,resultMessages} from './game-tools.mjs';
import {GameMemory} from './game-memory.mjs';

export function mountGame(app,{recognize,synthesize,cloud=false,llmUrl=process.env.GAME_LLM_URL||'http://127.0.0.1:8000/v1/chat/completions',memory=new GameMemory(),infer=gameInference}={}){
 const sessions=new Map(),voices=new Map();
 const actor=req=>String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('channel07='))?.slice(10);
 const get=req=>{const s=sessions.get(req.headers['x-game-session']);if(!s||s.actor!==actor(req))throw Object.assign(Error('게임에 다시 연결해 주세요.'),{status:401});s.touched=Date.now();return s;};
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){if(!res.headersSent)res.status(e.status||400).json({error:e.message});}};
 const view=s=>({id:s.id,state:snapshot(s.game),memory:{provider:memory.status,visits:s.memories.visits,facts:s.memories.facts,remoteCount:s.memories.remote.length},model:s.model,toolTrace:s.toolTrace||[],planning:!!s.planning,turnStatus:s.turnStatus||null,responding:!!s.narrating,dialogueError:s.dialogueError||null,models:gameModels.map(({modelId,...m})=>m),defaultModel:defaultGameModel});
 const flush=s=>{const last=s.game.events.at(-1)?.id||0;if(last===s.savedEvent)return;s.savedEvent=last;memory.remember(s.actor,s.id,s.lastInput||'[game simulation]',s.game.memoryFacts,s.game.events.slice(-5)).catch(()=>{memory.status='degraded';});};
 const narrate=s=>{
  if(s.planning||s.narrating||s.game.queue.length||s.game.route.length||s.game.job||s.game.waitUntil)return;
  const results=s.game.events.filter(e=>e.kind==='tool'&&e.id>(s.lastNarratedEvent||0));if(!results.length)return;
  const version=s.version,model=s.model,through=results.at(-1).id;s.lastNarratedEvent=through;s.narrating=true;s.dialogueError=null;
  const signal=AbortSignal.any([s.controller?.signal||new AbortController().signal,AbortSignal.timeout(45000)]);
  const terminal=s.game.won||results.some(e=>e.ok===false||e.data?.readOnly)||(s.toolRound||0)>=3;
  const resultPrompt=resultMessages(s.game,{text:s.lastInput||'',plan:s.lastPlan||{reply:''},results});
  const messages=terminal?resultPrompt:[...gameMessages(s.game,s.lastInput||'',[],s.selected||'').slice(0,-1),{role:'user',content:JSON.stringify({originalRequest:s.lastInput||'',toolResult:JSON.parse(resultPrompt.at(-1).content).toolResult,alreadyRequested:s.toolTrace?.flatMap(t=>t.actions)||[],instruction:'This is a RESULT of your previous tool call, NOT a new user request. Decide whether the ORIGINAL request is fully complete. If complete, actions=[] and give a natural Korean reaction in at most 2 short sentences. Do NOT repeat the mission goal or a stock question. If something required by that original request remains undone, request ONLY the missing actions. Never repeat an already performed action. Do not heat food unless the original request asked for heating. Do not start the next mission goal automatically.'})}];
  infer(model,messages,{signal,llmUrl,dialogue:terminal,continuation:true}).then(async r=>{
   if(s.version!==version||signal.aborted)return;
   const plan=terminal?{reply:r.reply,actions:[]}:validatePlan(r.plan);
   if(plan.actions.length){
    const key=a=>JSON.stringify([a.type,a.target,a.item||'',a.steps||0]);
    const previous=new Set((s.toolTrace||[]).flatMap(t=>t.actions).map(key));
    if(plan.actions.some(a=>previous.has(key(a)))||(s.toolTrace||[]).flatMap(t=>t.actions).length+plan.actions.length>8){
     const final=await infer(model,resultPrompt,{signal,llmUrl,dialogue:true});
     if(s.version===version&&!signal.aborted)say(s.game,final.reply,'jiu',{source:'model',model,afterTool:through});return;
    }
    s.toolRound=(s.toolRound||0)+1;s.lastPlan=plan;s.toolTrace.push({round:s.toolRound,actions:plan.actions,protocol:r.protocol});
    dispatch(s.game,plan);s.game.history.push({role:'assistant',content:JSON.stringify({reply:plan.reply,actions:plan.actions})});
   }else{
    say(s.game,plan.reply,'jiu',{source:'model',model,afterTool:through});s.game.history.push({role:'assistant',content:plan.reply});
   }
   s.game.history=s.game.history.slice(-6);flush(s);
  }).catch(e=>{if(s.version===version&&!signal.aborted)s.dialogueError='행동은 처리됐지만 대사 생성이 지연됐어요. 실행 결과: '+(s.game.lastResult?.text||e.message);})
   .finally(()=>{if(s.version===version)s.narrating=false;});
 };
 const timer=setInterval(()=>{const now=Date.now();for(const[id,s]of sessions){if(now-s.touched>3600000){s.controller?.abort();sessions.delete(id);continue;}tick(s.game,now);narrate(s);flush(s);}},100);timer.unref();
 app.get('/api/game/health',wrap(async(req,res)=>{let llm=false;try{llm=(await fetch(llmUrl.replace('/v1/chat/completions','/health'),{signal:AbortSignal.timeout(1500)})).ok;}catch{}res.json({llm,memory:memory.status,memoryConfigured:!!memory.memoryId});}));
 app.post('/api/game/session',wrap(async(req,res)=>{
  if(sessions.size>=300)throw Error('게임 접속이 많습니다. 잠시 후 다시 시도해 주세요.');
  let who=actor(req);await memory.ready;
  if(!who||!/^[a-f0-9]{64}$/.test(who)||!memory.players[who]){who=randomBytes(32).toString('hex');res.setHeader('Set-Cookie',`channel07=${who}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${cloud?'; Secure':''}`);}
  const old=[...sessions.entries()].filter(([,s])=>s.actor===who);for(const[id,s]of old){s.controller?.abort();flush(s);sessions.delete(id);}
  const memories=await memory.recall(who),game=newGame();game.modelDialogue=true;opening(game,memories);
  const s={id:randomUUID(),actor:who,game,memories,model:gameModels.some(m=>m.id===req.body.modelId&&m.ready)?req.body.modelId:defaultGameModel,touched:Date.now(),version:0,savedEvent:0};sessions.set(s.id,s);flush(s);res.json(view(s));
 }));
 app.get('/api/game/tools',wrap(async(req,res)=>{get(req);res.json({tools:[characterTool],capabilityLookup:{name:'character_control',arguments:{reply:'',actions:[{type:'help',target:'',item:''}]},readOnly:true}});}));
 app.get('/api/game/capabilities',wrap(async(req,res)=>res.json(capabilities(get(req).game))));
 app.get('/api/game/models',wrap(async(req,res)=>res.json({models:gameModels.map(({modelId,...m})=>m),defaultModel:defaultGameModel,speech:'Whisper · Polly Seoyeon 공통'})));
 app.post('/api/game/model',wrap(async(req,res)=>{const s=get(req);if(!gameModels.some(m=>m.id===req.body.modelId&&m.ready))throw Error('연결된 모델을 선택해 주세요.');s.version++;s.controller?.abort();s.narrating=false;s.planning=false;s.turnStatus=null;s.model=req.body.modelId;res.json(view(s));}));
 app.get('/api/game/state',wrap(async(req,res)=>res.json(view(get(req)))));
 app.post('/api/game/stop',wrap(async(req,res)=>{const s=get(req);s.version++;s.controller?.abort();s.narrating=false;s.planning=false;s.turnStatus=null;dispatch(s.game,{reply:'',actions:[{type:'stop',target:'',item:''}]});flush(s);res.json(view(s));}));
 const runTurn=async(req,res)=>{
  const s=get(req);if(s.game.won)return res.json(view(s));
  if((typeof req.body.text!=='string'&&typeof req.body.audio!=='string')||req.body.text?.length>500||req.body.audio?.length>2700000)throw Error('500자 또는 30초 이하의 음성으로 지시해 주세요.');
  s.controller?.abort();s.narrating=false;s.dialogueError=null;const controller=new AbortController(),version=++s.version;s.controller=controller;const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]),started=performance.now();
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  let text=typeof req.body.text==='string'?req.body.text.trim():null,asrMs=0;
  if(!text&&req.body.audio){const form=new FormData();form.append('file',new Blob([Buffer.from(req.body.audio,'base64')],{type:'audio/wav'}),'radio.wav');const r=await recognize(form,signal);text=r.text?.trim();asrMs=r.elapsedMs;}
  signal.throwIfAborted();if(s.version!==version)throw Error('새 지시가 들어와 이전 명령을 취소했어요.');
  if(!text)throw Error('무전이 잘 안 들렸어. 다시 말해줄래?');
  if(/^(?:지우야?[,! ]*)?(?:지금\s*)?(멈춰|멈춰줘|정지|스톱|취소)[.!\s]*$/.test(text)){
   s.planning=false;dispatch(s.game,{reply:'',actions:[{type:'stop',target:'',item:''}]});s.lastInput=text;flush(s);return res.json({...view(s),heard:text,metrics:{asrMs,llmMs:0,totalMs:Math.round(performance.now()-started)}});
  }
  const llmStart=performance.now();
  const messages=gameMessages(s.game,text,[...s.memories.memories.slice(-2),...s.memories.remote],typeof req.body.selected==='string'?req.body.selected:'');
  s.planning=true;let inferred;try{inferred=req.body.guidance===true?{plan:{reply:'',actions:[{type:'help',target:'',item:''}],toolCalls:[{name:'character_control',arguments:{actions:[{type:'help',target:'',item:''}]}}]},protocol:'direct-read-only-tool'}:await infer(s.model,messages,{signal,llmUrl});}finally{if(s.version===version)s.planning=false;}
  signal.throwIfAborted();if(s.version!==version)throw Error('새 지시가 들어와 이전 명령을 취소했어요.');
  const plan=validatePlan(inferred.plan);s.lastNarratedEvent=s.game.eventCounter;s.lastPlan=plan;s.lastMessages=messages;s.toolRound=1;s.toolTrace=[{round:1,actions:plan.actions,protocol:inferred.protocol}];s.selected=typeof req.body.selected==='string'?req.body.selected:'';dispatch(s.game,plan);
  s.lastInput=text;s.game.history.push({role:'user',content:text},{role:'assistant',content:JSON.stringify({reply:plan.reply,actions:plan.actions})});s.game.history=s.game.history.slice(-6);
  if(/내가\s*책임|책임질게/.test(text)&&!s.game.memoryFacts.includes('promise'))s.game.memoryFacts.push('promise');
  flush(s);res.json({...view(s),heard:text,actions:plan.actions,toolCalls:plan.toolCalls,metrics:{asrMs,model:s.model,protocol:inferred.protocol,modelLoadMs:inferred.loadMs||0,promptTokens:inferred.tokens?.input,generatedTokens:inferred.tokens?.output,llmMs:Math.round(performance.now()-llmStart),totalMs:Math.round(performance.now()-started)}});
 };
 app.post('/api/game/turn',wrap(async(req,res)=>{
  if(!req.body.async)return await runTurn(req,res);
  const s=get(req),id=randomUUID();s.turnStatus={id,status:'processing'};s.planning=true;
  const response={writableEnded:true,on(){},json(d){if(s.turnStatus?.id===id)s.turnStatus={id,status:'done',heard:d.heard,actions:d.actions,toolCalls:d.toolCalls,metrics:d.metrics};},status(){return this;}};
  runTurn(req,response).catch(e=>{if(s.turnStatus?.id===id){s.planning=false;s.turnStatus={id,status:'error',error:e.message};}});
  res.status(202).json({...view(s),accepted:id});
 }));
 app.get('/api/game/voice/:event',wrap(async(req,res)=>{
  const s=get(req),e=s.game.events.find(x=>x.id===Number(req.params.event));if(!e||['tool','intent'].includes(e.kind))throw Error('대사를 찾지 못했어요.');
  const key=e.text;let task=voices.get(key);if(!task){task=synthesize(e.text,'polly',AbortSignal.timeout(10000));voices.set(key,task);task.catch(()=>voices.delete(key));if(voices.size>120)voices.delete(voices.keys().next().value);}
  const d=await task;res.setHeader('Content-Type','audio/wav');res.send(d.bytes);
 }));
 return {sessions,memory,close:()=>{clearInterval(timer);for(const s of sessions.values())s.controller?.abort();}};
}
