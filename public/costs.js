import {compareCosts} from './cost-model.js';
const $=id=>document.getElementById(id),usd=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n),num=n=>Math.round(n).toLocaleString('ko-KR');
const sec=ms=>Number.isFinite(ms)?`${(ms/1000).toFixed(2)}초`:'—';
function args(requests=Number($('requests').value)){return{requests,replicaHours:Number($('replicas').value)*Number($('base-hours').value)+Number($('extra-hours').value),hourlyUSD:Number($('instance').value),ttsCharacters:Number($('characters').value),sonicUSDPerRequest:Number($('sonic-cost').value)/1000};}
function cell(row,value){const td=document.createElement('td');td.textContent=value;row.append(td);}
function failures(row,items,label='실패'){if(!items?.length)return;const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`${label} ${items.length}건 보기`;details.append(summary);for(const f of items){const p=document.createElement('p');p.textContent=`${f.caseId} · 인식: ${f.heard||'—'} · 응답: ${f.reply||f.error||'—'} · 기대 명령: ${JSON.stringify(f.expectedActions||[])} · 실제 명령: ${JSON.stringify(f.actualActions||[])}`;details.append(p);}row.firstElementChild.append(details);}
function draw(){
 const a=args(),c=compareCosts(a);$('open-total').textContent=usd(c.openUSD);$('sonic-total').textContent=usd(c.sonicUSD);
 $('verdict').textContent=c.openUSD<c.sonicUSD?`이 사용량에서는 GPU 구성이 월 ${usd(c.sonicUSD-c.openUSD)} 낮습니다.`:`이 사용량에서는 Sonic 추론비가 월 ${usd(c.openUSD-c.sonicUSD)} 낮습니다.`;
 $('break-even').textContent=c.breakEvenRequests==null?'현재 가정에서는 없음':`월 약 ${num(c.breakEvenRequests)}건`;$('daily').textContent=c.breakEvenRequests==null?'Polly 변동비가 Sonic 건당 비용 이상입니다.':`하루 평균 약 ${num(c.breakEvenRequests/(730/24))}건 · 서버 용량 검증 필요`;
 $('scenarios').replaceChildren();for(const n of [10000,100000,300000,1000000]){const row=document.createElement('tr'),r=compareCosts(args(n));for(const v of [num(n)+'건',usd(r.openUSD),usd(r.sonicUSD)])cell(row,v);$('scenarios').append(row);}
 const svg=$('chart'),ns='http://www.w3.org/2000/svg';svg.replaceChildren();const maxX=Math.max(1000000,a.requests,(c.breakEvenRequests||0)*1.4),maxY=Math.max(c.fixedUSD+maxX*c.variableUSDPerRequest,maxX*a.sonicUSDPerRequest)*1.12,x=n=>48+n/maxX*526,y=n=>225-n/maxY*200;
 const add=(tag,attrs,content)=>{const el=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));if(content)el.textContent=content;svg.append(el);};
 for(let i=0;i<=4;i++){const value=maxY*i/4;add('line',{x1:48,x2:574,y1:y(value),y2:y(value),stroke:'#355057'});add('text',{x:2,y:y(value)+4,fill:'#91a9ac','font-size':10},'$'+num(value));}
 for(let i=0;i<=4;i++){const value=maxX*i/4;add('text',{x:x(value),y:250,fill:'#91a9ac','font-size':10,'text-anchor':'middle'},num(value)+'건');}
 add('line',{x1:x(0),x2:x(maxX),y1:y(c.fixedUSD),y2:y(c.fixedUSD+maxX*c.variableUSDPerRequest),stroke:'#ace5c9','stroke-width':3});add('line',{x1:x(0),x2:x(maxX),y1:y(0),y2:y(maxX*a.sonicUSDPerRequest),stroke:'#b9c4f7','stroke-width':3});
 if(c.breakEvenRequests!=null){add('line',{x1:x(c.breakEvenRequests),x2:x(c.breakEvenRequests),y1:24,y2:225,stroke:'#d5e5dc','stroke-dasharray':'4 5'});add('circle',{cx:x(c.breakEvenRequests),cy:y(c.breakEvenRequests*a.sonicUSDPerRequest),r:5,fill:'#e7fff1'});}
}
for(const el of document.querySelectorAll('input,select'))el.addEventListener('input',()=>{try{draw();}catch{}});draw();
try{
 const r=await(await fetch('/rightsizing-report.json')).json();$('test-method').textContent=r.method;if(r.selection)$('selected-serving').textContent=r.selection.explanation;
 if(r.memorySnapshots){const labels={single:'단일 워커','two-workers':'복제본 2개',vllm:'vLLM Phi','vllm-qwen35':'vLLM Qwen'};$('pool-memory').textContent='GPU 전체 메모리 사용량 예시 · '+Object.values(Object.fromEntries(r.memorySnapshots.snapshots.map(m=>[m.mode,m]))).map(m=>`${labels[m.mode]||m.mode} ${(m.usedMiB/1024).toFixed(1)}GiB`).join(' / ')+'. Whisper·CUDA 컨텍스트·예약 캐시를 포함한 시점 측정이며 최대치는 아닙니다. vLLM은 KV 캐시 풀도 미리 예약하므로 메모리 사용량만으로 효율을 판단하지 않습니다.';}

 for(const m of r.models){const row=document.createElement('tr');for(const v of [m.name,`${m.passed}/${m.total}`,sec(m.medianFirstAudioMs),sec(m.p95FirstAudioMs),m.plannerGiB?`${m.plannerGiB.toFixed(2)}GiB`:'—'])cell(row,v);failures(row,m.failures);$('quality').append(row);}
 for(const m of r.engineQuality||[]){const row=document.createElement('tr');for(const v of [`${m.name} · ${m.serving}`,`${m.passed}/${m.total}`,sec(m.medianFirstAudioMs),sec(m.p95FirstAudioMs),m.mode==='two-workers'?'7.15GiB × 2벌':m.model==='phi4-mini'?'7.15GiB × 1벌 + KV 캐시':'text-only 가중치 + KV 캐시'])cell(row,v);failures(row,m.failures);$('quality').append(row);}
 for(const m of r.load){const row=document.createElement('tr');for(const v of [m.serving,m.name,m.concurrency,`${m.passed}/${m.count}`,`${m.successfulRequestsPerSecond}건/초`,sec(m.p95FirstAudioMs),m.p95PlannerQueueMs==null?'—':`${(m.p95PlannerQueueMs/1000).toFixed(2)}초`])cell(row,v);$('load').append(row);}
}catch{$('test-method').textContent='이 배포의 성능 시험은 진행 중입니다. 결과가 준비되면 이 페이지에 표시됩니다.';}
try{
 const response=await fetch('/rightsizing-followup.json');if(!response.ok)throw Error('Follow-up unavailable');const report=await response.json();
 if(report.production?.explanation)$('selected-serving').textContent=report.production.explanation;
 $('followup-note').textContent='L4와 T4는 GPU 이름입니다. 실제 시험한 AWS 서버는 서울 리전의 EC2 g6.xlarge(NVIDIA L4)와 g4dn.xlarge(NVIDIA T4)입니다. 현재 공유 데모는 g6.xlarge에서 실행합니다. 아래 월 가동비는 GPU만의 가격이 아니라 해당 EC2 인스턴스 한 대를 730시간 켜두는 비용입니다. Qwen3.5-4B를 기준으로 동일 한국어 녹음 명령의 차량 상태 변경과 실제 응답 음성까지 검증했습니다. L4는 기존 모델을 공유하는 별도 로컬 평가 API를 사용했습니다. 최종 비교는 같은 필수 도구 인자 스키마로 재측정했습니다. 공통 품질 31문항과 부하 시험의 반복 6종 명령은 서로 다른 시험입니다.';
 for(const config of report.configurations){
  const row=document.createElement('tr');const capacity=limit=>{const valid=config.load.filter(x=>x.passed===x.count&&x.p95FirstAudioMs<=limit);return valid.length?`${Math.max(...valid.map(x=>x.successfulRequestsPerSecond)).toFixed(3)}건/초`:'관측 없음';};
  const quality=config.common?`${config.common.passed}/${config.common.total}`:config.load.length?`부하 ${config.load.reduce((a,x)=>a+x.passed,0)}/${config.load.reduce((a,x)=>a+x.count,0)}`:'미측정';
  for(const value of [config.label,quality+(config.holdout?` / ${config.holdout.passed}/${config.holdout.total}`:''),config.common?sec(config.common.p95FirstAudioMs):config.integration?.status==='failed'?'실행 호환 실패':config.integration?.status==='timeout'?'초기화 시간 초과 · 성능 미측정':'공통 시험 미실시',`p95 3초: ${capacity(3000)} / 5초: ${capacity(5000)}`,usd(config.monthlyComputeUSD)])cell(row,value);
  if(config.integration?.error){const details=document.createElement('details'),summary=document.createElement('summary'),p=document.createElement('p');summary.textContent='실행 호환성 오류 보기';p.className='compat-error';p.textContent=config.integration.error;details.append(summary,p);row.firstElementChild.append(details);}
  if(config.common)failures(row,config.common.failures.map(x=>({...x,caseId:x.id})),'공통 명령 실패');if(config.holdout)failures(row,config.holdout.failures.map(x=>({...x,caseId:x.id})),'추가 표현 실패');
  $(config.schemaVersion==='typed-actions-v2'?'followup-comparison':'followup-legacy').append(row);
  for(const load of config.load){
   const r=load.resources;if(!r)continue;const detail=document.createElement('tr');
   for(const value of [config.label,load.concurrency,`${load.successfulRequestsPerSecond}건/초`,sec(load.p95FirstAudioMs),`${r.gpuBusyMeanPercent.toFixed(1)}%`,`${r.hostCpuMeanPercent.toFixed(1)}%`,`${(r.gpuFreeMinimumMiB/1024).toFixed(2)}GiB`,`${(r.hostMemAvailableMinimumMiB/1024).toFixed(2)}GiB`])cell(detail,value);$('followup-resources').append(detail);
  }
 }
 $('followup-verdict').textContent=report.conclusion||'추가 검증 중입니다. 현재 운영 구성은 L4 + Qwen BF16 + vLLM입니다. 처리량은 짧은 시험에서 관측한 값이며 운영 SLA나 최대 용량 보장은 아닙니다.';
}catch{$('followup-note').textContent='추가 GPU 검증 결과가 아직 이 배포에 게시되지 않았습니다.';}
