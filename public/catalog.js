const labels={'not-deployed':'이 배포에서는 미실행',ready:'연결됨',integrating:'연동 중',candidate:'후보', 'license-review':'라이선스 검토','access-needed':'접근 동의 필요','hardware-needed':'장비 필요','low-priority':'참고 후보'};
let catalog,filter='all';
function plannerOption(model){const config=model.demoConfig||{},option=Object.assign(document.createElement('option'),{value:model.id,textContent:(config.recommended?'✓ ':'')+model.name+(config.qualityScore!=null?' · '+config.qualityScore+'점':'')+(model.status==='ready'?'':' · '+(labels[model.status]||model.status)),disabled:model.status!=='ready'});Object.assign(option.dataset,{promptVersion:config.promptVersion||'compact-v2',generationProfile:config.generationProfile||'deterministic'});return option;}
function render(){
  const body=document.getElementById('candidate-rows');body.replaceChildren();
  for(const model of catalog.models.filter(m=>filter==='all'||m.role===filter)){
    const row=document.createElement('tr');
    const name=document.createElement('td'),link=document.createElement('a');link.textContent=model.name;link.href=model.source;link.target='_blank';link.rel='noopener noreferrer';name.append(link);row.append(name);
    const evaluation=model.evaluation?` ${model.evaluation.label||'실측'} ${model.evaluation.passed}/${model.evaluation.total} · ${model.evaluation.medianLlmMs}ms 중앙값` : '';
    for(const text of [model.size,model.korean,model.license,labels[model.status]||model.status,model.notes+evaluation]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
    row.dataset.status=model.status;body.append(row);
  }
  document.querySelectorAll('[data-model-filter]').forEach(button=>button.classList.toggle('selected',button.dataset.modelFilter===filter));
}
document.querySelectorAll('[data-model-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.modelFilter;render();}));
try{
  catalog=await(await fetch('/api/catalog')).json();
  const planners=document.getElementById('planner-model'),audio=document.getElementById('audio-model');
  planners.replaceChildren(...catalog.models.filter(m=>m.role==='sllm').map(model=>plannerOption(model)));
  audio.replaceChildren(...catalog.models.filter(m=>m.role==='s2s'&&(m.nativeAudio||m.audioPlanner)&&m.id!=='minicpm-o45').map(model=>{
    const option=Object.assign(document.createElement('option'),{value:model.id,textContent:model.name+(model.audioPlanner?'':' · 차량 제어 미지원'),disabled:model.status!=='ready'});
    Object.assign(option.dataset,{promptVersion:model.demoConfig?.promptVersion||'full-v1',generationProfile:model.demoConfig?.generationProfile||'deterministic',ready:String(model.status==='ready'),audioPlanner:String(!!model.audioPlanner),nativeAudio:String(!!model.nativeAudio)});return option;
  }));
  if(catalog.defaultPlannerId&&[...planners.options].some(o=>o.value===catalog.defaultPlannerId&&!o.disabled))planners.value=catalog.defaultPlannerId;document.dispatchEvent(new Event('vehicle-catalog-ready'));
  function notice(){const model=catalog.models.find(m=>m.id===planners.value),element=document.getElementById('planner-notice');element.hidden=!['hyperclova-05b','exaone4-12b','smollm3'].includes(model?.id);element.textContent=model?.id==='hyperclova-05b'?'Powered by HyperCLOVA X · 자체 라이선스 · 실험용':model?.id==='exaone4-12b'?'EXAONE · 연구·평가용 비상업 라이선스 · 제품 배포는 별도 허가 필요':model?.korean||'';}
  planners.addEventListener('change',notice);notice();
  function audioNotice(){
    const control=document.getElementById('conversation-engine').value==='audio-control';
    for(const option of audio.options){const model=catalog.models.find(m=>m.id===option.value);option.disabled=model?.status!=='ready'||(control?!model?.audioPlanner:!model?.nativeAudio);}
    if(audio.selectedOptions[0]?.disabled){const next=[...audio.options].find(o=>!o.disabled);if(next)audio.value=next.value;}
    const model=catalog.models.find(m=>m.id===audio.value);
    document.getElementById('audio-model-notice').textContent=[model?.korean,model?.notes].filter(Boolean).join(' · ')+' '+(control?'음성 → 모델 직접 판단 → 차량 검증·실행 → 선택한 한국어 TTS':'제어 없는 내장 음성 비교 · 온도·공조 상태가 바뀌지 않습니다');
  }
  audio.addEventListener('change',audioNotice);document.getElementById('conversation-engine').addEventListener('change',audioNotice);audioNotice();
  const s2s=catalog.models.filter(m=>m.role==='s2s').length,sllm=catalog.models.filter(m=>m.role==='sllm').length;
  document.getElementById('candidate-count').textContent=`${catalog.models.filter(m=>m.status==='ready').length}/${catalog.models.length} 연결 · 기본 모델 ${catalog.models.filter(m=>!m.variantOf).length} · 정밀도 변형 ${catalog.models.filter(m=>m.variantOf).length}`;
  document.getElementById('catalog-updated').textContent=`자료 확인: ${catalog.updatedAt} · 최신 31개 공통 음성 평가와 배포 판단은 위 표를 확인하세요. 이전 소규모 텍스트 시험과 구분합니다.`;render();
}catch{document.getElementById('candidate-count').textContent='후보 목록 연결 대기';}
