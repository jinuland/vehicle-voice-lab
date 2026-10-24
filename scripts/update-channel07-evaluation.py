"""Summarize completed real-model smoke runs. No score is assigned to unmeasured models."""
import argparse,json,pathlib,statistics,datetime
p=argparse.ArgumentParser();p.add_argument('inputs',nargs='+');a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[1];models={}
for name in a.inputs:
 d=json.loads(pathlib.Path(name).read_text())
 for m in d['models']:
  if m.get('total')!=6 or len(m.get('cases',[]))!=6:continue
  models[m['modelId']]={**m,'measuredAt':d['at']}
notes={'qwen35-4b':'기본 제어 비교용. 자연스러운 조언은 조언만 받기 모드를 사용하세요.','sonic':'이번 짧은 실험에서 한국어 선택지 안내가 가장 자연스러웠음. 공통 Whisper/Polly 경로.','gemma4-e2b':'직접 명령은 통과. 질문을 명령으로 해석한 사례가 있어 조언 모드를 사용하세요.','qwen35-4b-nf4':'제어 비교용. 말투가 반복적인 샘플이 있었음.','phi4-mini':'명령 누락과 어색한 한국어 샘플이 있었음.','minicpm-o45':'초기 측정값. 이후 대사 형식 보정이 들어갔으며 재검증 필요.'}
summary=[]
for mid,m in models.items():
 rows=[x for x in m['cases'] if 'metrics' in x];warm=[x['metrics']['llmMs'] for x in rows if not x['metrics'].get('modelLoadMs')];errs=sum(bool(x.get('dialogueError')) for x in m['cases']);passed=sum(bool(x.get('passed')) for x in m['cases'])
 summary.append({'modelId':mid,'passed':passed,'total':6,'medianWarmDecisionMs':round(statistics.median(warm)) if warm else None,'dialogueErrors':errs,'recommended':mid in ('qwen35-4b','sonic','qwen35-4b-nf4') and passed==6 and not errs,'note':notes.get(mid,'실험용 · 대화 품질은 별도 확인 필요'),'measuredAt':m['measuredAt']})
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Six fixed direct commands and actual simulated-state checks; not open-ended Korean accuracy, native S2S voice quality or a subjective quality score. Decision time is the server API round trip; shared GPU queueing is included. Movement and result dialogue are separately recorded. Guidance evolves separately and is tested with channel07-help-smoke.mjs.','models':list(models.values()),'experimentalObservations':[{'modelId':'qwen3-omni','note':'Text reasoning adapter connected, but an unfinished exploratory run produced unrelated follow-up actions after a two-step movement request. Not recommended yet; no completed six-case score assigned.'},{'modelId':'minicpm-o45','note':'An initial run executed 4/6 state checks but reply-format errors occurred. Plain-reply normalization was subsequently added; needs re-evaluation.'}]}
(root/'research/channel07-model-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
(root/'public/channel07/model-evaluation.json').write_text(json.dumps({'at':report['at'],'scope':'고정 6개 게임 명령 점검 · 차량 점수/자유 대화 품질 점수와 별개','models':summary},ensure_ascii=False,indent=2)+'\n')
for m in summary:print(m['modelId'],f"{m['passed']}/6",m['medianWarmDecisionMs'],'ms')
