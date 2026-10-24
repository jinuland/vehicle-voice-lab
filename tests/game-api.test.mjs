import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {mountGame} from '../game-api.mjs';import {GameMemory} from '../game-memory.mjs';
test('game sessions require both the opaque cookie and session token; stop is independent of the model',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'channel07-api-'));const app=express();app.use(express.json());const game=mountGame(app,{memory:new GameMemory({path:join(dir,'memory.json')}),llmUrl:'http://127.0.0.1:1/v1/chat/completions'});const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{const a=await fetch(base+'/api/game/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const cookie=a.headers.get('set-cookie').split(';')[0],s=await a.json();assert.ok(s.id);let r=await fetch(base+'/api/game/state',{headers:{'X-Game-Session':s.id}});assert.equal(r.status,401);r=await fetch(base+'/api/game/state',{headers:{Cookie:cookie,'X-Game-Session':s.id}});assert.equal(r.status,200);r=await fetch(base+'/api/game/stop',{method:'POST',headers:{Cookie:cookie,'X-Game-Session':s.id,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,200);const b=await fetch(base+'/api/game/session',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});const fresh=await b.json();assert.equal(fresh.memory.visits,2);r=await fetch(base+'/api/game/state',{headers:{Cookie:cookie,'X-Game-Session':s.id}});assert.equal(r.status,401);}
 finally{game.close();await new Promise(r=>server.close(r));await game.memory.writing;await rm(dir,{recursive:true,force:true});}
});
test('a late ASR result cannot cancel a newer instruction after stop',async()=>{
 const {dispatch}=await import('../game-engine.mjs');const dir=await mkdtemp(join(tmpdir(),'channel07-race-'));const app=express();app.use(express.json());let release,started;const began=new Promise(r=>started=r);const game=mountGame(app,{memory:new GameMemory({path:join(dir,'memory.json')}),recognize:()=>{started();return new Promise(r=>release=r);}});const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{const r=await fetch(base+'/api/game/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=r.headers.get('set-cookie').split(';')[0],s=await r.json(),headers={Cookie:cookie,'X-Game-Session':s.id,'Content-Type':'application/json'};const pending=fetch(base+'/api/game/turn',{method:'POST',headers,body:JSON.stringify({audio:'YWJj'})});await began;await fetch(base+'/api/game/stop',{method:'POST',headers,body:'{}'});const state=game.sessions.get(s.id).game;dispatch(state,{reply:'',actions:[{type:'take',target:'coffee',item:''}]});const command=state.command;release({text:'멈춰',elapsedMs:1});assert.equal((await pending).status,400);assert.equal(state.command,command);assert.equal(state.job.target,'coffee');}
 finally{game.close();await new Promise(r=>server.close(r));await game.memory.writing;await rm(dir,{recursive:true,force:true});}
});

test('character tool results return to the selected model; fixed execution receipts are not spoken',async()=>{
 const {tick}=await import('../game-engine.mjs'),dir=await mkdtemp(join(tmpdir(),'channel07-tools-'));let returned,release;
 const app=express();app.use(express.json());const game=mountGame(app,{memory:new GameMemory({path:join(dir,'memory.json')}),infer:async(id,messages,opts)=>{
  if(!opts.continuation)return {plan:{reply:'뒤로? 내 뒤 좀 봐줘.',actions:[{type:'step',target:'backward',item:'',steps:2}],toolCalls:[{name:'character_control',arguments:{actions:[{type:'step',target:'backward',item:'',steps:2}]}}]}};
  assert.equal(messages.filter(m=>m.role==='user'&&m.content==='뒤로 두 발자국').length,1);returned={id,messages};return new Promise(r=>release=r);
 }});const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const r=await fetch(base+'/api/game/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=r.headers.get('set-cookie').split(';')[0],s=await r.json(),headers={Cookie:cookie,'X-Game-Session':s.id,'Content-Type':'application/json'};
  const d=await(await fetch(base+'/api/game/turn',{method:'POST',headers,body:JSON.stringify({text:'뒤로 두 발자국'})})).json();assert.equal(d.toolCalls[0].name,'character_control');
  const state=game.sessions.get(s.id).game;for(let i=0;i<20;i++)tick(state,state.lastTick+100);
  for(let i=0;i<20&&!returned;i++)await new Promise(r=>setTimeout(r,25));assert.ok(returned);const result=JSON.parse(returned.messages.at(-1).content).toolResult;assert.equal(result.status,'completed');assert.ok(Math.abs(state.z+1.1)<.001);assert.equal(result.results.length,1);assert.equal(state.events.find(e=>e.text.includes('발자국 움직였어')).kind,'tool');
  release({plan:{reply:'됐어. 여기서 더 가면 내 사무실보다 좁아지겠는데?',actions:[]}});await new Promise(r=>setTimeout(r,20));assert.equal(state.events.at(-1).source,'model');assert.equal(state.events.at(-1).model,'qwen35-4b');
 }finally{game.close();await new Promise(r=>server.close(r));await game.memory.writing;await rm(dir,{recursive:true,force:true});}
});

test('async turns survive HTTP completion and remain cancelable while a model is loading',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'channel07-async-'));let release,called;const began=new Promise(r=>called=r),app=express();app.use(express.json());
 const game=mountGame(app,{memory:new GameMemory({path:join(dir,'memory.json')}),infer:()=>{called();return new Promise(r=>release=r);}});const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const first=await fetch(base+'/api/game/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=first.headers.get('set-cookie').split(';')[0],s=await first.json(),headers={Cookie:cookie,'X-Game-Session':s.id,'Content-Type':'application/json'};
  const r=await fetch(base+'/api/game/turn',{method:'POST',headers,body:JSON.stringify({text:'커피 집어',async:true})});assert.equal(r.status,202);const d=await r.json();assert.ok(d.accepted);await began;
  await fetch(base+'/api/game/stop',{method:'POST',headers,body:'{}'});release({plan:{reply:'가져올게.',actions:[{type:'take',target:'coffee',item:''}]}});await new Promise(r=>setTimeout(r,20));
  const state=await(await fetch(base+'/api/game/state',{headers})).json();assert.equal(state.turnStatus,null);assert.deepEqual(state.state.inventory,[]);assert.equal(state.state.pendingActions,0);
 }finally{game.close();await new Promise(r=>server.close(r));await game.memory.writing;await rm(dir,{recursive:true,force:true});}
});

test('the model can reason over a tool result and request a missing follow-up action',async()=>{
 const {tick}=await import('../game-engine.mjs'),dir=await mkdtemp(join(tmpdir(),'channel07-loop-'));let calls=0;
 const app=express();app.use(express.json());const game=mountGame(app,{memory:new GameMemory({path:join(dir,'memory.json')}),infer:async(id,messages,opts)=>{
  calls++;return {plan:calls===1?{reply:'가서 볼게.',actions:[{type:'move',target:'banana',item:''}]}:calls===2?{reply:'여기 있네. 집을게.',actions:[{type:'take',target:'banana',item:''}]}:{reply:'바나나 챙겼어.',actions:[]}};
 }});const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const first=await fetch(base+'/api/game/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=first.headers.get('set-cookie').split(';')[0],s=await first.json(),headers={Cookie:cookie,'X-Game-Session':s.id,'Content-Type':'application/json'};
  await fetch(base+'/api/game/turn',{method:'POST',headers,body:JSON.stringify({text:'바나나 챙겨'})});const state=game.sessions.get(s.id).game;
  for(let i=0;i<100&&calls<3;i++){tick(state,state.lastTick+200);await new Promise(r=>setTimeout(r,10));}
  assert.equal(calls,3);assert.ok(state.inventory.includes('banana'));assert.equal(game.sessions.get(s.id).toolTrace.length,2);assert.equal(state.events.at(-1).text,'바나나 챙겼어.');
 }finally{game.close();await new Promise(r=>server.close(r));await game.memory.writing;await rm(dir,{recursive:true,force:true});}
});
test('explicit guidance calls the read-only capability tool and never lets a model dispatch movements',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'channel07-guidance-'));let calls=0;const app=express();app.use(express.json());const game=mountGame(app,{memory:new GameMemory({path:join(dir,'memory.json')}),infer:async(id,messages,options)=>{calls++;assert.equal(options.dialogue,true);assert.equal(JSON.parse(messages.at(-1).content).toolResult.results[0].data.readOnly,true);return {reply:'주변 물건을 조사하거나 다른 조합을 골라볼래?'};}});const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{const first=await fetch(base+'/api/game/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),cookie=first.headers.get('set-cookie').split(';')[0],s=await first.json(),headers={Cookie:cookie,'X-Game-Session':s.id,'Content-Type':'application/json'};const r=await fetch(base+'/api/game/turn',{method:'POST',headers,body:JSON.stringify({text:'어떤 걸로 문을 열까?',guidance:true})});const d=await r.json();assert.equal(d.metrics.protocol,'direct-read-only-tool');assert.equal(d.actions[0].type,'help');for(let i=0;i<20&&!calls;i++)await new Promise(r=>setTimeout(r,25));assert.equal(calls,1);const state=game.sessions.get(s.id).game;assert.deepEqual(state.inventory,[]);assert.equal(state.doorOpen,false);assert.equal(state.x,-7.5);assert.equal(state.experiments.length,0);}
 finally{game.close();await new Promise(r=>server.close(r));await game.memory.writing;await rm(dir,{recursive:true,force:true});}
});
