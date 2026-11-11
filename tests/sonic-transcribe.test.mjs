import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createTranscribeInput,prepareTranscribePcm} from '../sonic-transcribe.mjs';

test('optional PCM gain keeps sample count and prevents clipping',()=>{
  const pcm=Buffer.alloc(6);
  pcm.writeInt16LE(4000,0);pcm.writeInt16LE(-5000,2);pcm.writeInt16LE(1000,4);
  const boosted=prepareTranscribePcm(pcm,2);
  assert.equal(boosted.length,pcm.length);
  assert.deepEqual([0,2,4].map(i=>boosted.readInt16LE(i)),[8000,-10000,2000]);
  assert.equal(pcm.readInt16LE(2),-5000);
  pcm.writeInt16LE(-20000,2);
  assert.equal(prepareTranscribePcm(pcm,2).readInt16LE(2),-32000);
  pcm.writeInt16LE(-32768,2);
  assert.equal(prepareTranscribePcm(pcm,2).readInt16LE(2),-32768);
  assert.equal(prepareTranscribePcm(pcm,1),pcm);
});

const result=(id,start,text,partial=false)=>({ResultId:id,StartTime:start,IsPartial:partial,Alternatives:[{Transcript:text}]});
test('streams bounded PCM before utterance end; delivers one ordered final transcript',async()=>{
  const packets=[],errors=[],sent=[];
  const input=createTranscribeInput({language:'ko',viewer:'unit-ordered',onError:d=>errors.push(d),onFinal:d=>sent.push(d),
    async *events(audio,language){
      assert.equal(language,'ko');
      for await(const {AudioEvent:{AudioChunk}} of audio){
        packets.push(AudioChunk.length);
        yield result('a',0,'틀린 미확정 문장',true);
      }
      yield result('b',2,'운전석은 27°로.');
      yield result('a',0,'조수석 이십오 도로.');
      yield result('a',0,'조수석 이십오 도로.');
    },
  });
  input.start('microphone');input.push(Buffer.alloc(2000));input.push(Buffer.alloc(2000));
  await tick();
  assert.deepEqual(packets,[3200]);assert.equal(sent.length,0);
  input.finish();input.finish();
  await tick();
  assert.deepEqual(packets,[3200,800]);assert.equal(sent.length,1);
  assert.equal(sent[0].rawText,'조수석 이십오 도로. 운전석은 27°로.');
  assert.equal(sent[0].text,'조수석 25 도로. 운전석은 27도로.');assert.ok(sent[0].finalizeMs>=0);
  assert.deepEqual(errors,[]);assert.equal(input.active,false);
});

test('canceled recognition cannot apply a late transcript; empty input releases the slot',async()=>{
  const errors=[],sent=[];let aborted;
  const input=createTranscribeInput({language:'ko',viewer:'unit-cancel',onError:d=>errors.push(d.code),onFinal:d=>sent.push(d),
    async *events(audio,_language,signal){
      for await(const _packet of audio){}
      aborted=signal.aborted;yield result('late',0,'음량을 20으로 맞춰줘.');
    },
  });
  input.start('microphone');input.push(Buffer.alloc(3200));input.close();
  await tick();
  assert.equal(aborted,true);assert.deepEqual(sent,[]);
  input.start('file');input.finish();assert.deepEqual(errors,['empty']);assert.equal(input.active,false);
});

test('microphone forwards audio before endpointing and anchors latency at the last voiced frame',async()=>{
  const el=new Map(),events=[];let now=0;
  const context=vm.createContext({
    document:{addEventListener(){},getElementById(id){if(!el.has(id))el.set(id,{style:{}});return el.get(id);}},
    window:{voiceLabPCM16(frame){return frame;}},performance:{now:()=>now},events,
  });
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  vm.runInContext(source.slice(0,source.indexOf("$('conversation-engine').addEventListener")),context);
  vm.runInContext(`
    engine='sonic';$('sonic-input').value='transcribe';$('sonic-asr-pause').value='850';
    micEnabled=true;audioContext={sampleRate:16000};resetSonicMetrics=()=>{};setStatus=()=>{};
    ensureSonic=async()=>({beginAsr:mode=>events.push(mode),sendPCM:()=>events.push('frame'),finishAsr:(mode,endedAt)=>events.push({mode,endedAt})});
    submit=()=>{throw Error('Should not upload a recorded WAV to Whisper');};
    const voiced=new Float32Array(1600).fill(.08),quiet=new Float32Array(1600);
  `,context);
  for(let i=1;i<=5;i++){now=i*100;vm.runInContext('onPCM(voiced)',context);await tick();}
  assert.equal(events[0],'microphone');assert.equal(events.filter(e=>e==='frame').length,5);
  for(let i=6;i<=13;i++){now=i*100;vm.runInContext('onPCM(quiet)',context);}
  assert.ok(events.every(e=>typeof e==='string'));
  now=1400;vm.runInContext('onPCM(quiet)',context);
  assert.equal(events.at(-1).mode,'microphone');assert.equal(events.at(-1).endedAt,500);
});
