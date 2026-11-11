import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {sonicAsrRoute,sonicWavPCM} from '../sonic-asr.mjs';

const sample=await readFile(new URL('../public/sample-command.wav',import.meta.url));

test('external ASR accepts the demo WAV with metadata, and rejects malformed or unsupported WAVs',()=>{
  assert.equal(sonicWavPCM(sample).length,163840);
  assert.equal(sonicWavPCM(sample.subarray(0,-2)),null);
  const wrongRate=Buffer.from(sample);wrongRate.writeUInt32LE(24000,24);
  assert.equal(sonicWavPCM(wrongRate),null);
  const tooLong=Buffer.alloc(961000);sample.copy(tooLong);
  assert.equal(sonicWavPCM(tooLong),null);
});

test('ASR-only HTTP route validates the session and audio, and returns only the transcript',async t=>{
  const app=express();app.use(express.json({limit:'3mb'}));let calls=0;
  app.post('/asr',sonicAsrRoute({
    session(req){if(req.headers['x-session-id']!=='valid')throw Error();return {id:'valid'};},
    async recognize(form,signal){
      calls++;assert.equal(form.get('language'),'ko');assert.equal(form.get('file').size,sample.length);
      assert.equal(signal.aborted,false);
      return {text:calls===1?'조수석 이십오 도로 맞춰줘.':'…',model:'whisper'};
    },
  }));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/asr`;
  const post=(body,id='valid')=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':id},body:JSON.stringify(body)});
  const audio=sample.toString('base64');
  assert.equal((await post({audio,language:'ko'},'invalid')).status,400);
  assert.equal((await post({audio:'not a wav',language:'ko'})).status,400);
  assert.equal((await post({audio,language:'ja'})).status,400);
  const silence=Buffer.from(sample);silence.fill(0,silence.length-sonicWavPCM(sample).length);
  assert.equal((await post({audio:silence.toString('base64'),language:'ko'})).status,422);
  assert.equal(calls,0);
  const response=await post({audio,language:'ko'});
  const result=await response.json();
  assert.equal(response.status,200);assert.equal(result.text,'조수석 25 도로 맞춰줘.');
  assert.equal(result.rawText,'조수석 이십오 도로 맞춰줘.');assert.equal(result.model,'whisper');
  assert.ok(result.asrMs>=0);assert.deepEqual(Object.keys(result).sort(),['asrMs','model','rawText','text']);
  assert.equal((await post({audio,language:'ko'})).status,422);
});
