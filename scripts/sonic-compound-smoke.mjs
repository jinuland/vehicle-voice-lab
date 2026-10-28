// Synthetic compound requests only. Optional audio input uses Polly Seoyeon.
import WebSocket from 'ws';import{writeFile,mkdir}from'node:fs/promises';
const base=process.env.TEST_BASE;if(!base)throw Error('Set TEST_BASE');const audioInput=process.env.TEST_INPUT==='audio';
const cases=[
 {id:'six-controls-plus-radio',text:'조수석 온도를 27도로 운전석은 25도로 에어컨 꺼주고 김서림 제거는 켜주고 열선 1단 켜주고 라디오 틀어준 다음에 서울역으로 목적지 설정해줘',driver:25,passenger:27,seatHeat:1,destination:'서울역'},
 {id:'seven-controls-plus-radio',text:'차량 설정을 여러 가지 바꿀게. 먼저 운전석은 25도, 조수석은 27도로 맞춰줘. 그리고 에어컨은 꺼주고, 앞유리 김서림 제거는 켜줘. 시트 열선은 1단으로 하고 음량은 20으로 맞춰줘. 마지막으로 서울역을 목적지로 설정하고, 재즈 라디오도 틀어줘.',driver:25,passenger:27,seatHeat:1,destination:'서울역',volume:20},
 {id:'four-controls-plus-radio',text:'운전석 25도 조수석 30도 그리고 에어컨은 꺼주고 김서림 제거 켜줘 그리고 라디오 틀어줘',driver:25,passenger:30,seatHeat:0},
].filter(x=>!process.env.TEST_CASE||x.id===process.env.TEST_CASE);
let polly,Command;if(audioInput){const sdk=await import('@aws-sdk/client-polly'),{awsCredentials}=await import('../aws-auth.mjs');polly=new sdk.PollyClient({region:'ap-northeast-2',...awsCredentials});Command=sdk.SynthesizeSpeechCommand;}
const results=[];
for(const c of cases){
 const s=await(await fetch(base+'/api/session',{method:'POST'})).json();let pcm;
 if(audioInput){const r=await polly.send(new Command({Text:c.text,VoiceId:'Seoyeon',Engine:'neural',LanguageCode:'ko-KR',OutputFormat:'pcm',SampleRate:'16000'}));pcm=Buffer.from(await r.AudioStream.transformToByteArray());}
 const row={id:c.id,text:c.text,input:audioInput?'synthetic-speech':'synthetic-text',inputSeconds:pcm?pcm.length/32000:null,tools:[],reply:'',audioBytes:0};
 await new Promise(resolve=>{
  let interval,position=0,finished=false;const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/sonic?session='+s.id+'&language=ko',{origin:base});
  const finish=()=>{if(finished)return;finished=true;clearInterval(interval);clearTimeout(timeout);ws.close();resolve();};const timeout=setTimeout(()=>{row.error='75 s timeout';finish();},75000);
  ws.on('error',e=>{row.error=e.message;finish();});ws.on('message',raw=>{const{event,data}=JSON.parse(raw);if(event==='ready'){
   ws.send(JSON.stringify(pcm?{type:'mode',mode:'file'}:{type:'text',text:c.text}));
   interval=setInterval(()=>{if(ws.readyState!==1)return;if(pcm&&position<pcm.length){ws.send(pcm.subarray(position,position+3200));position+=3200;}else ws.send(Buffer.alloc(3200));},100);
  }if(event==='tool')row.tools.push(data);if(event==='text'&&data.role==='ASSISTANT')row.reply+=data.text;if(event==='audio')row.audioBytes+=Buffer.from(data.audio,'base64').length;if(event==='error'){row.error=data.error;finish();}if(event==='done'&&(!pcm||position>=pcm.length))finish();});
 });
 const exported=await(await fetch(base+'/api/export',{headers:{'X-Session-Id':s.id}})).json(),state=exported.state;row.state=state;row.transcripts=exported.turns.map(t=>({input:t.input,validationError:t.validationError,toolTrace:t.toolTrace}));row.traceCount=exported.turns.flatMap(t=>t.toolTrace||[]).length;
 row.pass=!row.error&&!/["'](?:actions|type|zone|value|intent|operation)["']\s*:|assistant_tool\s*\{|<\|/i.test(row.reply)&&row.audioBytes>0&&state.temperature.driver===c.driver&&state.temperature.passenger===c.passenger&&state.ac===false&&state.defrost===true&&state.seatHeat===c.seatHeat&&(!c.destination||state.navigation.destination===c.destination)&&(c.volume===undefined||state.media.volume===c.volume)&&state.media.playing===false&&row.tools.some(t=>t.operation==='radio'&&t.ok&&t.effect?.type==='radio')&&row.traceCount>=2;
 row.recoveredFailures=row.tools.filter(t=>t.ok===false).map(t=>({error:t.error,errorStage:t.errorStage}));results.push(row);console.log(JSON.stringify({id:row.id,input:row.input,inputSeconds:row.inputSeconds,pass:row.pass,traceCount:row.traceCount,state,reply:row.reply,errors:row.recoveredFailures,error:row.error}));
}
await mkdir('output',{recursive:true});await writeFile(`output/sonic-compound-${audioInput?'audio':'text'}-smoke.json`,JSON.stringify({at:new Date().toISOString(),base,synthetic:true,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
