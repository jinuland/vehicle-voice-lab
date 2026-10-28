// Synthetic test requests only. Requires AWS_PROFILE only for optional Polly input.
import WebSocket from 'ws';import{writeFile,mkdir}from'node:fs/promises';
const base=process.env.TEST_BASE;if(!base)throw Error('Set TEST_BASE');
const audioInput=process.env.TEST_INPUT==='audio',selected=process.env.TEST_CASES?.split(',');
const cases=[['weather',process.env.TEST_WEATHER_QUERY||'수원 날씨 알려줘'],['radio','혹시 라디오 채널이 뭐가 있나요?'],['timer','오 초 타이머 맞춰줘'],['notes','메모해줘 주차 위치 지하 2층 B12'],['calculate','20 곱하기 350 계산해줘'],['holidays','다음 공휴일 언제야'],['exchange','100달러 원화로 환율 계산해줘'],['sun','강릉 일몰 알려줘'],['wiki','경복궁 설명해줘'],['route','서울시청에서 서울역까지 거리 알려줘'],['web','전기차 최근 뉴스 웹검색해줘']].filter(([id])=>!selected||selected.includes(id));
let polly,command;
if(audioInput){const sdk=await import('@aws-sdk/client-polly'),{awsCredentials}=await import('../aws-auth.mjs');polly=new sdk.PollyClient({region:'ap-northeast-2',...awsCredentials});command=sdk.SynthesizeSpeechCommand;}
async function probe([operation,text]){
 const session=await(await fetch(base+'/api/session',{method:'POST'})).json();let pcm;
 if(audioInput){const response=await polly.send(new command({Text:text,VoiceId:'Seoyeon',Engine:'neural',LanguageCode:'ko-KR',OutputFormat:'pcm',SampleRate:'16000'}));pcm=Buffer.from(await response.AudioStream.transformToByteArray());}
 const row={operation,text,input:audioInput?'synthetic-speech':'synthetic-text',tools:[],reply:'',captions:[],audioBytes:0};
 await new Promise(resolve=>{
  const start=performance.now();let interval,finished=false,position=0;
  const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/sonic?session='+session.id+'&language=ko',{origin:base});
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);clearInterval(interval);ws.close();row.totalMs=Math.round(performance.now()-start);resolve();};
  const timer=setTimeout(()=>{row.error='45 s timeout';finish();},45000);
  ws.on('error',error=>{row.error=error.message;finish();});
  ws.on('message',raw=>{const{event,data}=JSON.parse(raw);
   if(event==='ready'){
    ws.send(JSON.stringify(pcm?{type:'mode',mode:'file'}:{type:'text',text}));
    interval=setInterval(()=>{if(ws.readyState!==1)return;if(pcm&&position<pcm.length){ws.send(pcm.subarray(position,position+3200));position+=3200;}else ws.send(Buffer.alloc(3200));},100);
   }
   if(event==='tool')row.tools.push(data);
   if(event==='text'&&data.role==='ASSISTANT')row.reply+=data.text;
   if(event==='text'&&data.role==='USER')row.transcript=(row.transcript||'')+data.text;
   if(event==='caption')row.captions.push(data.text);
   if(event==='audio'){row.firstAudioMs??=Math.round(performance.now()-start);row.audioBytes+=Buffer.from(data.audio,'base64').length;}
   if(event==='error'){row.error=data.error;finish();}
   if(event==='done')finish();
  });
 });
 const tool=row.tools.find(x=>x.operation===operation&&x.ok);
 row.pass=!!(tool&&row.audioBytes&&!row.error&&!row.captions.some(t=>/assistant_tool\s*[{(:]|<\|/i.test(t)));
 if(operation==='weather')row.pass&&=tool?.position?.name?.includes(process.env.TEST_WEATHER_CITY||'수원')===true;
 if(operation==='radio')row.pass&&=tool?.effect===null&&tool?.items?.length===4;
 if(operation==='timer')row.pass&&=tool?.effect?.timers?.length>0;
 console.log(JSON.stringify({operation:row.operation,input:row.input,pass:row.pass,reply:row.reply,error:row.error,tools:row.tools.map(t=>({operation:t.operation,ok:t.ok,position:t.position,effect:t.effect,elapsedMs:t.elapsedMs}))}));return row;
}
const results=[];
// Two independent visitors at a time; this is a functional check, not a load benchmark.
for(let i=0;i<cases.length;i+=2)results.push(...await Promise.all(cases.slice(i,i+2).map(probe)));
await mkdir('output',{recursive:true});await writeFile(`output/sonic-tools-${audioInput?'audio':'text'}-audit.json`,JSON.stringify({at:new Date().toISOString(),base,synthetic:true,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
