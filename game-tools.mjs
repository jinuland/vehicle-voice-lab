import {gameSchema,snapshot} from './game-engine.mjs';
export const characterTool={type:'function',function:{name:'character_control',description:'Control Jiu in the simulated game. Use help to read current capabilities without changing the world. Request supported actions only; the engine returns actual outcomes. reply is a short Korean response, never proof of success.',parameters:gameSchema}};
export const gameDialogueSchema={type:'object',additionalProperties:false,properties:{reply:{type:'string'}},required:['reply']};
export function normalizeGameCall(value){
 if(!value||typeof value.reply!=='string'||!Array.isArray(value.tool_calls)||value.tool_calls.length>1)throw Error('캐릭터 도구 호출 형식을 확인하지 못했어요. 다시 말해 주세요.');
 const call=value.tool_calls[0];
 if(call&&(call.name!=='character_control'||!Array.isArray(call.arguments?.actions)))throw Error('알 수 없는 캐릭터 도구입니다.');
 return {reply:value.reply,actions:call?.arguments.actions||[],toolCalls:value.tool_calls};
}
export function resultMessages(game,{text,plan,messages,results}){
 const s=snapshot(game);
 return [{role:'system',content:'You are Jiu, an adult Korean office worker talking to a trusted teammate on the radio. A character_control call just finished. Continue the conversation in natural Korean 반말, at most 2 short sentences and 75 Korean characters. Use the actual result below. A dry playful aside is welcome when it fits, but do not force a joke. Avoid polite assistant wording, repetitive confirmations, lists, repeating the mission objective, or always asking what to do next. Do not claim any new action, eating, or change beyond the reported result. If the tool returned capabilities, explain 2-3 options the player can try, not an answer sequence. Never reveal a puzzle winning item or combination unless the user explicitly asks for the solution. Help them experiment with visible objects and their properties. Only suggest objects in nearbyObjects or held inventory. Do not invent a key, card or other prop, and do not predict an untested combination will fail or succeed. On failure explain the real obstacle briefly. This is a conversational reaction AFTER execution, not another plan. Return JSON {"reply":"your line"}.'},
 {role:'user',content:text},
 {role:'assistant',content:plan.reply||'한번 해볼게.'},
 {role:'user',content:JSON.stringify({toolResult:{name:'character_control',status:results.some(e=>e.ok===false)?'failed_or_partial':'completed',results:results.map(e=>({text:e.text,ok:e.ok!==false,...(e.data?{data:e.data}:{})})),state:{room:s.room,nearbyObjects:s.interactables.filter(o=>o.room===s.room||o.held).map(o=>({id:o.id,name:o.name})),inventory:s.inventory,placements:s.placements,microwave:s.microwave,doorOpen:s.doorOpen,approved:s.approved,clockedIn:s.clockedIn,won:s.won}}})}];
}
