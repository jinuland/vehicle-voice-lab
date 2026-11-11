import {normalizeTranscript} from './transcript.mjs';

export const NATIVE_NUMERIC_QUIET_MS=1400;
const numericActions=new Set(['temperature','fan','seatHeat','volume']);
const nativeNumerals={스물넷:24,스물네:24,스물아홉:29,스물다섯:25,스물여섯:26,스물일곱:27,스물여덟:28,스물셋:23,스물세:23,스물둘:22,스물두:22,스물하나:21,스물한:21,스무:20,열아홉:19,열여덟:18,열일곱:17,열여섯:16,서른:30};
const nativeNumberPattern=new RegExp(`(?<![가-힣])(${Object.keys(nativeNumerals).join('|')})(?=\\s*도)`,'g');
const zones={'운전석':'driver','조수석':'passenger','양쪽':'both','두 자리':'both'};
const zonePattern=/운전석|조수석|양쪽|두 자리/g;
const cuePattern=/(?:^|[\s,.;!?])(?:아니(?=[\s,.;!?]|$)|아,\s*아니|정정할게|정정해서)|\d+(?:\.\d+)?\s*도\s*말고/g;

// Only check an explicit temperature correction. Never invent the intended number
// or silently rewrite the model's requested action.
export function correctionError(input,actions){
  const targets=actions.filter(a=>a.type==='temperature');
  if(!targets.length)return null;
  const text=normalizeTranscript(String(input||'').replace(/(\d+(?:\.\d+)?)\s*°(?:\s*[Cc])?/g,'$1도'))
    .replace(nativeNumberPattern,word=>String(nativeNumerals[word]));
  const cue=[...text.matchAll(cuePattern)].at(-1);
  if(!cue)return null;
  const before=text.slice(0,cue.index+cue[0].length),after=text.slice(cue.index+cue[0].length);
  const numbers=[...after.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*도/g)];
  const first=numbers[0];
  if(!/\d\s*도|온도/.test(before)&&!first)return null;
  // "아니, 2도만 더 올려" is a relative adjustment, not an absolute correction.
  if(first&&/^\s*(?:만|정도|가량|씩)?\s*(?:더\s*)?(?:올려|내려|높여|낮춰)/.test(after.slice(first.index+first[0].length)))return null;
  const previousZone=[...before.matchAll(zonePattern)].at(-1)?.[0];
  const explicitZone=first?[...after.slice(0,first.index).matchAll(zonePattern)].at(-1)?.[0]:null;
  const zone=zones[explicitZone||previousZone];
  const value=first?Number(first[1]):NaN;
  const relevant=zone&&zone!=='both'?targets.filter(a=>a.zone===zone||a.zone==='both'):targets;
  if(!Number.isFinite(value)||value<16||value>30||!relevant.length||relevant.some(a=>a.value!==value||(zone&&a.zone!==zone))){
    return {code:'temperature-correction',value:Number.isFinite(value)&&value>=16&&value<=30?value:null};
  }
  return null;
}

export function numericGuardReply(reason,language){
  if(reason.code==='speech-resumed')return language==='en'
    ?'Speech resumed. This earlier command was not applied. Wait for the new complete request before calling the tool again.'
    :'말씀을 이어가셔서 앞 명령은 적용하지 않았어요. 새 발화가 끝난 뒤 최종 요청으로만 다시 판단하세요.';
  return reason.value===null
    ?language==='en'?'No change was applied. Ask for the final temperature in degrees.':'설정을 변경하지 않았어요. 최종 온도를 몇 도로 맞출지 다시 확인해 주세요.'
    :language==='en'?`No change was applied. The correction was ${reason.value} degrees. Check the seat and retry only the final request.`
      :`설정을 변경하지 않았어요. 정정한 값은 ${reason.value}도입니다. 좌석과 최종 값을 확인한 뒤 마지막 요청만 다시 처리하세요.`;
}

export function createNativeWriteGate({now=()=>performance.now(),quietMs=NATIVE_NUMERIC_QUIET_MS}={}){
  let id,blocked=false,lastVoice=-Infinity,file=false,fileEnded=false,waiting,closed=false;
  function settle(result){
    if(!waiting)return;
    clearTimeout(waiting.timer);const {resolve}=waiting;waiting=null;resolve(result);
  }
  return {
    transcript(next){if(next!==id){id=next;blocked=false;}},
    mode(mode){file=mode==='file';fileEnded=false;},
    audioEnd(){if(file){fileEnded=true;settle(true);}},
    observe(pcm){
      if(!pcm.length)return;
      let sum=0,n=0;
      for(let i=0;i+1<pcm.length;i+=8){const x=pcm.readInt16LE(i)/32768;sum+=x*x;n++;}
      if(sum/n<.018**2)return;
      lastVoice=now();fileEnded=false;
      if(waiting){blocked=true;settle(false);}
    },
    wait(actions){
      if(!actions.some(a=>numericActions.has(a.type)))return Promise.resolve(true);
      if(closed||blocked)return Promise.resolve(false);
      const delay=fileEnded?0:quietMs-(now()-lastVoice);
      if(delay<=0)return Promise.resolve(true);
      return new Promise(resolve=>{waiting={resolve,timer:setTimeout(()=>settle(true),delay)};});
    },
    close(){closed=true;settle(false);},
  };
}
