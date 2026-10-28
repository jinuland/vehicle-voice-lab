import test from'node:test';import assert from'node:assert/strict';import vm from'node:vm';import{readFileSync}from'node:fs';
import{initialState,parsePlan,executePlan,MAX_VEHICLE_ACTIONS}from'../vehicle.mjs';
import{SonicSession}from'../sonic.mjs';import{appendSonicToolTrace,guardSonicRadio}from'../sonic-tool-trace.mjs';
import{followConversation,transcriptMessages}from'../public/conversation-history.js';

test('seven cabin actions commit together; an invalid last action still prevents partial updates',()=>{
 const actions=[{type:'temperature',zone:'driver',value:25},{type:'temperature',zone:'passenger',value:27},{type:'ac',value:false},{type:'defrost',value:true},{type:'seatHeat',value:1},{type:'volume',value:20},{type:'navigate',value:'서울역'}];
 const current=initialState(),plan=parsePlan(JSON.stringify({intent:'control',actions,reply:''}));const r=executePlan(current,null,plan);assert.equal(r.results.length,7);assert.equal(r.state.temperature.passenger,27);assert.equal(r.state.navigation.destination,'서울역');
 assert.throws(()=>executePlan(current,null,{...plan,actions:[...actions,{type:'fan',value:20}]}));assert.deepEqual(current,initialState());
 assert.throws(()=>parsePlan(JSON.stringify({...plan,actions:Array(MAX_VEHICLE_ACTIONS+1).fill(actions[0])})));
});
test('failed native tool calls retain parameters and error stage in a session-private trace',async()=>{
 const record={};const s=new SonicSession({state:initialState(),emit:(event,data)=>{if(event==='tool')appendSonicToolTrace(record,data);},executeTool:()=>{throw Error('Invalid seat');}});
 await s.tool({toolUseId:'bad-seat',toolName:'vehicle_control',content:'{"actions":[{"type":"temperature","zone":"rear","value":25}]}'});
 await s.tool({toolUseId:'bad-json',toolName:'vehicle_control',content:'{"actions":['});
 assert.equal(record.toolTrace.length,2);assert.equal(record.toolTrace[0].arguments.actions[0].zone,'rear');assert.equal(record.toolTrace[0].errorStage,'tool-execution');assert.equal(record.toolTrace[1].errorStage,'tool-arguments');assert.equal(record.toolTrace[1].rawArguments,'{"actions":[');assert.equal(record.failedToolCalls,2);s.close();
});
test('a radio-only playback request cannot masquerade as simulated music',()=>{
 assert.throws(()=>guardSonicRadio('운전석 25도로 하고 라디오 틀어줘',[{type:'temperature',zone:'driver',value:25},{type:'media',value:'play'}]),/실제 라디오/);
 assert.doesNotThrow(()=>guardSonicRadio('라디오 끄고 음악 틀어줘',[{type:'media',value:'play'}]));
});
test('conversation keeps earlier messages and does not jump while reading history',()=>{
 const list={children:[],scrollTop:0,clientHeight:300,get scrollHeight(){return this.children.length*100;},append(el){el.isConnected=true;this.children.push(el);}};
 const document={addEventListener(){},getElementById:id=>id==='conversation'?list:null,createElement:()=>({append(){}}),createTextNode:text=>({text})};
 const context=vm.createContext({document,window:{},followConversation});const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');vm.runInContext(source.slice(0,source.indexOf('async function checkHealth')),context);
 for(let i=0;i<20;i++)vm.runInContext(`bubble('message ${i}','user')`,context);assert.equal(list.children.length,20);assert.equal(list.scrollTop,2000);
 list.scrollTop=100;vm.runInContext("conversationPinned=false;bubble('new reply','assistant')",context);assert.equal(list.children.length,21);assert.equal(list.scrollTop,100);
 const messages=transcriptMessages({turns:[{input:'earlier command',reply:'earlier answer'},{input:'<img src=x>',reply:''}]});assert.equal(messages.length,3);assert.equal(messages[2].text,'<img src=x>');
});

test('spaced Korean numbers in a long Sonic transcript must not create a false range rejection',async()=>{
 const{normalizeTranscript}=await import('../transcript.mjs');const{guardExplicitBounds}=await import('../plan-guards.mjs');
 const text='운전석 이십 오 도 조수석 이십 칠 도 에어컨은 꺼주고 김서림 제거 켜줘';
 const normalized=normalizeTranscript(text);assert.match(normalized,/운전석 25 도 조수석 27 도/);
 const p={intent:'control',actions:[{type:'temperature',zone:'driver',value:25},{type:'temperature',zone:'passenger',value:27}],reply:''};assert.equal(guardExplicitBounds(normalized,p).reason,null);
 assert.ok(guardExplicitBounds(normalizeTranscript('조수석 사십 오 도'),p).reason);
});

test('a misrecognized numeric prefix must not manufacture a 15-degree target from 니십오',async()=>{
 const{normalizeTranscript}=await import('../transcript.mjs');const{guardExplicitBounds}=await import('../plan-guards.mjs');
 const raw='먼저 운전석은니십오도 조수석은 이십칠도로 맞춰줘';
 const normalized=normalizeTranscript(raw);assert.doesNotMatch(normalized,/15/);assert.match(normalized,/27/);
 const p={intent:'control',actions:[{type:'temperature',zone:'driver',value:25},{type:'temperature',zone:'passenger',value:27}],reply:''};assert.equal(guardExplicitBounds(normalized,p).reason,null);
 assert.ok(guardExplicitBounds(normalizeTranscript('조수석사십오도'),p).reason);
});

test('JSON fragments in a spoken answer are blocked after tool execution without undoing the settings',async()=>{
 const events=[];let applied=false;
 const s=new SonicSession({state:initialState(),emit:(event,data)=>events.push({event,data}),executeTool:()=>{applied=true;return{ok:true,actions:[{type:'ac',value:false}]};}});
 await s.tool({toolName:'vehicle_control',toolUseId:'success',content:'{"actions":[{"type":"ac","value":false}]}'});
 await s.receive({contentStart:{contentId:'bad-speech',type:'TEXT',role:'ASSISTANT',additionalModelFields:'{"generationStage":"FINAL"}'}});
 await s.receive({textOutput:{contentId:'bad-speech',content:'" '}});
 await s.receive({textOutput:{contentId:'bad-speech',content:'"actions":}}]'}});
 assert.equal(applied,true);assert.equal(events.filter(e=>e.event==='text').length,0);assert.equal(events.at(-1).event,'error');assert.match(events.at(-1).data.error,/실제 적용 결과/);assert.equal(s.closed,true);
});
