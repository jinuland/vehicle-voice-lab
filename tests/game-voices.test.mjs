import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mountGame} from '../game-api.mjs';
import {GameMemory} from '../game-memory.mjs';

async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'channel07-voices-')),app=express(),calls=[];app.use(express.json());
 const game=mountGame(app,{memory:new GameMemory({path:join(dir,'memory.json')}),synthesize:async(text,provider,signal,options)=>{calls.push({text,provider,options});return {bytes:Buffer.from(options.voiceId+':'+options.engine),elapsedMs:1};}});
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const create=async(voiceId)=>{const r=await fetch(base+'/api/game/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voiceId})});assert.equal(r.status,200);const state=await r.json();return {state,headers:{Cookie:r.headers.get('set-cookie').split(';')[0],'X-Game-Session':state.id,'Content-Type':'application/json'}};};
 try{await run({base,game,calls,create});}
 finally{game.close();await new Promise(r=>server.close(r));await game.memory.writing;await rm(dir,{recursive:true,force:true});}
}
test('changing game voice keeps the world and model, isolates players, and does not reuse another timbre',async()=>fixture(async({base,game,calls,create})=>{
 const a=await create('jihye'),b=await create('hyunduk'),s=game.sessions.get(a.state.id);
 s.game.inventory.push('banana');s.game.doorOpen=true;s.game.x=-6;
 const event=s.game.events.find(e=>e.kind==='jiu').id;
 const first=await fetch(base+'/api/game/voice/'+event,{headers:a.headers});assert.equal(first.status,200);assert.equal(first.headers.get('x-game-voice'),'jihye');assert.equal(await first.text(),'Jihye:neural');
 await (await fetch(base+'/api/game/voice/'+event,{headers:a.headers})).arrayBuffer();assert.equal(calls.length,1);
 const r=await fetch(base+'/api/game/voice',{method:'POST',headers:a.headers,body:JSON.stringify({voiceId:'hyunduk'})}),changed=await r.json();
 assert.equal(r.status,200);assert.equal(changed.id,a.state.id);assert.equal(changed.model,a.state.model);assert.deepEqual(changed.state.inventory,['banana']);assert.equal(changed.state.doorOpen,true);assert.equal(changed.voiceId,'hyunduk');assert.equal(changed.state.x,-6);
 const second=await fetch(base+'/api/game/voice/'+event,{headers:a.headers});assert.equal(second.headers.get('x-tts-engine'),'generative');assert.equal(await second.text(),'Hyunduk:generative');assert.equal(calls.length,2);
 assert.equal((await fetch(base+'/api/game/voice',{method:'POST',headers:a.headers,body:JSON.stringify({voiceId:'arbitrary-speaker'})})).status,400);
 assert.equal((await fetch(base+'/api/game/voice',{method:'POST',headers:{...a.headers,Cookie:b.headers.Cookie},body:JSON.stringify({voiceId:'seoyeon'})})).status,401);
 assert.equal(game.sessions.get(b.state.id).voiceId,'hyunduk');
 const invalid=await fetch(base+'/api/game/session',{method:'POST',headers:a.headers,body:JSON.stringify({voiceId:'unknown'})});assert.equal(invalid.status,400);assert.ok(game.sessions.has(a.state.id));
}));
test('pre-game previews accept only the cached fixed sample and a known voice',async()=>fixture(async({base,calls})=>{
 const catalog=await(await fetch(base+'/api/game/voices')).json();assert.equal(catalog.voices.length,4);
 for(const voice of catalog.voices){
  const r=await fetch(base+'/api/game/voice-preview/'+voice.id+'?text=attacker-input');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'audio/wav');await r.arrayBuffer();
 }
 assert.equal(calls.length,4);assert.ok(calls.every(c=>c.text===catalog.previewText&&c.provider==='polly'));
 await (await fetch(base+'/api/game/voice-preview/jihye')).arrayBuffer();assert.equal(calls.length,4);
 assert.equal((await fetch(base+'/api/game/voice-preview/not-allowed')).status,400);assert.equal(calls.length,4);
}));
