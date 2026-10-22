import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {compareCosts} from '../public/cost-model.js';
const dir='research/rightsizing-l4';const assumptions=JSON.parse(await readFile(`${dir}/cost-assumptions.json`,'utf8'));
const ids=['qwen35-4b','qwen35-4b-nf4','phi4-mini'],names={'qwen35-4b':'Qwen 4B · BF16','qwen35-4b-nf4':'Qwen 4B · 4bit NF4','phi4-mini':'Phi-4 mini · BF16'};
const q=(a,p)=>{a=a.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.max(0,Math.ceil(a.length*p)-1)]:null;};
const report={at:new Date().toISOString(),hardware:'AWS Seoul g6.xlarge / 1× NVIDIA L4 24GB class / 4 vCPU / 16GiB host RAM',method:'서울 L4 한 대에서 Whisper → 선택 sLLM → 차량 상태 검증 → 서울 Polly. 동일 한국어 합성 음성 31개, 모델별 워밍업 후 측정. 첫 음성은 파일 제출부터 클라이언트 수신까지이며 SSH 터널 왕복을 포함합니다. 실제 마이크·차량 주행 시험은 아닙니다.',assumptions,models:[],load:[]};
for(const id of ids){let r;try{r=JSON.parse(await readFile(`${dir}/common/${id}.json`,'utf8'));}catch{continue;}
 const passed=r.rows.filter(x=>x.passed).length;report.models.push({id,name:names[id],status:r.status,passed,total:r.rows.length,qualityScore:Math.round(passed/r.rows.length*100),medianFirstAudioMs:q(r.rows.map(x=>x.firstAudioMs),.5),p95FirstAudioMs:q(r.rows.map(x=>x.firstAudioMs),.95),medianLlmMs:q(r.rows.map(x=>x.llmMs),.5),plannerGiB:(q(r.rows.map(x=>x.plannerMemory?.cudaAllocatedDeltaMiB),.5)||0)/1024,coldWarmupMs:r.warmup?.elapsedMs,coldModelLoadMs:r.warmup?.modelLoadMs,failures:r.rows.filter(x=>!x.passed).map(x=>({caseId:x.id,error:x.error,heard:x.heard,reply:x.reply,category:x.failureCategory,expectedActions:x.expectedActions,actualActions:x.actualActions}))});
}
const modes={'single':'HF 1 worker','two-workers':'HF 2 Docker workers','vllm':'vLLM continuous batching','vllm-qwen35':'vLLM · Qwen BF16 text-only'};
const loadReports=[];for(const [mode,label] of Object.entries(modes)){
 let load;try{load=JSON.parse(await readFile(`${dir}/${mode}/load.json`,'utf8'));}catch{continue;}
 loadReports.push(load);report.load.push(...load.rows.map(({rows,...s})=>({...s,mode,serving:label,name:names[s.model],medianAsrMs:q(rows.map(r=>r.asrMs),.5),p95AsrMs:q(rows.map(r=>r.asrMs),.95),medianLlmMs:q(rows.map(r=>r.llmMs),.5),p95LlmMs:q(rows.map(r=>r.llmMs),.95)})));
}
report.status=report.models.length===3&&report.models.every(x=>x.status==='complete')&&loadReports.length>=3&&loadReports.every(x=>x.status==='complete')?'complete':'running';
report.engineQuality=[];for(const mode of ['two-workers','vllm','vllm-qwen35']){const id=mode==='vllm-qwen35'?'qwen35-4b':'phi4-mini';let r;try{r=JSON.parse(await readFile(`${dir}/${mode}/${id}.json`,'utf8'));}catch{continue;}
 report.engineQuality.push({mode,serving:modes[mode],model:id,name:names[id],passed:r.rows.filter(x=>x.passed).length,total:r.rows.length,status:r.status,medianFirstAudioMs:q(r.rows.map(x=>x.firstAudioMs),.5),p95FirstAudioMs:q(r.rows.map(x=>x.firstAudioMs),.95),failures:r.rows.filter(x=>!x.passed).map(x=>({caseId:x.id,heard:x.heard,reply:x.reply,error:x.error,category:x.failureCategory,expectedActions:x.expectedActions,actualActions:x.actualActions}))});
}
report.status=report.status==='complete'&&report.engineQuality.length>=2&&report.engineQuality.every(r=>r.status==='complete')?'complete':'running';
report.capacityObservations=Object.entries(modes).map(([mode,serving])=>({mode,serving,under3s:Math.max(0,...report.load.filter(r=>r.mode===mode&&r.p95FirstAudioMs<=3000&&r.passed===r.count).map(r=>r.successfulRequestsPerSecond)),under5s:Math.max(0,...report.load.filter(r=>r.mode===mode&&r.p95FirstAudioMs<=5000&&r.passed===r.count).map(r=>r.successfulRequestsPerSecond)),note:'Observed short closed-loop test, not a proven production SLA or maximum capacity.'}));
try{report.memorySnapshots=JSON.parse(await readFile(`${dir}/gpu-memory-snapshots.json`,'utf8'));}catch{}
try{report.selection=JSON.parse(await readFile(`${dir}/selected-serving.json`,'utf8'));}catch{}
report.costScenarios=[];for(const replicas of [1,2,3])for(const requests of [10000,100000,300000,1000000])report.costScenarios.push({replicas,requests,...compareCosts({requests,replicaHours:replicas*assumptions.hoursPerMonth,hourlyUSD:assumptions.gpuHourlyUSD,ttsCharacters:assumptions.assumedPollyCharactersPerRequest,sonicUSDPerRequest:assumptions.sonicUSDPerRequest})});
await mkdir('public',{recursive:true});await writeFile(`${dir}/summary.json`,JSON.stringify(report,null,2));await writeFile('public/rightsizing-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,models:report.models,loadRows:report.load.length}));
