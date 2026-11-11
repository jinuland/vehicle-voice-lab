import {normalizeTranscript} from './transcript.mjs';

export const MAX_SONIC_WAV_BYTES=960_256;

// Accept PCM WAV only, including files with metadata chunks before the audio.
export function sonicWavPCM(wav){
  if(wav.length<46||wav.length>MAX_SONIC_WAV_BYTES||wav.toString('ascii',0,4)!=='RIFF'||
    wav.readUInt32LE(4)!==wav.length-8||wav.toString('ascii',8,12)!=='WAVE')return null;
  let format=false,pcm;
  for(let at=12;at+8<=wav.length;){
    const id=wav.toString('ascii',at,at+4),size=wav.readUInt32LE(at+4),start=at+8,end=start+size;
    if(end>wav.length)return null;
    if(id==='fmt '){
      if(format||size<16||wav.readUInt16LE(start)!==1||wav.readUInt16LE(start+2)!==1||
        wav.readUInt32LE(start+4)!==16000||wav.readUInt32LE(start+8)!==32000||
        wav.readUInt16LE(start+12)!==2||wav.readUInt16LE(start+14)!==16)return null;
      format=true;
    }
    if(id==='data'){
      if(pcm||!size||size>960_000||size%2)return null;
      pcm=wav.subarray(start,end);
    }
    at=end+(size%2);
  }
  return format&&pcm?pcm:null;
}

export function sonicAsrRoute({session,recognize}){
  const active=new Set();
  return async(req,res)=>{
    let id;
    try{id=session(req).id;}catch{return res.status(400).json({code:'session'});}
    const {audio,language}=req.body||{};
    if(typeof audio!=='string'||audio.length>Math.ceil(MAX_SONIC_WAV_BYTES/3)*4||!['ko','en'].includes(language))
      return res.status(400).json({code:'audio'});
    const wav=Buffer.from(audio,'base64'),pcm=sonicWavPCM(wav);
    if(!pcm)return res.status(400).json({code:'audio'});
    if(!pcm.some(byte=>byte!==0))return res.status(422).json({code:'empty'});
    if(active.has(id)||active.size>=4)return res.status(429).json({code:'busy'});
    const controller=new AbortController(),started=performance.now();
    res.once('close',()=>controller.abort());
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
    const form=new FormData();
    form.append('file',new Blob([wav],{type:'audio/wav'}),'speech.wav');
    form.append('language',language);
    active.add(id);
    try{
      const result=await recognize(form,signal);
      if(controller.signal.aborted)return;
      const rawText=typeof result?.text==='string'?result.text.trim():'';
      const text=normalizeTranscript(rawText).trim();
      if(!text||!/[\p{L}\p{N}]/u.test(text))return res.status(422).json({code:'empty'});
      if(text.length>500)return res.status(422).json({code:'long'});
      res.json({text,rawText,asrMs:Math.round(performance.now()-started),model:result.model});
    }catch{
      if(!controller.signal.aborted)res.status(503).json({code:'unavailable'});
    }finally{active.delete(id);}
  };
}
