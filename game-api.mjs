import {randomBytes,randomUUID} from 'node:crypto';
import {newGame,opening,snapshot,dispatch,gameSchema,gameMessages,tick,validatePlan} from './game-engine.mjs';
import {GameMemory} from './game-memory.mjs';

export function mountGame(app,{recognize,synthesize,cloud=false,llmUrl=process.env.GAME_LLM_URL||'http://127.0.0.1:8000/v1/chat/completions',memory=new GameMemory()}={}){
 const sessions=new Map(),voices=new Map();
 const actor=req=>String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('channel07='))?.slice(10);
 const get=req=>{const s=sessions.get(req.headers['x-game-session']);if(!s||s.actor!==actor(req))throw Object.assign(Error('게임에 다시 연결해 주세요.'),{status:401});s.touched=Date.now();return s;};
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){if(!res.headersSent)res.status(e.status||400).json({error:e.message});}};
 const view=s=>({id:s.id,state:snapshot(s.game),memory:{provider:memory.status,visits:s.memories.visits,facts:s.memories.facts,remoteCount:s.memories.remote.length},model:'Qwen3.5-4B · Whisper · Polly'});
 const flush=s=>{const last=s.game.events.at(-1)?.id||0;if(last===s.savedEvent)return;s.savedEvent=last;memory.remember(s.actor,s.id,s.lastInput||'[game simulation]',s.game.memoryFacts,s.game.events.slice(-5)).catch(()=>{memory.status='degraded';});};
 const timer=setInterval(()=>{const now=Date.now();for(const[id,s]of sessions){if(now-s.touched>3600000){s.controller?.abort();sessions.delete(id);continue;}tick(s.game,now);flush(s);}},100);timer.unref();
 app.get('/api/game/health',wrap(async(req,res)=>{let llm=false;try{llm=(await fetch(llmUrl.replace('/v1/chat/completions','/health'),{signal:AbortSignal.timeout(1500)})).ok;}catch{}res.json({llm,memory:memory.status,memoryConfigured:!!memory.memoryId});}));
 app.post('/api/game/session',wrap(async(req,res)=>{
  if(sessions.size>=300)throw Error('게임 접속이 많습니다. 잠시 후 다시 시도해 주세요.');
  let who=actor(req);await memory.ready;
  if(!who||!/^[a-f0-9]{64}$/.test(who)||!memory.players[who]){who=randomBytes(32).toString('hex');res.setHeader('Set-Cookie',`channel07=${who}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${cloud?'; Secure':''}`);}
  const old=[...sessions.entries()].filter(([,s])=>s.actor===who);for(const[id,s]of old){s.controller?.abort();flush(s);sessions.delete(id);}
  const memories=await memory.recall(who),game=newGame();opening(game,memories);
  const s={id:randomUUID(),actor:who,game,memories,touched:Date.now(),version:0,savedEvent:0};sessions.set(s.id,s);flush(s);res.json(view(s));
 }));
 app.get('/api/game/state',wrap(async(req,res)=>res.json(view(get(req)))));
 app.post('/api/game/stop',wrap(async(req,res)=>{const s=get(req);s.version++;s.controller?.abort();dispatch(s.game,{reply:'',actions:[{type:'stop',target:'',item:''}]});flush(s);res.json(view(s));}));
 app.post('/api/game/turn',wrap(async(req,res)=>{
  const s=get(req);if(s.game.won)return res.json(view(s));
  if((typeof req.body.text!=='string'&&typeof req.body.audio!=='string')||req.body.text?.length>500||req.body.audio?.length>2700000)throw Error('500자 또는 30초 이하의 음성으로 지시해 주세요.');
  s.controller?.abort();const controller=new AbortController(),version=++s.version;s.controller=controller;const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(35000)]),started=performance.now();
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  let text=typeof req.body.text==='string'?req.body.text.trim():null,asrMs=0;
  if(!text&&req.body.audio){const form=new FormData();form.append('file',new Blob([Buffer.from(req.body.audio,'base64')],{type:'audio/wav'}),'radio.wav');const r=await recognize(form,signal);text=r.text?.trim();asrMs=r.elapsedMs;}
  signal.throwIfAborted();if(s.version!==version)throw Error('새 지시가 들어와 이전 명령을 취소했어요.');
  if(!text)throw Error('무전이 잘 안 들렸어. 다시 말해줄래?');
  if(/^(?:지우야?[,! ]*)?(?:지금\s*)?(멈춰|멈춰줘|정지|스톱|취소)[.!\s]*$/.test(text)){
   dispatch(s.game,{reply:'',actions:[{type:'stop',target:'',item:''}]});s.lastInput=text;flush(s);return res.json({...view(s),heard:text,metrics:{asrMs,llmMs:0,totalMs:Math.round(performance.now()-started)}});
  }
  const llmStart=performance.now();
  const messages=gameMessages(s.game,text,[...s.memories.memories.slice(-2),...s.memories.remote],typeof req.body.selected==='string'?req.body.selected:'');
  const r=await fetch(llmUrl,{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({model:'vehicle-planner',messages,temperature:0,seed:7,max_tokens:500,chat_template_kwargs:{enable_thinking:false},structured_outputs:{json:gameSchema}})});
  if(!r.ok)throw Object.assign(Error('게임 판단 모델에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'),{status:502});
  const data=await r.json();signal.throwIfAborted();if(s.version!==version)throw Error('새 지시가 들어와 이전 명령을 취소했어요.');
  if(data.choices?.[0]?.finish_reason==='length')throw Error('지시가 너무 길었어. 한 번에 한두 가지씩 말해줄래?');
  const plan=validatePlan(JSON.parse(data.choices?.[0]?.message?.content||'null'));dispatch(s.game,plan);
  s.lastInput=text;s.game.history.push({role:'user',content:text},{role:'assistant',content:JSON.stringify(plan)});s.game.history=s.game.history.slice(-6);
  if(/내가\s*책임|책임질게/.test(text)&&!s.game.memoryFacts.includes('promise'))s.game.memoryFacts.push('promise');
  flush(s);res.json({...view(s),heard:text,actions:plan.actions,metrics:{asrMs,promptTokens:data.usage?.prompt_tokens,generatedTokens:data.usage?.completion_tokens,llmMs:Math.round(performance.now()-llmStart),totalMs:Math.round(performance.now()-started)}});
 }));
 app.get('/api/game/voice/:event',wrap(async(req,res)=>{
  const s=get(req),e=s.game.events.find(x=>x.id===Number(req.params.event));if(!e)throw Error('대사를 찾지 못했어요.');
  const key=e.text;let task=voices.get(key);if(!task){task=synthesize(e.text,'polly',AbortSignal.timeout(10000));voices.set(key,task);task.catch(()=>voices.delete(key));if(voices.size>120)voices.delete(voices.keys().next().value);}
  const d=await task;res.setHeader('Content-Type','audio/wav');res.send(d.bytes);
 }));
 return {sessions,memory,close:()=>clearInterval(timer)};
}
