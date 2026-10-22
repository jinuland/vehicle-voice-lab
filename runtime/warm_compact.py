"""Wait for readiness and warm a full synthetic voice turn before sharing.

Cloud-mode origin keys are read locally as root, never printed or passed in argv.
No developer credentials are read. The test owns a new simulated cabin session.
"""
import base64,json,pathlib,time,urllib.request,urllib.error
root=pathlib.Path('/opt/vehicle-compact');headers={}
envfile=pathlib.Path('/etc/vehicle-compact-cloud.env')
if envfile.exists():
 values=dict(line.split('=',1) for line in envfile.read_text().splitlines() if '=' in line)
 headers['X-Vehicle-Origin-Key']=values['ORIGIN_VERIFY_SECRET']
base='http://127.0.0.1:18887/api/'
def request(path,body=None,extra=None):
 h={**headers,**(extra or {})}
 if body is not None:h['Content-Type']='application/json'
 return urllib.request.urlopen(urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=h),timeout=120)
deadline=time.monotonic()+600
while True:
 try:
  with request('health') as response:ready=json.load(response).get('ready')
 except (OSError,urllib.error.URLError):ready=False
 if ready:break
 if time.monotonic()>deadline:raise TimeoutError('Compact serving did not become ready')
 time.sleep(2)
with request('session',{}) as response:session=json.load(response)
planner=json.loads((root/'model-catalog.json').read_text())['defaultPlannerId']
payload={'audio':base64.b64encode((root/'public/sample-command.wav').read_bytes()).decode(),'plannerId':planner,'asrId':'whisper','ttsProvider':'polly','inputMode':'file','promptVersion':'compact-v2','generationProfile':'deterministic'}
started=time.monotonic();first=None;metrics=None;audio_bytes=0;event=None
with request('turn',payload,{'X-Session-Id':session['id']}) as response:
 for raw in response:
  line=raw.decode().strip()
  if line.startswith('event: '):event=line[7:]
  elif line.startswith('data: '):
   data=json.loads(line[6:])
   if event=='error':raise RuntimeError('Synthetic voice warmup failed: '+str(data.get('error','unknown'))[:160])
   if event=='audio':
    if first is None:first=round((time.monotonic()-started)*1000)
    audio_bytes+=len(base64.b64decode(data['audio']))
   elif event=='done':metrics=data.get('metrics')
assert metrics and metrics['state']['temperature']['passenger']==25 and audio_bytes>44
print(json.dumps({'ready':True,'plannerId':planner,'syntheticVoiceWarmupFirstAudioMs':first,'audioBytes':audio_bytes,'simulatedPassengerTemperature':25,'privateOriginKeyPrinted':False}))
