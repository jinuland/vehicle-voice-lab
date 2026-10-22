"""Keep the validated vehicle /plan contract while vLLM batches text inference."""
import os,time,json
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI,HTTPException
from pydantic import BaseModel

MODEL=os.environ.get('VLLM_MODEL_ID','microsoft/Phi-4-mini-instruct')
REVISION=os.environ.get('VLLM_MODEL_REVISION','cfbefacb99257ffa30c83adab238a50856ac3083')
ENDPOINT=os.environ.get('VLLM_URL','http://127.0.0.1:8000')
with open('runtime/planner-schema.json') as file:SCHEMA=json.load(file)
# The audio-planner schema also requires ASR text; text planners use the same
# control schema without that field, matching model_server.PLAN_SCHEMA.
SCHEMA['required']=[key for key in SCHEMA['required'] if key!='heard'];SCHEMA['properties'].pop('heard',None)
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
 return {'ready':ready,'role':'core','models':{'llm':MODEL,'quantization':'bf16','engine':'vllm'},'gpu':'NVIDIA L4','cuda':True}
@app.post('/plan')
async def plan(req:PlanRequest):
 if req.model_id!=MODEL or req.quantization!='bf16':raise HTTPException(400,'This replica serves only its pinned BF16 planner')
 if req.generation_profile!='deterministic':raise HTTPException(400,'Only the reviewed deterministic profile is enabled')
 start=time.perf_counter()
 try:
  response=await app.state.client.post(ENDPOINT+'/v1/chat/completions',json={'model':'vehicle-planner','messages':req.messages,'temperature':0,'max_tokens':1024,'seed':42,'chat_template_kwargs':{'enable_thinking':False},'structured_outputs':{'json':SCHEMA}})
  response.raise_for_status();data=response.json();choice=data['choices'][0]
  if choice.get('finish_reason')=='length':raise ValueError('Planner exhausted its output budget')
  answer=choice['message']['content'];json.loads(answer)
 except (httpx.HTTPError,KeyError,ValueError) as error:raise HTTPException(502,'vLLM planning failed: '+str(error)[:180])
 return {'text':answer,'elapsedMs':round((time.perf_counter()-start)*1000),'loadMs':0,'model':MODEL,'revision':REVISION,'quantization':'bf16','generationProfile':'deterministic','engine':'vllm','generatedTokens':data.get('usage',{}).get('completion_tokens'),'memory':{'measurement':'vLLM GPU pool; inspect separate GPU monitoring, not planner-only allocated weights'}}
