import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceOutput} from '../voice-output.mjs';
test('Polly voice preview uses the existing synthesis provider and never pretends cloning exists',async()=>{
 const calls=[];const voice=createVoiceOutput({synthesize:async(...args)=>{calls.push(args);return {bytes:Buffer.from('wav'),elapsedMs:10}}});
 const r=await voice.render({text:' 안녕하세요 ',language:'ko'});
 assert.equal(r.provider,'polly');assert.equal(r.bytes.toString(),'wav');assert.equal(calls[0][0],'안녕하세요');assert.deepEqual(calls[0][3],{language:'ko',engine:'neural'});
 await assert.rejects(voice.render({text:'안녕하세요',mode:'clone'}),{code:'CLONE_NOT_AVAILABLE'});
 await assert.rejects(voice.render({text:''}),/characters/);
});
