import test from 'node:test';
import assert from 'node:assert/strict';
import {correctionError,createNativeWriteGate} from '../sonic-number-guard.mjs';

const temp=(value,zone='passenger')=>({type:'temperature',zone,value});
test('temperature corrections reject stale, out-of-range and mis-scoped proposals',()=>{
  const correction='조수석을 29도로 해 줘. 아니 잠깐, 스물넷 도로 바꿔 줘.';
  assert.equal(correctionError(correction,[temp(24)]),null);
  assert.deepEqual(correctionError(correction,[temp(29)]),{code:'temperature-correction',value:24});
  assert.deepEqual(correctionError(correction,[temp(24,'both')]),{code:'temperature-correction',value:24});
  assert.deepEqual(correctionError('조수석 29°로. 아니 잠깐 이 도로 바꿔 줘',[temp(29)]),{code:'temperature-correction',value:null});
  assert.deepEqual(correctionError('조수석 29도 말고 24도',[temp(29)]),{code:'temperature-correction',value:24});
  assert.equal(correctionError('아니, 2도만 더 올려 줘',[temp(24)]),null);
  assert.equal(correctionError('조수석은 29도, 에어컨은 끄지 말고 유지해',[temp(29)]),null);
});

test('native numeric write is canceled when the user resumes, and the next transcript can commit',async()=>{
  let now=0;
  const voiced=Buffer.alloc(3200);for(let i=0;i<voiced.length;i+=2)voiced.writeInt16LE(2000,i);
  const gate=createNativeWriteGate({now:()=>now});
  gate.mode('file');gate.transcript('first');gate.observe(voiced);
  now=1100;
  const stale=gate.wait([temp(29)]);now=1250;gate.observe(voiced);
  assert.equal(await stale,false);assert.equal(await gate.wait([temp(29)]),false);
  gate.transcript('second');const corrected=gate.wait([temp(24)]);gate.audioEnd();
  assert.equal(await corrected,true);
  gate.close();
});

test('quiet already elapsed, nonnumeric writes, and cancellation do not impose an extra wait',async()=>{
  let now=0;const voiced=Buffer.alloc(3200,20),gate=createNativeWriteGate({now:()=>now});
  gate.transcript('first');gate.observe(voiced);
  assert.equal(await gate.wait([{type:'defrost',value:true}]),true);
  now=1500;assert.equal(await gate.wait([temp(24)]),true);
  gate.observe(voiced);const pending=gate.wait([temp(24)]);gate.close();assert.equal(await pending,false);
});
