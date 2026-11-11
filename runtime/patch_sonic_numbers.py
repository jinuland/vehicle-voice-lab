"""Patch the vehicle Sonic WebSocket without replacing other deployed demos."""
import pathlib
import sys

server = pathlib.Path(sys.argv[1])
source = server.read_text()
marker = "import {createNativeWriteGate,correctionError,numericGuardReply} from './sonic-number-guard.mjs';"
if marker in source:
    raise SystemExit(0)
changes = [
    ("import express from 'express';", marker + "\nimport express from 'express';"),
    ("let record,recordStart=0,stopped=false,idleTimer,transcribe,sonicKeepAlive;", """let record,recordStart=0,stopped=false,idleTimer,transcribe,sonicKeepAlive,sonicTranscriptId;
  const writeGate=createNativeWriteGate();"""),
    ("transcribe?.close();if(record", "transcribe?.close();writeGate.close();if(record"),
    ("language,executeTool:args=>{", "language,executeTool:async args=>{"),
    (";const gate=guardExplicitBounds(normalizeTranscript(record?.input||''),proposedPlan),plan=gate.plan;", """;
    const correction=language==='ko'?correctionError(record?.input,proposedPlan.actions):null;
    const delayStart=performance.now();
    const nativeAudio=!transcribe&&record?.inputMode!=='text';
    const mayWrite=!!correction||!nativeAudio||await writeGate.wait(proposedPlan.actions);
    if(stopped||sonicConnections.get(s.id)?.stop!==stop)throw new Error('취소된 차량 명령입니다.');
    const refusal=correction||(!mayWrite?{code:'speech-resumed'}:null);
    if(refusal){
      if(!record||record.completed)newRecord();
      record.modelProposedActions.push(...proposedPlan.actions);
      record.numericGuard={...refusal,waitMs:Math.round(performance.now()-delayStart)};
      const error=numericGuardReply(refusal,language);
      return{ok:false,error,reply:error,validationError:refusal.code,state:s.state,actions:[],results:[]};
    }
    const gate=guardExplicitBounds(normalizeTranscript(record?.input||''),proposedPlan),plan=gate.plan;"""),
    ("    return{ok:!gate.reason,", """    if(nativeAudio)record.numericCommitWaitMs=(record.numericCommitWaitMs||0)+Math.round(performance.now()-delayStart);
    return{ok:!gate.reason,"""),
    ("if(data.role==='USER'){if(!record||record.completed)newRecord();record.input+=data.text;}", """if(data.role==='USER'){
        if(!record||record.completed)newRecord();
        if(data.id!==sonicTranscriptId){sonicTranscriptId=data.id;writeGate.transcript(data.id);if(record.input)record.input+=' ';}
        record.input+=data.text;
      }"""),
    ("if(transcribe)transcribe.push(raw);else sonic.audio(raw);", "if(transcribe)transcribe.push(raw);else{writeGate.observe(raw);sonic.audio(raw);}"),
    ("{touch();if(!record||record.completed)newRecord('',data.mode);}", """{touch();writeGate.mode(data.mode);if(!record||record.completed)newRecord('',data.mode);}
        else if(data.type==='audio-end'&&!transcribe)writeGate.audioEnd();"""),
]
start = source.index("wss.on('connection',(ws,req,url)=>{")
prefix, connection = source[:start], source[start:]
for old, new in changes[:1]:
    if prefix.count(old) != 1:
        raise SystemExit(f"Unexpected server imports at {old}")
    prefix = prefix.replace(old,new,1)
for old, new in changes[1:]:
    if connection.count(old) != 1:
        raise SystemExit(f"Unexpected vehicle Sonic handler at {old}")
    connection = connection.replace(old,new,1)
server.write_text(prefix+connection)
