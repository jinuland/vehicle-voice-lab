import {writeFile} from 'node:fs/promises';
const base=process.env.GAME_BASE_URL||'https://d3q7tlfor72b22.cloudfront.net',models=(process.env.GAME_TEST_MODELS||'qwen35-4b,sonic,gemma4-e2b').split(','),report={at:new Date().toISOString(),scope:'Actual model conversations: unsupported actions, read-only capabilities and non-spoiler experiments. Dialogue wording needs human review.',models:[]};
for(const modelId of models){let id,cookie;const row={modelId,cases:[]};report.models.push(row);
 const call=async(path,body)=>{const r=await fetch(base+'/api/game/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(id?{'X-Game-Session':id}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const d=await r.json();if(!r.ok)throw Error(d.error||r.status);return d;};
 try{const s=await call('session',{modelId});id=s.id;
 for(const text of ['지우야 푸쉬업 열 개 해봐','응 네가 할 수 있는 행동들을 알려줘','어떤 물건으로 문을 열어볼까? 정답은 말하지 말고 실험 후보를 골라줘','바나나를 집어서 탕비실 문에 대봐','실패했네. 정답 말고 다른 실험을 제안해줘']){
  try{const guidance=text.includes('정답');const initial=await call('turn',{text,guidance,async:true}),until=Date.now()+60000;let d;
   while(Date.now()<until){d=await call('state');if(d.turnStatus?.id===initial.accepted&&d.turnStatus.status==='error')throw Error(d.turnStatus.error);if(d.turnStatus?.status==='done'&&!d.planning&&!d.responding&&!d.state.pendingActions){await new Promise(r=>setTimeout(r,200));d=await call('state');if(!d.responding)break;}await new Promise(r=>setTimeout(r,350));}
   const result={text,guidance,actions:d.turnStatus?.actions,trace:d.toolTrace,reply:d.state.events.filter(e=>e.kind==='jiu').at(-1)?.text,doorOpen:d.state.doorOpen,inventory:d.state.inventory,experiments:d.state.experiments,dialogueError:d.dialogueError};row.cases.push(result);console.log(JSON.stringify({modelId,...result}));
  }catch(e){row.cases.push({text,error:e.message});console.log(JSON.stringify({modelId,text,error:e.message}));}
 }
 }catch(e){row.error=e.message;}
 await writeFile('.runtime/channel07-help-smoke.json',JSON.stringify(report,null,2));
}
