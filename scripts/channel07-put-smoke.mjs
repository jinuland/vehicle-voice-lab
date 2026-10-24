import {writeFile,mkdir} from 'node:fs/promises';
const base=process.env.GAME_BASE_URL||'https://d3q7tlfor72b22.cloudfront.net';let id,cookie;const report={at:new Date().toISOString(),rows:[]};
async function call(path,body){const r=await fetch(base+'/api/game/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(id?{'X-Game-Session':id}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const d=await r.json();if(!r.ok)throw Error(d.error||r.status);return d;}
async function wait(){for(let i=0;i<90;i++){const d=await call('state');if(!d.state.moving&&!d.state.pendingActions&&!d.state.educationSeconds)return d;await new Promise(r=>setTimeout(r,350));}throw Error('Action timeout');}
try{let d=await call('session',{});id=d.id;for(const[text,check]of [
 ['커피 집어서 출입문에 사용해봐',s=>s.doorOpen],
 ['커피 다시 내려놔',s=>!s.inventory.includes('coffee')&&s.placements.coffee?.surface==='table'&&s.doorOpen],
 ['커피 다시 집어',s=>s.inventory.includes('coffee')],
 ['박주임한테 팀장님이 프린터 고장났으니 점검하래',s=>s.guard.away],
 ['커피를 자료실 책상 위에 올려놔',s=>!s.inventory.includes('coffee')&&s.placements.coffee?.room==='office'],
 ['책상에 놓은 커피 다시 들어',s=>s.inventory.includes('coffee')&&s.room==='office'],
 ['커피 바닥에 내려놔',s=>!s.inventory.includes('coffee')&&s.placements.coffee?.surface==='floor'],
 ['방금 내려놓은 커피 다시 집어',s=>s.inventory.includes('coffee')&&s.room==='office']
 ]){const r=await call('turn',{text});d=await wait();const row={text,actions:r.actions,passed:!!check(d.state),reply:d.state.events.at(-1)?.text};report.rows.push(row);console.log(JSON.stringify(row));if(!row.passed)throw Error('Failed: '+text);}report.passed=true;}catch(e){report.passed=false;report.error=e.message;console.error(e.message);process.exitCode=1;}await mkdir('.runtime',{recursive:true});await writeFile('.runtime/channel07-put-smoke.json',JSON.stringify(report,null,2));
