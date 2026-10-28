export const initialState = () => ({ revision: 0, temperature: {driver: 22, passenger: 22}, fan: 2, ac: true, defrost: false, seatHeat: 0, media: {playing: false, volume: 35, track: '드라이브 플레이리스트'}, navigation: {destination: null, active: false}, speed: 0 });
export const systemPrompt = `너는 한국어 차량 음성 비서 '온'이다. 모든 차량 동작은 시뮬레이터에서만 실행된다.
짧고 자연스럽게 한국어로 대답한다. 아래 형식의 JSON 객체만 출력하라. 생각 과정, 마크다운, 설명은 출력하지 마라.
{"intent":"control|question|clarify","actions":[],"reply":"짧은 한국어 답변"}
지원하는 actions:
{"type":"temperature","zone":"driver|passenger|both","value":16~30 숫자}
{"type":"fan","value":1~7 정수}
{"type":"ac","value":true 또는 false}
{"type":"defrost","value":true 또는 false} : 앞유리 김서림 제거, 성에 제거, 디프로스터 켜기/끄기
{"type":"seatHeat","value":0~3 정수}
{"type":"media","value":"play|pause|next"}
{"type":"volume","value":0~100 정수}
{"type":"navigate","value":"사용자가 말한 목적지"}
{"type":"navigationStop"}
{"type":"undo"}
현재 상태와 직전 대화를 참고한다. '아니 24도로' 같은 정정은 직전의 대상에 반영한다.
지원하는 동작을 명확하게 요청하면 intent는 control이다. actions가 하나라도 있으면 intent는 반드시 control이어야 한다. 현재 상태만 묻는 질문은 intent=question, actions=[].
운전석/조수석 언급 없이 온도를 설정하면 both. '더워'는 현재 온도에서 1도 낮추기, '추워'는 1도 올리기. 정확한 수치 명령은 그 수치를 따른다.
'온도 올려줘/높여줘'는 해당 좌석의 현재 온도보다 1도 높이고, '온도 내려줘/낮춰줘'는 1도 낮춘다. 좌석 언급이 없으면 양쪽에 적용한다. 현재 양쪽 온도가 다르면 각 좌석별 temperature 동작을 생성한다.
범위 밖 수치를 임의 변경하지 말고 actions=[]로 두고 가능한 범위를 안내한다. '음악 꺼'는 pause, '소리 줄여'는 volume을 현재보다 10 낮추되 최소0.
설정 취소/되돌리기는 반드시 undo(직전 차량 제어 이전 상태를 복구)를 사용한다. '방금 설정 되돌려', '원래대로 돌려', '직전 명령 취소'는 actions=[{"type":"undo"}]. navigationStop과 구분하라. navigationStop은 '길 안내 종료', '내비 안내 꺼'처럼 안내를 중지할 때만 사용한다. 복합 명령은 actions에 순서대로 추가한다.
목적지 없이 '길 안내해'처럼 불명확하면 확인 질문을 하고 actions=[]. navigate는 모의 목적지 설정이며 실시간 경로, 교통, 도착시간을 지어내지 마라.
현재 온도·음량 등 상태 질문은 actions=[]로 현재 상태를 정확히 답한다. 일반 지식 대화는 간결하게 답하되 모르는 실시간 정보는 조회할 수 없다고 한다.
앞유리 김서림 제거는 지원하는 공조 기능이다. '앞유리 김서림 제거 켜줘'는 actions=[{"type":"defrost","value":true}]. '김서림 제거 꺼'는 value=false.
창문 열기/닫기, 문 잠금, 가속, 제동 등 지원 목록에 없는 동작은 수행하지 말고 지원하지 않는다고 답한다. 앞유리 김서림 제거와 창문 열기는 서로 다른 기능이다.
날씨·주변 장소·실시간 교통·실제 음악 재생 기능은 연결되지 않았다. 성공했다고 말하지 마라.
도구 실행 성공 문구는 서버가 생성하므로 actions가 있으면 reply는 빈 문자열로 두어도 된다.`;

function number(value, min, max, integer=false) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value))) throw new Error(`값은 ${min}~${max}${integer?' 정수':''}여야 합니다.`);
  return value;
}
export function parsePlan(raw) {
  const clean=raw.replace(/<think>[\s\S]*?<\/think>/g,'').replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
  let parsed;
  try { parsed=JSON.parse(clean); }
  catch { throw new Error('판단 모델이 차량 명령을 완성하지 못했어요. 다시 말씀해 주세요.'); }
  if(!['control','question','clarify'].includes(parsed.intent)||!Array.isArray(parsed.actions)||parsed.actions.length>6||typeof parsed.reply!=='string'||parsed.reply.length>350) throw new Error('모델 응답 형식이 올바르지 않습니다.');
  if(parsed.actions.length && parsed.intent!=='control') throw new Error('제어 의도가 아닌 응답의 동작을 거부했습니다.');
  return parsed;
}
export function executePlan(current, previous, plan, language='ko') {
  const say=text=>localizeVehicleText(text,language);
  if(!plan.actions.length) return {state:current, previous, reply:say(plan.reply||'어떤 기능을 도와드릴까요?'), results:[]};
  let state=structuredClone(current), before=structuredClone(current), results=[];
  for(const a of plan.actions) {
    if(!a||typeof a!=='object') throw new Error('잘못된 차량 명령입니다.');
    switch(a.type) {
      case 'temperature': {
        const v=number(a.value,16,30);
        if(!['driver','passenger','both'].includes(a.zone)) throw new Error('좌석을 확인해 주세요.');
        for(const z of a.zone==='both'?['driver','passenger']:[a.zone])state.temperature[z]=v;
        results.push(`${a.zone==='both'?'양쪽':a.zone==='driver'?'운전석':'조수석'} 온도를 ${v}도로 맞췄어요.`);break;
      }
      case 'fan':state.fan=number(a.value,1,7,true);results.push(`바람 세기를 ${a.value}단으로 바꿨어요.`);break;
      case 'ac':case 'defrost': {
        if(typeof a.value!=='boolean')throw new Error('켜기 또는 끄기를 지정해 주세요.');
        state[a.type]=a.value;results.push(`${a.type==='ac'?'에어컨을':'앞유리 김서림 제거 기능을'} ${a.value?'켰':'껐'}어요.`);break;
      }
      case 'seatHeat':state.seatHeat=number(a.value,0,3,true);results.push(a.value?`열선을 ${a.value}단으로 켰어요.`:'열선을 껐어요.');break;
      case 'volume':state.media.volume=number(a.value,0,100,true);results.push(`음량을 ${a.value}으로 맞췄어요.`);break;
      case 'media':
        if(!['play','pause','next'].includes(a.value))throw new Error('지원하지 않는 미디어 명령입니다.');
        if(a.value==='next'){state.media.track=state.media.track==='드라이브 플레이리스트'?'다음 드라이브 곡':'드라이브 플레이리스트';results.push('다음 곡으로 바꿨어요.');}
        else {state.media.playing=a.value==='play';results.push(state.media.playing?'음악을 재생했어요.':'음악을 멈췄어요.');}break;
      case 'navigate':
        if(typeof a.value!=='string'||!a.value.trim()||a.value.length>80)throw new Error('목적지를 다시 말씀해 주세요.');
        state.navigation={destination:a.value.trim(),active:true};results.push(`${a.value.trim()}을 모의 목적지로 설정했어요.`);break;
      case 'navigationStop':state.navigation.active=false;results.push('모의 길 안내를 종료했어요.');break;
      case 'undo':
        if(plan.actions.length!==1)throw new Error('되돌리기는 단독으로 요청해 주세요.');
        if(!previous)return {state:current,previous,reply:say('되돌릴 차량 명령이 없어요.'),results:[]};
        state=structuredClone(previous);results.push('직전 차량 설정을 되돌렸어요.');break;
      default:throw new Error('지원하지 않는 차량 동작입니다.');
    }
  }
  state.revision=current.revision+1;
  return {state,previous:before,reply:results.map(say).join(' '),results:results.map(say)};
}

// Translate only executor-authored receipts. Never rewrite free-form model answers
// or user-provided destination names, and never report success before validation.
export function localizeVehicleText(text,language='ko') {
  if(language!=='en')return text;
  const fixed={
    '어떤 기능을 도와드릴까요?':'How can I help?',
    '되돌릴 차량 명령이 없어요.':'There is no vehicle command to undo.',
    '직전 차량 설정을 되돌렸어요.':'Restored the previous vehicle settings.',
    '열선을 껐어요.':'Turned off the seat heating.',
    '다음 곡으로 바꿨어요.':'Skipped to the next track.',
    '음악을 재생했어요.':'Started simulated music playback.',
    '음악을 멈췄어요.':'Paused simulated music playback.',
    '모의 길 안내를 종료했어요.':'Stopped simulated navigation.',
    '좌석을 확인해 주세요.':'Please specify the seat.',
    '켜기 또는 끄기를 지정해 주세요.':'Please specify on or off.',
    '목적지를 다시 말씀해 주세요.':'Please specify a destination.',
    '되돌리기는 단독으로 요청해 주세요.':'Please request undo separately.',
    '지원하지 않는 차량 동작입니다.':'That vehicle action is not supported.',
    '잘못된 차량 명령입니다.':'Invalid vehicle command.',
    '지원하지 않는 미디어 명령입니다.':'That media action is not supported.',
    '온도는 16~30도 사이로 말씀해 주세요.':'Please choose a temperature between 16 and 30 degrees Celsius.',
    '바람 세기는 1~7단 사이로 말씀해 주세요.':'Please choose a fan level from 1 to 7.',
    '열선은 0~3단 사이로 말씀해 주세요.':'Please choose a seat heating level from 0 to 3.'
  };
  if(fixed[text])return fixed[text];
  if(text.startsWith('설정을 적용하지 않았어요. '))return 'No settings were changed. '+localizeVehicleText(text.slice('설정을 적용하지 않았어요. '.length),language);
  return text
    .replace(/^(양쪽|운전석|조수석) 온도를 ([\d.]+)도로 맞췄어요\.$/,(_,zone,value)=>`Set ${zone==='양쪽'?'both cabin zones':zone==='운전석'?'the driver temperature':'the passenger temperature'} to ${value} degrees Celsius.`)
    .replace(/^바람 세기를 (\d+)단으로 바꿨어요\.$/,'Set the fan to level $1.')
    .replace(/^(에어컨을|앞유리 김서림 제거 기능을) (켰|껐)어요\.$/,(_,device,on)=>`Turned ${on==='켰'?'on':'off'} ${device==='에어컨을'?'the air conditioning':'the windshield defroster'}.`)
    .replace(/^열선을 (\d+)단으로 켰어요\.$/,'Set the seat heating to level $1.')
    .replace(/^음량을 (\d+)으로 맞췄어요\.$/,'Set the volume to $1.')
    .replace(/^(.+)을 모의 목적지로 설정했어요\.$/,'Set the simulated destination to $1.')
    .replace(/^값은 (\d+)~(\d+)( 정수)?여야 합니다\.$/,(_,min,max,integer)=>`Please choose ${integer?'an integer':'a value'} between ${min} and ${max}.`);
}
