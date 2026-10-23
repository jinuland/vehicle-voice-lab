import {writeFile,mkdir} from 'node:fs/promises';
const base=process.env.GAME_BASE_URL||'https://d3q7tlfor72b22.cloudfront.net';let id,cookie;
const report={at:new Date().toISOString(),base,kind:'actual Qwen planner and authoritative game execution; optional synthetic audio ASR smoke',rows:[]};
async function call(path,body){const r=await fetch(base+'/api/game/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(id?{'X-Game-Session':id}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();if(!r.ok)throw Error(data.error||r.status);return data;}
async function idle(timeout=22000){const start=Date.now();let d;do{d=await call('state');if(!d.state.moving&&!d.state.pendingActions&&!d.state.educationSeconds)return d;await new Promise(r=>setTimeout(r,400));}while(Date.now()-start<timeout);throw Error('Action completion timeout');}
try{
 let d=await call('session',{});id=d.id;report.memoryStart=d.memory.provider;
 const turns=[['바나나를 집어서 탕비실 문에 대봐',s=>s.bananaAttempts>0],['커피를 집어서 출입문에 사용해봐',s=>s.doorOpen],['박주임한테 팀장님이 프린터 고장났으니 점검하래',s=>s.guard.away],['자료실에서 결재 도장 챙겨',s=>s.inventory.includes('stamp')],['기밀 문서도 가져와',s=>s.records],['결재 도장을 퇴근 게이트에 사용해',s=>s.approved],['출근 단말기 눌러봐',s=>s.clockedIn],['퇴근 게이트 열고 나가자',s=>s.won]];
 for(const[text,check]of turns){const r=await call('turn',{text});d=await idle();const row={text,actions:r.actions,metrics:r.metrics,passed:check(d.state),lastEvents:d.state.events.slice(-3).map(x=>x.text)};report.rows.push(row);console.log(JSON.stringify(row));if(!row.passed)throw Error('Failed: '+text);}
 report.ending=d.state.ending;d=await call('session',{});id=d.id;report.memoryReplay={provider:d.memory.provider,remoteCount:d.memory.remoteCount,visits:d.memory.visits,facts:d.memory.facts,intro:d.state.events[0].text};if(!d.state.events[0].text.includes('바나나'))throw Error('Replay callback missing');
 if(process.env.GAME_TEST_AUDIO){const {readFile}=await import('node:fs/promises');const audio=(await readFile(process.env.GAME_TEST_AUDIO)).toString('base64');const r=await call('turn',{audio});d=await idle();const row={audio:true,heard:r.heard,actions:r.actions,metrics:r.metrics,passed:d.state.doorOpen};report.rows.push(row);console.log(JSON.stringify(row));if(!row.passed)throw Error('ASR-to-game failed');}
 report.passed=true;
}catch(e){report.passed=false;report.error=e.message;console.error(e.message);process.exitCode=1;}
await mkdir('.runtime',{recursive:true});await writeFile('.runtime/channel07-smoke.json',JSON.stringify(report,null,2));
