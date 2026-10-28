import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('Sonic microphone input resamples to 16kHz signed PCM with clipped amplitudes',()=>{
  const scope=vm.createContext({window:{},Float32Array,Uint8Array,DataView});
  vm.runInContext(readFileSync(new URL('../public/sonic-client.js',import.meta.url),'utf8'),scope);
  const pcm=scope.window.voiceLabPCM16(new Float32Array(4800).fill(.25),48000);
  assert.equal(pcm.length,3200);assert.equal(new DataView(pcm.buffer).getInt16(0,true),8191);
  const clipped=scope.window.voiceLabPCM16(new Float32Array([2,-2]),16000),view=new DataView(clipped.buffer);
  assert.equal(view.getInt16(0,true),32767);assert.equal(view.getInt16(2,true),-32768);
});

function sonicClient(){
 const context=vm.createContext({window:{},Float32Array,Uint8Array,DataView,performance:{now:()=>1000},setTimeout,clearTimeout});
 vm.runInContext(readFileSync(new URL('../public/sonic-client.js',import.meta.url),'utf8'),context);
 return new context.window.SonicVoice({sessionId:'test',language:'en',onEvent:()=>{}});
}
test('Sonic sends the rest of a long utterance after a premature transcript, regardless of the legacy checkbox',()=>{
 const voice=sonicClient(),speech=new Float32Array(2048).fill(.1);let chunks=0;
 voice.sendPCM=bytes=>{chunks++;assert.ok(bytes.some(b=>b!==0),'Speech must not be replaced with silence');};
 // More than 40 s of continuous microphone audio, including pending and speaking states.
 for(let i=0;i<950;i++){
  if(i===10)voice.handle('text',{role:'USER',text:'I would like to, um...'});
  if(i===100)voice.sources.add({});
  voice.mic(speech,48000,false);
 }
 assert.equal(chunks,950);
});
test('native Sonic interruption stops all scheduled audio and clears the playback queue',()=>{
 const voice=sonicClient();let stopped=0,disconnected=0;
 for(let i=0;i<3;i++)voice.sources.add({stop(){stopped++;},disconnect(){disconnected++;}});
 voice.awaiting=true;voice.nextTime=42;voice.handle('interrupted',{});
 assert.equal(stopped,3);assert.equal(disconnected,3);assert.equal(voice.sources.size,0);assert.equal(voice.nextTime,0);assert.equal(voice.awaiting,false);
});

test('patient microphone playback waits through a resumed hesitation and never ends while audio is held',()=>{
 let now=100,id=0;const timers=new Map(),events=[],played=[];
 const scope=vm.createContext({window:{},Float32Array,Uint8Array,DataView,performance:{now:()=>now},setTimeout:(fn)=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(readFileSync(new URL('../public/sonic-client.js',import.meta.url),'utf8'),scope);
 const voice=new scope.window.SonicVoice({sessionId:'test',language:'en',onEvent:(type)=>events.push(type)});
 voice.sendPCM=()=>{};voice.play=data=>played.push(data);voice.liveMic=true;
 voice.mic(new Float32Array(1600).fill(.1),16000);
 voice.handle('audio',{audio:'AAAA',sampleRate:24000});voice.handle('done',{});
 assert.equal(played.length,0);assert.ok(!events.includes('playbackEnd'));
 now=1600;voice.mic(new Float32Array(1600).fill(.1),16000);
 now=2700;voice.flushAudio();assert.equal(played.length,0,'A filler extends the quiet-period deadline');
 now=4200;voice.flushAudio();assert.equal(played.length,1);assert.equal(timers.size,0);
 voice.lastVoiceAt=4200;voice.handle('audio',{audio:'AAAA',sampleRate:24000});
 voice.handle('interrupted',{});assert.equal(voice.pendingAudio.length,0);assert.equal(timers.size,0);
 now=9000;voice.flushAudio();assert.equal(played.length,1,'Interrupted buffered replies must never play later');
});
