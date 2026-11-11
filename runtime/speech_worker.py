"""Pinned native speech adapters, selected by the process manager."""
import base64,io,json,os,pathlib,sys,tempfile,threading,time,copy
from contextlib import asynccontextmanager,redirect_stdout
import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI,UploadFile,HTTPException,Form
from speech_protocol import complete_json_text
ROOT=pathlib.Path(__file__).parent
KIND=os.environ['SPEECH_MODEL_ID']
SPECS={
 'qwen3-omni':('Qwen/Qwen3-Omni-30B-A3B-Instruct','26291f793822fb6be9555850f06dfe95f2d7e695'),
 'step-audio2-mini':('stepfun-ai/Step-Audio-2-mini','e36fdd5d71e0ea22f09dd94bbab9bfc544ca1e36'),
 'mimo-audio':('XiaomiMiMo/MiMo-Audio-7B-Instruct','c359441c22c2a1c74be5f99a91e83392680e9cc8'),
 'moshi':('kyutai/moshiko-pytorch-bf16','2bfc9ae6e89079a5cc7ed2a68436010d91a3d289'),
}
REPO,REV=SPECS[KIND]
status={'ready':False,'modelId':KIND,'model':REPO,'revision':REV,'error':None,'nativeAudio':True,'audioPlanner':KIND!='moshi','koreanSupported':KIND=='qwen3-omni','quantization':'NF4 thinker linear layers' if KIND=='qwen3-omni' else 'BF16'}
model=processor=decoder=grammar=None;lock=threading.Lock()
def load():
 global model,processor,decoder,grammar
 try:
  from huggingface_hub import snapshot_download
  if KIND=='qwen3-omni':
   from transformers import Qwen3OmniMoeForConditionalGeneration,Qwen3OmniMoeProcessor,BitsAndBytesConfig
   import xgrammar as xgr
   quant=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type='nf4',bnb_4bit_compute_dtype=torch.bfloat16,bnb_4bit_use_double_quant=True,llm_int8_skip_modules=['talker','code2wav','audio_tower','visual'])
   cache=ROOT/'models/vehicle-omni-nf4-457'
   try:cached=json.loads((cache/'READY').read_text()).get('revision')==REV
   except (OSError,ValueError):cached=False
   model=Qwen3OmniMoeForConditionalGeneration.from_pretrained(str(cache) if cached else REPO,**({} if cached else {'revision':REV,'quantization_config':quant}),device_map={'':'cuda:0'},dtype=torch.bfloat16,attn_implementation='sdpa').eval()
   if not cached:
    model.save_pretrained(cache,max_shard_size='4GB',safe_serialization=True)
    (cache/'READY').write_text(json.dumps({'source':REPO,'revision':REV,'transformers':'4.57.6','bitsandbytes':'0.49.2','format':'NF4 thinker linear; BF16 audio'}))
   processor=Qwen3OmniMoeProcessor.from_pretrained(REPO,revision=REV)
   tokenizer=processor.tokenizer
   stops=model.thinker.generation_config.eos_token_id
   stops=stops if isinstance(stops,list) else [stops] if stops is not None else [151645]
   info=xgr.TokenizerInfo.from_huggingface(tokenizer,vocab_size=model.config.thinker_config.text_config.vocab_size,stop_token_ids=stops)
   grammar=xgr.GrammarCompiler(info).compile_json_schema(json.loads((ROOT/'planner-schema.json').read_text()),any_whitespace=False,separators=(',',':'))
  elif KIND=='step-audio2-mini':
   sys.path.insert(0,str(ROOT/'Step-Audio2'))
   from stepaudio2 import StepAudio2
   from token2wav import Token2wav
   path=snapshot_download(REPO,revision=REV)
   model=StepAudio2(path);decoder=Token2wav(path+'/token2wav')
   import xgrammar as xgr
   info=xgr.TokenizerInfo.from_huggingface(model.llm_tokenizer,vocab_size=model.llm.config.text_config.vocab_size,stop_token_ids=[model.eos_token_id])
   grammar=xgr.GrammarCompiler(info).compile_json_schema(json.loads((ROOT/'planner-schema.json').read_text()),any_whitespace=False,separators=(',',':'))
  elif KIND=='mimo-audio':
   sys.path.insert(0,str(ROOT/'MiMo-Audio'))
   from src.mimo_audio.mimo_audio import MimoAudio
   path=snapshot_download(REPO,revision=REV,allow_patterns=['*.json','*.safetensors','tokenizer*','*.model'])
   tok=snapshot_download('XiaomiMiMo/MiMo-Audio-Tokenizer',revision='5df9914f72d3acda1320d7fecde7d91622edb0c1',allow_patterns=['*.json','*.safetensors','*.pt','*.model'])
   model=MimoAudio(path,tok)
   # Command planning uses deterministic decoding, independently of the
   # upstream sampling settings for conversational speech output.
   model.vehicle_original_samplers=copy.deepcopy(model.task_sampler_configs['audio_understanding'])
   for sampler in model.task_sampler_configs['audio_understanding'].values():sampler.do_sample=False
   from transformers import MaxTimeCriteria
   forward=model.forward
   def bounded_forward(*args,**kwargs):
    kwargs['max_new_tokens']=min(kwargs.get('max_new_tokens',192),192)
    kwargs['stopping_criteria']=[*(kwargs.get('stopping_criteria') or []),MaxTimeCriteria(max_time=30)]
    # Upstream prints the generated text channel; keep user utterances out of
    # persistent GPU service logs.
    with redirect_stdout(io.StringIO()):return forward(*args,**kwargs)
   model.forward=bounded_forward
  else:
   from moshi.models import loaders,LMGen
   import sentencepiece
   path=pathlib.Path(snapshot_download(REPO,revision=REV,allow_patterns=['model.safetensors','tokenizer_spm_32k_3.model','tokenizer-e351c8d8-checkpoint125.safetensors','config.json']))
   decoder=loaders.get_mimi(str(path/loaders.MIMI_NAME),device='cuda');decoder.set_num_codebooks(8)
   model=loaders.get_moshi_lm(str(path/loaders.MOSHI_NAME),device='cuda',dtype=torch.bfloat16)
   processor=sentencepiece.SentencePieceProcessor(str(path/loaders.TEXT_TOKENIZER_NAME))
  torch.cuda.empty_cache()
  status['ready']=True
 except Exception as e:
  import traceback;traceback.print_exc();status['error']=str(e)
@asynccontextmanager
async def lifespan(app):threading.Thread(target=load,daemon=True).start();yield
app=FastAPI(lifespan=lifespan)
@app.get('/health')
def health():return {**status,'gpuMemoryMiB':round(torch.cuda.memory_allocated()/1024**2)}
def audio_input(file):
 if not status['ready']:raise HTTPException(503,status['error'] or '모델 준비 중')
 raw=file.file.read(2_000_001)
 if len(raw)>2_000_000:raise HTTPException(413,'Audio too large')
 samples,rate=sf.read(io.BytesIO(raw),dtype='float32')
 if rate!=16000 or samples.ndim!=1 or not 0<len(samples)<=rate*30:raise HTTPException(400,'16kHz mono WAV, max 30 seconds')
 return samples
def history_input(raw):
 try:
  history=json.loads(raw)
  if not isinstance(history,list) or len(history)>14:raise ValueError()
  if any(not isinstance(m,dict) or m.get('role') not in ('system','user','assistant') or not isinstance(m.get('content'),str) for m in history):raise ValueError()
  if sum(len(m['content']) for m in history)>20000:raise ValueError()
  return history
 except (ValueError,TypeError,AttributeError):raise HTTPException(400,'Invalid messages')
def omni_inputs(samples,history):
 messages=[{'role':m['role'],'content':[{'type':'text','text':m['content']}]} for m in history]
 messages.append({'role':'user','content':[{'type':'audio','audio':samples}]})
 text=processor.apply_chat_template(messages,add_generation_prompt=True,tokenize=False)
 return processor(text=text,audio=[samples],return_tensors='pt',padding=True).to(model.device).to(torch.bfloat16)
def clean_mimo(text):return text.split('<|eot|>')[0].split('<|im_end|>')[0].replace('.....','').strip()
@app.post('/plan-audio')
def plan_audio(file:UploadFile,messages:str=Form(...),generation_profile:str=Form('deterministic')):
 samples=audio_input(file);history=history_input(messages)
 if KIND=='moshi':raise HTTPException(400,'Moshi does not support JSON vehicle planning')
 if not lock.acquire(blocking=False):raise HTTPException(429,'Model busy')
 started=time.perf_counter()
 try:
  with torch.inference_mode(),tempfile.TemporaryDirectory(prefix='voice-',dir='/dev/shm') as directory:
   path=directory+'/input.wav';sf.write(path,samples,16000)
   if KIND=='qwen3-omni':
    from xgrammar.contrib.hf import LogitsProcessor
    inputs=omni_inputs(samples,history)
    output,_=model.generate(**inputs,return_audio=False,thinker_do_sample=False,thinker_max_new_tokens=768,thinker_logits_processor=[LogitsProcessor(grammar)])
    output=getattr(output,'sequences',output)
    text=processor.batch_decode(output[:,inputs.input_ids.shape[1]:],skip_special_tokens=True,clean_up_tokenization_spaces=False)[0]
   elif KIND=='step-audio2-mini':
    msgs=history+[{'role':'user','content':[{'type':'audio','audio':path}]},{'role':'assistant','content':None}]
    from xgrammar.contrib.hf import LogitsProcessor
    generate=model.llm.generate
    # The upstream adapter puts kwargs in GenerationConfig; inject the token
    # processor at generate() itself so the schema is actually enforced.
    model.llm.generate=lambda **kw:generate(**kw,logits_processor=[LogitsProcessor(grammar)])
    options={'do_sample':False}
    if generation_profile=='official':options={'do_sample':True,'temperature':0.7,'top_p':0.9,'repetition_penalty':1.05};torch.manual_seed(42)
    try:_,text,_=model(msgs,max_new_tokens=768,**options)
    finally:model.llm.generate=generate
   else:
    # The upstream audio-understanding interface accepts one text question.
    # Use compact English tool instructions (the model's trained instruction
    # language) rather than flattening a long Korean system prompt into it.
    state_text=history[0]['content'].split('현재 차량 상태: ',1)[-1].split('\n',1)[0] if history else '{}'
    last_reply=next((m['content'] for m in reversed(history[1:]) if m['role']=='assistant'),'none')
    prompt=(ROOT/'mimo-planner-prompt.txt').read_text()+'\nCurrent simulator state: '+state_text+'\nLast completed action (only for an explicit correction): '+last_reply+'\nThe current user request is ONLY the attached audio. Do not repeat a previous action or a phrase from the instructions. Listen to the new audio now and output its JSON plan.'
    model.task_sampler_configs['audio_understanding']=copy.deepcopy(model.vehicle_original_samplers)
    if generation_profile!='official':
     for sampler in model.task_sampler_configs['audio_understanding'].values():sampler.do_sample=False
    else:torch.manual_seed(42)
    text=clean_mimo(model.audio_understanding_sft(path,prompt))
  try:text=complete_json_text(text,default_control_reply=KIND=='mimo-audio')
  except ValueError:raise HTTPException(502,'음성 모델이 차량 명령 JSON을 완성하지 못했어요. 다시 말씀해 주세요.')
  return {'text':text,'model':REPO,'revision':REV,'modelId':KIND,'elapsedMs':round((time.perf_counter()-started)*1000),'quantization':status['quantization'],'generationProfile':generation_profile}
 finally:lock.release()
@app.post('/s2s')
def speech(file:UploadFile,messages:str=Form('[]'),language:str=Form('ko')):
 samples=audio_input(file);history=history_input(messages)
 if not lock.acquire(blocking=False):raise HTTPException(429,'Model busy')
 started=time.perf_counter()
 try:
  # The comparison path cannot claim it changed simulator state.
  prompt='You are a friendly voice assistant. Reply in '+('Korean' if language=='ko' else 'English')+', in one short sentence of at most 12 words. You have no vehicle tools. Do not claim vehicle settings were changed.'
  if language=='ko':prompt+=' 답변은 30자 이내의 한국어 한 문장으로 끝내세요.'
  with torch.inference_mode(),tempfile.TemporaryDirectory(prefix='voice-',dir='/dev/shm') as directory:
   path=directory+'/input.wav';sf.write(path,samples,16000)
   if KIND=='qwen3-omni':
    inputs=omni_inputs(samples,[{'role':'system','content':prompt}]+[m for m in history if m['role']!='system'][-10:])
    output,audio=model.generate(**inputs,speaker='Chelsie',thinker_max_new_tokens=96,talker_max_new_tokens=768,thinker_do_sample=False)
    output=getattr(output,'sequences',output)
    text=processor.batch_decode(output[:,inputs.input_ids.shape[1]:],skip_special_tokens=True,clean_up_tokenization_spaces=False)[0]
    if audio is None:raise HTTPException(502,'모델에서 음성 출력이 없어요.')
    buf=io.BytesIO();sf.write(buf,audio.reshape(-1).float().cpu().numpy(),24000,format='WAV');wav=buf.getvalue()
   elif KIND=='step-audio2-mini':
    msgs=[{'role':'system','content':prompt}]+[m for m in history if m['role']!='system'][-10:]+[{'role':'user','content':[{'type':'audio','audio':path}]},{'role':'assistant','content':'<tts_start>','eot':False}]
    _,text,tokens=model(msgs,max_new_tokens=1536,temperature=0.7,top_p=.9,repetition_penalty=1.05,do_sample=True)
    tokens=[t for t in tokens if 0<=t<6561]
    if not tokens:raise HTTPException(502,'모델에서 음성 토큰이 없어요.')
    wav=decoder(tokens,prompt_wav=str(ROOT/'Step-Audio2/assets/default_female.wav'))
   elif KIND=='mimo-audio':
    output_path=directory+'/output.wav'
    # Voice conditioning is optional upstream. Avoid an unrelated English
    # reference utterance priming the response in unsupported-language trials.
    text=clean_mimo(model.spoken_dialogue_sft(path,output_audio_path=output_path,system_prompt=prompt))
    wav=pathlib.Path(output_path).read_bytes()
   else:
    from moshi.models import LMGen
    import librosa
    audio=librosa.resample(samples,orig_sr=16000,target_sr=24000);audio=np.pad(audio,(0,24000*4))
    pcm=torch.tensor(audio,device='cuda').reshape(1,1,-1);gen=LMGen(model,temp=.8,temp_text=.7,use_sampling=True)
    frames=[];parts=[];size=int(decoder.sample_rate/decoder.frame_rate)
    with decoder.streaming(1),gen.streaming(1):
     for chunk in pcm.split(size,dim=-1):
      if chunk.shape[-1]!=size:chunk=torch.nn.functional.pad(chunk,(0,size-chunk.shape[-1]))
      codes=decoder.encode(chunk);out=gen.step(codes)
      if out is None:continue
      frames.append(decoder.decode(out[:,1:]).cpu())
      tid=out[0,0,0].item()
      if tid not in (0,3):parts.append(processor.id_to_piece(tid).replace('▁',' '))
    text=''.join(parts).strip();buf=io.BytesIO();sf.write(buf,torch.cat(frames,dim=-1).reshape(-1).float().numpy(),24000,format='WAV');wav=buf.getvalue()
  return {'text':text,'audio':base64.b64encode(wav).decode(),'model':REPO,'revision':REV,'modelId':KIND,'elapsedMs':round((time.perf_counter()-started)*1000),'quantization':status['quantization'],'vehicleTools':False,'koreanSupported':status['koreanSupported']}
 finally:lock.release()
