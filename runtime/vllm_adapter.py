"""Keep the validated vehicle /plan contract while vLLM batches text inference."""
import os,time,json
from contextlib import asynccontextmanager
import httpx
from runtime.vehicle_plan_schema import vehicle_plan_schema
from fastapi import FastAPI,HTTPException
from pydantic import BaseModel

MODEL=os.environ.get('VLLM_MODEL_ID','microsoft/Phi-4-mini-instruct')
REVISION=os.environ.get('VLLM_MODEL_REVISION','cfbefacb99257ffa30c83adab238a50856ac3083')
ENDPOINT=os.environ.get('VLLM_URL','http://127.0.0.1:8000')
QUANTIZATION=os.environ.get('VLLM_QUANTIZATION','bf16')
GPU_NAME=os.environ.get('VLLM_GPU_NAME','NVIDIA GPU')
SCHEMA_VERSION=os.environ.get('PLANNER_SCHEMA_VERSION','typed-actions-v2')
SCHEMA=vehicle_plan_schema(SCHEMA_VERSION)
@asynccontextmanager
async def lifespan(app):
 async with httpx.AsyncClient(timeout=120) as client:
  app.state.client=client;yield
app=FastAPI(lifespan=lifespan)
class PlanRequest(BaseModel):
 messages:list[dict]
 model_id:str=MODEL
 quantization:str='bf16'
 generation_profile:str='deterministic'
@app.get('/health')
async def health():
 try:ready=(await app.state.client.get(ENDPOINT+'/health',timeout=2)).is_success
 except httpx.HTTPError:ready=False
 return {'ready':ready,'role':'core','models':{'llm':MODEL,'quantization':QUANTIZATION,'engine':'vllm'},'gpu':GPU_NAME,'cuda':True}
@app.post('/plan')
async def plan(req:PlanRequest):
 if req.model_id!=MODEL or req.quantization!=QUANTIZATION:raise HTTPException(400,'This replica serves only its pinned planner and quantization')
 if req.generation_profile!='deterministic':raise HTTPException(400,'Only the reviewed deterministic profile is enabled')
 start=time.perf_counter()
 try:
  response=await app.state.client.post(ENDPOINT+'/v1/chat/completions',json={'model':'vehicle-planner','messages':req.messages,'temperature':0,'max_tokens':1024,'seed':42,'chat_template_kwargs':{'enable_thinking':False},'structured_outputs':{'json':SCHEMA}})
  response.raise_for_status();data=response.json();choice=data['choices'][0]
  if choice.get('finish_reason')=='length':raise ValueError('Planner exhausted its output budget')
  answer=choice['message']['content'];json.loads(answer)
 except (httpx.HTTPError,KeyError,ValueError) as error:raise HTTPException(502,'vLLM planning failed: '+str(error)[:180])
 return {'text':answer,'elapsedMs':round((time.perf_counter()-start)*1000),'loadMs':0,'model':MODEL,'revision':REVISION,'quantization':QUANTIZATION,'generationProfile':'deterministic','engine':'vllm','generatedTokens':data.get('usage',{}).get('completion_tokens'),'memory':{'measurement':'vLLM GPU pool; inspect separate GPU monitoring, not planner-only allocated weights'}}
