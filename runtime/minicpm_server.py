"""Pinned MiniCPM-o speech-to-speech research worker; loopback only."""
import asyncio,base64,io,json,os,threading,time,uuid
from contextlib import asynccontextmanager
import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI,UploadFile,HTTPException,Request,Form
from fastapi.responses import StreamingResponse
from minicpm_protocol import chunk_windows,Conversation

MODEL='openbmb/MiniCPM-o-4_5'
REVISION='503e754207c94da6bb26850b4469f367c9ea3582'
status={'ready':False,'model':MODEL,'revision':REVISION,'integrationVersion':2,'audioPlanner':True,'error':None,'mode':'utterance input / native streamed audio output','vehicleTools':False,'koreanSupported':False}
model=None;lock=threading.Lock();ref_audio=None
conversation=Conversation()

def load():
    global model,ref_audio
    try:
        from huggingface_hub import snapshot_download
        from transformers import AutoModel
        path=snapshot_download(MODEL,revision=REVISION,allow_patterns=['*.json','*.safetensors','*.py','tokenizer*','*.model','assets/token2wav/**'])
        model=AutoModel.from_pretrained(path,trust_remote_code=True,attn_implementation='sdpa',torch_dtype=torch.bfloat16,init_vision=False,init_audio=True,init_tts=True).eval().cuda()
        model.init_tts()
        ref_audio,rate=sf.read('/opt/vehicle-voice/reference-neutral.wav',dtype='float32')
        if rate!=16000 or ref_audio.ndim!=1:raise RuntimeError('Reference must be mono 16kHz WAV')
        status['ready']=True
    except Exception as error:
        import traceback;traceback.print_exc();status['error']=str(error)

@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load,daemon=True).start();yield
app=FastAPI(lifespan=lifespan)
@app.get('/health')
def health():return status

@app.post('/plan-audio')
def plan_audio(file:UploadFile,messages:str=Form(...)):
    if not status['ready']:raise HTTPException(503,status['error'] or 'Model loading')
    raw=file.file.read(2_000_001)
    if len(raw)>2_000_000:raise HTTPException(413,'Audio too large')
    samples,rate=sf.read(io.BytesIO(raw),dtype='float32')
    if rate!=16000 or samples.ndim!=1 or not 0<len(samples)<=rate*30:raise HTTPException(400,'16kHz mono WAV, max 30 seconds')
    try:
        history=json.loads(messages)
        if not isinstance(history,list) or not 1<=len(history)<=14 or history[0].get('role')!='system':raise ValueError()
        if any(not isinstance(m,dict) or m.get('role') not in ('system','user','assistant') or not isinstance(m.get('content'),str) for m in history):raise ValueError()
        if sum(len(m['content']) for m in history)>20000:raise ValueError()
    except (ValueError,TypeError,AttributeError):raise HTTPException(400,'Invalid planner messages')
    if not lock.acquire(blocking=False):raise HTTPException(429,'MiniCPM is processing another request; try again shortly')
    started=time.perf_counter()
    try:
        # Explicit text history from the application prevents native voice-mode
        # instructions or another browser's KV cache leaking into tool planning.
        conversation.invalidate();model.reset_session(reset_token2wav_cache=True)
        msgs=[{'role':m['role'],'content':[m['content']]} for m in history]
        msgs.append({'role':'user','content':['Listen carefully to this newest Korean audio request. Return ONLY JSON with heard, intent, actions, reply. Preserve the exact seat, number, and on/off meaning you hear. Follow the vehicle tool instructions in the system message. Do not repeat an earlier request.',samples]})
        with torch.inference_mode():
            answer=model.chat(msgs=msgs,generate_audio=False,use_tts_template=False,enable_thinking=False,omni_mode=False,do_sample=False,max_new_tokens=512)
            passes=1
            try:understanding=json.loads(answer)
            except (ValueError,TypeError):understanding={}
            incomplete=not all(k in understanding for k in ('intent','actions','reply'))
            inconsistent=bool(understanding.get('actions')) and understanding.get('intent')!='control'
            if isinstance(understanding.get('heard'),str) and (incomplete or inconsistent):
                heard=understanding['heard'][:500]
                text_msgs=[{'role':m['role'],'content':[m['content']]} for m in history]
                text_msgs.append({'role':'user','content':[heard+'\nheard, intent, actions, reply 네 필드가 있는 JSON만 출력하세요. 지원하는 차량 조작 요청이면 intent=control, actions에 해당 동작을 생성하세요. 질문이면 intent=question, actions=[].']})
                answer=model.chat(msgs=text_msgs,generate_audio=False,use_tts_template=False,enable_thinking=False,do_sample=False,max_new_tokens=512)
                try:
                    planned=json.loads(answer);planned['heard']=heard;answer=json.dumps(planned,ensure_ascii=False)
                except (ValueError,TypeError):pass
                passes=2
        return {'text':answer,'model':MODEL,'revision':REVISION,'elapsedMs':round((time.perf_counter()-started)*1000),'loadMs':0,'mode':'native audio understanding and JSON planning','controlVersion':2,'plannerPasses':passes}
    finally:lock.release()

@app.post('/s2s')
async def speech(file:UploadFile,request:Request,language:str=Form('en'),conversation_id:str=Form('')):
    if not status['ready']:raise HTTPException(503,status['error'] or 'Model loading')
    raw=await file.read(2_000_001)
    if len(raw)>2_000_000:raise HTTPException(413,'Audio too large')
    samples,rate=sf.read(io.BytesIO(raw),dtype='float32')
    if rate!=16000 or samples.ndim!=1 or not 0<len(samples)<=rate*30:raise HTTPException(400,'16kHz mono WAV, max 30 seconds')
    if language not in ('en','ko') or len(conversation_id)>128:raise HTTPException(400,'Invalid conversation settings')
    if not lock.acquire(blocking=False):raise HTTPException(429,'MiniCPM is processing another request; try again shortly')
    canceled=threading.Event();loop=asyncio.get_running_loop();queue=asyncio.Queue(maxsize=100)
    def emit(data):
        if not canceled.is_set():asyncio.run_coroutine_threadsafe(queue.put(data),loop).result(timeout=10)
    def generate():
        started=time.perf_counter();text='';first=None;completed=False
        try:
            with torch.inference_mode():
                reset=conversation.begin(conversation_id,language,time.monotonic());sid=conversation.session_id
                if reset:
                    model.reset_session(reset_token2wav_cache=True);model.init_token2wav_cache(ref_audio)
                    prompt=model.get_sys_prompt(ref_audio=ref_audio,mode='audio_assistant',language='en')
                    prompt['content'].append('Answer briefly, in one short sentence. You cannot execute vehicle commands. For a vehicle command, acknowledge the requested seat and value and explain that no setting was applied. Do not invent which features the vehicle has. '+('한국어로 답하세요.' if language=='ko' else 'Respond in English.'))
                    model.streaming_prefill(session_id=sid,msgs=[prompt],omni_mode=False,is_last_chunk=True)
                padded=0
                for start,end,padding,last in chunk_windows(len(samples)):
                    if canceled.is_set():return
                    chunk=samples[start:end]
                    if padding:chunk=np.pad(chunk,(0,padding));padded+=padding
                    model.streaming_prefill(session_id=sid,msgs=[{'role':'user','content':[chunk]}],omni_mode=False,is_last_chunk=last)
                for wav,chunk_text in model.streaming_generate(session_id=sid,generate_audio=True,use_tts_template=True,enable_thinking=False,do_sample=True,max_new_tokens=512,length_penalty=1.1):
                    if canceled.is_set():return
                    first=first or round((time.perf_counter()-started)*1000)
                    audio=wav.detach().float().cpu().numpy().reshape(-1);buffer=io.BytesIO();sf.write(buffer,audio,24000,format='WAV',subtype='PCM_16')
                    text+=chunk_text;emit({'event':'audio','audio':base64.b64encode(buffer.getvalue()).decode(),'text':chunk_text,'firstAudioMs':first})
                conversation.finish(time.monotonic());completed=True
                emit({'event':'done','text':text,'firstAudioMs':first,'totalMs':round((time.perf_counter()-started)*1000),'model':MODEL,'revision':REVISION,'integrationVersion':2,'conversationContinued':not reset,'inputSamples':len(samples),'paddedSamples':padded})
        except Exception as error:
            import traceback;traceback.print_exc();emit({'event':'error','error':str(error)})
        finally:
            if not completed:conversation.invalidate()
            lock.release()
            try:emit(None)
            except Exception:pass
    threading.Thread(target=generate,daemon=True).start()
    async def stream():
        try:
            while True:
                if await request.is_disconnected():break
                try:item=await asyncio.wait_for(queue.get(),timeout=1)
                except asyncio.TimeoutError:continue
                if item is None:break
                yield json.dumps(item,ensure_ascii=False)+'\n'
        finally:canceled.set()
    return StreamingResponse(stream(),media_type='application/x-ndjson')
