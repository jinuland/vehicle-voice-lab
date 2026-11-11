// Replays identical, synthetic Korean clips through all three deployed input modes.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {PollyClient,SynthesizeSpeechCommand} from '@aws-sdk/client-polly';
import WebSocket from 'ws';
import {awsCredentials} from '../aws-auth.mjs';
import {sonicWavPCM} from '../sonic-asr.mjs';

const base=new URL(process.env.TEST_BASE||'http://localhost:8787').origin;
const originHeaders=process.env.TEST_ORIGIN_KEY?{'X-Vehicle-Origin-Key':process.env.TEST_ORIGIN_KEY}:{};
const syntheticCases=[
  {id:'compound-seven',voice:'Seoyeon',text:'운전석은 이십오 도, 조수석은 이십칠 도로 맞추고, 에어컨은 끄고, 앞유리 김서림 제거는 켜 줘. 시트 열선은 이 단, 바람은 삼 단, 음량은 이십으로 맞춰 줘.',check:s=>s.temperature.driver===25&&s.temperature.passenger===27&&!s.ac&&s.defrost&&s.seatHeat===2&&s.fan===3&&s.media.volume===20},
  {id:'correction-pause',voice:'Jihye',parts:['조수석을 이십구 도로 해 줘.','아니 잠깐, 이십사 도로 바꿔 줘. 운전석 온도는 그대로 둬.'],pauseMs:1250,check:s=>s.temperature.passenger===24&&s.temperature.driver===22},
  {id:'negative',voice:'Hyunduk',text:'에어컨은 끄지 말고 앞유리 김서림 제거만 켜 줘. 풍량은 그대로 두고.',check:s=>s.ac&&s.defrost&&s.fan===2},
  {id:'proper-noun',voice:'Seoyeon',text:'목적지는 수원 컨벤션센터 말고 광교중앙역으로 설정해 줘.',check:s=>compact(s.navigation.destination)==='광교중앙역'},
  {id:'mixed-language',voice:'Jihye',text:'KTX 광명역으로 안내해 줘. 그리고 에어컨은 꺼 줘.',check:s=>compact(s.navigation.destination).includes('광명역')&&!s.ac},
  {id:'noise-seat-temp',voice:'Hyunduk',snr:7,text:'운전석 온도는 십구 도로, 조수석은 스물여섯 도로 설정해 줘. 열선은 일 단만 켜 줘.',check:s=>s.temperature.driver===19&&s.temperature.passenger===26&&s.seatHeat===1},
  {id:'noise-volume-fan',voice:'Seoyeon',snr:3,text:'음량을 사십오로 올리고 바람 세기는 육 단으로 바꿔 줘.',check:s=>s.media.volume===45&&s.fan===6},
  {id:'quiet-command',voice:'Jihye',gain:0.14,text:'조수석 온도만 이십팔 도로 높이고, 시트 열선은 삼 단으로 올려 줘.',check:s=>s.temperature.passenger===28&&s.temperature.driver===22&&s.seatHeat===3},
  {id:'timer-unit',voice:'Hyunduk',text:'구십 초 뒤에 알려 줘. 휴식 타이머로 설정해 줘.',check:(_s,tools)=>tools.some(t=>t.ok&&t.operation==='timer'&&t.effect?.timers?.length&&/90초/.test(t.reply||''))},
  {id:'out-of-range',voice:'Seoyeon',text:'조수석 온도를 사십 도로 올려 줘. 운전석은 건드리지 마.',check:(s,_tools,reply)=>s.revision===0&&/(범위|불가|없|사이|까지|초과)/.test(reply)},
  {id:'natural-numbers',voice:'Jihye',text:'두 자리 다 스물세 도로 맞추고, 시트 열선은 한 단만 켜 줘.',check:s=>s.temperature.driver===23&&s.temperature.passenger===23&&s.seatHeat===1},
  {id:'abbreviated-noise',voice:'Hyunduk',snr:5,text:'조수석 스물다섯 도, 앞유리 성에 제거 켜고, 볼륨은 삼십오 말고 이십으로.',check:s=>s.temperature.passenger===25&&s.defrost&&s.media.volume===20},
];
const compact=text=>(text||'').replace(/\s/g,'');
const manifest=process.env.TEST_MANIFEST?JSON.parse(await readFile(process.env.TEST_MANIFEST,'utf8')):null;
const cases=manifest?manifest.cases.map(c=>({...c,check:c.expected?state=>Object.entries(c.expected).every(([key,value])=>key.split('.').reduce((node,part)=>node?.[part],state)===value):null})):syntheticCases;
const polly=manifest?null:new PollyClient({region:'ap-northeast-2',...awsCredentials});
const out=process.env.TEST_OUT||'output/sonic-asr-challenge';
await mkdir(out,{recursive:true});
function wav(pcm){
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
function trim(pcm){
  let start=-1,end=0;
  for(let i=0;i+320<=pcm.length;i+=320){
    let sum=0;for(let p=i;p<i+320;p+=2)sum+=(pcm.readInt16LE(p)/32768)**2;
    if(sum/160>.006**2){if(start<0)start=i;end=i+320;}
  }
  return start<0?pcm:pcm.subarray(Math.max(0,start-1920),Math.min(pcm.length,end+1280));
}
async function fixture(c){
  if(c.file){
    const pcm=sonicWavPCM(await readFile(c.file));
    if(!pcm)throw Error(`Invalid 16 kHz PCM WAV: ${c.id}`);
    return pcm;
  }
  const path=`${out}/${c.id}.wav`;
  try{const cached=sonicWavPCM(await readFile(path));if(cached)return cached;}catch(error){if(error.code!=='ENOENT')throw error;}
  const parts=[];
  for(const text of c.parts||[c.text]){
    const response=await polly.send(new SynthesizeSpeechCommand({Text:text,VoiceId:c.voice,Engine:c.voice==='Hyunduk'?'generative':'neural',LanguageCode:'ko-KR',OutputFormat:'pcm',SampleRate:'16000'}));
    if(parts.length)parts.push(Buffer.alloc(c.pauseMs*32));
    parts.push(trim(Buffer.from(await response.AudioStream.transformToByteArray())));
  }
  const pcm=Buffer.concat(parts);let seed=42;
  const rnd=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32)*2-1;
  let sum=0,noiseSum=0,low=0;const noise=new Float64Array(pcm.length/2);
  for(let i=0;i<noise.length;i++){
    low=low*.96+rnd()*.04;
    noise[i]=low*2+Math.sin(2*Math.PI*93*i/16000)*.15+rnd()*.17;
    noiseSum+=noise[i]**2;sum+=pcm.readInt16LE(i*2)**2;
  }
  const scale=c.snr==null?0:Math.sqrt(sum/noiseSum)/10**(c.snr/20);
  for(let i=0;i<noise.length;i++)pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(pcm.readInt16LE(i*2)*(c.gain??1)+noise[i]*scale))),i*2);
  await writeFile(path,wav(pcm));return pcm;
}

// Preserve content words. Ignore whitespace, punctuation, case and equivalent numeral notation.
const numerals={스물다섯:25,스물여섯:26,스물세:23,스물셋:23,이십구:29,이십팔:28,이십칠:27,이십육:26,이십오:25,이십사:24,이십삼:23,이십이:22,이십:20,십구:19,사십오:45,사십:40,삼십오:35,구십:90,한:1,일:1,이:2,두:2,삼:3,육:6};
function chars(s){
  const number=new RegExp(`(^|[^가-힣])(${Object.keys(numerals).sort((a,b)=>b.length-a.length).join('|')})(?=\\s*(?:도|단|초|으로|로|\\s|[.,!?]|$))`,'g');
  return [...s.normalize('NFKC').toLowerCase().replaceAll('°','도').replace(number,(_m,prefix,n)=>prefix+numerals[n]).replace(/[^\p{L}\p{N}]/gu,'')];
}
function edits(a,b){
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(const [i,x]of a.entries()){
    const next=[i+1];for(const [j,y]of b.entries())next.push(Math.min(prev[j+1]+1,next[j]+1,prev[j]+(x===y?0:1)));
    prev=next;
  }
  return prev[b.length];
}
async function run(c,pcm,mode){
  const sessionReply=await fetch(base+'/api/session',{method:'POST',headers:originHeaders});if(!sessionReply.ok)throw Error('Could not start demo session');
  const session=await sessionReply.json(),headers={...originHeaders,'X-Session-Id':session.id,'Content-Type':'application/json'};
  const row={id:c.id,mode,voice:c.voice,sourceId:c.sourceId,condition:c.condition,snr:c.snr??null,pauseMs:c.pauseMs??null,seconds:pcm.length/32000,reference:c.parts?.join(' ')||c.text,transcript:'',reply:'',tools:[],audioBytes:0};
  const socketUrl=new URL('/api/sonic',base);socketUrl.protocol=socketUrl.protocol==='https:'?'wss:':'ws:';
  socketUrl.searchParams.set('session',session.id);socketUrl.searchParams.set('language','ko');
  if(process.env.TEST_RUNTIME)socketUrl.searchParams.set('runtime',process.env.TEST_RUNTIME);
  if(mode==='transcribe')socketUrl.searchParams.set('input','transcribe');
  const ws=new WebSocket(socketUrl,{origin:process.env.TEST_WS_ORIGIN||base,headers:originHeaders});let live=true,endedAt,firstAudioAt,keepalive,settle,done=false;
  const t=()=>performance.now();
  await new Promise(resolve=>{
    const finish=()=>{if(!live)return;live=false;clearTimeout(limit);clearTimeout(settle);clearInterval(keepalive);ws.close();resolve();};
    const limit=setTimeout(()=>{row.error='Timeout';finish();},pcm.length/32+27000);
    ws.on('error',error=>{row.error=error.message;finish();});
    ws.on('close',()=>{if(live){row.error='Connection closed';finish();}});
    ws.on('message',async raw=>{
      try{
        const {event,data}=JSON.parse(raw),now=t();
        if(event==='ready'){
          if(mode==='whisper'){
            keepalive=setInterval(()=>{if(live)ws.send(Buffer.alloc(3200));},100);
            endedAt=t();
            const r=await fetch(base+'/api/sonic-asr',{method:'POST',headers,body:JSON.stringify({audio:wav(pcm).toString('base64'),language:'ko'}),signal:AbortSignal.timeout(10000)});
            const d=await r.json();if(!r.ok)throw Error(`Whisper ${r.status}: ${d.code}`);
            row.transcript=d.rawText;row.asrFinalMs=Math.round(t()-endedAt);row.asrServerMs=d.asrMs;
            if(live)ws.send(JSON.stringify({type:'text',text:d.text}));
          }else{
            ws.send(JSON.stringify(mode==='transcribe'?{type:'asr-start',mode:'file'}:{type:'mode',mode:'file'}));
            const start=t();
            for(let pos=0;pos<pcm.length&&live;pos+=3200){
              const part=pcm.subarray(pos,pos+3200);
              await sleep(Math.max(0,start+(pos+part.length)/32-t()));
              if(live)ws.send(part);
            }
            if(!live)return;
            endedAt=t();
            if(mode==='transcribe')ws.send(JSON.stringify({type:'asr-end'}));
            else{
              if(process.env.TEST_AUDIO_END==='1')ws.send(JSON.stringify({type:'audio-end'}));
              keepalive=setInterval(()=>{if(live)ws.send(Buffer.alloc(3200));},100);
              if(done)settle=setTimeout(finish,3500);
            }
          }
        }
        if(event==='asr-final'){row.transcript=data.rawText;row.asrFinalMs=Math.round(now-endedAt);row.asrServerMs=data.finalizeMs;}
        if(event==='tool')row.tools.push({at:now,...data});
        if(event==='text'&&data.role==='USER'&&mode==='native'){row.transcript+=(row.transcript?' ':'')+data.text;row.asrFinalMs=endedAt?Math.round(now-endedAt):null;}
        if(event==='text'&&data.role==='ASSISTANT')row.reply+=data.text;
        if(event==='audio'){firstAudioAt??=now;row.audioBytes+=Buffer.from(data.audio,'base64').length;}
        if(event==='error'||event==='asr-error'){row.error=data.error||data.code;finish();}
        if(event==='done'){done=true;if(endedAt)finish();}
      }catch(error){row.error=error.message;finish();}
    });
  });
  row.firstAudioMs=endedAt&&firstAudioAt?Math.round(firstAudioAt-endedAt):null;
  row.earlyAudio=row.firstAudioMs!=null&&row.firstAudioMs<0;
  row.earlyTool=!!endedAt&&row.tools.some(tool=>tool.at<endedAt&&tool.ok&&tool.actions?.length);
  row.tools.forEach(tool=>{delete tool.at;});
  const expected=chars(row.reference);row.referenceChars=expected.length;row.charEdits=edits(expected,chars(row.transcript));
  const exportReply=await fetch(base+'/api/export',{headers});if(!exportReply.ok)throw Error('Could not read test session');
  const snapshot=await exportReply.json();row.state=snapshot.state;
  row.numericGuards=snapshot.turns.flatMap(turn=>turn.numericGuard?[turn.numericGuard]:[]);
  row.numericCommitWaitMs=snapshot.turns.reduce((sum,turn)=>sum+(turn.numericCommitWaitMs||0),0);
  row.pass=c.check?!row.error&&row.audioBytes>0&&c.check(snapshot.state,row.tools,row.reply):null;
  return row;
}
const rows=[];
const modes=process.env.TEST_MODES?.split(',')||['native','whisper','transcribe'];
if(modes.some(mode=>!['native','whisper','transcribe'].includes(mode)))throw Error('Unknown test mode');
for(const c of cases.filter(c=>!process.env.TEST_CASE||process.env.TEST_CASE.split(',').includes(c.id))){
  const pcm=await fixture(c);
  const batch=await Promise.all(modes.map(mode=>run(c,pcm,mode)));
  for(const row of batch){rows.push(row);console.log(JSON.stringify({id:row.id,mode:row.mode,transcript:row.transcript,edits:row.charEdits,firstAudioMs:row.firstAudioMs,asrMs:row.asrFinalMs,pass:row.pass,error:row.error}));}
}
polly?.destroy();
const round=n=>Math.round(n*10)/10;
const median=a=>a.length?Math.round((a[(a.length-1)>>1]+a[a.length>>1])/2):null;
const summary=Object.fromEntries(modes.map(mode=>{
  const r=rows.filter(x=>x.mode===mode),timing=r.map(x=>x.firstAudioMs).filter(x=>x!=null&&x>=0).sort((a,b)=>a-b);
  return [mode,{n:r.length,completed:r.filter(x=>!x.error&&x.audioBytes>0).length,passed:r.some(x=>x.pass!==null)?r.filter(x=>x.pass).length:null,
    cerPct:round(100*r.reduce((n,x)=>n+x.charEdits,0)/r.reduce((n,x)=>n+x.referenceChars,0)),
    firstAudioMedianMs:median(timing),firstAudioP95Ms:timing[Math.ceil(timing.length*.95)-1]??null,timed:timing.length,earlyAudio:r.filter(x=>x.earlyAudio).length,earlyTool:r.filter(x=>x.earlyTool).length,
    asrFinalMedianMs:median(r.map(x=>x.asrFinalMs).filter(x=>x!=null).sort((a,b)=>a-b))}];
}));
console.log(JSON.stringify(summary));
await writeFile(`${out}/${process.env.TEST_CASE||'report'}.json`,JSON.stringify({at:new Date().toISOString(),base,synthetic:!manifest||manifest.synthetic===true,source:manifest?.source,summary,rows},null,2));
if(rows.some(x=>x.mode==='transcribe'&&x.error))process.exitCode=1;
