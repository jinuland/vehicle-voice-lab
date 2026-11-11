import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {StrandsSonicSession} from '../strands-sonic.mjs';

test('Strands bridge forwards audio, validated tool results, and response events',async()=>{
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
 const previous=process.env.STRANDS_BIDI_URL;process.env.STRANDS_BIDI_URL=`ws://127.0.0.1:${server.address().port}/ws`;
 const emitted=[];let seenTool;
 const s=new StrandsSonicSession({state:{},language:'ko',systemInstruction:'test',emit:(type,data)=>emitted.push({type,data}),executeTool:async(args)=>{seenTool=args;return {ok:true};}});
 const connection=once(server,'connection');const running=s.start();const [socket]=await connection;
 try{
  const first=await once(socket,'message');const init=JSON.parse(first[0].toString());assert.equal(init.prompt,'test');assert.equal(init.tools[0].name,'vehicle_control');
  const received=once(socket,'message');s.audio(Buffer.from([0,1]));const [audio,isBinary]=await received;assert.ok(isBinary);assert.deepEqual([...audio],[0,1]);
  socket.send(JSON.stringify({type:'ready'}));
  const reply=once(socket,'message');socket.send(JSON.stringify({type:'tool_call',id:'1',name:'vehicle_control',arguments:{actions:[]}}));
  const [raw]=await reply;assert.deepEqual(seenTool,{actions:[]});assert.equal(JSON.parse(raw.toString()).result.ok,true);
  socket.send(JSON.stringify({type:'event',event:{type:'bidi_audio_stream_delta',audio:'AA==',sample_rate:24000}}));
  socket.send(JSON.stringify({type:'event',event:{type:'bidi_response_stop',response_id:'r'}}));
  await new Promise(resolve=>setTimeout(resolve,20));assert.ok(emitted.some(e=>e.type==='ready'));assert.ok(emitted.some(e=>e.type==='audio'));assert.ok(emitted.some(e=>e.type==='done'));
 }finally{s.close();await running;await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.STRANDS_BIDI_URL;else process.env.STRANDS_BIDI_URL=previous;}
});
