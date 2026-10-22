import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('planner pool distributes parallel sessions, releases failed requests and checks every replica',async t=>{
 const hits=[0,0],ready=[true,true];let fail=false;
 const worker=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const index=req.url.startsWith('/b/')?1:0;
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/health'))return res.end(JSON.stringify({ready:ready[index]}));
  if(req.url.endsWith('/plan')){
   hits[index]++;await new Promise(resolve=>setTimeout(resolve,40));
   if(fail){res.statusCode=502;return res.end('{"error":"test failure"}');}
   const body=JSON.parse(Buffer.concat(chunks));const value=body.messages.at(-1).content.includes('25')?25:24;
   return res.end(JSON.stringify({text:JSON.stringify({intent:'control',actions:[{type:'temperature',zone:'passenger',value}],reply:''}),elapsedMs:40}));
  }
  res.end('{}');
 });
 worker.listen(0,'127.0.0.1');await once(worker,'listening');t.after(()=>{worker.closeAllConnections();worker.close();});
 const url='http://127.0.0.1:'+worker.address().port;
 const child=spawn('node',['server.mjs'],{env:{...process.env,PORT:'18788',COMPACT_SERVING:'1',CORE_URL:url+'/a',CORE_URLS:url+'/a,'+url+'/b',WHISPER_URL:url+'/a',TTS_URL:url+'/a',MINICPM_URL:url+'/a',SPEECH_URL:url+'/a'},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('Server exited '+code)));setTimeout(()=>reject(Error('Server start timeout')),5000).unref();});
 const base='http://localhost:18788/api/';
 async function health(){return(await fetch(base+'health')).json();}
 async function turn(value){const s=await(await fetch(base+'session',{method:'POST'})).json();const r=await fetch(base+'turn',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':s.id},body:JSON.stringify({text:`조수석 ${value}도`,plannerId:'phi4-mini',speak:false})});return{body:await r.text(),state:(await(await fetch(base+'export',{headers:{'X-Session-Id':s.id}})).json()).state};}
 assert.equal((await health()).ready,true);
 const results=await Promise.all([24,25,24,25,24,25].map(turn));
 assert.deepEqual(hits,[3,3]);results.forEach((r,i)=>assert.equal(r.state.temperature.passenger,i%2?25:24));
 fail=true;assert.match((await turn(25)).body,/event: error/);assert.deepEqual((await health()).workers[0].replicas.map(r=>r.active),[0,0]);
 ready[1]=false;assert.equal((await health()).ready,false);
});
