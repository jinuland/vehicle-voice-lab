import {createScene} from './scene.js';
const $=id=>document.getElementById(id),names={coffee:'☕ 커피',banana:'바나나',stamp:'결재 도장',document:'기밀 문서'},targetNames={coffee:'뜨거운 커피',banana:'바나나',sign:'안내문',table:'탕비실 테이블',pantryDoor:'탕비실 출입문',hall:'복도',locker:'청소도구함',robot:'박주임',office:'자료실',desk:'팀장 책상',stamp:'결재 도장',document:'기밀 문서',clock:'출근 단말기',exit:'퇴근 게이트'};
let session=null,state=null,seen=0,selected='',currentCamera='pantry',serverCamera='pantry',busy=false,muted=false,scene,currentAudio,voiceQueue=[],voiceBusy=false,voiceGeneration=0,controller,turnVersion=0,polling=false,recording=false,micStarting=false,media,context,source,worklet,gain,chunks=[],recordTimer;
const api=async(path,options={})=>{const r=await fetch('/api/game/'+path,{...options,headers:{'Content-Type':'application/json','X-Game-Session':session||'',...options.headers}});if(!r.ok){let data;try{data=await r.json();}catch{}throw Object.assign(Error(data?.error||'서버에 연결하지 못했어요.'),{status:r.status});}return r;};
function status(t){$('status').textContent=t;}
function error(t){status(t);$('subtitle').textContent=t;}
function line(text,kind){const e=document.createElement('div');e.className='line '+(kind==='user'?'user':'');const label=document.createElement('span');label.textContent=kind==='user'?'YOU / CONTROL':kind==='robot'?'PARK / SECURITY':kind==='system'?'HAPPINESS LAB':'JIU / CHANNEL 07';e.append(label,document.createTextNode(text));$('dialogue').append(e);while($('dialogue').children.length>3)$('dialogue').firstChild.remove();}
function chooseCamera(id){currentCamera=id;scene?.camera(id);document.querySelectorAll('[data-camera]').forEach(b=>b.classList.toggle('active',b.dataset.camera===id));$('camera-name').textContent={pantry:'CAM 01 · 탕비실',hall:'CAM 02 · 복도',office:'CAM 03 · 자료실',overview:'CAM 00 · 전체 배치'}[id];}
function stopVoice(){voiceGeneration++;voiceQueue=[];currentAudio?.pause();currentAudio=null;voiceBusy=false;scene?.talking(false);}
async function playNext(){
 if(voiceBusy||muted||!voiceQueue.length)return;voiceBusy=true;const event=voiceQueue.shift(),generation=voiceGeneration;let url;
 try{const r=await api('voice/'+event.id),blob=await r.blob();if(generation!==voiceGeneration)return;url=URL.createObjectURL(blob);const audio=new Audio(url);currentAudio=audio;scene?.talking(event.kind==='jiu');await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=()=>reject(Error('음성 재생 실패'));audio.onpause=resolve;audio.play().catch(reject);});}
 catch(e){if(generation===voiceGeneration)status('대사는 화면에서 확인할 수 있어요 · '+e.message);}
 finally{if(url)URL.revokeObjectURL(url);if(generation===voiceGeneration){voiceBusy=false;currentAudio=null;scene?.talking(false);playNext();}}
}
function render(d){
 state=d.state;scene?.update(state);if(state.camera!==serverCamera){serverCamera=state.camera;chooseCamera(state.camera);}
 $('objective').textContent=state.objective;$('clock').textContent=new Date(2000,0,1,18,0,state.elapsedSeconds).toTimeString().slice(0,8);
 $('movement').textContent=state.won?'JIU / OFF DUTY':state.hidden?'JIU / HIDING':state.moving?'JIU / MOVING':'JIU / STANDING BY';
 $('inventory-count').textContent=state.inventory.length+' / 4';$('inventory').replaceChildren();if(!state.inventory.length){const e=document.createElement('span');e.className='empty';e.textContent='아직 챙긴 물건이 없어요.';$('inventory').append(e);}for(const item of state.inventory){const e=document.createElement('span');e.className='item';e.textContent=names[item];$('inventory').append(e);}
 $('education').hidden=!state.educationSeconds;$('education').textContent=`행복한 보안교육 ${state.educationSeconds}초 · 다음에는 도구함에 숨자`;
 const fresh=state.events.filter(e=>e.id>seen);for(const e of fresh){seen=e.id;line(e.text,e.kind);$('subtitle').textContent=e.text;if(!muted&&e.kind!=='system'){voiceQueue.push(e);voiceQueue=voiceQueue.slice(-3);}}
 if(fresh.length)playNext();
 const facts=d.memory.facts,visits=d.memory.visits;
 $('memory').textContent=facts.includes('banana')?'바나나로 문 열려던 사건을 기억하고 있어요.':facts.includes('promise')?'“내가 책임질게.” 그 약속, 기억하고 있어요.':facts.includes('escaped')?'지난번 함께 퇴근한 일을 기억하고 있어요.':visits>1?`${visits}번째 근무. 이번에는 꼭 퇴근합시다.`:'첫 근무. 아직은 서로를 믿습니다.';
 $('memory-provider').textContent=d.memory.provider==='agentcore'?'AGENTCORE MEMORY · 연결됨':d.memory.provider==='degraded'?'기억은 로컬 보존 중 · 클라우드 연결 재시도':d.memory.provider==='connecting'?'AGENTCORE MEMORY · 연결 중':'이 서버에 플레이 기억 보존';
 if(state.won){$('ending').hidden=false;$('ending-text').textContent=`${state.ending} · 소요 ${Math.floor(state.elapsedSeconds/60)}분 ${state.elapsedSeconds%60}초 · 보안교육 ${state.caught}회. 지우는 이번 근무를 기억합니다.`;}
 const tips=!state.doorOpen?['안내문 읽어봐','커피 집어서 문에 써봐','바나나로 문 열어봐']:!state.inventory.includes('stamp')?['박주임한테 팀장님이 프린터 고장났대','청소도구함에 숨어','자료실에서 결재 도장 챙겨']:!state.approved?['기밀 문서도 챙겨','도장을 퇴근 게이트에 써봐']:!state.clockedIn?['출근 단말기 눌러봐']:['퇴근 게이트 열어'];
 if($('suggestions').dataset.key!==tips.join('|')){$('suggestions').dataset.key=tips.join('|');$('suggestions').replaceChildren(...tips.map(t=>{const b=document.createElement('button');b.textContent=t;b.onclick=()=>submit({text:t});return b;}));}
}
async function begin(){
 turnVersion++;controller?.abort();stopVoice();if(recording)await endRecording(false);status('지우와 무전 연결 중…');$('start').disabled=true;
 try{const d=await(await api('session',{method:'POST',body:'{}'})).json();session=d.id;seen=0;serverCamera='pantry';$('dialogue').replaceChildren();$('ending').hidden=true;render(d);chooseCamera('pantry');$('welcome').close();$('connection').textContent='● 무전 연결됨';$('connection').classList.add('ready');status('지우가 듣고 있어요 · 음성 또는 텍스트로 지시하세요.');busy=false;}
 catch(e){error(e.message);}finally{$('start').disabled=false;}
}
async function submit(payload){
 if(!session){$('welcome').showModal();return;}if(state?.won){status('퇴근 성공! 다음 근무를 시작해보세요.');return;}
 const version=++turnVersion;controller?.abort();controller=new AbortController();const signal=controller.signal;stopVoice();busy=true;$('wave').classList.add('active');status(payload.audio?'무전을 듣고 있어요…':'지우가 지시를 이해하고 있어요…');
 if(payload.text)line(payload.text,'user');
 try{const d=await(await api('turn',{method:'POST',body:JSON.stringify({...payload,selected}),signal})).json();if(version!==turnVersion)return;if(payload.audio)line(d.heard,'user');render(d);status('지시 전달 완료 · 새 지시로 행동을 바꿀 수 있어요.');$('metrics').textContent=`${d.heard} · 판단 ${d.metrics?.llmMs??0}ms · 전체 ${d.metrics?.totalMs??0}ms`;}
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
try{scene=createScene($('world'),$('portrait'),id=>{selected=id;$('selected').textContent='선택: '+(targetNames[id]||id);status((targetNames[id]||id)+' 선택됨 · “저거 조사해봐”라고 말해보세요.');});}catch(e){$('scene-error').hidden=false;$('scene-error').textContent='3D 화면을 시작하지 못했습니다. WebGL을 지원하는 브라우저에서 다시 열어주세요. '+e.message;}
$('command-form').onsubmit=e=>{e.preventDefault();const text=$('command').value.trim();if(text){$('command').value='';submit({text});}};
$('mic').onclick=()=>recording?endRecording():startRecording();$('stop').onclick=halt;$('start').onclick=begin;$('restart').onclick=begin;$('again').onclick=begin;
$('sound').onclick=()=>{muted=!muted;$('sound').textContent=muted?'음성 꺼짐':'음성 켜짐';$('sound').setAttribute('aria-pressed',String(!muted));if(muted)stopVoice();};
$('help').onclick=()=>{const d=$('welcome');d.showModal();$('start').textContent=session?'새 근무 시작 ↗':'무전 연결하기 ↗';};
$('welcome').addEventListener('click',e=>{if(e.target===$('welcome')&&session)$('welcome').close();});
for(const b of document.querySelectorAll('[data-camera]'))b.onclick=()=>chooseCamera(b.dataset.camera);
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat&&!['INPUT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName)&&!$('welcome').open){e.preventDefault();recording?endRecording():startRecording();}if(e.code==='Escape')halt();});
setInterval(async()=>{if(!session||polling)return;polling=true;try{render(await(await api('state')).json());}catch(e){if(e.status===401){session=null;$('connection').textContent='● 재연결 필요';$('welcome').showModal();}if(!busy)status(e.message);}finally{polling=false;}},350);
window.channel07={getState:()=>state,sceneInfo:()=>scene?.info()};
$('welcome').showModal();
