import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {initialState,executePlan,localizeVehicleText} from '../vehicle.mjs';
import {responseLanguage,replyLanguageInstruction,speechOptions} from '../response-language.mjs';

test('English receipts preserve compound actions, destination names and undo semantics',()=>{
 const original=initialState();
 const plan={intent:'control',actions:[{type:'temperature',zone:'passenger',value:25},{type:'defrost',value:true},{type:'navigate',value:'서울역'}],reply:''};
 const english=executePlan(original,null,plan,'en');
 assert.deepEqual(english.state,executePlan(original,null,plan).state);
 assert.deepEqual(english.results,['Set the passenger temperature to 25 degrees Celsius.','Turned on the windshield defroster.','Set the simulated destination to 서울역.']);
 assert.equal(executePlan(english.state,english.previous,{actions:[{type:'undo'}]},'en').reply,'Restored the previous vehicle settings.');
 assert.equal(executePlan(original,null,{actions:[{type:'undo'}]},'en').reply,'There is no vehicle command to undo.');
 assert.equal(localizeVehicleText('설정을 적용하지 않았어요. 값은 16~30여야 합니다.','en'),'No settings were changed. Please choose a value between 16 and 30.');
 assert.throws(()=>executePlan(original,null,{actions:[{type:'temperature',zone:'both',value:40}]},'en'));
 assert.deepEqual(original,initialState());
});
test('voice language contract preserves Korean game defaults and selects English Joanna',()=>{
 assert.equal(responseLanguage('fr'),'ko');
 assert.deepEqual(speechOptions('en'),{voiceId:'Joanna',engine:'neural',languageCode:'en-US'});
 assert.deepEqual(speechOptions(),{voiceId:'Seoyeon',engine:'neural',languageCode:'ko-KR'});
 assert.equal(speechOptions('ko',{voiceId:'Hyunduk',engine:'generative'}).voiceId,'Hyunduk');
 assert.match(replyLanguageInstruction('en'),/English/);
});
test('HTTP turns switch reply language within the same session and pass English to ASR and utility tools',async t=>{
 const requests=[];
 const worker=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  res.setHeader('Content-Type','application/json');requests.push({url:req.url,body});
  if(req.url==='/plan')return res.end(JSON.stringify({text:JSON.stringify({intent:'control',actions:[{type:'temperature',zone:'passenger',value:25}],reply:''}),elapsedMs:1}));
  if(req.url==='/asr')return res.end(JSON.stringify({text:'Set the passenger temperature to 25 degrees',model:'mock-whisper',elapsedMs:1}));
  res.end('{"ready":true}');
 });
 worker.listen(0,'127.0.0.1');await once(worker,'listening');t.after(()=>{worker.closeAllConnections();worker.close();});
 const url='http://127.0.0.1:'+worker.address().port;
 const child=spawn('node',['server.mjs'],{env:{...process.env,PORT:'18792',CORE_URL:url,CORE_URLS:url,WHISPER_URL:url,WHISPER_URLS:url},stdio:['ignore','pipe','pipe']});t.after(()=>child.kill());
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Server timeout')),5000).unref())]);
 const base='http://localhost:18792/api/';
 const s=await(await fetch(base+'session',{method:'POST'})).json();
 async function turn(payload){const r=await fetch(base+'turn',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':s.id},body:JSON.stringify({plannerId:'qwen35-4b',speak:false,...payload})});const body=await r.text();assert.doesNotMatch(body,/event: error/);return body.split('\n\n').filter(x=>x.startsWith('event: reply')).map(x=>JSON.parse(x.split('data: ')[1]))[0];}
 const english=await turn({responseLanguage:'en',asrId:'nemotron',audio:Buffer.from('test').toString('base64')});assert.match(english.reply,/passenger temperature/);
 assert.match(requests.find(r=>r.url==='/asr').body,/name="language"\r\n\r\nen/);
 const prompt=JSON.parse(requests.find(r=>r.url==='/plan').body).messages[0].content;assert.match(prompt,/Response language: English/);assert.doesNotMatch(prompt,/Korean reply/);
 const timer=await turn({responseLanguage:'en',text:'Set a timer for 2 minutes'});assert.match(timer.reply,/Timer set for 120 seconds/);
 const korean=await turn({responseLanguage:'ko',text:'조수석 25도로'});assert.match(korean.reply,/조수석 온도를 25도로/);assert.equal(korean.state.temperature.passenger,25);assert.equal(korean.state.revision,2);
});

test('switching the UI reconnects an existing Sonic session without resetting cabin or conversation',async()=>{
 const vm=await import('node:vm'),{readFileSync}=await import('node:fs');
 const listeners=new Map(),elements=new Map();
 const document={documentElement:{lang:'ko'},addEventListener:(name,fn)=>listeners.set(name,fn),querySelectorAll:()=>[],getElementById(id){
  if(!elements.has(id))elements.set(id,{value:'ko',addEventListener(){},querySelector(selector){return document.getElementById(id+selector);}});return elements.get(id);
 }};
 const context=vm.createContext({document,window:{},fetch:async()=>({json:async()=>({})}),performance:{now:()=>0}});
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.runInContext(source.slice(0,source.indexOf("window.addEventListener('beforeunload'")),context);
 vm.runInContext("sessionId='existing';engine='sonic';cabinState={temperature:{driver:24,passenger:26}};let closes=0,toggles=0;sonicVoice={close(){closes++}};micEnabled=true;toggleMic=async()=>{micEnabled=!micEnabled;toggles++};checkHealth=async()=>{ready=true};",context);
 document.documentElement.lang='en';listeners.get('vehicle-ui-language')();await vm.runInContext('languageSwitch',context);
 assert.equal(elements.get('sonic-language').value,'en');assert.equal(elements.get('audio-language').value,'en');assert.equal(elements.get('minicpm-language').value,'en');
 assert.equal(vm.runInContext('closes',context),1);assert.equal(vm.runInContext('toggles',context),2);assert.equal(vm.runInContext('micEnabled',context),true);assert.equal(vm.runInContext('cabinState.temperature.passenger',context),26);
 document.documentElement.lang='ko';listeners.get('vehicle-ui-language')();await vm.runInContext('languageSwitch',context);assert.equal(elements.get('sonic-language').value,'ko');
});
