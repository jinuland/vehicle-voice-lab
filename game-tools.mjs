import {gameSchema,snapshot,gameVoiceStyle} from './game-engine.mjs';
export const characterTool={type:'function',function:{name:'character_control',description:'Control Jiu in the simulated game. Use help to read current capabilities without changing the world. Request supported actions only; the engine returns actual outcomes. reply is a short Korean response, never proof of success.',parameters:gameSchema}};
export const gameDialogueFormatInstruction='Return JSON {"reply":"your line"}.';
export const gameDialogueSchema={type:'object',additionalProperties:false,properties:{reply:{type:'string'}},required:['reply']};
export function normalizeGameCall(value){
 if(!value||typeof value.reply!=='string'||!Array.isArray(value.tool_calls)||value.tool_calls.length>1)throw Error('캐릭터 도구 호출 형식을 확인하지 못했어요. 다시 말해 주세요.');
 const call=value.tool_calls[0];
 if(call&&(call.name!=='character_control'||!Array.isArray(call.arguments?.actions)))throw Error('알 수 없는 캐릭터 도구입니다.');
 return {reply:value.reply,actions:call?.arguments.actions||[],toolCalls:value.tool_calls};
}
export function resultMessages(game,{text,plan,messages,results}){
 const s=snapshot(game);
 return [{role:'system',content:`너는 무전으로 플레이어와 얘기하는 지우야. 방금 character_control 도구가 돌려준 결과를 보고 대답해.
${gameVoiceStyle}
필요하면 세 문장까지, 140자 안으로 말해. 사용자가 물은 내용부터 답하고 불필요한 뒷말은 붙이지 마. 문장의 조사와 서술어를 빠뜨리지 마. '문에 대보려는 건 어때?' 대신 '문에 대볼까?'처럼 짧게 써.
아래 toolResult만 현재 사실이야. 새 행동을 했다고 하거나, 기록에 없는 일을 이미 해봤다고 말하지 마. 실패했다면 막힌 이유를 알려줘. 처음 보는 물건의 효과나 내용물을 추측해서 단정하지 마.
할 수 있는 일을 물으면 가까운 물건(nearbyObjects)이나 들고 있는 물건으로 해볼 만한 일을 두세 가지 알려줘. 멀리 있거나 없는 열쇠·카드 등을 끌어오지 마. recentAttempts에 나온 시도는 기억하되, 모르는 건 모른다고 해.
힌트는 정답을 찍어주는 대신 고를 수 있게 도와줘. 물건을 함께 언급해도 되지만, 안 해본 조합의 성공·실패를 미리 말하지 마. 정답을 직접 요청했을 때만 전체 풀이를 알려줘. 지금은 결과에 대한 대화만 하고 새 행동을 시키지 마.
${gameDialogueFormatInstruction}`},
 {role:'user',content:text},
 ...(plan.reply?[{role:'assistant',content:plan.reply}]:[]),
 {role:'user',content:JSON.stringify({toolResult:{name:'character_control',status:results.some(e=>e.ok===false)?'failed_or_partial':'completed',results:results.map(e=>({text:e.text,ok:e.ok!==false,...(e.data?{data:e.data}:{})})),state:{room:s.room,nearbyObjects:s.interactables.filter(o=>o.room===s.room||o.held).map(o=>({id:o.id,name:o.name})),inventory:s.inventory,recentAttempts:s.experiments.slice(-3),examined:s.examined,placements:s.placements,microwave:s.microwave,doorOpen:s.doorOpen,approved:s.approved,clockedIn:s.clockedIn,won:s.won}}})}];
}
