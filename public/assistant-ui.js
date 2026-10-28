import {TimerMonitor} from './timer-monitor.js';
const $=id=>document.getElementById(id);
let api,radio,radioStation,playbackStarted=0,refreshTimer,radioRequest=0,radioVolume=.35,radioDucked=false,lastResult;
const en=()=>document.documentElement.lang==='en';
const text=(ko,english)=>en()?english:ko;
let timerAudio,timerSounds=[],timerAlarmRepeat,timerAlarmStop;
function armTimerAudio(){try{timerAudio??=new AudioContext();if(timerAudio.state==='suspended')void timerAudio.resume().catch(()=>{});}catch{}}
function stopTimerSound(){for(const sound of timerSounds)try{sound.stop();}catch{}timerSounds=[];}
function stopTimerAlarm(){clearInterval(timerAlarmRepeat);clearTimeout(timerAlarmStop);timerAlarmRepeat=null;timerAlarmStop=null;stopTimerSound();}
function timerChime(){
 stopTimerSound();
 if(timerAudio?.state!=='running')return false;
 const start=timerAudio.currentTime;
 for(let i=0;i<3;i++){
  const tone=timerAudio.createOscillator(),gain=timerAudio.createGain(),at=start+i*.4;
  tone.frequency.value=i===1?880:660;gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(.25,at+.02);gain.gain.exponentialRampToValueAtTime(.001,at+.28);
  tone.connect(gain);gain.connect(timerAudio.destination);tone.onended=()=>{tone.disconnect();gain.disconnect();};tone.start(at);tone.stop(at+.3);timerSounds.push(tone);
 }
 return true;
}
function playTimerAlert(){
 const played=timerChime();
 $('timer-alert-status').textContent=played?text('알림음을 재생하고 있어요. 30초 동안 반복합니다.','Playing the alert repeatedly for 30 seconds.'):text('소리가 차단됐어요. 알림음 테스트를 눌러 주세요.','Sound is blocked. Press Test chime.');
 if(!played){armTimerAudio();void timerAudio?.resume().then(()=>{if(!$('timer-alert').hidden&&timerChime())$('timer-alert-status').textContent=text('알림음을 재생하고 있어요.','Playing the alert.');}).catch(()=>{});}
}
const timerMonitor=new TimerMonitor(due=>{
 stopTimerAlarm();$('timer-alert').hidden=false;playTimerAlert();
 timerAlarmRepeat=setInterval(playTimerAlert,4000);
 timerAlarmStop=setTimeout(()=>{clearInterval(timerAlarmRepeat);timerAlarmRepeat=null;if(!$('timer-alert').hidden)$('timer-alert-status').textContent=text('알림음 반복을 마쳤어요. 알림 확인을 눌러 주세요.','Chime repetitions finished. Press Dismiss alert.');},30000);
 document.dispatchEvent(new CustomEvent('vehicle-timer-expired',{detail:{count:due.length}}));
});
function renderTimers(remaining=timerMonitor.tick()){
 const active=remaining.filter(t=>t.seconds>0).map(t=>`${text('휴식 타이머','Break timer')}: ${t.seconds}s`);
 if(!$('timer-alert').hidden&&remaining.some(t=>t.seconds===0))active.push(text('타이머 완료 · 알림 확인을 눌러 주세요.','Timer finished · Press Dismiss alert.'));
 const label=active.join(' · ');$('assistant-timers').textContent=label;
 const inline=$('conversation-timers');if(inline){inline.textContent=label;inline.hidden=!label;}
 if(!remaining.some(t=>t.seconds>0)){clearInterval(refreshTimer);refreshTimer=null;}
}
document.addEventListener('pointerdown',armTimerAudio,{passive:true});
document.addEventListener('keydown',armTimerAudio,{passive:true});
document.addEventListener('visibilitychange',()=>renderTimers());
$('timer-dismiss')?.addEventListener('click',()=>{$('timer-alert').hidden=true;stopTimerAlarm();renderTimers();});
$('timer-sound-test')?.addEventListener('click',async()=>{armTimerAudio();await timerAudio?.resume().catch(()=>{});$('timer-alert-status').textContent=timerChime()?'알림음을 재생했어요.':'브라우저에서 소리를 켜려면 알림음 테스트를 눌러 주세요.';});
const examples={weather:['서울 날씨 알려줘','Weather in Seoul'],web:['전기차 최근 뉴스 웹검색해줘','Search the web for recent electric vehicle news'],radio:['재즈 라디오 틀어줘','Play jazz radio'],wiki:['경복궁 설명해줘','Tell me about Gyeongbokgung'],holidays:['다음 공휴일 언제야','When is the next public holiday?'],exchange:['100달러 원화로 환율 계산해줘','Convert 100 USD to KRW'],sun:['강릉 일몰 알려줘','Sunset in Gangneung'],route:['서울시청에서 서울역까지 거리 알려줘','Distance from Seoul City Hall to Seoul Station'],places:['근처 카페 찾아줘','Find nearby cafes'],timer:['10분 타이머 맞춰줘','Set a timer for 10 minutes'],notes:['메모: 주차 위치 지하 2층 B12','Note: parking spot B12 on basement level 2'],calculate:['충전비 20kWh, kWh당 350원 계산해줘','Calculate 20 * 350']};
function prompt(value){document.dispatchEvent(new CustomEvent('vehicle-assistant-prompt',{detail:{text:value}}));}
export function configureAssistant(client){api=client;void refreshTools();}
async function refreshTools(){
 try{
  const d=await(await fetch('/api/tools')).json();$('assistant-transport').textContent=d.transport;
  $('assistant-tool-chips').replaceChildren();$('assistant-tool-rows').replaceChildren();
  for(const t of d.tools){
   const button=document.createElement('button');button.textContent=en()?t.labelEn:t.label;button.disabled=!t.enabled;button.title=t.enabled?examples[t.id]?.[en()?1:0]||'':text('속도·안정성 검사에서 제외','Excluded after latency / reliability checks');button.addEventListener('click',()=>prompt(examples[t.id][en()?1:0]));$('assistant-tool-chips').append(button);
   const row=document.createElement('tr');for(const value of [en()?t.labelEn:t.label,t.enabled?text('연결됨','Enabled'):text('기본 제외','Excluded'),t.p95Ms!=null?`${t.medianMs} / ${t.p95Ms} ms`:'—',t.successCount!=null?`${t.successCount}/${t.sampleCount}`:text('로컬 도구','Local utility')]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}$('assistant-tool-rows').append(row);
  }
  $('assistant-benchmark-note').textContent=text('외부 도구 왕복 p95 3초 초과 또는 반복 실패 시 기본 제외. ASR·모델·TTS 시간은 별도이며 캐시 적중도 포함됩니다.','External tools are excluded if round-trip p95 exceeds 3 s or repeated failures occur. ASR, model and TTS time are separate; cached calls are included.')+(d.reportAt?' '+d.reportAt:'');
 }catch{$('assistant-transport').textContent=text('도구 연결 확인 중','Checking tools');}
}
const radioChanged=()=>document.dispatchEvent(new CustomEvent('vehicle-radio-state'));
export function getRadioState(){return radioStation?{name:radioStation.name,playing:!!radio&&!radio.paused}:null;}
export function stopRadio(cancelPending=true){if(cancelPending)radioRequest++;radio?.pause();if(radio){radio.removeAttribute('src');radio.load();}radio=null;radioStation=null;$('radio-now').textContent=text('라디오 정지','Radio stopped');radioChanged();}
export function syncRadioState(state,actions=[]){radioVolume=Math.max(0,Math.min(1,state.media.volume/100));if(!radio)return;radio.volume=radioDucked?Math.min(.08,radioVolume):radioVolume;const command=actions.find(x=>x.type==='media');if(command?.value==='pause')radio.pause();else if(command?.value==='play')radio.play().catch(()=>{});}
export function duckRadio(duck){radioDucked=duck;if(radio)radio.volume=duck?Math.min(.08,radioVolume):radioVolume;}
async function playStation(id){
 const request=++radioRequest;
 try{
  const response=await api('radio/station',{method:'POST',body:JSON.stringify({stationId:id})});if(!response.ok)throw Error('Station unavailable');const station=await response.json();
  if(request!==radioRequest)return;stopRadio(false);radioStation=station;$('radio-station').value=id;const player=$('radio-player');radio=player;player.src=station.url;player.volume=radioVolume;playbackStarted=performance.now();
  $('radio-now').textContent=text('라디오 연결 중…','Connecting radio…');
  player.onplaying=()=>{$('radio-now').textContent=`${text('실제 재생 중','Live playback')} · ${station.name} · ${Math.round(performance.now()-playbackStarted)} ms`;radioChanged();document.dispatchEvent(new CustomEvent('vehicle-radio-playback',{detail:{status:'playing',stationId:id,firstPlaybackMs:Math.round(performance.now()-playbackStarted)}}));};
  player.onerror=()=>{$('radio-now').textContent=text('이 방송은 재생할 수 없어요. 다른 방송을 선택해 주세요.','This station could not play. Please choose another.');radioChanged();};
  player.onpause=()=>{if(radioStation)$('radio-now').textContent=`${text('일시 정지','Paused')} · ${station.name}`;radioChanged();};
  await player.play();
 }catch{$('radio-now').textContent=text('재생 버튼을 눌러 시작하거나 다른 방송을 선택해 주세요.','Press Play to start, or choose another station.');}
}
export function renderAssistantResult(result,{applyEffect=true}={}){
 lastResult=result;
 const box=$('assistant-result');box.replaceChildren();box.hidden=false;
 const header=document.createElement('strong');header.textContent=`${result.operation||''} · ${result.elapsedMs??'—'} ms · ${result.transport||'tool'}`;box.append(header);
 const reply=document.createElement('p');reply.textContent=result.reply||result.error||'';box.append(reply);
 for(const item of result.items||[]){const line=document.createElement('div');line.className='assistant-item';line.textContent=[item.date,item.name||item.title,item.text].filter(Boolean).join(' · ');if(result.operation==='radio'&&item.id){line.textContent=[item.name,item.genre].filter(Boolean).join(' · ');const play=document.createElement('button');play.textContent=text('재생','Play');play.addEventListener('click',()=>void playStation(item.id));line.append(play);}box.append(line);}
 const links=document.createElement('div');links.className='assistant-sources';
 for(const s of result.sources||[]){if(!/^https?:\/\//.test(s.url))continue;const a=document.createElement('a');a.href=s.url;a.textContent=s.title||s.url;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}box.append(links);
 if(result.notice){const note=document.createElement('small');note.textContent=result.notice;box.append(note);}
 const effect=applyEffect?result.effect:null;
 if(effect?.type==='radio')void playStation(effect.stationId);
 if(effect?.type==='radio-stop')stopRadio();
 if(effect?.type==='timers'){
  clearInterval(refreshTimer);renderTimers(timerMonitor.set(effect.timers));
  if(!effect.timers.length){$('timer-alert').hidden=true;stopTimerAlarm();renderTimers();}
  if(effect.timers.some(t=>t.deadline>Date.now()))refreshTimer=setInterval(renderTimers,250);
 }
}
document.addEventListener('vehicle-ui-language',()=>{void refreshTools();renderTimers();if(lastResult)renderAssistantResult(lastResult,{applyEffect:false});if(!radioStation)$('radio-now').textContent=text('라디오 정지','Radio stopped');});
$('radio-stop')?.addEventListener('click',stopRadio);
$('radio-play')?.addEventListener('click',()=>void playStation($('radio-station').value));
$('use-location')?.addEventListener('click',()=>{
 if(!navigator.geolocation){$('assistant-location').textContent=text('위치 기능을 지원하지 않아요.','Geolocation is unavailable.');return;}
 navigator.geolocation.getCurrentPosition(async({coords})=>{try{const r=await api('location',{method:'POST',body:JSON.stringify({latitude:coords.latitude,longitude:coords.longitude})});if(!r.ok)throw Error();$('assistant-location').textContent=`${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`;}catch{$('assistant-location').textContent=text('위치를 저장하지 못했어요.','Could not set location.');}},()=>{$('assistant-location').textContent=text('위치 권한이 없어 서울시청 데모 좌표를 사용합니다.','Location permission unavailable; using the Seoul City Hall demo coordinate.');},{timeout:6000,maximumAge:300000});
});
document.addEventListener('vehicle-assistant-effect',e=>renderAssistantResult(e.detail));
window.addEventListener('beforeunload',()=>{stopTimerAlarm();stopRadio();});
