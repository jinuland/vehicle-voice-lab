// Same synthetic audio, same Sonic model and tools, two input paths.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {PollyClient,SynthesizeSpeechCommand} from '@aws-sdk/client-polly';
import WebSocket from 'ws';
import {awsCredentials} from '../aws-auth.mjs';
import {sonicWavPCM} from '../sonic-asr.mjs';
import {cases as vehicleCases} from './vehicle-benchmark-cases.mjs';

const base=process.env.TEST_BASE;
if(!base)throw Error('Set TEST_BASE to the Sonic demo origin.');
const defaultCases=[
  {id:'passenger',text:'조수석 온도를 25도로 맞춰 주세요.',audio:'public/sample-command.wav',matches:s=>s.temperature.passenger===25},
  {id:'defrost',text:'앞유리 김서림 제거 켜고 바람은 삼 단으로 해 줘.',matches:s=>s.defrost&&s.fan===3},
  {id:'compound',text:'운전석은 이십오 도, 조수석은 이십칠 도로 해 줘. 에어컨은 끄고, 앞유리 김서림 제거는 켜 줘.',matches:s=>s.temperature.driver===25&&s.temperature.passenger===27&&!s.ac&&s.defrost},
  {id:'destination',text:'목적지는 광명역으로 설정해 줘.',matches:s=>s.navigation.destination==='광명역'},
  {id:'timer',text:'타이머를 오 초로 설정해 줘.',matches:(_s,tools)=>tools.some(t=>t.operation==='timer'&&t.ok&&t.effect?.timers?.length&&/5초 타이머/.test(t.reply||''))},
];
const regressionChecks={
  'seat-2':s=>s.seatHeat===2,
  'seat-off':(_s,tools)=>tools.some(t=>t.ok&&t.actions?.some(a=>a.type==='seatHeat'&&a.value===0)),
  'volume-20':s=>s.media.volume===20,
  status:(s,_tools,reply)=>s.revision===0&&/(?:22|이십이|스물두|스물 두)\s*도/.test(reply),
  'out-of-range':(s,_tools,reply)=>s.revision===0&&/(?:범위|불가|없|사이|까지)/.test(reply),
};
const regression=process.env.TEST_SUITE==='regression';
const cases=(regression?Object.entries(regressionChecks).map(([id,matches])=>{
  const c=vehicleCases.find(item=>item.id===id);
  return {id,text:c.text,matches};
}):defaultCases).filter(c=>!process.env.TEST_CASE||c.id===process.env.TEST_CASE);
const polly=new PollyClient({region:'ap-northeast-2',...awsCredentials});
function wav(pcm){
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
async function fixture(c){
  if(c.audio)return readFile(c.audio);
  const r=await polly.send(new SynthesizeSpeechCommand({Text:c.text,VoiceId:'Seoyeon',Engine:'neural',LanguageCode:'ko-KR',OutputFormat:'pcm',SampleRate:'16000'}));
  return wav(Buffer.from(await r.AudioStream.transformToByteArray()));
}
async function run(c,audio,mode){
  const session=await(await fetch(base+'/api/session',{method:'POST'})).json();
  const headers={'X-Session-Id':session.id,'Content-Type':'application/json'};
  const pcm=sonicWavPCM(audio);
  const row={id:c.id,reference:c.text,mode,seconds:pcm.length/32000,transcript:'',tools:[],reply:'',audioBytes:0};
  const socketUrl=new URL('/api/sonic',base);socketUrl.protocol=socketUrl.protocol==='https:'?'wss:':'ws:';
  socketUrl.searchParams.set('session',session.id);socketUrl.searchParams.set('language','ko');
  const ws=new WebSocket(socketUrl,{origin:new URL(base).origin});let live=true,t0,firstAudio,interval;
  await new Promise(resolve=>{
    const finish=()=>{if(!live)return;live=false;clearInterval(interval);clearTimeout(timeout);ws.close();resolve();};
    const timeout=setTimeout(()=>{row.error='45 s timeout';finish();},45000);
    ws.on('error',e=>{row.error=e.message;finish();});ws.on('close',()=>{if(live){row.error='Connection closed';finish();}});
    ws.on('message',async raw=>{
      try{
        const {event,data}=JSON.parse(raw);
        if(event==='ready'){
          if(mode==='whisper'){
            t0=performance.now();
            interval=setInterval(()=>{if(live)ws.send(Buffer.alloc(3200));},100);
            const r=await fetch(base+'/api/sonic-asr',{method:'POST',headers,body:JSON.stringify({audio:audio.toString('base64'),language:'ko'}),signal:AbortSignal.timeout(10000)});
            const d=await r.json();
            if(!r.ok)throw Error(`ASR ${r.status}: ${d.code}`);
            row.transcript=d.rawText;row.asrServerMs=d.asrMs;row.asrRoundTripMs=Math.round(performance.now()-t0);
            if(live)ws.send(JSON.stringify({type:'text',text:d.text}));
          }else{
            ws.send(JSON.stringify({type:'mode',mode:'file'}));
            for(let i=0;i<pcm.length&&live;i+=3200){
              const chunk=pcm.subarray(i,i+3200);ws.send(chunk);await sleep(chunk.length/32);
            }
            t0=performance.now();
            interval=setInterval(()=>{if(live)ws.send(Buffer.alloc(3200));},100);
          }
        }
        if(event==='tool')row.tools.push(data);
        if(event==='text'&&data.role==='USER'&&mode==='native')row.transcript+=data.text;
        if(event==='text'&&data.role==='ASSISTANT')row.reply+=data.text;
        if(event==='audio'){firstAudio??=performance.now();row.audioBytes+=Buffer.from(data.audio,'base64').length;}
        if(event==='error'){row.error=data.error;finish();}
        if(event==='done'&&t0)finish();
      }catch(error){row.error=error.message;finish();}
    });
  });
  row.firstAudioMs=t0&&firstAudio?Math.round(firstAudio-t0):null;
  row.sonicAfterAsrMs=mode==='whisper'&&row.firstAudioMs!=null?row.firstAudioMs-row.asrRoundTripMs:null;
  const snapshot=await(await fetch(base+'/api/export',{headers})).json();
  row.pass=!row.error&&row.audioBytes>0&&c.matches(snapshot.state,row.tools,row.reply);
  return row;
}
const rows=[];
for(const c of cases){
  const audio=await fixture(c);
  for(const row of await Promise.all(['native','whisper'].map(mode=>run(c,audio,mode)))){
    rows.push(row);
    const {tools,reply,audioBytes,...brief}=row;console.log(JSON.stringify(brief));
  }
}
polly.destroy();
await mkdir('output',{recursive:true});
await writeFile(`output/sonic-asr-ab${regression?'-regression':''}.json`,JSON.stringify({at:new Date().toISOString(),base,synthetic:true,rows},null,2));
if(rows.some(row=>row.mode==='whisper'&&!row.pass))process.exitCode=1;
