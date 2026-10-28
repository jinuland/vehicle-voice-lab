// Deployed Sonic + the real browser client code, with synthetic microphone PCM and a WebAudio test double.
// Scheduled PCM is inspected for audibility. This does not replace a human microphone/echo test.
import WebSocket from 'ws';import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const base=process.env.TEST_BASE||'https://d3q7tlfor72b22.cloudfront.net',directory=new URL('../.runtime/sonic-turn-tests/',import.meta.url),source=await readFile(new URL('../public/sonic-client.js',import.meta.url),'utf8');
const clips=await Promise.all(['prefix','filler','ending'].map(n=>readFile(new URL(n+'.pcm',directory))));const gap=Buffer.alloc(44800),prefix=[clips[0],gap,clips[1],gap,clips[1],gap,clips[1],gap],commandStartMs=Buffer.concat(prefix).length/32,pcm=Buffer.concat([...prefix,clips[2]]);
const r=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('Session '+r.status);const session=await r.json();
const row={at:new Date().toISOString(),base,method:'Real Sonic WebSocket + source client mic/queue logic; synthetic English; simulated WebAudio scheduling',clientSHA256:createHash('sha256').update(source).digest('hex'),inputDurationMs:pcm.length/32,commandStartMs,patienceMs:2500,transcripts:[],replies:[],interrupted:0,audibleChunks:0};
let start=performance.now(),finishResolve,ticker,finished=false,voice;const done=new Promise(resolve=>finishResolve=resolve),ms=()=>Math.round(performance.now()-start);
const finish=error=>{if(finished)return;finished=true;if(error)row.error=String(error);clearTimeout(timeout);clearInterval(ticker);voice?.close();finishResolve();};const timeout=setTimeout(()=>finish('90 s timeout'),90000);
class TestAudioContext{
 constructor(){this.origin=performance.now();this.destination={};this.nodes=new Set();}
 get currentTime(){return(performance.now()-this.origin)/1000;}
 async resume(){}async close(){for(const node of this.nodes)node.stop();}
 createBuffer(channels,length,rate){const samples=new Float32Array(length);return{duration:length/rate,getChannelData:()=>samples,samples};}
 createBufferSource(){const context=this,node={connect(){},disconnect(){context.nodes.delete(node);},start(at){
  context.nodes.add(node);const delay=Math.max(0,(at-context.currentTime)*1000);
  node.started=setTimeout(()=>{const rms=Math.sqrt(node.buffer.samples.reduce((a,x)=>a+x*x,0)/node.buffer.samples.length);if(rms>.005){row.firstAudiblePlaybackMs??=ms();row.audibleChunks++;}},delay);
  node.ended=setTimeout(()=>node.onended?.(),delay+node.buffer.duration*1000);
 },stop(){clearTimeout(node.started);clearTimeout(node.ended);context.nodes.delete(node);}};return node;}
}
class Socket extends WebSocket{constructor(url){super(url,{origin:base});}}
const context=vm.createContext({window:{},location:{href:base,protocol:new URL(base).protocol},URL,AudioContext:TestAudioContext,WebSocket:Socket,performance,setTimeout,clearTimeout,setInterval,clearInterval,Uint8Array,Float32Array,DataView,Math,Set,atob});vm.runInContext(source,context);
voice=new context.window.SonicVoice({sessionId:session.id,language:'en',patienceMs:2500,onEvent:(event,data)=>{
 if(event==='ready')row.endpointingSensitivity=data.endpointingSensitivity;
 if(event==='text')row[data.role==='USER'?'transcripts':'replies'].push({ms:ms(),text:data.text});
 if(event==='tool'&&data.state)row.state=data.state;
 if(event==='interrupted')row.interrupted++;
 if(event==='playbackWait')row.waitEvents=(row.waitEvents||0)+1;
 if(event==='playbackEnd'&&row.inputEndMs!=null&&row.audibleChunks)finish();
 if(event==='error')finish(data.error);
}});
try{
 await voice.connect();start=performance.now();voice.liveMic=true;voice.basis='microphone';voice.send({type:'mode',mode:'microphone'});let position=0;
 ticker=setInterval(()=>{const bytes=position<pcm.length?pcm.subarray(position,position+3200):Buffer.alloc(3200),samples=new Float32Array(1600);
  for(let i=0;i<bytes.length/2;i++)samples[i]=bytes.readInt16LE(i*2)/32768;
  voice.mic(samples,16000);if(position<pcm.length){position+=3200;if(position>=pcm.length)row.inputEndMs=ms();}
 },100);
}catch(e){finish(e.message);}
await done;
row.playbackAfterInputEndMs=row.firstAudiblePlaybackMs-row.inputEndMs;row.pass=!row.error&&row.endpointingSensitivity==='LOW'&&row.audibleChunks>0&&row.firstAudiblePlaybackMs>=row.inputEndMs&&row.state?.temperature.passenger===23&&row.state?.fan===3;
await writeFile(new URL('client-'+new URL(base).hostname+'.json',directory),JSON.stringify(row,null,2));console.log(JSON.stringify(row,null,2));if(!row.pass)process.exitCode=1;
