"""One speech model process at a time; keeps incompatible runtimes isolated."""
import asyncio,json,os,pathlib,time
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI,HTTPException,UploadFile,Form
from fastapi.responses import JSONResponse
ROOT=pathlib.Path(__file__).parent
MODELS={'qwen3-omni':'omni-env','step-audio2-mini':'legacy-env','mimo-audio':'legacy-env','moshi':'moshi-env'}
process=None;loaded=None;loading=None;error=None;gate=asyncio.Lock();log=None
async def stop():
 global process,loaded,log
 if process and process.returncode is None:
  process.terminate()
  try:await asyncio.wait_for(process.wait(),15)
  except asyncio.TimeoutError:process.kill();await process.wait()
 process=None;loaded=None
 if log:log.close();log=None
@asynccontextmanager
async def lifespan(app):
 yield
 await stop()
app=FastAPI(lifespan=lifespan)
async def ensure(model_id):
 global process,loaded,loading,error,log
 if model_id not in MODELS:raise HTTPException(400,'Unknown audio model')
 if loaded==model_id and process and process.returncode is None:return 0
 await stop();loading=model_id;error=None;start=time.perf_counter()
 log=open(ROOT/'worker.log','a')
 process=await asyncio.create_subprocess_exec(str(ROOT/MODELS[model_id]/'bin/python'),'-m','uvicorn','speech_worker:app','--host','127.0.0.1','--port','9114',cwd=ROOT,env={**os.environ,'SPEECH_MODEL_ID':model_id,'PYTORCH_CUDA_ALLOC_CONF':'expandable_segments:True'},stdout=log,stderr=log)
 try:
  async with httpx.AsyncClient() as client:
   for _ in range(600):
    if process.returncode is not None:raise RuntimeError('음성 모델 프로세스가 종료됐어요. 설치 로그를 확인해 주세요.')
    try:
     h=(await client.get('http://127.0.0.1:9114/health',timeout=2)).json()
     if h.get('error'):raise RuntimeError(h['error'])
     if h.get('ready'):loaded=model_id;return round((time.perf_counter()-start)*1000)
    except (httpx.HTTPError,ValueError):pass
    await asyncio.sleep(1)
  raise RuntimeError('음성 모델 준비 시간이 초과됐어요.')
 except Exception as e:error=str(e);await stop();raise HTTPException(503,error)
 finally:loading=None
@app.get('/health')
async def health():
 h={'ready':True,'loaded':loaded,'loading':loading,'error':error,'available':list(MODELS),'swapModels':True}
 if loaded:
  try:
   async with httpx.AsyncClient() as client:h['worker']=(await client.get('http://127.0.0.1:9114/health',timeout=2)).json()
  except httpx.HTTPError:h['ready']=False
 return h
@app.post('/select')
async def select(body:dict):
 if gate.locked():raise HTTPException(429,'다른 음성 모델 요청을 처리 중이에요.')
 async with gate:return {'modelId':body.get('modelId'),'loadMs':await ensure(body.get('modelId'))}

@app.post('/game-text')
async def game_text(body:dict):
 model_id=body.get('model_id')
 if model_id not in ('qwen3-omni','step-audio2-mini'):raise HTTPException(400,'No game text adapter')
 if gate.locked():raise HTTPException(429,'다른 음성 모델 요청을 처리 중이에요.')
 async with gate:
  load_ms=await ensure(model_id)
  async with httpx.AsyncClient(timeout=120) as client:r=await client.post('http://127.0.0.1:9114/game-text',json=body)
  try:d=r.json()
  except ValueError:raise HTTPException(502,'게임 모델 응답 형식을 확인하지 못했어요. 서버 어댑터를 확인해 주세요.')
  d['loadMs']=load_ms
  return JSONResponse(d,status_code=r.status_code)

@app.post('/{operation}')
async def run(operation:str,file:UploadFile,model_id:str=Form(...),messages:str=Form('[]'),language:str=Form('ko'),generation_profile:str=Form('deterministic')):
 if operation not in ('plan-audio','s2s'):raise HTTPException(404)
 if model_id=='moshi' and operation=='plan-audio':raise HTTPException(400,'Moshi는 차량 JSON 도구를 지원하지 않는 음성 비교 모델입니다.')
 raw=await file.read(2_000_001)
 if len(raw)>2_000_000:raise HTTPException(413,'Audio too large')
 if gate.locked():raise HTTPException(429,'다른 음성 모델 요청을 처리 중이에요.')
 async with gate:
  load_ms=await ensure(model_id)
  try:
   async with httpx.AsyncClient(timeout=90) as client:
    r=await client.post('http://127.0.0.1:9114/'+operation,files={'file':('speech.wav',raw,'audio/wav')},data={'messages':messages,'language':language,'generation_profile':generation_profile})
  except httpx.HTTPError:
   await stop()
   raise HTTPException(504,'음성 모델 응답 시간이 초과되거나 연결이 끊겼어요. 모델을 다시 준비한 뒤 재시도해 주세요.')
  try:d=r.json()
  except ValueError:d={'detail':'음성 모델 응답 형식을 확인해 주세요.'}
  d['loadMs']=load_ms
  return JSONResponse(d,status_code=r.status_code)
