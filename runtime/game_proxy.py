"""Private VPC bridge; SG admits only game web SG. No arbitrary schema or URL forwarding."""
import json,os,urllib.request,urllib.error
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
CORE=os.environ.get('GAME_PROXY_KIND','core')=='core'
ALLOWED={'Qwen/Qwen3.5-4B','Qwen/Qwen3.5-2B','Qwen/Qwen3.5-0.8B','microsoft/Phi-4-mini-instruct','google/gemma-4-E2B-it','HuggingFaceTB/SmolLM3-3B','LGAI-EXAONE/EXAONE-4.0-1.2B','naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-0.5B','minicpm-o45'} if CORE else {'qwen3-omni','step-audio2-mini','minicpm-o45'}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200 if self.path=='/health' else 404);self.end_headers();self.wfile.write(b'{"bridge":true}')
 def do_POST(self):
  try:
   n=int(self.headers.get('Content-Length','0'))
   if self.path!='/infer' or not 0<n<=45000:raise ValueError('Invalid inference request')
   d=json.loads(self.rfile.read(n));messages=d.get('messages')
   if d.get('model_id') not in ALLOWED or d.get('schema_kind') not in ('game','game_dialogue'):raise ValueError('Unknown game model or schema')
   if not isinstance(messages,list) or not 1<=len(messages)<=16 or any(m.get('role') not in ('system','user','assistant') or not isinstance(m.get('content'),str) for m in messages):raise ValueError('Invalid history')
   port=9103 if d['model_id']=='minicpm-o45' else 9101 if CORE else 9104
   path='/plan' if CORE and d['model_id']!='minicpm-o45' else '/game-text'
   r=urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}{path}',data=json.dumps(d).encode(),headers={'Content-Type':'application/json'}),timeout=360)
   body=r.read();code=200
  except urllib.error.HTTPError as e:body=e.read();code=e.code
  except Exception as e:body=json.dumps({'detail':str(e)}).encode();code=400
  self.send_response(code);self.send_header('Content-Type','application/json');self.end_headers()
  try:self.wfile.write(body)
  except BrokenPipeError:pass
ThreadingHTTPServer((os.environ['GAME_PROXY_BIND'],19207),Handler).serve_forever()
