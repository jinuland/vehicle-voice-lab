// Synthetic fixtures only; no microphone input or user conversations are recorded.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.TEST_BASE||'http://localhost:8787';
const session=await(await fetch(base+'/api/session',{method:'POST'})).json(),results=[];
async function turn(label,payload){
 const r=await fetch(base+'/api/turn',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':session.id},body:JSON.stringify({plannerId:'qwen35-4b',ttsProvider:'polly',...payload}),signal:AbortSignal.timeout(60000)});
 assert.equal(r.status,200);const events=(await r.text()).split('\n\n').filter(Boolean).map(block=>({event:block.split('\n')[0].slice(7),data:JSON.parse(block.split('\ndata: ')[1])}));
 const error=events.find(e=>e.event==='error');assert.equal(error,undefined,JSON.stringify(error));
 const reply=events.find(e=>e.event==='reply')?.data,done=events.find(e=>e.event==='done')?.data.metrics;
 assert.ok(reply&&done);if(payload.speak!==false)assert.ok(events.some(e=>e.event==='audio'));
 const row={label,reply:reply.reply,state:reply.state,language:done.responseLanguage,asr:done.asrModel,tts:done.ttsProvider,audio:events.some(e=>e.event==='audio')};results.push(row);console.log(JSON.stringify(row));return row;
}
try{
 assert.match((await turn('Korean baseline',{language:'ko',text:'조수석 온도를 25도로 맞춰줘',speak:false})).reply,/조수석/);
 const audio=(await readFile('public/sample-english.wav')).toString('base64');
 const spoken=await turn('English speech recognition, control and audio',{responseLanguage:'en',language:'en',audio});assert.equal(spoken.state.temperature.driver,24);assert.doesNotMatch(spoken.reply,/[가-힣]/);
 const q=await turn('English reply to Korean question after mixed-language history',{responseLanguage:'en',text:'지금 양쪽 온도는 몇 도야?',speak:false});assert.doesNotMatch(q.reply,/[가-힣]/);assert.equal(q.state.temperature.driver,24);assert.equal(q.state.temperature.passenger,25);
 assert.match((await turn('English utility',{responseLanguage:'en',text:'Set a timer for 2 minutes'})).reply,/Timer set for 120 seconds/);
 assert.match((await turn('Switch back to Korean, same vehicle',{responseLanguage:'ko',text:'지금 양쪽 온도는 몇 도야?'})).reply,/[가-힣]/);
}catch(error){console.error(error);process.exitCode=1;}
await mkdir('output',{recursive:true});await writeFile(`output/response-language-${new URL(base).hostname}.json`,JSON.stringify({at:new Date().toISOString(),base,syntheticInput:true,pass:!process.exitCode,results},null,2));
