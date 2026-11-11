"""Add the ASR-only route without replacing the target's other demo routes."""
import pathlib
import sys

server = pathlib.Path(sys.argv[1])
source = server.read_text()
recognizer = 'recognizeOnWhisper' if 'function recognizeOnWhisper(' in source else "(form,signal)=>remote(whisper+'/asr',{method:'POST',body:form},signal).then(r=>r.json())"
for before, extra in [
    ("import express from 'express';", "import {sonicAsrRoute} from './sonic-asr.mjs';\n"),
    ("app.get('/api/health',", f"app.post('/api/sonic-asr',sonicAsrRoute({{session,recognize:{recognizer}}}));\n"),
]:
    if extra not in source:
        if source.count(before) != 1:
            raise SystemExit(f"Unexpected server layout at {before}")
        source = source.replace(before, extra + before)
server.write_text(source)
