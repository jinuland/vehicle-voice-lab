import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {GameMemory} from '../game-memory.mjs';
test('verified incidents survive restart, stay isolated by actor and reach AgentCore',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'channel07-memory-')),path=join(dir,'memory.json'),a='a'.repeat(64),b='b'.repeat(64),calls=[];
 const client={send:async command=>{calls.push(command);return command.constructor.name==='RetrieveMemoryRecordsCommand'?{memoryRecordSummaries:[{content:{text:'Previous verified banana incident'}}]}:{event:{eventId:'event'}};}};
 try{const m=new GameMemory({path,memoryId:'test-memory',client});await m.recall(a);await m.remember(a,'session','문 열어봐',['banana'],[{kind:'jiu',text:'바나나로는 안 열려.'}]);await Promise.all(m.pending);assert.equal(m.status,'agentcore');const write=calls.find(x=>x.constructor.name==='CreateEventCommand');assert.equal(write.input.actorId,a);assert.match(write.input.payload[1].conversational.content.text,/Verified game events/);const fresh=new GameMemory({path,memoryId:'test-memory',client});const recalled=await fresh.recall(a);assert.ok(recalled.facts.includes('banana'));assert.equal(recalled.visits,2);assert.equal(recalled.remote.length,1);const other=await fresh.player(b);assert.deepEqual(other.facts,[]);assert.ok(calls.some(x=>x.input.namespace===`/channel07/${a}/facts`));await assert.rejects(()=>fresh.player('../other'));await fresh.writing;}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('only engine outcomes, never a model claim, enter verified incident memory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'channel07-truth-'));try{
  const memory=new GameMemory({path:join(dir,'memory.json')}),actor='c'.repeat(64);await memory.remember(actor,'s','문 열어',[],[{kind:'tool',text:'문이 잠겨 있어.',ok:false},{kind:'jiu',source:'model',text:'문 열렸어.'},{kind:'intent',text:'문을 열었어.'}]);assert.match(memory.players[actor].memories[0],/잠겨/);assert.doesNotMatch(memory.players[actor].memories[0],/열렸|열었/);await memory.writing;
 }finally{await rm(dir,{recursive:true,force:true});}
});
