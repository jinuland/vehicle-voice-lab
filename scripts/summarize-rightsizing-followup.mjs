import {readFile,writeFile} from 'node:fs/promises';
const root='research/rightsizing-followup';
const read=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const quantile=(a,p)=>{a=a.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.max(0,Math.ceil(a.length*p)-1)]:null;};
const configurations=[
 {id:'l4-bf16',label:'g6.xlarge · NVIDIA L4 · vLLM BF16 · Whisper 1개',instance:'g6.xlarge',engine:'vLLM',model:'qwen35-4b',hourlyUSD:.9896,qualityPath:'research/rightsizing-l4/vllm-qwen35/qwen35-4b.json'},
 {id:'l4-two-asr',label:'g6.xlarge · NVIDIA L4 · vLLM BF16 · Whisper 2개',instance:'g6.xlarge',engine:'vLLM',model:'qwen35-4b',hourlyUSD:.9896},
 {id:'t4-nf4',label:'g4dn.xlarge · NVIDIA T4 · HF NF4 4bit / FP16 계산',instance:'g4dn.xlarge',engine:'HF',model:'qwen35-4b-nf4',hourlyUSD:.647},
 {id:'t4-awq',label:'g4dn.xlarge · NVIDIA T4 · vLLM AWQ 4bit / FP16 계산',instance:'g4dn.xlarge',engine:'vLLM',model:'qwen35-4b-awq',hourlyUSD:.647},
 {id:'l4-strict',label:'g6.xlarge · NVIDIA L4 · vLLM BF16 · 도구 스키마 수정',instance:'g6.xlarge',engine:'vLLM',model:'qwen35-4b',hourlyUSD:.9896,schemaVersion:'typed-actions-v2'},
 {id:'t4-awq-strict',label:'g4dn.xlarge · NVIDIA T4 · vLLM AWQ 4bit · 도구 스키마 수정',instance:'g4dn.xlarge',engine:'vLLM',model:'qwen35-4b-awq',hourlyUSD:.647,schemaVersion:'typed-actions-v2'},
];
const method=await read(`${root}/method.json`);
const report={at:new Date().toISOString(),method,conclusion:method.conclusion,production:method.production,configurations:[]};
function quality(r){if(!r)return null;const controls=r.rows.filter(x=>x.id!=='holdout-weather');return {status:r.status,passed:r.rows.filter(x=>x.passed).length,total:r.rows.length,cabinControlsPassed:controls.filter(x=>x.passed).length,cabinStatePassed:controls.filter(x=>x.stateCorrect).length,cabinControlsTotal:controls.length,medianFirstAudioMs:quantile(r.rows.map(x=>x.firstAudioMs),.5),p95FirstAudioMs:quantile(r.rows.map(x=>x.firstAudioMs),.95),medianLlmMs:quantile(r.rows.map(x=>x.llmMs),.5),plannerAllocatedGiB:(quantile(r.rows.map(x=>x.plannerMemory?.cudaAllocatedDeltaMiB),.5)||0)/1024,computeDtype:r.rows.find(x=>x.plannerMemory?.computeDtype)?.plannerMemory.computeDtype,failures:r.rows.filter(x=>!x.passed).map(x=>({id:x.id,heard:x.heard,reply:x.reply,error:x.error,expectedActions:x.expectedActions,actualActions:x.actualActions}))};}
for(const config of configurations){
 const dir=`${root}/${config.id}`,load=await read(`${dir}/load.json`),common=await read(config.qualityPath||`${dir}/common/${config.model}.json`),holdout=await read(`${dir}/holdout/${config.model}.json`),integration=await read(`${dir}/integration.json`);
 if(!load&&!common&&!integration)continue;
 let samples=[];try{samples=(await readFile(`${dir}/resources.jsonl`,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
 const rows=(load?.rows||[]).map(({rows,...row})=>{
  const s=samples.filter(x=>Date.parse(x.at)>=Date.parse(row.startedAt)&&Date.parse(x.at)<=Date.parse(row.completedAt));
  const avg=k=>s.length?s.reduce((a,x)=>a+x[k],0)/s.length:null;
  const resources=s.length?{samples:s.length,gpuBusyMeanPercent:avg('gpuBusyPercent'),gpuMemoryBusyMeanPercent:avg('gpuMemoryBusyPercent'),gpuUsedPeakMiB:Math.max(...s.map(x=>x.gpuUsedMiB)),gpuTotalMiB:s[0].gpuTotalMiB,gpuFreeMinimumMiB:Math.min(...s.map(x=>x.gpuTotalMiB-x.gpuUsedMiB)),hostCpuMeanPercent:avg('hostCpuBusyPercent'),hostMemAvailableMinimumMiB:Math.min(...s.map(x=>x.hostMemAvailableMiB)),hostMemTotalMiB:s[0].hostMemTotalMiB}:null;
  return {...row,resources,requestErrors:rows.filter(x=>x.error).map(x=>({caseId:x.caseId,error:x.error})),computeUSDPerThousandSuccessfulRequests:row.successfulRequestsPerSecond?config.hourlyUSD/3600/row.successfulRequestsPerSecond*1000:null};
 });
 report.configurations.push({...config,monthlyComputeUSD:config.hourlyUSD*730,common:quality(common),holdout:quality(holdout),integration,loadStatus:load?.status,load:rows});
}
await writeFile(`${root}/summary.json`,JSON.stringify(report,null,2)+'\n');
await writeFile('public/rightsizing-followup.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.configurations.map(c=>({id:c.id,common:c.common&&`${c.common.passed}/${c.common.total}`,holdout:c.holdout&&`${c.holdout.passed}/${c.holdout.total}`,load:c.load.map(x=>({concurrency:x.concurrency,passed:x.passed,count:x.count,rps:x.successfulRequestsPerSecond,p95:x.p95FirstAudioMs,gpuBusy:x.resources?.gpuBusyMeanPercent}))})),null,2));
