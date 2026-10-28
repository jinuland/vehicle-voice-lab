"""Pinned, self-hosted Korean Whisper ASR; no user audio written to disk."""
import io,time,threading
from contextlib import asynccontextmanager
import torch,soundfile as sf
from fastapi import FastAPI,UploadFile,HTTPException,Form
MODEL='openai/whisper-large-v3-turbo'
REVISION='41f01f3fe87f28c78e2fbf8b568835947dd65ed9'
model=processor=None
status={'ready':False,'model':MODEL,'revision':REVISION,'error':None};lock=threading.Lock()
def load():
 global model,processor
 try:
  from transformers import AutoProcessor,AutoModelForSpeechSeq2Seq
  processor=AutoProcessor.from_pretrained(MODEL,revision=REVISION)
  model=AutoModelForSpeechSeq2Seq.from_pretrained(MODEL,revision=REVISION,torch_dtype=torch.float16,device_map='cuda',attn_implementation='sdpa').eval()
  status['ready']=True
 except Exception as e:
  import traceback;traceback.print_exc();status['error']=str(e)
@asynccontextmanager
async def lifespan(app):
 threading.Thread(target=load,daemon=True).start();yield
app=FastAPI(lifespan=lifespan)
@app.get('/health')
def health():return status
@app.post('/asr')
def asr(file:UploadFile,language:str=Form('ko')):
 if language not in ('ko','en'):raise HTTPException(400,'Supported languages: ko, en')
 if not status['ready']:raise HTTPException(503,status['error'] or 'Whisper model loading')
 raw=file.file.read(2_000_001)
 if len(raw)>2_000_000:raise HTTPException(413,'Audio too large')
 samples,rate=sf.read(io.BytesIO(raw),dtype='float32')
 if rate!=16000 or samples.ndim!=1 or len(samples)>rate*30:raise HTTPException(400,'16kHz mono WAV, max 30 seconds')
 started=time.perf_counter()
 with lock,torch.inference_mode():
  inputs=processor(samples,sampling_rate=16000,return_tensors='pt',return_attention_mask=True).to('cuda')
  inputs['input_features']=inputs['input_features'].to(torch.float16)
  output=model.generate(**inputs,language=language,task='transcribe',max_new_tokens=128,do_sample=False)
  text=processor.batch_decode(output,skip_special_tokens=True)[0].strip()
 return{'text':text,'elapsedMs':round((time.perf_counter()-started)*1000),'model':MODEL,'revision':REVISION}
