// Synthetic English hesitations streamed in real time through the deployed Sonic WebSocket.
// This checks service turn-taking; client microphone suppression is covered by sonic-audio tests.
import WebSocket from 'ws';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PollyClient,SynthesizeSpeechCommand} from '@aws-sdk/client-polly';
import {awsCredentials} from '../aws-auth.mjs';
const base=process.env.TEST_BASE||'https://d3q7tlfor72b22.cloudfront.net',directory=new URL('../.runtime/sonic-turn-tests/',import.meta.url);
await mkdir(directory,{recursive:true});
const texts={prefix:'I would like you to adjust the climate controls, but please let me finish the whole request first. I am thinking about the temperature for the passenger, and also the fan speed.',filler:'Um, uh, let me think.',ending:'Okay, now set the passenger temperature to twenty three degrees, and set the fan speed to three.'},clips={};
const polly=new PollyClient({region:'ap-northeast-2',...awsCredentials});
for(const[name,text]of Object.entries(texts)){
 const file=new URL(name+'.pcm',directory);
 try{clips[name]=await readFile(file);}catch{const d=await polly.send(new SynthesizeSpeechCommand({VoiceId:'Joanna',Engine:'neural',OutputFormat:'pcm',SampleRate:'16000',Text:text}));clips[name]=Buffer.from(await d.AudioStream.transformToByteArray());await writeFile(file,clips[name]);}
}
if(process.argv.includes('--prepare-only')){console.log('Prepared synthetic English PCM clips.');process.exit(0);}
const gap=Buffer.alloc(16000/1000*2*1400),parts=[clips.prefix,gap,clips.filler,gap,clips.filler,gap,clips.filler,gap],finalCommandStartMs=Buffer.concat(parts).length/32,pcm=Buffer.concat([...parts,clips.ending]);
const row={at:new Date().toISOString(),base,syntheticInput:true,inputDurationMs:pcm.length/32,hesitationSilenceMs:1400,finalCommandStartMs,transcripts:[],replies:[],audioBytes:0,toolEvents:[]};
const response=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error('Session '+response.status);const session=await response.json();
await new Promise(resolve=>{
 const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/sonic?session='+session.id+'&language=en',{origin:base});let ticker,start,position=0,finished=false;
 const finish=error=>{if(finished)return;finished=true;if(error)row.error=String(error);clearTimeout(timeout);clearInterval(ticker);ws.close();resolve();};
 const timeout=setTimeout(()=>finish('90 s timeout'),90000),ms=()=>Math.round(performance.now()-start);
 ws.on('error',e=>finish(e.message));
 ws.on('message',raw=>{
  const{event,data}=JSON.parse(raw);
  if(event==='ready'){row.endpointingSensitivity=data.endpointingSensitivity;start=performance.now();ws.send(JSON.stringify({type:'mode',mode:'microphone'}));ticker=setInterval(()=>{if(ws.readyState!==1)return;if(position<pcm.length){ws.send(pcm.subarray(position,position+3200));position+=3200;if(position>=pcm.length)row.inputEndMs=ms();}else ws.send(Buffer.alloc(3200));},100);}
  if(event==='text'){row[data.role==='USER'?'transcripts':'replies'].push({ms:ms(),text:data.text});}
  if(event==='audio'){row.firstAudioMs??=ms();row.audioBytes+=Buffer.from(data.audio,'base64').length;}
  if(event==='tool'&&data.state){row.state=data.state;row.toolEvents.push({ms:ms(),actions:data.actions});}
  if(event==='interrupted')row.interruptions=(row.interruptions||0)+1;
  if(event==='error')finish(data.error);
  if(event==='done'&&position>=pcm.length&&row.audioBytes>0)finish();
 });
});
row.respondedBeforeFinalCommand=row.firstAudioMs!=null&&row.firstAudioMs<finalCommandStartMs;
row.firstAudioAfterInputEndMs=row.firstAudioMs-row.inputEndMs;
row.pass=!row.error&&row.endpointingSensitivity==='LOW'&&!row.respondedBeforeFinalCommand&&row.audioBytes>0&&row.state?.temperature.passenger===23&&row.state?.fan===3;
await writeFile(new URL('deployed-'+new URL(base).hostname+'.json',directory),JSON.stringify(row,null,2));console.log(JSON.stringify(row,null,2));if(!row.pass)process.exitCode=1;
