import {createScene} from './scene.js';
const $=id=>document.getElementById(id),names={coffee:'☕ 커피',banana:'바나나',stamp:'결재 도장',document:'기밀 문서'},targetNames={microwave:'전자레인지',coffee:'뜨거운 커피',banana:'바나나',sign:'안내문',table:'탕비실 테이블',pantryDoor:'탕비실 출입문',hall:'복도',locker:'청소도구함',robot:'박주임',office:'자료실',desk:'팀장 책상',stamp:'결재 도장',document:'기밀 문서',clock:'출근 단말기',exit:'퇴근 게이트'};
let voiceOptions=[],chosenVoice='seoyeon',voiceChanging=false,voiceReady,previewUrl,previewController;
let completedTurn=null,audioTurn=null;let modelOptions=[],modelChecks=new Map(),chosenModel=null,session=null,state=null,seen=0,selected='',currentCamera='pantry',serverCamera='pantry',busy=false,muted=false,scene,currentAudio,voiceQueue=[],voiceBusy=false,voiceGeneration=0,controller,turnVersion=0,polling=false,recording=false,micStarting=false,media,context,source,worklet,gain,chunks=[],recordTimer;
const api=async(path,options={})=>{const r=await fetch('/api/game/'+path,{...options,headers:{'Content-Type':'application/json','X-Game-Session':session||'',...options.headers}});if(!r.ok){let data;try{data=await r.json();}catch{}throw Object.assign(Error(data?.error||'서버에 연결하지 못했어요.'),{status:r.status});}return r;};
function status(t){$('status').textContent=t;}
function error(t){status(t);$('subtitle').textContent=t;}
function line(text,kind){const e=document.createElement('div');e.className='line '+(kind==='user'?'user':'');const label=document.createElement('span');label.textContent=kind==='user'?'YOU / CONTROL':kind==='robot'?'PARK / SECURITY':kind==='system'?'HAPPINESS LAB':'JIU / CHANNEL 07';e.append(label,document.createTextNode(text));$('dialogue').append(e);while($('dialogue').children.length>3)$('dialogue').firstChild.remove();}
function chooseCamera(id){currentCamera=id;scene?.camera(id);document.querySelectorAll('[data-camera]').forEach(b=>b.classList.toggle('active',b.dataset.camera===id));$('camera-name').textContent={pantry:'CAM 01 · 탕비실',hall:'CAM 02 · 복도',office:'CAM 03 · 자료실',overview:'CAM 00 · 전체 배치'}[id];}
function stopVoice(){
 voiceGeneration++;voiceQueue=[];previewController?.abort();previewController=null;currentAudio?.pause();currentAudio=null;voiceBusy=false;scene?.talking(false);
 for(const id of ['voice-preview-player','welcome-voice-preview-player']){const player=$(id);player.pause();player.removeAttribute('src');player.hidden=true;}
 if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
 for(const id of ['preview-voice','welcome-preview-voice'])$(id).disabled=!voiceOptions.length;
 voiceStatus('같은 대사를 들어보고 골라보세요.');
}
async function playNext(){
 if(voiceBusy||muted||!voiceQueue.length)return;voiceBusy=true;const event=voiceQueue.shift(),generation=voiceGeneration;let url;
 try{const r=await api('voice/'+event.id),blob=await r.blob();if(generation!==voiceGeneration)return;url=URL.createObjectURL(blob);const audio=new Audio(url);currentAudio=audio;scene?.talking(['jiu','intent'].includes(event.kind));await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=()=>reject(Error('음성 재생 실패'));audio.onpause=resolve;audio.play().catch(reject);});}
 catch(e){if(generation===voiceGeneration)status('대사는 화면에서 확인할 수 있어요 · '+e.message);}
 finally{if(url)URL.revokeObjectURL(url);if(generation===voiceGeneration){voiceBusy=false;currentAudio=null;scene?.talking(false);playNext();}}
}
function render(d){
 state=d.state;scene?.update(state);if(d.voiceId&&!voiceChanging){chosenVoice=d.voiceId;syncVoicePickers();}if(d.planning&&!busy)status('지우가 생각 중이에요. 처음에는 모델을 불러오느라 조금 걸릴 수 있어요.');if(d.turnStatus&&d.turnStatus.status!=='processing'&&completedTurn!==d.turnStatus.id){completedTurn=d.turnStatus.id;const t=d.turnStatus;if(audioTurn===t.id&&t.heard){line(t.heard,'user');audioTurn=null;}if(t.error)error(t.error);else{if(t.heard){$('heard-command').textContent='들은 말: '+t.heard;$('planned-command').textContent='도구 호출: '+(t.actions?.length?t.actions.map(actionLabel).join(' → '):'대화');$('metrics').textContent=`${t.heard} · 판단 ${t.metrics?.llmMs??0}ms · 모델 로딩 ${t.metrics?.modelLoadMs??0}ms`;}status(state.pendingActions?'지우가 행동 중이에요.':'지우가 대답했어요. 이어서 말해보세요.');}}if(d.model){chosenModel=d.model;syncModelPickers();}renderGuidance();if(d.toolTrace?.length)$('planned-command').textContent='도구 호출: '+d.toolTrace.map(t=>t.actions.map(actionLabel).join(' → ')).filter(Boolean).join(' → ');if(state.camera!==serverCamera){serverCamera=state.camera;chooseCamera(state.camera);}
 $('objective').textContent=state.objective;$('clock').textContent=new Date(2000,0,1,18,0,state.elapsedSeconds).toTimeString().slice(0,8);
 $('movement').textContent=state.won?'지우 / 퇴근!':state.hidden?'지우 / 숨는 중':state.moving?'지우 / 이동 중':'지우 / 대기 중';
 $('inventory-count').textContent=state.inventory.length+' / 4';$('inventory').replaceChildren();if(!state.inventory.length){const e=document.createElement('span');e.className='empty';e.textContent='아직 챙긴 물건이 없어요.';$('inventory').append(e);}for(const item of state.inventory){const e=document.createElement('span');e.className='item';e.textContent=names[item];$('inventory').append(e);}
 $('education').hidden=!state.educationSeconds;$('education').textContent=`보안교육 끝날 때까지 ${state.educationSeconds}초`;
 const fresh=state.events.filter(e=>e.id>seen);for(const e of fresh){seen=e.id;if(e.kind==='tool'||e.kind==='intent')continue;line(e.text,e.kind);$('subtitle').textContent=e.text;if(!muted&&e.kind!=='system'){voiceQueue.push(e);voiceQueue=voiceQueue.slice(-3);}}
 if(fresh.length)playNext();if(d.dialogueError)status(d.dialogueError);else if(d.responding&&!busy)status('지우가 해보고 대답하는 중…');else if(!d.planning&&!busy&&!state.pendingActions&&$('status').textContent.startsWith('지우가 해보고'))status('지우가 듣고 있어요 · 다음 말을 건네보세요.');
 const facts=d.memory.facts,visits=d.memory.visits;
 $('memory').textContent=facts.includes('banana')?'바나나로 문 열려던 사건을 기억하고 있어요.':facts.includes('promise')?'“내가 책임질게.” 그 약속, 기억하고 있어요.':facts.includes('escaped')?'지난번 함께 퇴근한 일을 기억하고 있어요.':visits>1?`${visits}번째 근무. 이번에는 꼭 퇴근합시다.`:'첫 만남이에요. 아직은 서로 믿고 있어요.';
 $('memory-provider').textContent=d.memory.provider==='agentcore'?'AGENTCORE MEMORY · 연결됨':d.memory.provider==='degraded'?'기억은 로컬 보존 중 · 클라우드 연결 재시도':d.memory.provider==='connecting'?'AGENTCORE MEMORY · 연결 중':'이 서버에 플레이 기억 보존';
 if(state.won){$('ending').hidden=false;$('ending-text').textContent=`${state.ending} · 소요 ${Math.floor(state.elapsedSeconds/60)}분 ${state.elapsedSeconds%60}초 · 보안교육 ${state.caught}회. 지우는 이번 근무를 기억합니다.`;}
 const tips=!state.doorOpen?['주변에 뭐가 있어?','할 수 있는 행동 알려줘','문 근처에 뭐가 있지?','뒤로 두 발자국']:['다른 공간도 살펴볼까?','들고 있는 물건 알려줘','이걸 어디에 써볼까?','뭘 할 수 있어?'];
 if($('suggestions').dataset.key!==tips.join('|')){$('suggestions').dataset.key=tips.join('|');$('suggestions').replaceChildren(...tips.map(t=>{const b=document.createElement('button');b.textContent=t;b.onclick=()=>submit({text:t,guidance:t!=='뒤로 두 발자국'});return b;}));}
}
async function begin(){
 turnVersion++;controller?.abort();stopVoice();if(recording)await endRecording(false);status('지우와 무전 연결 중…');$('start').disabled=true;
 try{await voiceReady;const d=await(await api('session',{method:'POST',body:JSON.stringify({modelId:chosenModel,voiceId:chosenVoice})})).json();session=d.id;seen=0;serverCamera='pantry';$('dialogue').replaceChildren();$('ending').hidden=true;render(d);chooseCamera('pantry');$('welcome').close();$('connection').textContent='● 무전 연결됨';$('connection').classList.add('ready');status('지우가 듣고 있어요. 마이크나 입력창으로 말해보세요.');busy=false;}
 catch(e){error(e.message);}finally{$('start').disabled=false;}
}
async function submit(payload){
 if(!session){$('welcome').showModal();return;}if(state?.won){status('퇴근 성공! 다음 근무를 시작해보세요.');return;}
 const version=++turnVersion;controller?.abort();controller=new AbortController();const signal=controller.signal;stopVoice();busy=true;$('wave').classList.add('active');status(payload.audio?'무전을 듣고 있어요…':'지우가 듣고 생각하는 중…');
 if(payload.text)line(payload.text,'user');
 try{const d=await(await api('turn',{method:'POST',body:JSON.stringify({...payload,guidance:payload.guidance??$('advice-only').checked,selected,async:true}),signal})).json();if(version!==turnVersion)return;if(d.accepted){if(payload.audio)audioTurn=d.accepted;render(d);status('지우가 생각 중이에요. 다른 말을 하면 이전 부탁은 취소돼요.');return;}if(payload.audio)line(d.heard,'user');render(d);$('heard-command').textContent='들은 말: '+d.heard;$('planned-command').textContent='하려는 일: '+(d.actions?.length?d.actions.map(a=>actionLabel(a)).join(' → '):'지우의 대답 · 행동 변경 없음');status(d.state.pendingActions?'지우가 행동 중이에요 · 새 지시로 바꿀 수 있어요.':'지우가 대답했어요. 이어서 말해보세요.');$('metrics').textContent=`${d.heard} · 판단 ${d.metrics?.llmMs??0}ms · 전체 ${d.metrics?.totalMs??0}ms`;}
 catch(e){if(e.name!=='AbortError'&&version===turnVersion)error(e.message);}finally{if(version===turnVersion){busy=false;$('wave').classList.remove('active');}}
}
async function halt(){turnVersion++;controller?.abort();stopVoice();if(recording)await endRecording(false);if(!session)return;try{render(await(await api('stop',{method:'POST',body:'{}'})).json());status('멈췄어요 · 다음 지시를 말해 주세요.');}catch(e){error(e.message);}busy=false;$('wave').classList.remove('active');}
function wav(chunks,rate){const n=chunks.reduce((x,y)=>x+y.length,0),input=new Float32Array(n);let p=0;for(const a of chunks){input.set(a,p);p+=a.length;}const count=Math.floor(n*16000/rate),b=new ArrayBuffer(44+count*2),v=new DataView(b);const str=(i,s)=>{for(let j=0;j<s.length;j++)v.setUint8(i+j,s.charCodeAt(j));};str(0,'RIFF');v.setUint32(4,36+count*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,count*2,true);for(let i=0;i<count;i++){const a=Math.floor(i*rate/16000),end=Math.min(n,Math.max(a+1,Math.floor((i+1)*rate/16000)));let s=0;for(let j=a;j<end;j++)s+=input[j];s=Math.max(-1,Math.min(1,s/(end-a)));v.setInt16(44+i*2,s<0?s*32768:s*32767,true);}return new Uint8Array(b);}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
async function startRecording(){
 if(recording||micStarting)return;if(!session){$('welcome').showModal();return;}micStarting=true;stopVoice();
 try{if(!navigator.mediaDevices?.getUserMedia)throw Error('HTTPS 또는 localhost에서 마이크를 사용할 수 있어요.');
  media=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});context=new AudioContext();await context.resume();await context.audioWorklet.addModule('/pcm-worklet.js');source=context.createMediaStreamSource(media);worklet=new AudioWorkletNode(context,'pcm-recorder');gain=context.createGain();gain.gain.value=0;source.connect(worklet).connect(gain).connect(context.destination);chunks=[];recording=true;worklet.port.onmessage=e=>{if(recording)chunks.push(new Float32Array(e.data));};
  $('mic').classList.add('recording');$('mic').setAttribute('aria-pressed','true');$('mic').setAttribute('aria-label','무전 녹음 종료 및 전송');$('mic-label').textContent='다시 눌러 보내기';$('wave').classList.add('active');status('무전 녹음 중 · 다시 누르면 지우에게 보냅니다.');recordTimer=setTimeout(()=>endRecording(),25000);
 }catch(e){media?.getTracks().forEach(t=>t.stop());await context?.close().catch(()=>{});error('마이크를 켤 수 없어요. '+e.message);}finally{micStarting=false;}
}
async function endRecording(send=true){
 if(!recording)return;recording=false;clearTimeout(recordTimer);const data=chunks,rate=context.sampleRate;chunks=[];worklet?.disconnect();source?.disconnect();gain?.disconnect();media?.getTracks().forEach(t=>t.stop());await context?.close();$('mic').classList.remove('recording');$('mic').setAttribute('aria-pressed','false');$('mic').setAttribute('aria-label','무전 녹음 시작');$('mic-label').textContent='눌러서 말하기';$('wave').classList.remove('active');
 if(send&&data.reduce((n,a)=>n+a.length,0)>rate*.18)submit({audio:base64(wav(data,rate))});else status('무전 대기 중 · 다시 말해 주세요.');
}
try{scene=createScene($('world'),$('portrait'),id=>{selected=id;$('object-select').value=id;renderObjectActions();$('selected').textContent='선택: '+(targetNames[id]||id);status((targetNames[id]||id)+' 선택됨 · “저거 조사해봐”라고 말해보세요.');});}catch(e){$('scene-error').hidden=false;$('scene-error').textContent='3D 화면을 시작하지 못했습니다. WebGL을 지원하는 브라우저에서 다시 열어주세요. '+e.message;}
$('command-form').onsubmit=e=>{e.preventDefault();const text=$('command').value.trim();if(text){$('command').value='';submit({text});}};
$('mic').onclick=()=>recording?endRecording():startRecording();$('stop').onclick=halt;$('start').onclick=begin;$('restart').onclick=begin;$('again').onclick=begin;
$('sound').onclick=()=>{muted=!muted;$('sound').textContent=muted?'음성 꺼짐':'음성 켜짐';$('sound').setAttribute('aria-pressed',String(!muted));if(muted)stopVoice();};
$('help').onclick=async()=>{try{const data=await(await api('capabilities')).json();renderCapabilities(data);}catch{}$('help-dialog').showModal();$('help-heading').focus({preventScroll:true});$('help-dialog').scrollTop=0;};$('close-help').onclick=()=>$('help-dialog').close();$('hint-button').onclick=()=>submit({text:'지금 좀 막혔어. 정답은 말하지 말고, 주변에 있는 걸로 뭘 해보면 좋을지 같이 생각해줘.',guidance:true});$('ask-capabilities').onclick=()=>{$('help-dialog').close();submit({text:'지우야, 지금 뭘 해볼 수 있어? 정답은 말하지 말고 두세 가지만 알려줘.',guidance:true});};
$('welcome').addEventListener('click',e=>{if(e.target===$('welcome')&&session)$('welcome').close();});
for(const b of document.querySelectorAll('[data-camera]'))b.onclick=()=>chooseCamera(b.dataset.camera);
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat&&!['INPUT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName)&&!$('welcome').open){e.preventDefault();recording?endRecording():startRecording();}if(e.code==='Escape')halt();});
setInterval(async()=>{if(!session||polling)return;polling=true;try{render(await(await api('state')).json());}catch(e){if(e.status===401){session=null;$('connection').textContent='● 재연결 필요';$('welcome').showModal();}if(!busy)status(e.message);}finally{polling=false;}},350);
loadModels();voiceReady=loadVoices();
window.channel07={getState:()=>state,sceneInfo:()=>scene?.info()};
$('welcome').showModal();$('welcome-heading').focus({preventScroll:true});$('welcome').scrollTop=0;

function actionLabel(a){const target=targetNames[a.target]||({forward:'앞으로',backward:'뒤로',left:'왼쪽',right:'오른쪽'}[a.target])||'현재 위치';return a.type==='step'?`${target} ${a.steps}발자국`:a.type==='put'?`${names[a.item]} → ${target}`:`${target} · ${{take:'집기',move:'이동',inspect:'조사',open:'열기/누르기',close:'닫기',activate:'작동',turn:'돌기',hide:'숨기',distract:'주의 돌리기',use:'사용',stop:'멈추기',wait:'기다리기',camera:'카메라',help:'가능한 행동 조회'}[a.type]||a.type}`;}
function renderGuidance(){
 $('guide-goal').textContent=state.guide?.goal||state.objective;$('guide-hint').textContent=state.guide?.hint||'';
 const message=state.lastResult?.text||(state.pendingActions?'지우가 움직이고 있어요.':'물건을 선택하거나 지우에게 말을 걸어보세요.');$('last-result').textContent=(state.lastResult?.kind==='dialogue'?'지우의 대답: ':state.lastResult?.ok===false?'하지 못했어요: ':state.pendingActions?'진행 중 · ':'')+message;$('last-result').classList.toggle('blocked',state.lastResult?.ok===false);$('executed-command').textContent='결과: '+message;
 const list=state.interactables||[],key=list.map(o=>o.id+o.room+o.held).join('|');
 if($('object-select').dataset.key!==key){$('object-select').dataset.key=key;$('object-select').replaceChildren(Object.assign(document.createElement('option'),{value:'',textContent:'물건을 선택하면 가능한 행동이 보여요'}),...list.map(o=>Object.assign(document.createElement('option'),{value:o.id,textContent:`${o.name} · ${o.held?'소지 중':{pantry:'탕비실',hall:'복도',office:'자료실'}[o.room]}`})));$('object-select').value=selected;}
 renderObjectActions();const attempts=state.experiments||[];$('experiment-log').replaceChildren(...(attempts.length?attempts.slice(-3).map(a=>{const row=document.createElement('p');row.textContent=`${names[a.item]||a.item} → ${targetNames[a.target]||a.target} · ${a.ok?'써봤어요':'통하지 않았어요'} · ${a.result.slice(0,64)}`;return row;}):[document.createTextNode('아직 물건을 써보진 않았어요.')]));
}
function renderObjectActions(){
 const item=state?.interactables?.find(o=>o.id===selected),actions=item?.actions||[],key=JSON.stringify(actions);if($('object-actions').dataset.key===key)return;$('object-actions').dataset.key=key;
 $('object-actions').replaceChildren(...actions.map(a=>{const b=document.createElement('button');b.textContent=a.label;b.title='이렇게 말해도 돼요: '+a.text;b.onclick=()=>submit({text:a.text});return b;}));
}
$('object-select').onchange=()=>{selected=$('object-select').value;renderObjectActions();};
function syncModelPickers(){
 for(const id of ['game-model','welcome-model'])$(id).value=chosenModel;
 const model=modelOptions.find(m=>m.id===chosenModel),check=modelChecks.get(chosenModel);
 if(!model)return;
 const detail=[model.score!=null?`차량 테스트 ${model.score}점`:'차량 테스트 점수 없음',check?`게임 명령 ${check.passed}/${check.total}개 통과`:'게임 명령 테스트 전',check?.recommended?'✓ 먼저 써볼 만한 모델':'비교해 보는 중'].join(' · ');
 const languageNote=chosenModel==='sonic'?'짧은 대화 비교에서는 한국어 안내가 가장 자연스러웠어요.':chosenModel==='qwen35-4b'||chosenModel==='qwen35-4b-nf4'?'명령 수행은 확인했지만, 대사가 어색할 때가 있어요.':'대화가 자연스러운지는 직접 비교해 보세요.';
 $('model-detail').textContent=detail+'. '+languageNote;
 $('welcome-model-detail').textContent=detail+'. '+languageNote+' 목소리는 아래에서 따로 고를 수 있어요.';
}
async function loadModels(){
 try{
  const data=await(await fetch('/api/game/models')).json();let evaluation={models:[]};
  try{evaluation=await(await fetch('/channel07/model-evaluation.json')).json();}catch{}
  modelOptions=data.models;modelChecks=new Map(evaluation.models.map(m=>[m.modelId,m]));
  let saved;try{saved=localStorage.getItem('channel07-model');}catch{}
  chosenModel=data.models.some(m=>m.id===saved&&m.ready)?saved:data.defaultModel;
  for(const id of ['game-model','welcome-model']){
   $(id).replaceChildren(...data.models.map(m=>Object.assign(document.createElement('option'),{
    value:m.id,textContent:(modelChecks.get(m.id)?.recommended?'✓ ':'')+m.name+(m.ready?'':' (아직 연결 안 됨)'),disabled:!m.ready,
    title:m.provider+(modelChecks.get(m.id)?.note?' · '+modelChecks.get(m.id).note:'')
   })));
   $(id).disabled=false;
  }
  syncModelPickers();
 }catch{for(const id of ['model-detail','welcome-model-detail'])$(id).textContent='모델 목록을 불러오지 못했어요. 기본 모델로 시작할 수 있어요.';}
}
async function changeModel(id){
 const previous=chosenModel;for(const picker of ['game-model','welcome-model'])$(picker).disabled=true;
 try{
  if(session){turnVersion++;controller?.abort();stopVoice();busy=false;const d=await(await api('model',{method:'POST',body:JSON.stringify({modelId:id})})).json();render(d);}
  chosenModel=id;try{localStorage.setItem('channel07-model',id);}catch{}
  status('모델을 바꿨어요. 하던 게임은 그대로 이어집니다. 처음에는 모델을 불러오느라 조금 걸릴 수 있어요.');
 }catch(e){chosenModel=previous;error(e.message);}
 finally{syncModelPickers();for(const picker of ['game-model','welcome-model'])$(picker).disabled=false;}
}
for(const id of ['game-model','welcome-model'])$(id).onchange=()=>changeModel($(id).value);

function renderCapabilities(data){
 $('capability-list').replaceChildren(...data.groups.map(g=>{const section=document.createElement('section'),title=document.createElement('h2'),examples=document.createElement('p');title.textContent=g.name;examples.textContent=g.examples.map(x=>'“'+x+'”').join(' · ');section.append(title,examples);return section;}));
}

function voiceStatus(message){for(const id of ['voice-status','welcome-voice-status'])$(id).textContent=message;}
function syncVoicePickers(){
 for(const id of ['game-voice','welcome-voice'])$(id).value=chosenVoice;
 $('voice-detail').textContent=voiceOptions.find(v=>v.id===chosenVoice)?.description||'';
}
async function loadVoices(){
 try{
  const data=await(await api('voices')).json();voiceOptions=data.voices;
  let saved;try{saved=localStorage.getItem('channel07-voice');}catch{}
  chosenVoice=voiceOptions.some(v=>v.id===saved)?saved:data.defaultVoice;
  for(const id of ['game-voice','welcome-voice']){
   $(id).replaceChildren(...voiceOptions.map(v=>Object.assign(document.createElement('option'),{value:v.id,textContent:v.name,title:v.description})));$(id).disabled=false;
  }
  for(const id of ['preview-voice','welcome-preview-voice'])$(id).disabled=false;
  syncVoicePickers();
 }catch{voiceStatus('목소리 목록을 불러오지 못했어요. 기본 목소리로 시작할 수 있어요.');}
}
async function changeVoice(id){
 const previous=chosenVoice;voiceChanging=true;stopVoice();for(const picker of ['game-voice','welcome-voice'])$(picker).disabled=true;
 try{
  if(session)render(await(await api('voice',{method:'POST',body:JSON.stringify({voiceId:id})})).json());
  chosenVoice=id;try{localStorage.setItem('channel07-voice',id);}catch{}
  voiceStatus('목소리를 바꿨어요. 다음 대사부터 들을 수 있어요.');
 }catch(e){chosenVoice=previous;voiceStatus(e.message);}
 finally{voiceChanging=false;syncVoicePickers();for(const picker of ['game-voice','welcome-voice'])$(picker).disabled=false;}
}
async function previewVoice(playerId){
 stopVoice();const generation=voiceGeneration,voice=chosenVoice,player=$(playerId);previewController=new AbortController();voiceBusy=true;
 for(const id of ['preview-voice','welcome-preview-voice'])$(id).disabled=true;
 voiceStatus('미리 들을 목소리를 준비하고 있어요…');
 try{
  const r=await api('voice-preview/'+encodeURIComponent(voice),{signal:previewController.signal}),blob=await r.blob();if(generation!==voiceGeneration)return;
  previewUrl=URL.createObjectURL(blob);player.src=previewUrl;player.hidden=false;currentAudio=player;
  const finishPreview=message=>{if(generation===voiceGeneration&&currentAudio===player){player.hidden=true;voiceBusy=false;currentAudio=null;voiceStatus(message);playNext();}};
  player.onended=()=>finishPreview('다른 목소리도 들어보세요.');
  player.onpause=()=>finishPreview('미리 듣기를 멈췄어요. 다시 들으려면 버튼을 눌러주세요.');
  player.onerror=()=>finishPreview('목소리를 재생하지 못했어요. 다시 눌러주세요.');
  try{await player.play();if(generation===voiceGeneration)voiceStatus('“들려? 나 지우야. 오늘은 꼭 퇴근하자.”');}
  catch{if(generation===voiceGeneration)voiceStatus('아래 재생 버튼을 눌러 들어보세요.');}
 }catch(e){if(generation===voiceGeneration&&e.name!=='AbortError'){voiceBusy=false;voiceStatus(e.message);}}
 finally{if(generation===voiceGeneration)for(const id of ['preview-voice','welcome-preview-voice'])$(id).disabled=false;}
}
for(const id of ['game-voice','welcome-voice'])$(id).onchange=()=>changeVoice($(id).value);
$('preview-voice').onclick=()=>previewVoice('voice-preview-player');
$('welcome-preview-voice').onclick=()=>previewVoice('welcome-voice-preview-player');
