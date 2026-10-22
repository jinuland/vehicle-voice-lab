"""Write an isolated catalog for the pinned AWQ compatibility experiment.

Does not change the default catalog or deploy a service. AWQ quality must be
measured separately from NF4 and the original checkpoint.
"""
import argparse,copy,json,pathlib

p=argparse.ArgumentParser();p.add_argument('--output',required=True);a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
catalog=json.loads((root/'model-catalog.json').read_text())
checkpoint=json.loads((root/'research/rightsizing-followup/awq-checkpoint.json').read_text())
model=copy.deepcopy(next(m for m in catalog['models'] if m['id']=='qwen35-4b'))
model.update(id='qwen35-4b-awq',name='Qwen3.5-4B · AWQ 4bit experiment',repo=checkpoint['repo'],revision=checkpoint['revision'],quantization='awq',status='ready')
model.pop('evaluation',None);model.pop('demoConfig',None)
model.pop('legacyEvaluation',None);model.pop('evidence',None)
model['source']=checkpoint['source']
model['notes']='Pinned community AWQ compatibility experiment; NF4 quality scores do not apply.'
for item in catalog['models']:item['status']='not-deployed'
catalog['models'].append(model);catalog['defaultPlannerId']=model['id']
output=pathlib.Path(a.output);output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
