import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {cases} from './vehicle-benchmark-cases.mjs';
import {initialState,executePlan} from '../vehicle.mjs';
const base=process.env.BENCH_BASE||'http://localhost:18887/api/';
const models=(process.env.BENCH_MODELS||'qwen35-4b-nf4,phi4-mini').split(',');
const levels=(process.env.BENCH_CONCURRENCY||'1,2,4,8').split(',').map(Number),count=Number(process.env.BENCH_REQUESTS||24);
const dir=process.env.BENCH_REPORT_DIR||'research/rightsizing-l4';await mkdir(dir,{recursive:true});
const samples=cases.filter(c=>['driver-24','passenger-25','fan-5','defrost-on','volume-20','compound'].includes(c.id));
const audio=new Map(await Promise.all(samples.map(async c=>[c.id,(await readFile(`output/vehicle-benchmark/${c.id}.wav`)).toString('base64')])));
const q=(values,p)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.max(0,Math.ceil(a.length*p)-1)]:null;};
const stateKey=s=>{if(!s)return '';const{revision,...rest}=s;return JSON.stringify(rest);};
async function turn(plannerId,c){
 const started=performance.now();let firstAudioMs=null,audioBytes=0,metrics,error;
 try{
  const session=await(await fetch(base+'session',{method:'POST'})).json();
  const response=await fetch(base+'turn',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':session.id},body:JSON.stringify({audio:audio.get(c.id),plannerId,asrId:'whisper',ttsProvider:'polly',inputMode:'file',promptVersion:'compact-v2',generationProfile:'deterministic'}),signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(await response.text());
  let buffer='';const decoder=new TextDecoder();
  for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let cut;
   while((cut=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,cut);buffer=buffer.slice(cut+2);const event=block.match(/^event: (.*)/m)?.[1],data=JSON.parse(block.match(/^data: (.*)/m)?.[1]||'{}');
    if(event==='audio'){firstAudioMs??=Math.round(performance.now()-started);audioBytes+=Buffer.from(data.audio,'base64').length;}
    if(event==='done')metrics=data.metrics;if(event==='error')error=data.error;
   }
  }
 }catch(e){error=e.message;}
 const expected=executePlan(initialState(),null,{intent:'control',actions:c.actions,reply:''}).state;
 return {caseId:c.id,firstAudioMs,elapsedMs:Math.round(performance.now()-started),audioBytes,passed:!error&&audioBytes>0&&stateKey(metrics?.state)===stateKey(expected),error,asrMs:metrics?.asrMs,llmMs:metrics?.llmMs,plannerQueueMs:metrics?.plannerQueueMs,ttsMs:metrics?.ttsMs,ttsCharacters:metrics?.ttsCharacters,modelLoadMs:metrics?.modelLoadMs,plannerMemory:metrics?.plannerMemory};
}
const report={startedAt:new Date().toISOString(),status:'running',mode:process.env.BENCH_SERVING_MODE||'single',hardware:process.env.BENCH_HARDWARE||'g6.xlarge / L4',method:'Closed-loop fixed concurrent request slots, recorded Korean audio, real Whisper + planner + validated state + Polly. Each request has a fresh session. Includes HTTP session creation and SSH tunnel RTT. Not concurrent always-listening users. Serving mode is recorded separately; baseline serializes planning, replicas route independent requests, vLLM uses continuous batching. Load sample pool differs from 31-case quality suite.',rows:[]};
for(const model of models){
 const warmup=await turn(model,samples[0]);if(!warmup.passed)throw Error('Warmup failed '+model+': '+JSON.stringify(warmup));
 for(const concurrency of levels){
  const rows=new Array(count);let next=0;const start=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const i=next++;if(i>=count)return;rows[i]=await turn(model,samples[i%samples.length]);}}));
  const wallSeconds=(performance.now()-start)/1000,passed=rows.filter(r=>r.passed).length;
  const summary={model,concurrency,count,passed,wallSeconds:+wallSeconds.toFixed(2),completedRequestsPerSecond:+(count/wallSeconds).toFixed(3),successfulRequestsPerSecond:+(passed/wallSeconds).toFixed(3),medianFirstAudioMs:q(rows.map(r=>r.firstAudioMs),.5),p95FirstAudioMs:q(rows.map(r=>r.firstAudioMs),.95),p95PlannerQueueMs:q(rows.map(r=>r.plannerQueueMs),.95),medianAsrMs:q(rows.map(r=>r.asrMs),.5),p95AsrMs:q(rows.map(r=>r.asrMs),.95),medianLlmMs:q(rows.map(r=>r.llmMs),.5),p95LlmMs:q(rows.map(r=>r.llmMs),.95),meanTtsCharacters:rows.reduce((n,r)=>n+(r.ttsCharacters||0),0)/count,within3s:rows.filter(r=>r.passed&&r.firstAudioMs<=3000).length,within5s:rows.filter(r=>r.passed&&r.firstAudioMs<=5000).length,rows};
  report.rows.push(summary);await writeFile(`${dir}/load.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({...summary,rows:undefined}));
 }
}
report.status='complete';report.completedAt=new Date().toISOString();await writeFile(`${dir}/load.json`,JSON.stringify(report,null,2));
