"""Apply only the Transcribe WebSocket hooks to the deployed vehicle server."""
import pathlib
import sys

server = pathlib.Path(sys.argv[1])
source = server.read_text()
marker = "import {createTranscribeInput,TRANSCRIBE_REGION} from './sonic-transcribe.mjs';"
if marker in source:
    raise SystemExit(0)
changes = [
    ("import express from 'express';", marker + "\nimport express from 'express';"),
    ("asrWorkers:{whisper:states[4]}", "asrWorkers:{whisper:states[4],transcribe:{ready:true,region:TRANSCRIBE_REGION}}"),
    ("let record,recordStart=0,stopped=false,idleTimer;", "let record,recordStart=0,stopped=false,idleTimer,transcribe,sonicKeepAlive;"),
    ("clearTimeout(idleTimer);clearTimeout(lifetime);", "clearTimeout(idleTimer);clearTimeout(lifetime);clearInterval(sonicKeepAlive);transcribe?.close();"),
    ("  sonicConnections.set(s.id,{stop});", """  if(url.searchParams.get('input')==='transcribe'){
    const viewer=String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',').at(-1).trim();
    transcribe=createTranscribeInput({language,viewer,onError:data=>send('asr-error',data),onFinal:data=>{
      if(stopped||ws.readyState!==1)return;
      touch();
      Object.assign(newRecord(data.text,'transcribe-'+data.mode),{rawTranscript:data.rawText,asrModel:'Amazon Transcribe',asrRegion:data.region,asrFinalizeMs:data.finalizeMs});
      send('asr-final',data);sonic.text(data.text);
    }});
    const silence=Buffer.alloc(3200);sonicKeepAlive=setInterval(()=>sonic.audio(silence),100).unref();
  }
  sonicConnections.set(s.id,{stop});"""),
    ("sonic.audio(raw);if(raw.some", "if(transcribe)transcribe.push(raw);else sonic.audio(raw);if(raw.some"),
    ("if(data.type==='text'&&typeof data.text==='string'&&data.text.trim()&&data.text.length<=500)", """if(transcribe&&data.type==='asr-start'){
          touch();if(record&&!record.completed)send('asr-error',{code:'busy'});else transcribe.start(data.mode);
        }else if(transcribe&&data.type==='asr-end'){touch();transcribe.finish();}
        else if(transcribe&&data.type==='asr-cancel')transcribe.close();
        else if(data.type==='text'&&typeof data.text==='string'&&data.text.trim()&&data.text.length<=500&&!transcribe?.active)"""),
]
for old, new in changes:
    if source.count(old) != 1:
        raise SystemExit(f"Unexpected server layout at {old}")
    source = source.replace(old, new, 1)
server.write_text(source)
