import test from 'node:test';
import assert from 'node:assert/strict';
import {SonicSession} from '../sonic.mjs';
import {initialState} from '../vehicle.mjs';

test('Sonic records final spoken text and finishes a turn even without completionEnd',async()=>{
  const events=[];
  const s=new SonicSession({state:initialState(),emit:(type,data)=>events.push({type,data}),executeTool:()=>({ok:true})});
  await s.receive({contentStart:{contentId:'preview',role:'ASSISTANT',additionalModelFields:'{"generationStage":"SPECULATIVE"}'}});
  await s.receive({textOutput:{contentId:'preview',content:'Unspoken draft'}});
  assert.equal(events.at(-1).type,'caption');
  assert.equal(events.at(-1).data.text,'Unspoken draft');
  assert.equal(events.at(-1).data.final,false);
  await s.receive({audioOutput:{content:'AAAA'}});
  await s.receive({contentStart:{contentId:'final',role:'ASSISTANT',additionalModelFields:'{"generationStage":"FINAL"}'}});
  await s.receive({textOutput:{contentId:'final',content:'Actual speech'}});
  await s.receive({contentEnd:{contentId:'final',completionId:'turn',stopReason:'END_TURN'}});
  await s.receive({completionEnd:{completionId:'turn'}});
  assert.deepEqual(events.filter(e=>e.type==='text').map(e=>e.data.text),['Actual speech']);
  const captions=events.filter(e=>e.type==='caption');
  assert.equal(captions.at(-1).data.text,'Actual speech');
  assert.equal(captions.at(-1).data.final,true);
  assert.equal(new Set(captions.map(e=>e.data.id)).size,1);
  assert.ok(events.findIndex(e=>e.type==='caption')<events.findIndex(e=>e.type==='audio'));
  assert.equal(events.filter(e=>e.type==='done').length,1);s.close();
});

test('Sonic replaces a multi-sentence preview with only spoken finals after interruption',async()=>{
  const events=[];const s=new SonicSession({state:initialState(),emit:(type,data)=>events.push({type,data}),executeTool:()=>({ok:true})});
  s.beginTurn();
  for(const [id,stage,text]of[['p','SPECULATIVE','First sentence. Unspoken second sentence.'],['f','FINAL','First sentence.']]){
    await s.receive({contentStart:{contentId:id,type:'TEXT',role:'ASSISTANT',additionalModelFields:JSON.stringify({generationStage:stage})}});
    await s.receive({textOutput:{contentId:id,content:text}});
    await s.receive({contentEnd:{contentId:id,stopReason:'PARTIAL_TURN'}});
  }
  await s.receive({textOutput:{content:'{"interrupted":true}'}});
  assert.equal(events.filter(e=>e.type==='caption').at(-1).data.text,'First sentence.');
  assert.deepEqual(events.filter(e=>e.type==='text').map(e=>e.data.text),['First sentence.']);
  const previousId=events.filter(e=>e.type==='caption').at(-1).data.id;
  s.beginTurn();
  await s.receive({contentStart:{contentId:'next',type:'TEXT',role:'ASSISTANT',additionalModelFields:'{"generationStage":"FINAL"}'}});
  await s.receive({textOutput:{contentId:'next',content:'No preview for this reply.'}});
  const next=events.filter(e=>e.type==='caption').at(-1).data;
  assert.equal(next.text,'No preview for this reply.');assert.notEqual(next.id,previousId);s.close();
});

test('Sonic removes an entirely unspoken preview on interruption',async()=>{
  const events=[];const s=new SonicSession({state:initialState(),emit:(type,data)=>events.push({type,data}),executeTool:()=>({ok:true})});
  await s.receive({contentStart:{contentId:'p',role:'ASSISTANT',additionalModelFields:'{"generationStage":"SPECULATIVE"}'}});
  await s.receive({textOutput:{contentId:'p',content:'Unspoken'}});
  await s.receive({contentEnd:{contentId:'p',stopReason:'INTERRUPTED'}});
  assert.equal(events.filter(e=>e.type==='caption').at(-1).data.text,'');
  assert.equal(events.filter(e=>e.type==='text').length,0);s.close();
});

test('Sonic cannot execute duplicate or canceled vehicle tool calls',async()=>{
  let calls=0;const s=new SonicSession({state:initialState(),emit:()=>{},executeTool:()=>{calls++;return{ok:true};}});
  const call={toolUseId:'one',toolName:'vehicle_control',content:'{"actions":[]}'};
  await s.tool(call);await s.tool(call);assert.equal(calls,1);
  s.close();await s.tool({...call,toolUseId:'two'});assert.equal(calls,1);
});

test('continuous Sonic microphone turns sharing completionId each finish exactly once',async()=>{
  const events=[];const s=new SonicSession({state:initialState(),emit:(type,data)=>events.push({type,data}),executeTool:()=>({ok:true})});
  for(let turn=1;turn<=3;turn++){
    await s.receive({contentStart:{contentId:`user-${turn}`,type:'TEXT',role:'USER',additionalModelFields:'{"generationStage":"FINAL"}'}});
    await s.receive({textOutput:{contentId:`user-${turn}`,content:'A new user request'}});
    await s.receive({contentEnd:{contentId:`user-${turn}`,completionId:'shared',stopReason:'END_TURN'}});
    await s.receive({contentStart:{contentId:`reply-${turn}`,type:'TEXT',role:'ASSISTANT',additionalModelFields:'{"generationStage":"FINAL"}'}});
    await s.receive({textOutput:{contentId:`reply-${turn}`,content:'Done'}});
    await s.receive({contentEnd:{contentId:`reply-${turn}`,completionId:'shared',stopReason:'END_TURN'}});
    await s.receive({completionEnd:{completionId:'shared'}});
  }
  assert.deepEqual(events.filter(e=>e.type==='done').map(e=>e.data.sonicTurn),[1,2,3]);s.close();
});

test('Sonic defaults to patient turn detection and validates comparison settings',()=>{
 for(const sensitivity of ['LOW','MEDIUM','HIGH']){
  const s=new SonicSession({state:initialState(),emit:()=>{},...(sensitivity==='LOW'?{}:{endpointingSensitivity:sensitivity})});
  const start=JSON.parse(s.queue.values[0].chunk.bytes.toString()).event.sessionStart;
  assert.equal(start.turnDetectionConfiguration.endpointingSensitivity,sensitivity);s.close();
 }
 assert.throws(()=>new SonicSession({endpointingSensitivity:'arbitrary'}));
});
