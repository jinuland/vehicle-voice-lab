import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('Whisper replicas preserve vehicle actions, release failures and report unhealthy replicas',async t=>{
 const hits=[0,0],ready=[true,true];let fail=false;
 const worker=http.createServer(async(req,res)=>{
  for await(const chunk of req){};
  const index=req.url.startsWith('/b/')?1:0;res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/health'))return res.end(JSON.stringify({ready:ready[index]}));
  if(req.url.endsWith('/asr')){
   hits[index]++;await new Promise(resolve=>setTimeout(resolve,50));
   if(fail){res.statusCode=502;return res.end('{"error":"recognition failed"}');}
   return res.end(JSON.stringify({text:'조수석 온도 25도로',elapsedMs:50,model:'test-whisper'}));
  }
  if(req.url.endsWith('/plan'))return res.end(JSON.stringify({text:JSON.stringify({intent:'control',actions:[{type:'temperature',zone:'passenger',value:25}],reply:''}),elapsedMs:1}));
  res.end('{}');
 });
 worker.listen(0,'127.0.0.1');await once(worker,'listening');t.after(()=>{worker.closeAllConnections();worker.close();});
 const url='http://127.0.0.1:'+worker.address().port;
 const child=spawn('node',['server.mjs'],{env:{...process.env,PORT:'18789',COMPACT_SERVING:'1',CORE_URL:url+'/a',CORE_URLS:url+'/a',WHISPER_URL:url+'/a',WHISPER_URLS:url+'/a,'+url+'/b',TTS_URL:url+'/a',MINICPM_URL:url+'/a',SPEECH_URL:url+'/a'},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('Server exited '+code)));setTimeout(()=>reject(Error('Server start timeout')),5000).unref();});
 const base='http://localhost:18789/api/';
 const health=async()=>await(await fetch(base+'health')).json();
 async function turn(){const s=await(await fetch(base+'session',{method:'POST'})).json();const r=await fetch(base+'turn',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':s.id},body:JSON.stringify({audio:Buffer.from('test audio').toString('base64'),asrId:'whisper',plannerId:'phi4-mini',speak:false})});return{body:await r.text(),state:(await(await fetch(base+'export',{headers:{'X-Session-Id':s.id}})).json()).state};}
 const results=await Promise.all(Array.from({length:6},turn));assert.deepEqual(hits,[3,3]);results.forEach(r=>assert.equal(r.state.temperature.passenger,25));
 fail=true;assert.match((await turn()).body,/event: error/);assert.deepEqual((await health()).asrWorkers.whisper.replicas.map(r=>r.active),[0,0]);
 ready[1]=false;assert.equal((await health()).ready,false);
});
