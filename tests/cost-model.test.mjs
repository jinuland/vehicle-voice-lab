import test from 'node:test';import assert from 'node:assert/strict';import {compareCosts} from '../public/cost-model.js';
test('break-even includes idle GPU hours, extra replica hours and Polly variable charges',()=>{
 const args={requests:100000,replicaHours:730,hourlyUSD:.9896,ttsCharacters:20,sonicUSDPerRequest:.0027131898};
 const a=compareCosts(args);assert.ok(Math.abs(a.openUSD-754.408)<.000001);assert.ok(Math.abs(a.breakEvenRequests-301859.644)<1);
 const b=compareCosts({...args,replicaHours:1460});assert.equal(b.breakEvenRequests,2*a.breakEvenRequests);
 const atBreakEven=compareCosts({...args,requests:a.breakEvenRequests});assert.ok(Math.abs(atBreakEven.openUSD-atBreakEven.sonicUSD)<1e-8);
});
test('there is no positive break-even if external voice cost already exceeds Sonic',()=>{
 assert.equal(compareCosts({requests:100,replicaHours:730,hourlyUSD:1,ttsCharacters:300,sonicUSDPerRequest:.002}).breakEvenRequests,null);
 assert.throws(()=>compareCosts({requests:-1,replicaHours:0,hourlyUSD:1,ttsCharacters:20,sonicUSDPerRequest:.002}));
});
