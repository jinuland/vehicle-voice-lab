"""Readiness probe executes a synthetic plan; health/model load alone is insufficient."""
import argparse,json,urllib.request
p=argparse.ArgumentParser();p.add_argument('--url',required=True);p.add_argument('--model',required=True);p.add_argument('--quantization',default='bf16');a=p.parse_args()
body={'messages':[{'role':'system','content':'Return JSON with intent, actions, reply. Control the simulated vehicle. Actions use type, zone, value. Use temperature, passenger, 25 for this request.'},{'role':'user','content':'조수석 온도를 25도로 맞춰줘.'}],'model_id':a.model,'quantization':a.quantization,'generation_profile':'deterministic'}
r=urllib.request.Request(a.url+'/plan',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(r,timeout=120) as response:result=json.load(response)
plan=json.loads(result['text'])
assert isinstance(plan.get('actions'),list) and isinstance(plan.get('reply'),str)
print(json.dumps({'realInferenceReady':True,'model':a.model,'quantization':a.quantization,'intent':plan.get('intent')},ensure_ascii=False))
