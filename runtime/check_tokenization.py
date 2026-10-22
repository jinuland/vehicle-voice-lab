"""Compare actual vLLM chat input token IDs to the pinned HF tokenizer.

Read the exact application messages as a JSON list from stdin. Run before load
measurement because importing the tokenizer can consume CPU during startup.
"""
import argparse,sys,json,urllib.request
from transformers import AutoTokenizer
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--revision',required=True);p.add_argument('--url',default='http://127.0.0.1:8000');p.add_argument('--served-model',default='vehicle-planner');a=p.parse_args()
messages=json.load(sys.stdin)
tokenizer=AutoTokenizer.from_pretrained(a.model,revision=a.revision,local_files_only=True)
expected=tokenizer.apply_chat_template(messages,tokenize=True,add_generation_prompt=True,enable_thinking=False)
# Transformers 5.20 returns a BatchEncoding by default; older versions return IDs.
if hasattr(expected,'keys'):expected=expected['input_ids']
request=urllib.request.Request(a.url+'/tokenize',data=json.dumps({'model':a.served_model,'messages':messages,'add_generation_prompt':True,'chat_template_kwargs':{'enable_thinking':False}}).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request) as response:actual=json.load(response)['tokens']
result={'model':a.model,'sameInputTokenIds':actual==expected,'hfTokenCount':len(expected),'vllmTokenCount':len(actual),'thinkingEnabled':False};print(json.dumps(result));assert actual==expected
