import {SonicSession} from './sonic.mjs';
import {gameSchema} from './game-engine.mjs';
import {gameDialogueFormatInstruction} from './game-tools.mjs';
export function sonicGameSystem(messages,dialogue=false){
 const system=messages.filter(m=>m.role==='system').map(m=>dialogue?m.content.replaceAll(gameDialogueFormatInstruction,'Return only ordinary Korean speech, no JSON.'):m.content).join('\n')+'\nYou are Jiu. Respond naturally in Korean. For actions call character_control; never print a JSON tool envelope as dialogue. The reply argument is your short intent BEFORE execution. Without an action simply chat. Only use the attached tool for supported actions.';
 return dialogue?system+'\nThis turn is after actual tool results. Say the reply in ordinary Korean text, no JSON.':system;
}
// The current game uses Sonic text reasoning/tool calls with common ASR/TTS, not native voice streaming.
export async function sonicGameInference(messages,{signal,dialogue=false}={}){
 return await new Promise((resolve,reject)=>{
  let session,ticker,settled=false,spoken='',preview='';
  const finish=(error,value)=>{if(settled)return;settled=true;clearInterval(ticker);session?.close();signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>finish(signal.reason||Error('취소됐어요.'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
  const system=sonicGameSystem(messages,dialogue);
  const tool={toolSpec:{name:'character_control',description:'Control Jiu in the simulated game. Actions are requests and will be validated by the engine. reply is your Korean reaction before attempting them.',inputSchema:{json:JSON.stringify(gameSchema)}}};
  session=new SonicSession({state:{},language:'ko',tools:dialogue?[]:[tool],systemInstruction:system,executeNamedTool:async(name,args)=>{
   if(name!=='character_control')throw Error('Unknown character tool');
   finish(null,{reply:args.reply||'',tool_calls:[{name,arguments:{actions:args.actions}}]});return {status:'requested'};
  },emit:(event,data)=>{
   if(event==='ready'){session.text(messages.filter(m=>m.role!=='system').map(m=>m.role+': '+m.content).join('\n'));ticker=setInterval(()=>session.audio(Buffer.alloc(3200)),100);}
   if(event==='text'&&data.role==='ASSISTANT')spoken+=data.text;
   if(event==='caption')preview=data.text||preview;
   if(event==='done'){let reply=(spoken||preview).trim();if(reply.startsWith('{')){try{const d=JSON.parse(reply);if(typeof d.reply==='string')reply=d.reply.trim();}catch{}}finish(reply?null:Error('Sonic이 응답을 반환하지 않았어요.'),dialogue?{reply}:{reply,tool_calls:[]});}
   if(event==='error')finish(Error(data.error));
   if(event==='closed'&&!settled)finish(Error('Sonic 연결이 종료됐어요.'));
  }});session.start();
 });
}
