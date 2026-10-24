import test from 'node:test';import assert from 'node:assert/strict';
import {newGame,gameMessages} from '../game-engine.mjs';import {normalizeGameCall} from '../game-tools.mjs';
test('tool usage examples cannot masquerade as past conversation or completed world actions',()=>{
 const msgs=gameMessages(newGame(),'바나나를 전자레인지에 넣어');assert.deepEqual(msgs.map(m=>m.role),['system','user']);assert.match(msgs[0].content,/not past events/);assert.equal(msgs.at(-1).content,'바나나를 전자레인지에 넣어');
});
test('the character tool adapter never dispatches an unknown function or malformed call',()=>{
 assert.throws(()=>normalizeGameCall({reply:'',tool_calls:[{name:'vehicle_control',arguments:{actions:[]}}]}));assert.throws(()=>normalizeGameCall({reply:'',tool_calls:[{name:'character_control',arguments:{actions:'take'}}]}));assert.deepEqual(normalizeGameCall({reply:'치킨 먹고 싶어.',tool_calls:[]}).actions,[]);
});
