import {createRequire} from 'node:module';
import {awsCredentials} from './aws-auth.mjs';
import {normalizeTranscript} from './transcript.mjs';

export const TRANSCRIBE_REGION=process.env.SONIC_TRANSCRIBE_REGION||'ap-northeast-2';
const require=createRequire(import.meta.url);
let sdk,client;
function getClient(){
  if(!client){
    try{sdk=require('@aws-sdk/client-transcribe-streaming');}
    catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;sdk=require('./runtime/transcribe-sdk.cjs');}
    client=new sdk.TranscribeStreamingClient({region:TRANSCRIBE_REGION,maxAttempts:1,...awsCredentials});
  }
  return client;
}
export async function* transcribeEvents(audio,language,signal){
  const transport=getClient();
  const reply=await transport.send(new sdk.StartStreamTranscriptionCommand({
    LanguageCode:language==='en'?'en-US':'ko-KR',MediaEncoding:'pcm',MediaSampleRateHertz:16000,AudioStream:audio,
  }),{abortSignal:signal});
  for await(const event of reply.TranscriptResultStream){
    if(!event.TranscriptEvent)throw Error('Transcribe stream failed');
    yield* event.TranscriptEvent.Transcript?.Results||[];
  }
}

const CHUNK_BYTES=3200, MAX_BYTES=960000, MAX_PENDING=128000;
const koreanGain=process.env.SONIC_TRANSCRIBE_GAIN==='2'?2:1;
// Keep the original cadence and leave headroom. No buffering across chunks.
export function prepareTranscribePcm(pcm,gain){
  if(gain===1)return pcm;
  let peak=0;
  for(let i=0;i<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)));
  if(!peak)return pcm;
  const scale=Math.min(gain,Math.max(1,32000/peak));
  if(scale===1)return pcm;
  const result=Buffer.allocUnsafe(pcm.length);
  for(let i=0;i<pcm.length;i+=2)result.writeInt16LE(Math.round(pcm.readInt16LE(i)*scale),i);
  return result;
}
const budgets=new Map();let active=0;
function reserve(viewer){
  if(active>=4)return false;
  const now=Date.now();
  for(const [key,budget] of budgets)if(now>=budget.until)budgets.delete(key);
  const budget=budgets.get(viewer)||{until:now+60000,count:0};
  if(budget.count>=24||(!budgets.has(viewer)&&budgets.size>=1024))return false;
  budget.count++;budgets.set(viewer,budget);active++;return true;
}

export function createTranscribeInput({language,viewer,onFinal,onError,events=transcribeEvents}){
  let turn;
  function release(t){
    if(turn!==t)return false;
    turn=null;clearTimeout(t.timeout);t.controller.abort();t.wake?.();active--;return true;
  }
  function fail(t,code){if(release(t))onError({code});}
  async function* audio(t){
    while(!t.controller.signal.aborted){
      if(!t.chunks.length){
        if(t.finished)return;
        await new Promise(resolve=>{t.wake=resolve;});t.wake=null;continue;
      }
      const chunk=t.chunks.shift();t.pending-=chunk.length;
      yield {AudioEvent:{AudioChunk:prepareTranscribePcm(chunk,language==='ko'?koreanGain:1)}};
    }
  }
  async function run(t){
    try{
      const segments=new Map();let lastEnd=0;
      for await(const result of events(audio(t),language,t.controller.signal)){
        if(turn!==t)return;
        if(result.IsPartial!==false)continue;
        const text=result.Alternatives?.[0]?.Transcript?.trim();
        if(text)segments.set(result.ResultId??result.StartTime??segments.size,{text,at:result.StartTime??lastEnd});
        lastEnd=result.EndTime??lastEnd;
      }
      if(!t.finished)return fail(t,'unavailable');
      const rawText=[...segments.values()].sort((a,b)=>a.at-b.at).map(s=>s.text).join(' ');
      const text=normalizeTranscript(rawText.replace(/(\d+(?:\.\d+)?)\s*°(?:\s*[Cc])?/g,'$1도')).trim();
      if(!/[\p{L}\p{N}]/u.test(text))return fail(t,'empty');
      if(text.length>500)return fail(t,'long');
      if(release(t))onFinal({text,rawText,mode:t.mode,region:TRANSCRIBE_REGION,finalizeMs:Math.round(performance.now()-t.endedAt)});
    }catch(error){
      if(turn!==t)return;
      // Log the failure class only. No audio, transcript, or credentials.
      console.warn('Sonic Transcribe:',error.name||'Error');
      fail(t,error.name==='LimitExceededException'?'busy':'unavailable');
    }
  }
  function enqueue(t,bytes){
    t.chunks.push(bytes);t.pending+=bytes.length;t.wake?.();
  }
  return {
    get active(){return !!turn;},
    start(mode){
      if(turn||!['microphone','file'].includes(mode)||!reserve(viewer)){onError({code:'busy'});return;}
      const t=turn={mode,chunks:[],pending:0,total:0,tail:Buffer.alloc(0),controller:new AbortController(),finished:false};
      t.timeout=setTimeout(()=>fail(t,'timeout'),36000).unref();
      void run(t);
    },
    push(pcm){
      const t=turn;
      if(!t||t.finished)return;
      t.total+=pcm.length;
      if(t.total>MAX_BYTES)return fail(t,'long');
      if(t.pending+t.tail.length+pcm.length>MAX_PENDING)return fail(t,'busy');
      const bytes=Buffer.concat([t.tail,pcm]);
      const stop=bytes.length-bytes.length%CHUNK_BYTES;
      for(let i=0;i<stop;i+=CHUNK_BYTES)enqueue(t,bytes.subarray(i,i+CHUNK_BYTES));
      t.tail=bytes.subarray(stop);
    },
    finish(){
      const t=turn;
      if(!t||t.finished)return;
      if(!t.total)return fail(t,'empty');
      t.endedAt=performance.now();t.finished=true;
      if(t.tail.length)enqueue(t,t.tail);
      t.wake?.();
      clearTimeout(t.timeout);t.timeout=setTimeout(()=>fail(t,'timeout'),7000).unref();
    },
    close(){if(turn)release(turn);},
  };
}
