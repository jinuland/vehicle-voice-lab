import test from 'node:test';import assert from 'node:assert/strict';
import {newGame,gameMessages} from '../game-engine.mjs';import {normalizeGameCall} from '../game-tools.mjs';
test('tool usage examples cannot masquerade as past conversation or completed world actions',()=>{
 const msgs=gameMessages(newGame(),'바나나를 전자레인지에 넣어');assert.deepEqual(msgs.map(m=>m.role),['system','user']);assert.match(msgs[0].content,/not past events/);assert.equal(msgs.at(-1).content,'바나나를 전자레인지에 넣어');
});
test('the character tool adapter never dispatches an unknown function or malformed call',()=>{
 assert.throws(()=>normalizeGameCall({reply:'',tool_calls:[{name:'vehicle_control',arguments:{actions:[]}}]}));assert.throws(()=>normalizeGameCall({reply:'',tool_calls:[{name:'character_control',arguments:{actions:'take'}}]}));assert.deepEqual(normalizeGameCall({reply:'치킨 먹고 싶어.',tool_calls:[]}).actions,[]);
});

// Structured text models and native Sonic speech must receive different output contracts.
test('Sonic receives plain speech instructions even when the character prompt is Korean',async()=>{
 const {resultMessages,gameDialogueFormatInstruction}=await import('../game-tools.mjs');
 const {sonicGameSystem}=await import('../game-sonic.mjs');
 const messages=resultMessages(newGame(),{text:'뭘 해볼까?',plan:{reply:''},results:[]});
 assert.ok(messages[0].content.includes(gameDialogueFormatInstruction));
 const system=sonicGameSystem(messages,true);
 assert.ok(!system.includes(gameDialogueFormatInstruction));assert.match(system,/ordinary Korean speech, no JSON/);
 assert.equal(messages.at(-1).role,'user');assert.ok(JSON.parse(messages.at(-1).content).toolResult);
});
