import {gameSchema} from './game-engine.mjs';
import {sonicGameInference} from './game-sonic.mjs';
import {readFileSync,existsSync} from 'node:fs';
import {characterTool,gameDialogueSchema,normalizeGameCall} from './game-tools.mjs';
const catalog=JSON.parse(readFileSync(new URL(existsSync(new URL('./game-model-catalog.json',import.meta.url))?'./game-model-catalog.json':'./model-catalog.json',import.meta.url)));
const coreUrl=process.env.GAME_CORE_URL,speechUrl=process.env.GAME_SPEECH_URL;
const audioText=new Set(['qwen3-omni','step-audio2-mini','minicpm-o45']);
export const gameModels=catalog.models.filter(m=>m.status==='ready').map(m=>{
 const kind=m.id==='sonic'?'sonic':m.id==='qwen35-4b'?'vllm':m.role==='sllm'?'core':audioText.has(m.id)?'speech':'unsupported';
 const ready=kind==='sonic'&&process.env.GAME_SONIC_ENABLED==='1'||kind==='vllm'||kind==='core'&&!!coreUrl||kind==='speech'&&!!speechUrl;
 return {id:m.id,name:m.name,repo:m.repo,quantization:m.id==='qwen3-omni'?'NF4 thinker / BF16 audio':m.quantization||'bf16',kind,ready,score:m.demoConfig?.qualityScore??null,size:m.size,vehiclePassed:m.evaluation?.passed,vehicleTotal:m.evaluation?.total,provider:kind==='sonic'?'Amazon Bedrock · 도쿄':kind==='vllm'?'서울 L4 · 기존 vLLM':kind==='core'?'서울 L40S · 차량 공유 GPU':'차량 음성 모델 · 텍스트 판단 비교',description:ready?'차량 점수 기준 정렬 · 게임 도구와 한국어 자유 대화':kind==='unsupported'?'현재 게임용 도구 어댑터 미지원': '기존 차량 GPU 연결 설정 필요'};
}).sort((a,b)=>(b.score??-1)-(a.score??-1));
export const defaultGameModel='qwen35-4b';
export async function gameInference(modelId,messages,{signal,llmUrl='http://127.0.0.1:8000/v1/chat/completions',dialogue=false}={}){
 const m=gameModels.find(m=>m.id===modelId&&m.ready);if(!m)throw Error('연결된 게임 모델을 선택해 주세요.');
 const start=performance.now(),schema=dialogue?gameDialogueSchema:gameSchema;let value,tokens,loadMs=0;
 if(m.kind==='sonic'){value=await sonicGameInference(messages,{signal,dialogue});}else if(m.kind==='vllm'){
  const r=await fetch(llmUrl,{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({model:'vehicle-planner',messages,temperature:dialogue?.55:0,seed:7,max_tokens:700,chat_template_kwargs:{enable_thinking:false},...(dialogue?{structured_outputs:{json:schema}}:{tools:[characterTool],tool_choice:{type:'function',function:{name:'character_control'}}})})});
  if(!r.ok)throw Error('자체 GPU 모델에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  const d=await r.json();if(d.choices?.[0]?.finish_reason==='length')throw Error('모델이 응답을 완성하지 못했어요. 한두 가지씩 말해 주세요.');
  const message=d.choices?.[0]?.message;value=JSON.parse(dialogue?message?.content||'null':message?.tool_calls?.find(t=>t.function?.name==='character_control')?.function.arguments||'null');tokens={input:d.usage?.prompt_tokens,output:d.usage?.completion_tokens};
 }else{
  const r=await fetch((m.kind==='core'||m.id==='minicpm-o45'?coreUrl:speechUrl)+'/infer',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({messages,model_id:m.kind==='core'?m.repo:m.id,quantization:m.quantization,schema_kind:dialogue?'game_dialogue':'game'})});
  const d=await r.json();if(!r.ok)throw Error(d.detail||d.error||'차량 공유 GPU가 응답하지 않았어요.');
  value=JSON.parse(d.text);tokens={output:d.generatedTokens};loadMs=d.loadMs||0;
 }
 if(dialogue){if(typeof value?.reply!=='string')throw Error('캐릭터 대사를 생성하지 못했어요.');return {reply:value.reply.slice(0,200),model:m.id,elapsedMs:Math.round(performance.now()-start),loadMs,tokens};}
 return {plan:normalizeGameCall(Array.isArray(value?.actions)?{reply:value.reply,tool_calls:value.actions.length?[{name:'character_control',arguments:{actions:value.actions}}]:[]}:value),model:m.id,name:m.name,protocol:['vllm','sonic'].includes(m.kind)?'native-tool-calling':'schema-tool-adapter',elapsedMs:Math.round(performance.now()-start),loadMs,tokens};
}
