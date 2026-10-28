import test from'node:test';import assert from'node:assert/strict';
import{inferAssistant,providerLookup,normalizeUtilityNumbers}from'../assistant-providers.mjs';
import{arithmetic,localUtility,executeAssistant}from'../assistant-service.mjs';
import{SonicSession}from'../sonic.mjs';import{initialState}from'../vehicle.mjs';
test('new information intents do not reroute ordinary vehicle controls',()=>{
 for(const request of ['운전석 온도를 24도로 맞춰줘','앞유리 김서림 제거 켜줘','음악 재생하고 음량은 20으로 해줘','서울역으로 길 안내해줘','방금 설정 되돌려줘'])assert.equal(inferAssistant(request),null,request);
 assert.equal(inferAssistant('재즈 라디오 틀어줘').operation,'radio');assert.equal(inferAssistant('서울시청에서 서울역까지 거리 알려줘').operation,'route');assert.equal(inferAssistant('100달러 원화로 계산해줘').operation,'exchange');
});
test('calculations cannot execute JavaScript and reject malformed or unbounded inputs',()=>{
 assert.equal(arithmetic('(20 + 5) * 350'),8750);assert.equal(arithmetic('100 / 4'),25);
 for(const x of ['process.exit()','1/0','2+','2(3)','9**3'])assert.throws(()=>arithmetic(x));
 assert.equal(localUtility({operation:'calculate',query:'충전비 20kWh, kWh당 350원 계산해줘'},{}).value,7000);
 assert.equal(localUtility({operation:'calculate',query:'여행경비 60000원 3명 나눠줘'},{}).value,20000);
 assert.equal(localUtility({operation:'calculate',query:'20 더하기 5 계산해줘'},{}).value,25);
});
test('notes are isolated per visitor and timer limits do not mutate vehicle state',()=>{
 const a={state:initialState()},b={state:initialState()};localUtility({operation:'notes',query:'메모: B12'},a);
 assert.equal(a.notes[0].text,'B12');assert.equal(localUtility({operation:'notes',query:'메모 읽어줘'},b).notes.length,0);
 const before=structuredClone(a.state);const timer=localUtility({operation:'timer',query:'10분 타이머'},a);assert.equal(timer.effect.timers.length,1);assert.deepEqual(a.state,before);
 assert.throws(()=>localUtility({operation:'timer',query:'100시간 타이머'},a));
 const english=localUtility({operation:'timer',query:'Set a timer for ten minutes.',language:'en'},{});assert.equal(Math.round((english.effect.timers[0].deadline-Date.now())/1000),600);
 assert.equal(normalizeUtilityNumbers('one hundred twenty five dollars'),'125 dollars');
});
test('unknown tools, invalid coordinates and canceled requests cannot perform external work',async()=>{
 await assert.rejects(providerLookup({operation:'shell',query:'anything'}));await assert.rejects(providerLookup({operation:'weather',query:'서울',latitude:100}));
 const controller=new AbortController(),session={};controller.abort();await assert.rejects(executeAssistant({operation:'notes',query:'메모: canceled'},session,{signal:controller.signal}));assert.equal(session.notes,undefined);
});
test('Sonic assistant tool uses its callback and cannot enter the vehicle executor',async()=>{
 let vehicle=0,assistant=0;const events=[];
 const s=new SonicSession({state:initialState(),emit:(event,data)=>events.push({event,data}),executeTool:()=>{vehicle++;},executeAssistantTool:async(args)=>{assistant++;assert.equal(args.language,'ko');return{ok:true,operation:'holidays',reply:'A holiday'};}});
 assert.equal(s.queue.values.filter(x=>JSON.parse(x.chunk.bytes).event.contentStart?.role==='SYSTEM').length,1,'Bedrock allows one SYSTEM content block');
 await s.tool({toolUseId:'lookup',toolName:'assistant_tool',content:'{"operation":"holidays","query":"다음 공휴일"}'});
 assert.equal(assistant,1);assert.equal(vehicle,0);assert.equal(events[0].data.toolName,'assistant_tool');s.close();
});

test('radio questions list all stations without starting playback; explicit play and stop retain effects',async()=>{
 for(const query of ['라디오 채널 뭐가 있어?','혹시 라디오 채널이 뭐가 있나요?','어떤 라디오 채널 들을 수 있어','What radio stations are available?']){
  const result=await providerLookup({operation:'radio',query,language:'ko'});assert.equal(result.effect,null,query);assert.equal(result.status,'listed');assert.equal(result.items.length,4);assert.match(result.reply,/Secret Agent/);
 }
 assert.equal((await providerLookup({operation:'radio',query:'재즈 라디오 틀어줘'})).effect.stationId,'secretagent');
 assert.equal((await providerLookup({operation:'radio',query:'라디오 꺼줘'})).effect.type,'radio-stop');
});
test('named Suwon weather outranks even an existing Seoul GPS coordinate',async()=>{
 const {coordinates,requestedLocation}=await import('../assistant-providers.mjs');
 for(const query of ['수원 날씨 알려줘','내일 수원 날씨','수원에는 비 와?','Weather in Suwon']){
  const p=await coordinates(query,{operation:'weather',language:'ko',latitude:37.5665,longitude:126.978});assert.equal(p.name,'수원');assert.equal(p.latitude,37.29111);
 }
 assert.equal(requestedLocation('오늘 날씨 어때?','weather'),'');
});

test('spoken Korean durations produce actual timer deadlines rather than clarification-only replies',()=>{
 for(const [query,seconds]of [['오 초 타이머',5],['십오 분 타이머',900],['한 시간 타이머',3600],['스물다섯 초 타이머',25],['삼십 초 타이머',30],['두 시간 타이머',7200]]){
  const start=Date.now(),result=localUtility({operation:'timer',query,language:'ko'},{});assert.equal(result.effect.type,'timers');assert.ok(Math.abs(result.effect.timers[0].deadline-start-seconds*1000)<100,query);
 }
});

test('an unresolvable named place never returns default Seoul weather',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const urls=[];
 globalThis.fetch=async url=>{urls.push(String(url));return new Response(JSON.stringify({results:[]}),{headers:{'Content-Type':'application/json'}});};
 const result=await providerLookup({operation:'weather',query:'없는도시테스트 날씨 알려줘',latitude:37.5665,longitude:126.978,language:'ko'});
 assert.equal(result.ok,false);assert.equal(result.needsLocation,true);assert.match(result.reply,/시·군 이름/);assert.equal(urls.length,1);assert.match(urls[0],/geocoding-api/);
});
