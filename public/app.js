import {configureAssistant,renderAssistantResult,stopRadio,syncRadioState,duckRadio,getRadioState} from './assistant-ui.js';
const $=id=>document.getElementById(id);
let sessionId,ready=false,micEnabled=false,audioContext,mediaStream,recorder,source,muteGain;
let micStarting=false;
window.voiceLabAudioStatus=()=>({enabled:micEnabled,starting:micStarting,context:audioContext?.state,streamActive:mediaStream?.active,workletReady:!!recorder});
let currentController,currentAudio,currentAudioUrl,lastTurnId,requestNumber=0,busy=false,stage='idle';
let audioQueue=[],generationDone=false,playedFirst=false;
let ttsChoice='polly';
const replyLanguage=()=>document.documentElement?.lang==='en'?'en':'ko';
const pollyLabel=()=>replyLanguage()==='en'?'Amazon Polly · Joanna':'Amazon Polly · Seoyeon';
function syncConversationLanguage(){
  const language=replyLanguage();
  for(const id of ['sonic-language','minicpm-language','audio-language'])$(id).value=language;
  if(language==='en'){ttsChoice='polly';$('tts-provider').value='polly';asrChoice='whisper';$('asr-model').value='whisper';}
  $('tts-provider').querySelector('[value="polly"]').textContent=pollyLabel();
  $('tts-provider').querySelector('[value="qwen"]').disabled=language==='en';
}
let plannerChoice='qwen35-4b';let asrChoice='whisper';
document.addEventListener('vehicle-catalog-ready',()=>{plannerChoice=$('planner-model').value;});
let engine='cascade',sonicVoice,sonicConnecting;
const isExtraAudio=()=>engine.startsWith('audio-');
const isAudioInput=()=>engine.startsWith('minicpm')||isExtraAudio();
const audioModelName=()=>$('audio-model').selectedOptions[0]?.textContent||'음성 모델';
const sonicBubbles=new Map();
function clearSonicPreviews(){for(const[id,item]of sonicBubbles)if(item.preview){item.el.remove();sonicBubbles.delete(id);}}
let bargeInEnabled=false;
let speech=false,frames=[],preRoll=[],voiceMs=0,silenceMs=0,noiseFloor=.004,lastVoiceAt=0;
let currentBasis='text',currentStart=0;
let cabinState;
const api=(path,options={})=>fetch('/api/'+path,{...options,headers:{'Content-Type':'application/json','X-Session-Id':sessionId,...options.headers}});
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,7000);}
function setStatus(text,kind='idle'){ $('voice-status').textContent=text;$('status-dot').className='status-dot '+kind; }
function idleStatus(){if(speech)setStatus('말씀을 듣고 있어요…','listening');else setStatus(micEnabled?'듣고 있어요 · 편하게 말씀해 주세요':ready?'마이크를 켜거나 텍스트로 시작하세요':'GPU 모델을 준비하고 있어요',micEnabled?'listening':'idle');}
function renderState(s){
  cabinState=s;
  syncRadioState(s);
  $('driver-temp').innerHTML=`${s.temperature.driver}<em>°</em>`;$('passenger-temp').innerHTML=`${s.temperature.passenger}<em>°</em>`;
  $('ac-state').textContent=s.ac?'켜짐':'꺼짐';$('ac-tile').classList.toggle('active',s.ac);
  $('fan-state').textContent=s.fan+'단';$('defrost-state').textContent=s.defrost?'켜짐':'꺼짐';$('defrost-tile').classList.toggle('active',s.defrost);
  $('seat-state').textContent=s.seatHeat?s.seatHeat+'단':'꺼짐';$('seat-tile').classList.toggle('active',s.seatHeat>0);
  $('track').textContent=s.media.track;$('media-state').textContent=s.media.playing?'모의 재생 중':'일시 정지';$('equalizer').classList.toggle('playing',s.media.playing);
  const liveRadio=getRadioState();if(liveRadio){$('track').textContent=liveRadio.name;$('media-state').textContent=liveRadio.playing?'실제 라디오 재생 중':'라디오 일시 정지';$('equalizer').classList.toggle('playing',liveRadio.playing);}
  $('volume-value').textContent=s.media.volume;$('volume-bar').style.width=s.media.volume+'%';
  $('destination').textContent=s.navigation.destination||'어디로 갈까요?';$('nav-state').textContent=s.navigation.active?'모의 안내 중 · 실제 경로 조회 없음':'목적지를 말해 주세요 · 모의 길 안내';
}
function bubble(text,type){
  $('welcome')?.remove();const el=document.createElement('div');el.className='bubble '+type;
  const label=document.createElement('span');label.className='label';label.textContent=type==='user'?'YOU':type==='error'?'안내':'온';el.append(label,document.createTextNode(text));
  const list=$('conversation');list.append(el);
  const messages=[...list.querySelectorAll('.bubble')];for(const old of messages.slice(0,-6))old.remove();
  for(const[id,item]of sonicBubbles)if(!item.el.isConnected)sonicBubbles.delete(id);
  list.scrollTop=list.scrollHeight;return el;
}
async function checkHealth(){
  try{const h=await(await fetch('/api/health')).json();$('conversation-engine').querySelector('[value="minicpm-control"]').disabled=!h.minicpmControl;for(const mode of ['audio-control','audio-native'])$('conversation-engine').querySelector(`[value="${mode}"]`).disabled=(mode==='audio-native'&&!$('comparison-only').checked)||!h.researchWorkers?.speech?.ready||![...$('audio-model').options].some(o=>o.dataset.ready==='true'&&(mode==='audio-control'?o.dataset.audioPlanner==='true':o.dataset.nativeAudio==='true'));ready=isExtraAudio()?!!(h.researchWorkers?.speech?.ready&&h.researchWorkers.speech.available?.includes($('audio-model').value)&&!$('audio-model').selectedOptions[0]?.disabled):engine==='minicpm-control'?!!(h.minicpmControl&&h.researchWorkers?.minicpm?.ready&&h.researchWorkers.minicpm.audioPlanner):engine==='sonic'?!!h.sonic:engine.startsWith('minicpm')?!!h.researchWorkers?.minicpm?.ready:h.ready&&(asrChoice!=='whisper'||h.asrWorkers?.whisper?.ready);
    $('connection').className='connection'+(ready?' ready':'');$('connection').replaceChildren(Object.assign(document.createElement('i'),{}),document.createTextNode(isExtraAudio()?(h.researchWorkers?.speech?.loading?'음성 모델 교체·로딩 중':ready?'추가 음성 GPU 연결됨':'음성 GPU 준비 중'):engine==='sonic'?'Sonic · 도쿄 API 준비':engine.startsWith('minicpm')?(ready?'MiniCPM · GPU 연결됨':'MiniCPM 모델 준비 중'):ready?'GPU 연결됨':'GPU 모델 준비 중'));
    const m=h.workers.flatMap(w=>Object.keys(w.models||{}));
    for(const key of ['asr','llm','tts'])$('model-'+key).classList.toggle('ready',engine!=='cascade'?ready:m.includes(key));
    $('model-tts').replaceChildren(document.createElement('i'),document.createTextNode(ttsChoice==='polly'?pollyLabel():'Qwen3-TTS · Sohee'));
    if(engine==='sonic')for(const [key,label]of Object.entries({asr:'Nova 2.5 Sonic · 음성 이해',llm:'Sonic · 통합 추론',tts:'Sonic · Tiffany'}))$('model-'+key).replaceChildren(document.createElement('i'),document.createTextNode(label));
    else if(engine==='minicpm-control')for(const [key,label]of Object.entries({asr:'MiniCPM · 음성 입력',llm:'MiniCPM · 명령 판단',tts:ttsChoice==='polly'?pollyLabel():'Qwen3-TTS · Sohee'}))$('model-'+key).replaceChildren(document.createElement('i'),document.createTextNode(label));
    else if(engine==='minicpm')for(const [key,label]of Object.entries({asr:'MiniCPM-o · 음성 이해',llm:'MiniCPM · 음성 대화',tts:'MiniCPM · 내장 음성 출력'}))$('model-'+key).replaceChildren(document.createElement('i'),document.createTextNode(label));
    else if(isExtraAudio())for(const [key,label]of Object.entries({asr:audioModelName()+' · 음성 입력',llm:audioModelName(),tts:engine==='audio-control'?(ttsChoice==='polly'?pollyLabel():'Qwen3-TTS · Sohee'):'모델 내장 음성'}))$('model-'+key).replaceChildren(document.createElement('i'),document.createTextNode(label));
    else for(const [key,label]of Object.entries({asr:asrChoice==='whisper'?'Whisper large-v3-turbo':'Nemotron 3.5 ASR',llm:$('planner-model').selectedOptions[0].textContent}))$('model-'+key).replaceChildren(document.createElement('i'),document.createTextNode(label));
    $('speech-language-label').textContent='VOICE · '+(engine==='sonic'?$('sonic-language').value:engine==='minicpm'?$('minicpm-language').value:engine==='audio-native'?$('audio-language').value:replyLanguage()).toUpperCase();
    $('deployment').textContent=engine==='sonic'?'AWS 도쿄 · Bedrock S2S':isExtraAudio()?'AWS 서울 · 음성 전용 L40S 48GB':'AWS 서울 · L40S 48GB';
    if(h.servingProfile==='compact'){
      $('asr-model').querySelector('[value="nemotron"]').disabled=true;
      $('tts-provider').querySelector('[value="qwen"]').disabled=true;
      if(engine==='cascade'){$('model-asr').classList.toggle('ready',!!h.asrWorkers?.whisper?.ready);$('model-tts').classList.toggle('ready',ttsChoice==='polly');}
      if(engine==='cascade')$('deployment').textContent=`AWS 서울 · L4 · ${h.instanceType} · ${h.workers[0].models?.engine==='vllm'?'vLLM 배치':'HF 서빙'}`;
      if(!document.getElementById('serving-cost-link')){const link=document.createElement('a');link.id='serving-cost-link';link.className='quiet';link.href='/costs.html';link.textContent=document.documentElement.lang==='en'?'L4 cost & performance':'L4 비용·성능 실측';document.querySelector('.header-right').prepend(link);}
    }
    $('mic').disabled=!ready||micStarting;$('send').disabled=!ready||isAudioInput();$('text-input').disabled=isAudioInput();$('text-input').placeholder=isAudioInput()?'마이크나 음성 샘플로 테스트하세요':'마이크 없이 텍스트로도 테스트할 수 있어요';
    $('control-connection').textContent=['audio-native','minicpm'].includes(engine)?'차량 제어 꺼짐 · 내장 목소리만 비교합니다. 온도·공조는 바뀌지 않습니다.':'✓ 차량 제어 연결 · 좌석 온도·공조·열선·미디어·모의 길 안내 / 센서·창문·주행 제어 미지원';$('control-connection').classList.toggle('comparison', ['audio-native','minicpm'].includes(engine));if(!busy&&!speech&&!micStarting)idleStatus();
    $('connection').title=isExtraAudio()?(h.researchWorkers?.speech?.error||''):engine.startsWith('minicpm')?(h.researchWorkers?.minicpm?.error||''):h.workers.map(w=>w.error).filter(Boolean).join('\n');
  }catch{$('connection').textContent='서버 연결 끊김';ready=false;}
}
function stopPlayback(clearQueue=true){if(currentAudio){currentAudio.pause();currentAudio.src='';currentAudio=null;}if(currentAudioUrl){URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=null;}if(clearQueue)audioQueue=[];}
async function interrupt(announce=true){
  clearSonicPreviews();
  sonicVoice?.close();sonicVoice=null;
  requestNumber++;currentController?.abort();currentController=null;stopPlayback();busy=false;stage='idle';
  try{const response=await api('cancel',{method:'POST',body:'{}'});const d=await response.json();if(d.state)renderState(d.state);}catch{}
  if(announce)setStatus('응답을 중단했어요. 새로 말씀해 주세요.',micEnabled?'listening':'idle');
}
function metric(id,value){$(id).replaceChildren(document.createTextNode(value==null?'—':Math.round(value).toLocaleString()),Object.assign(document.createElement('small'),{textContent:'ms'}));}
async function playAudio(base64,number){
  if(number!==requestNumber)return;
  if(currentAudio){audioQueue.push({base64,number});return;}
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));currentAudioUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
  const audio=new Audio(currentAudioUrl);currentAudio=audio;
  audio.addEventListener('playing',()=>{duckRadio(true);if(number===requestNumber){if(!playedFirst){playedFirst=true;const ms=performance.now()-currentStart;metric('first-audio-ms',ms);api('metrics',{method:'POST',body:JSON.stringify({turnId:lastTurnId,firstPlaybackMs:ms,basis:currentBasis})}).catch(()=>{});}setStatus(bargeInEnabled?'온이 말하고 있어요 · 끼어들어도 괜찮아요':'온이 말하고 있어요 · 응답이 끝나면 말씀해 주세요','busy');}},{once:true});
  audio.onended=()=>{duckRadio(false);if(number===requestNumber){stopPlayback(false);const next=audioQueue.shift();if(next)playAudio(next.base64,next.number);else if(generationDone){busy=false;stage='idle';idleStatus();}else setStatus('다음 응답 음성을 만들고 있어요…','busy');}};
  try{await audio.play();}catch{if(number===requestNumber){busy=false;idleStatus();toast('음성 재생이 차단됐어요. 화면을 한 번 클릭한 뒤 다시 테스트해 주세요.');}}
}
async function submit(payload,{basis='text',endedAt=performance.now()}={}){
  if(!ready){toast('GPU 모델을 준비하고 있어요. 연결 표시가 초록색으로 바뀌면 시작해 주세요.');return;}
  if(engine==='sonic'){
    try{if(payload.audio&&micEnabled)await toggleMic();const voice=await ensureSonic();resetSonicMetrics();busy=true;
      if(payload.text){bubble(payload.text,'user');voice.text(payload.text);}
      else await voice.file(Uint8Array.from(atob(payload.audio),c=>c.charCodeAt(0)).buffer);
    }catch(error){busy=false;toast(error.message);}return;
  }
  if(isAudioInput()&&payload.text){toast('이 모드는 마이크나 음성 샘플로 테스트해 주세요.');return;}
  if(busy)await interrupt(false);
  payload.comparisonOnly=$('comparison-only').checked&&['audio-native','minicpm'].includes(engine);payload.ttsProvider=ttsChoice;payload.inputMode=basis;payload.plannerId=plannerChoice;payload.asrId=asrChoice;payload.promptVersion=engine==='cascade'?$('planner-model').selectedOptions[0]?.dataset.promptVersion||'compact-v2':engine==='minicpm-control'?'compact-v2':$('audio-model').selectedOptions[0]?.dataset.promptVersion||'full-v1';payload.generationProfile=$('planner-model').selectedOptions[0]?.dataset.generationProfile||'deterministic';payload.language=isExtraAudio()?$('audio-language').value:engine==='minicpm'?$('minicpm-language').value:replyLanguage();payload.responseLanguage=replyLanguage();payload.audioModelId=$('audio-model').value;
  const number=++requestNumber;currentController=new AbortController();const controller=currentController;busy=true;generationDone=false;playedFirst=false;audioQueue=[];currentBasis=basis;currentStart=endedAt;
  $('metric-context').textContent=isExtraAudio()?(engine==='audio-control'?'음성 모델 직접 판단 → 차량 검증·실행 → 한국어 TTS':'내장 S2S 통합 처리 · 차량 도구 없음'):engine==='minicpm-control'?'MiniCPM 음성 이해·판단 → 차량 검증·실행 → 한국어 TTS':engine==='minicpm'?'MiniCPM S2S 통합 처리 · 단계별 시간 분리 불가':basis==='microphone'?'마지막 발화 시점 기준':basis==='file'?'음성 파일 제출 기준':'텍스트 제출 기준';
  for(const id of ['asr-ms','llm-ms','tts-ms','first-audio-ms'])metric(id,null);
  $('feedback').hidden=true;$('feedback-status').textContent='';lastTurnId=null;
  let userBubble,spokenBubble,spokenText='';if(payload.text)userBubble=bubble(payload.text,'user');else userBubble=bubble(isAudioInput()?'음성 입력 · 이 경로는 별도 전사를 제공하지 않습니다.':'음성을 인식하고 있어요…','user');
  try{
    const response=await api(isExtraAudio()?engine:engine==='minicpm'?'s2s':engine==='minicpm-control'?'minicpm-control':'turn',{method:'POST',body:JSON.stringify(payload),signal:controller.signal});
    if(!response.ok)throw new Error((await response.json()).error||'요청에 실패했어요.');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){
      const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      let boundary;
      while((boundary=buffer.indexOf('\n\n'))!==-1){
        const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const event=block.split('\n').find(l=>l.startsWith('event: '))?.slice(7);
        const raw=block.split('\n').find(l=>l.startsWith('data: '))?.slice(6);if(!raw||number!==requestNumber)continue;
        const d=JSON.parse(raw);
        if(event==='stage'){
          stage=d.stage;setStatus(d.stage==='nativeSpeech'?`${d.model} 내장 음성을 생성하고 있어요 · 첫 로딩은 수 분 걸릴 수 있어요`:d.stage==='audioPlanning'?`${d.model||'MiniCPM'}이 음성을 이해하고 차량 명령을 판단하고 있어요 · 첫 로딩은 수 분 걸릴 수 있어요`:d.stage==='s2s'?'MiniCPM 음성 대화를 처리하고 있어요 · 차량 제어 미연결':d.stage==='recognizing'?'한국어 음성을 인식하고 있어요…':d.stage==='thinking'?'선택한 판단 모델로 요청을 확인하고 있어요 · 첫 전환은 모델 준비 시간이 필요해요':ttsChoice==='qwen'?'Qwen 음성을 합성하고 있어요 · 수십 초 걸릴 수 있어요':'답변 음성을 만들고 있어요…','busy');
        }else if(event==='understood'){
          userBubble.lastChild.textContent=(d.model||'MiniCPM')+'이 이해한 요청: '+d.text;
        }else if(event==='transcript'){
          userBubble.lastChild.textContent=d.rawText&&d.rawText!==d.text?d.rawText+' (숫자 표기 정리: '+d.text+')':d.text;metric('asr-ms',basis==='text'||engine==='minicpm-control'?null:d.asrMs);
        }else if(event==='assistant'){
          renderAssistantResult(d);
        }else if(event==='reply'){
          const el=bubble(d.reply,'assistant');
          if(engine==='audio-native'){const note=document.createElement('div');note.className='tool-result';note.textContent='음성 모델 발화 비교 · 차량 명령은 실행되지 않았어요';el.append(note);}
          if(d.assistant){const note=document.createElement('div');note.className='tool-result';note.textContent=`${d.assistant.operation} · ${d.assistant.elapsedMs??'—'} ms`;el.append(note);$('metric-context').textContent='외부 도구 조회 · 차량 제어 경로 유지';}
          if(!d.assistant&&!d.results.length&&d.vehicleTools){const note=document.createElement('div');note.className='tool-result';note.textContent=d.validationError?'제어 연결 정상 · 잘못된 명령을 검증 단계에서 거부했어요. '+d.validationError:d.guardReason?'제어 연결 정상 · 불확실한 명령을 확인 질문으로 처리했어요':'제어 연결 정상 · 모델이 실행할 명령을 제안하지 않았어요. 위의 이해한 요청과 답변을 확인하세요.';el.append(note);}if(d.results.length){const tools=document.createElement('div');tools.className='tool-result';tools.textContent='차량 시뮬레이터에 반영됨 · '+d.actions.map(a=>a.type).join(', ');el.append(tools);}
          renderState(d.state);syncRadioState(d.state,d.actions);$('state-change').textContent=d.results.length?d.results.join(' '):'차량 설정 변경 없음';metric('llm-ms',d.llmMs);
          lastTurnId=d.turnId;$('feedback').hidden=false;document.querySelectorAll('[data-rating]').forEach(b=>b.classList.remove('selected'));
          if(d.modelLoadMs>1000)toast(`${isExtraAudio()?'음성':'판단'} 모델 전환·로딩에 ${(d.modelLoadMs/1000).toFixed(1)}초 걸렸어요. 다음 요청부터는 로딩 시간을 제외하고 비교할 수 있어요.`);
          $('conversation').scrollTop=$('conversation').scrollHeight;
        }else if(event==='s2sText'){
          spokenBubble??=bubble('','assistant');spokenText+=d.text;spokenBubble.lastChild.textContent=spokenText;$('conversation').scrollTop=$('conversation').scrollHeight;lastTurnId=d.turnId;$('feedback').hidden=false;
        }else if(event==='audio'){
          metric('tts-ms',d.ttsMs);playAudio(d.audio,number);
        }else if(event==='done'){
          generationDone=true;
        }else if(event==='error'){
          if(d.state)renderState(d.state);throw new Error((d.failureStage?({'recognition':'음성 인식','model-planning':'모델 판단·GPU 연결','plan-format':'명령 형식','vehicle-validation':'차량 명령 검증','speech-output':'음성 출력'}[d.failureStage]||d.failureStage)+' 단계: ':'')+d.error);
        }
      }
    }
    if(number===requestNumber&&!currentAudio){busy=false;idleStatus();}
  }catch(e){if(e.name!=='AbortError'&&number===requestNumber){stopPlayback();bubble(e.message,'error');busy=false;stage='idle';idleStatus();}}
}
function wavFromFrames(chunks,rate){
  const n=chunks.reduce((n,c)=>n+c.length,0),input=new Float32Array(n);let pos=0;for(const c of chunks){input.set(c,pos);pos+=c.length;}
  const targetRate=16000,count=Math.floor(n*targetRate/rate),buffer=new ArrayBuffer(44+count*2),v=new DataView(buffer);
  const str=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+count*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,targetRate,true);v.setUint32(28,targetRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,count*2,true);
  for(let i=0;i<count;i++){const start=Math.floor(i*rate/targetRate),end=Math.min(n,Math.max(start+1,Math.floor((i+1)*rate/targetRate)));let s=0;for(let j=start;j<end;j++)s+=input[j];s=Math.max(-1,Math.min(1,s/(end-start)));v.setInt16(44+i*2,s<0?s*32768:s*32767,true);}
  return new Uint8Array(buffer);
}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
function onPCM(chunk){
  if(!micEnabled)return;
  let sum=0;for(const x of chunk)sum+=x*x;const rms=Math.sqrt(sum/chunk.length),duration=chunk.length/audioContext.sampleRate*1000;
  $('level-bar').style.width=Math.min(100,rms*1800)+'%';
  if(engine==='sonic'){sonicVoice?.mic(chunk,audioContext.sampleRate);return;}
  if(busy&&!bargeInEnabled){speech=false;frames=[];preRoll=[];voiceMs=0;silenceMs=0;return;}
  const threshold=Math.max(.012,Math.min(.06,noiseFloor*3.2));
  const voiced=rms>threshold;
  if(!speech){
    preRoll.push(chunk);while(preRoll.length>5)preRoll.shift();
    if(!voiced){noiseFloor=noiseFloor*.98+rms*.02;voiceMs=0;return;}
    voiceMs+=duration;
    if(voiceMs<120)return;
    speech=true;frames=[...preRoll];preRoll=[];silenceMs=0;lastVoiceAt=performance.now();
    if(busy){interrupt(false);setStatus('새로운 말씀을 듣고 있어요…','listening');}else setStatus('말씀을 듣고 있어요…','listening');
  }else{
    frames.push(chunk);
    if(voiced){silenceMs=0;voiceMs+=duration;lastVoiceAt=performance.now();}else silenceMs+=duration;
    const total=frames.length*duration;
    if(silenceMs>650||total>20000){
      const complete=frames;const endedAt=lastVoiceAt;const valid=voiceMs>=180;
      speech=false;frames=[];preRoll=[];voiceMs=0;silenceMs=0;
      if(valid)submit({audio:base64(wavFromFrames(complete,audioContext.sampleRate))},{basis:'microphone',endedAt});else idleStatus();
    }
  }
}
async function toggleMic(){
  if(micStarting)return;
  if(micEnabled){
    if(engine==='sonic'){sonicVoice?.close();sonicVoice=null;busy=false;}
    micEnabled=false;mediaStream?.getTracks().forEach(t=>t.stop());recorder?.disconnect();source?.disconnect();muteGain?.disconnect();await audioContext?.close();speech=false;frames=[];preRoll=[];voiceMs=0;silenceMs=0;$('level-bar').style.width='0';
  }else{
    micStarting=true;$('mic').disabled=true;
    try{
      audioContext=new AudioContext();const resumed=audioContext.resume();
      if(engine==='sonic'){const voice=await ensureSonic();voice.liveMic=true;voice.basis='microphone';voice.send({type:'mode',mode:'microphone'});}
      setStatus('브라우저의 마이크 권한을 확인해 주세요.');
      let timedOut=false,timer;
      const requested=navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}}).then(stream=>{if(timedOut)stream.getTracks().forEach(t=>t.stop());return stream;});
      try{mediaStream=await Promise.race([requested,new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('마이크 연결을 기다리는 시간이 길어요. 브라우저와 macOS의 마이크 권한을 확인하거나 음성 파일로 테스트해 주세요.'));},20000);})]);}finally{clearTimeout(timer);}
      setStatus('오디오 장치를 시작하고 있어요…');
      await resumed;
      setStatus('마이크 입력을 준비하고 있어요…');
      await audioContext.audioWorklet.addModule('/pcm-worklet.js');
      source=audioContext.createMediaStreamSource(mediaStream);recorder=new AudioWorkletNode(audioContext,'pcm-recorder');muteGain=audioContext.createGain();muteGain.gain.value=0;
      source.connect(recorder).connect(muteGain).connect(audioContext.destination);recorder.port.onmessage=e=>onPCM(e.data);micEnabled=true;noiseFloor=.004;
    }catch(e){mediaStream?.getTracks().forEach(t=>t.stop());audioContext?.close().catch(()=>{});sonicVoice?.close();sonicVoice=null;toast('마이크를 켤 수 없어요. '+e.message);idleStatus();return;}
    finally{micStarting=false;$('mic').disabled=!ready;}
  }
  $('mic').classList.toggle('recording',micEnabled);$('mic').setAttribute('aria-pressed',String(micEnabled));$('mic').querySelector('span').textContent=micEnabled?'마이크 끄기':'마이크 시작';if(!busy)idleStatus();
}
function resetSonicMetrics(){for(const id of ['asr-ms','llm-ms','tts-ms','first-audio-ms'])metric(id,null);$('metric-context').textContent=(engine==='minicpm'?'MiniCPM':'Sonic')+' 통합 S2S · 단계별 시간 분리 불가';}
async function ensureSonic(){
  if(sonicVoice&&!sonicVoice.closed)return sonicVoice;
  if(sonicConnecting)return sonicConnecting;
  setStatus('Nova 2.5 Sonic에 연결하고 있어요…','busy');
  const voice=new window.SonicVoice({sessionId,language:$('sonic-language').value,patienceMs:Number($('sonic-patience').value),onEvent:(event,data)=>{
    if(voice!==sonicVoice)return;
    if(event==='ready')setStatus('Sonic 연결됨 · 말씀하거나 샘플을 눌러 주세요','listening');
    if(event==='turn'){lastTurnId=data.turnId;$('feedback').hidden=false;}
    if(event==='caption'){
      let item=sonicBubbles.get(data.id);
      if(!data.text){item?.el.remove();sonicBubbles.delete(data.id);}
      else{
        if(!item){item={el:bubble('','assistant')};sonicBubbles.set(data.id,item);}
        item.preview=!data.final;item.el.lastChild.textContent=data.text;item.el.querySelector('.label').textContent=data.final?'온':'온 · 응답 미리보기';
        $('conversation').scrollTop=$('conversation').scrollHeight;
      }
    }
    if(event==='text'&&data.role==='USER'){
      const key=data.id;let item=sonicBubbles.get(key);
      if(!item){item={el:bubble('',data.role==='USER'?'user':'assistant'),text:''};sonicBubbles.set(key,item);}item.text+=data.text;item.el.lastChild.textContent=item.text;$('conversation').scrollTop=$('conversation').scrollHeight;
      if(data.role==='USER'){busy=true;resetSonicMetrics();setStatus('Sonic이 요청을 처리하고 있어요…','busy');}
    }
    if(event==='tool'){if(data.operation)renderAssistantResult(data);if(data.state){renderState(data.state);syncRadioState(data.state,data.actions);}$('state-change').textContent=data.operation?`${data.operation} · ${data.elapsedMs??'—'} ms`:data.ok?(data.results?.join(' ')||'차량 상태 조회'):data.error;}
    if(event==='playbackWait'){busy=true;setStatus('말씀을 더 기다리고 있어요…','listening');}
    if(event==='audio'){duckRadio(true);busy=true;setStatus('Sonic이 말하고 있어요…','busy');}
    if(event==='firstPlayback'){metric('first-audio-ms',data.ms);$('metric-context').textContent=data.basis==='text'?'Sonic · 텍스트 제출 → 재생 예약':data.basis==='file'?'Sonic · 입력 음성 종료 → 재생 예약':'Sonic · 마지막 발화 추정 → 재생 예약';}
    if(event==='playbackEnd'){duckRadio(false);busy=false;idleStatus();}
    if(event==='error'){clearSonicPreviews();busy=false;bubble(data.error,'error');idleStatus();}
    if(event==='closed'){clearSonicPreviews();busy=false;if(micEnabled)void toggleMic();idleStatus();}
  }});
  sonicVoice=voice;sonicConnecting=voice.connect();
  try{return await sonicConnecting;}finally{sonicConnecting=null;}
}
$('conversation-engine').addEventListener('change',async e=>{
  if(micEnabled)await toggleMic();await interrupt(false);engine=e.target.value;
  $('barge-in-option').hidden=engine==='sonic';$('sonic-options').hidden=engine!=='sonic';$('sonic-english').hidden=engine!=='sonic';$('tts-provider').parentElement.hidden=engine==='sonic';
  $('minicpm-options').hidden=engine!=='minicpm';$('minicpm-control-notice').hidden=engine!=='minicpm-control';$('planner-row').hidden=engine!=='cascade';$('asr-row').hidden=engine!=='cascade';$('planner-notice').hidden=engine!=='cascade'||!['hyperclova-05b','exaone4-12b','smollm3'].includes(plannerChoice);$('audio-model-row').hidden=!isExtraAudio();$('audio-language').parentElement.hidden=engine==='audio-control';$('tts-provider').parentElement.hidden=!['cascade','minicpm-control','audio-control'].includes(engine);$('sonic-english').hidden=engine==='cascade';
  document.querySelectorAll('[data-prompt]').forEach(button=>button.hidden=isAudioInput());
  $('pipeline-description').textContent=isExtraAudio()?(engine==='audio-control'?'음성 직접 판단 → 차량 실행 → 한국어 TTS · 하이브리드 실험':'모델 내장 S2S · 발화 단위 입력 · 차량 제어 미연결'):engine==='sonic'?'실시간 음성 스트림 · Sonic 내장 턴 감지 · 한국어 미지원 실험 · 실제 차량 연결 없음':engine==='minicpm-control'?'MiniCPM 음성 판단 → 차량 실행 → 한국어 TTS · 하이브리드 실험':engine==='minicpm'?'MiniCPM 자체 S2S · 발화 단위 입력 · 출력 스트리밍 · 차량 제어 미연결':'발화 단위 인식 · 문장 단위 음성 응답 · 실제 차량 연결 없음';
  resetSonicMetrics();if(isExtraAudio())$('metric-context').textContent=engine==='audio-control'?'음성 모델 직접 판단 → 차량 검증·실행 → 한국어 TTS':'모델 내장 S2S · 단계별 시간 분리 불가';if(engine==='minicpm')$('metric-context').textContent='MiniCPM 내장 S2S · 단계별 시간 분리 불가';if(engine==='minicpm-control')$('metric-context').textContent='MiniCPM 음성 이해·판단 → 차량 검증·실행 → 한국어 TTS';if(engine==='cascade')$('metric-context').textContent='측정 대기';await checkHealth();
});
$('comparison-only').addEventListener('change',async e=>{for(const id of ['minicpm','audio-native'])$('conversation-engine').querySelector(`[value="${id}"]`).hidden=!e.target.checked;for(const id of ['minicpm','audio-native'])$('conversation-engine').querySelector(`[value="${id}"]`).disabled=!e.target.checked;if(!e.target.checked&&['audio-native','minicpm'].includes(engine)){$('conversation-engine').value=engine==='minicpm'?'minicpm-control':'audio-control';$('conversation-engine').dispatchEvent(new Event('change'));}});
$('audio-model').addEventListener('change',async()=>{if(micEnabled)await toggleMic();await interrupt(false);await checkHealth();});
$('asr-model').addEventListener('change',async e=>{if(micEnabled)await toggleMic();await interrupt(false);asrChoice=e.target.value;await checkHealth();});
$('planner-model').addEventListener('change',async e=>{if(micEnabled)await toggleMic();await interrupt(false);plannerChoice=e.target.value;await checkHealth();});
$('sonic-patience').addEventListener('change',e=>{if(sonicVoice){sonicVoice.patienceMs=Number(e.target.value);sonicVoice.flushAudio();}});
$('sonic-language').addEventListener('change',async()=>{if(micEnabled)await toggleMic();await interrupt(false);idleStatus();});
$('sonic-english').addEventListener('click',async()=>{
  try{const response=await fetch(engine==='minicpm'?'/sample-greeting.wav':'/sample-english.wav');if(!response.ok)throw new Error('영어 샘플을 불러오지 못했어요.');await submit({audio:base64(new Uint8Array(await response.arrayBuffer()))},{basis:'file'});}catch(error){toast(error.message);}
});
$('mic').addEventListener('click',toggleMic);
$('barge-in').addEventListener('change',e=>{bargeInEnabled=e.target.checked;});
$('interrupt').addEventListener('click',()=>interrupt());
$('text-form').addEventListener('submit',e=>{e.preventDefault();const text=$('text-input').value.trim();if(!text)return;$('text-input').value='';submit({text});});
document.querySelectorAll('[data-prompt]').forEach(button=>button.addEventListener('click',()=>submit({text:button.dataset.prompt})));
$('tts-provider').addEventListener('change',e=>{
  if(busy){e.target.value=ttsChoice;toast('답변이 끝나면 응답 음성을 변경할 수 있어요.');return;}
  ttsChoice=e.target.value;
  $('model-tts').replaceChildren(document.createElement('i'),document.createTextNode(ttsChoice==='polly'?pollyLabel():'Qwen3-TTS · Sohee'));
});
$('sample-audio').addEventListener('click',async()=>{
  try{const r=await fetch(replyLanguage()==='en'?'/sample-english.wav':'/sample-command.wav');if(!r.ok)throw new Error('샘플 음성을 불러오지 못했어요.');await submit({audio:base64(new Uint8Array(await r.arrayBuffer()))},{basis:'file'});}catch(e){toast(e.message);}
});
document.querySelectorAll('[data-rating]').forEach(button=>button.addEventListener('click',async()=>{
  if(!lastTurnId)return;
  try{const r=await api('feedback',{method:'POST',body:JSON.stringify({turnId:lastTurnId,rating:button.dataset.rating})});if(!r.ok)throw new Error((await r.json()).error);document.querySelectorAll('[data-rating]').forEach(b=>b.classList.toggle('selected',b===button));$('feedback-status').textContent='이 대화의 피드백을 서버에 저장했어요.';}catch(e){toast(e.message);}
}));
$('reset').addEventListener('click',async()=>{await interrupt(false);stopRadio();renderAssistantResult({operation:'reset',effect:{type:'timers',timers:[]}});$('assistant-result').hidden=true;const r=await api('reset',{method:'POST',body:'{}'});const d=await r.json();renderState(d.state);$('state-change').textContent='차량 상태와 대화 기록을 초기화했어요.';$('conversation').replaceChildren();$('feedback').hidden=true;lastTurnId=null;idleStatus();});
$('export').addEventListener('click',async()=>{try{const r=await api('export');const blob=await r.blob();const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='vehicle-voice-session.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){toast(e.message);}});
$('audio-file').addEventListener('change',async e=>{
  const f=e.target.files[0];if(!f)return;
  try{
    if(f.size>10*1024*1024)throw new Error('10MB 이하, 30초 이하의 음성을 선택해 주세요.');
    const ctx=new AudioContext(),decoded=await ctx.decodeAudioData(await f.arrayBuffer());await ctx.close();if(decoded.duration>30)throw new Error('30초 이하 음성을 선택해 주세요.');
    const mono=new Float32Array(decoded.length);for(let c=0;c<decoded.numberOfChannels;c++){const a=decoded.getChannelData(c);for(let i=0;i<a.length;i++)mono[i]+=a[i]/decoded.numberOfChannels;}
    submit({audio:base64(wavFromFrames([mono],decoded.sampleRate))},{basis:'file'});
  }catch(err){toast(err.message);}finally{e.target.value='';}
});
document.addEventListener('vehicle-assistant-prompt',e=>{void submit({text:e.detail.text});});
document.addEventListener('vehicle-timer-expired',()=>{bubble(replyLanguage()==='en'?'Your timer has finished.':'설정한 타이머가 끝났어요.','assistant');});
document.addEventListener('vehicle-radio-state',()=>{if(cabinState)renderState(cabinState);});
let languageSwitch=Promise.resolve();
document.addEventListener('vehicle-ui-language',()=>{
  languageSwitch=languageSwitch.then(async()=>{
    const resumeMic=micEnabled;
    if(micEnabled)await toggleMic();
    if(sessionId)await interrupt(false);
    syncConversationLanguage();
    await checkHealth();
    if(resumeMic&&ready)await toggleMic();
  }).catch(error=>toast(error.message));
});
syncConversationLanguage();
window.addEventListener('beforeunload',()=>{mediaStream?.getTracks().forEach(t=>t.stop());sonicVoice?.close();stopPlayback();});
try{const d=await(await api('session',{method:'POST',body:'{}'})).json();sessionId=d.id;configureAssistant(api);renderState(d.state);await checkHealth();setInterval(checkHealth,10000);}catch(e){toast('서버에 연결할 수 없어요. '+e.message);}
