"""GPU model workers; reachable only through an SSH tunnel."""
import os, io, time, threading, json, asyncio, gc
from contextlib import asynccontextmanager
import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, UploadFile, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from typing import Literal

ROLE = os.environ.get('MODEL_ROLE', 'core')
status = {'ready': False, 'role': ROLE, 'error': None, 'models': {}}
lock = threading.Lock()
model = processor = asr = asr_processor = tts = None
compiled_grammar = None
tts_queue = asyncio.Lock()
PLANNERS={
    'Qwen/Qwen3.5-4B':'851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',
    'Qwen/Qwen3.5-2B':'15852e8c16360a2fea060d615a32b45270f8a8fc',
    'Qwen/Qwen3.5-0.8B':'2fc06364715b967f1860aea9cf38778875588b17',
    'microsoft/Phi-4-mini-instruct':'cfbefacb99257ffa30c83adab238a50856ac3083',
    'google/gemma-4-E2B-it':'3e22461f65e89153144f8adb70e3b8c2cc9845a7',
    'naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-0.5B':'3da5046fb0195d14f2497de198136987d35fd644',
    'LGAI-EXAONE/EXAONE-4.0-1.2B':'3abf2810673c7c0778df64a73c2d52eab32d91c4',
    'HuggingFaceTB/SmolLM3-3B':'a07cc9a04f16550a088caea529712d1d335b0ac1',
}
try:
    from runtime.vehicle_plan_schema import vehicle_plan_schema
except ModuleNotFoundError:
    from vehicle_plan_schema import vehicle_plan_schema
PLAN_SCHEMA=vehicle_plan_schema(os.environ.get('PLANNER_SCHEMA_VERSION','typed-actions-v2'))

def load():
    global model, processor, asr, asr_processor, tts, compiled_grammar
    try:
        if ROLE == 'core':
            from transformers import AutoModelForRNNT, AutoProcessor, AutoTokenizer, AutoModelForImageTextToText
            if os.environ.get('COMPACT_SERVING') != '1':
                aid = 'nvidia/nemotron-3.5-asr-streaming-0.6b'
                asr_processor = AutoProcessor.from_pretrained(aid)
                asr = AutoModelForRNNT.from_pretrained(aid, device_map='cuda', torch_dtype=torch.float32).eval()
                status['models']['asr'] = aid
            # Small serving replicas must not load a BF16 model before NF4.
            load_planner(os.environ.get('DEFAULT_PLANNER','Qwen/Qwen3.5-4B'),os.environ.get('DEFAULT_QUANTIZATION','bf16'))
        else:
            from qwen_tts import Qwen3TTSModel
            tid = os.environ.get('TTS_MODEL', 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')
            tts = Qwen3TTSModel.from_pretrained(tid, device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
            status['models']['tts'] = tid
        status['ready'] = True
    except Exception as e:
        import traceback
        traceback.print_exc()
        status['error'] = str(e)

def load_planner(lid, quantization='bf16'):
    global model,processor,compiled_grammar
    if lid not in PLANNERS:raise ValueError('Planner is not in the reviewed allowlist')
    if quantization not in ('bf16','nf4') or (quantization=='nf4' and lid!='Qwen/Qwen3.5-4B'):
        raise ValueError('Quantization is not enabled for this model')
    if status['models'].get('llm')==lid and status['models'].get('quantization')==quantization and model is not None:return 0
    from transformers import AutoTokenizer,AutoModelForImageTextToText,AutoModelForCausalLM,AutoModelForMultimodalLM
    import xgrammar as xgr
    started=time.perf_counter();status['loadingPlanner']=lid
    model=processor=compiled_grammar=None;status['models'].pop('llm',None);status['models'].pop('quantization',None);status.pop('plannerMemory',None);gc.collect();torch.cuda.empty_cache()
    torch.cuda.synchronize();base_allocated=torch.cuda.memory_allocated()
    try:
        processor=AutoTokenizer.from_pretrained(lid,revision=PLANNERS[lid],local_files_only=True)
        loader=AutoModelForMultimodalLM if lid.startswith('google/') else AutoModelForImageTextToText if lid.startswith('Qwen/') else AutoModelForCausalLM
        attention='eager' if lid.startswith('google/') else 'sdpa'
        options={}
        # T4 has no native BF16 arithmetic. Keep the existing BF16 path on
        # Ampere/Ada; use FP16 compute and unquantized modules for NF4 on Turing.
        compute_dtype=torch.bfloat16 if torch.cuda.get_device_capability()[0]>=8 else torch.float16
        if quantization=='bf16' and compute_dtype!=torch.bfloat16:
            raise ValueError('This GPU has no native BF16 support; select the NF4/FP16 experiment')
        if quantization=='nf4':
            from transformers import BitsAndBytesConfig
            options['quantization_config']=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type='nf4',bnb_4bit_use_double_quant=True,bnb_4bit_compute_dtype=compute_dtype)
        model=loader.from_pretrained(lid,revision=PLANNERS[lid],local_files_only=True,device_map='cuda',torch_dtype=compute_dtype,attn_implementation=attention,**options).eval()
        torch.cuda.synchronize()
        quantized_layers=sum(type(module).__name__=='Linear4bit' for module in model.modules())
        if quantization=='nf4' and quantized_layers==0:raise RuntimeError('No Linear4bit layers were loaded; refusing a mislabeled quantized model')
        status['plannerMemory']={'modelFootprintMiB':round(model.get_memory_footprint()/2**20,2),'cudaAllocatedDeltaMiB':round((torch.cuda.memory_allocated()-base_allocated)/2**20,2),'linear4bitLayers':quantized_layers,'computeDtype':str(compute_dtype),'measurement':'this process CUDA allocated delta after planner load; excludes other workers, includes model quantization buffers; not vehicle shared RAM'}
        stops=model.generation_config.eos_token_id;stops=stops if isinstance(stops,list) else [stops]
        text_config=getattr(model.config,'text_config',model.config)
        info=xgr.TokenizerInfo.from_huggingface(processor,vocab_size=text_config.vocab_size,stop_token_ids=stops)
        # Unbounded JSON whitespace lets Phi repeat CR tokens until the token
        # budget expires. Use compact JSON so every structural token progresses.
        compiled_grammar=xgr.GrammarCompiler(info).compile_json_schema(
            json.dumps(PLAN_SCHEMA), any_whitespace=False, indent=None, separators=(',', ':'))
        status['models']['llm']=lid
        status['models']['quantization']=quantization
        return round((time.perf_counter()-started)*1000)
    finally:status['loadingPlanner']=None

@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load, daemon=True).start()
    yield

app = FastAPI(lifespan=lifespan)

@app.get('/health')
def health():
    return {**status, 'cuda': torch.cuda.is_available(), 'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}

def require_ready():
    if not status['ready']:
        raise HTTPException(503, status['error'] or '모델을 불러오는 중입니다.')

class PlanRequest(BaseModel):
    messages: list[dict]
    model_id: str = 'Qwen/Qwen3.5-4B'
    generation_profile: Literal['deterministic','official'] = 'deterministic'
    quantization: Literal['bf16','nf4'] = 'bf16'

@app.post('/plan')
def plan(req: PlanRequest):
    require_ready()
    if ROLE != 'core': raise HTTPException(404)
    started = time.perf_counter()
    with lock, torch.inference_mode():
        queue_ms=round((time.perf_counter()-started)*1000)
        if req.model_id not in PLANNERS:raise HTTPException(400,'Unknown planner')
        if req.quantization=='nf4' and req.model_id!='Qwen/Qwen3.5-4B':raise HTTPException(400,'NF4 is enabled only for Qwen3.5-4B')
        load_ms=load_planner(req.model_id,req.quantization)
        torch.cuda.synchronize();allocated_before=torch.cuda.memory_allocated();torch.cuda.reset_peak_memory_stats()
        inference_started=time.perf_counter()
        from xgrammar.contrib.hf import LogitsProcessor
        messages=req.messages
        if req.model_id.startswith('naver-hyperclovax/'):
            messages=[{'role':'tool_list','content':''}]+messages
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        inputs = processor(text=[text], return_tensors='pt', add_special_tokens=False).to(model.device)
        options={'repetition_penalty':1.2} if req.model_id.startswith('naver-hyperclovax/') else {}
        processors=[LogitsProcessor(compiled_grammar)];sampling={'do_sample':False}
        if req.generation_profile=='official' and req.model_id.startswith('Qwen/'):
            # Official non-thinking text sampling; presence applies only to output.
            prefix_length=inputs.input_ids.shape[1]
            class PresencePenalty:
                def __call__(self,input_ids,scores):
                    seen=input_ids[0,prefix_length:].unique()
                    if seen.numel():scores[0,seen]-=2.0
                    return scores
            processors=[PresencePenalty(),*processors];sampling={'do_sample':True,'temperature':1.0,'top_p':1.0,'top_k':20,'repetition_penalty':1.0};torch.manual_seed(42)
        elif req.generation_profile=='official' and req.model_id.startswith('HuggingFaceTB/'):
            sampling={'do_sample':True,'temperature':0.6,'top_p':0.95};torch.manual_seed(42)
        if req.model_id.startswith('naver-hyperclovax/'):
            options.update(stop_strings=['<|endofturn|>','<|stop|>'],tokenizer=processor)
        output = model.generate(**inputs, max_new_tokens=1024, use_cache=True, logits_processor=processors, **sampling, **options)
        generated = output[:, inputs.input_ids.shape[1]:]
        answer = processor.batch_decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
        # A grammar restricts each token, but a token limit can still interrupt
        # a valid prefix. Never forward an incomplete plan for execution.
        try:
            json.loads(answer)
        except json.JSONDecodeError:
            raise HTTPException(502, '판단 모델이 차량 명령을 완성하지 못했어요. 다시 말씀해 주세요.')
        model_id=status['models']['llm']
        torch.cuda.synchronize();elapsed_ms=round((time.perf_counter()-inference_started)*1000)
        memory={**status['plannerMemory'],'processPeakAllocatedMiB':round(torch.cuda.max_memory_allocated()/2**20,2),'requestAdditionalPeakMiB':round((torch.cuda.max_memory_allocated()-allocated_before)/2**20,2)}
    return {'text':answer,'elapsedMs':elapsed_ms,'totalMs':round((time.perf_counter()-started)*1000),'queueMs':queue_ms,'loadMs':load_ms,'model':model_id,'revision':PLANNERS[model_id],'generatedTokens':generated.shape[1],'generationProfile':req.generation_profile,'quantization':req.quantization,'memory':memory}

@app.post('/asr')
def transcribe(file: UploadFile):
    require_ready()
    if ROLE != 'core': raise HTTPException(404)
    if asr is None:raise HTTPException(503,'Nemotron is disabled in compact serving; select Whisper')
    raw = file.file.read(2_000_001)
    if len(raw) > 2_000_000: raise HTTPException(413, 'Audio too large')
    samples, rate = sf.read(io.BytesIO(raw), dtype='float32')
    if rate != 16000 or samples.ndim != 1 or len(samples) > rate*30:
        raise HTTPException(400, '16kHz mono WAV, max 30 seconds required')
    started = time.perf_counter()
    with lock, torch.inference_mode():
        inputs = asr_processor(samples, sampling_rate=rate, language='ko-KR', return_tensors='pt')
        inputs = inputs.to(asr.device)
        output = asr.generate(**inputs, return_dict_in_generate=True)
        text = asr_processor.decode(output.sequences, skip_special_tokens=True)
        if isinstance(text, list): text = text[0]
    return {'text': text.strip(), 'elapsedMs': round((time.perf_counter()-started)*1000), 'model': status['models']['asr']}

class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=350)

@app.post('/tts')
async def synthesize(req: TTSRequest, request: Request):
    require_ready()
    if ROLE != 'tts': raise HTTPException(404)
    started = time.perf_counter()
    def generate():
        with lock, torch.inference_mode():
            return tts.generate_custom_voice(text=req.text, language='Korean', speaker='Sohee', max_new_tokens=1024, do_sample=False)
    async with tts_queue:
        # Canceled browser turns must not keep occupying the GPU queue.
        if await request.is_disconnected(): raise HTTPException(499, 'Request canceled')
        wavs, sr = await asyncio.to_thread(generate)
    buf=io.BytesIO(); sf.write(buf, wavs[0], sr, format='WAV', subtype='PCM_16')
    return Response(buf.getvalue(), media_type='audio/wav', headers={'X-Inference-Ms': str(round((time.perf_counter()-started)*1000)), 'X-Model': status['models']['tts']})
