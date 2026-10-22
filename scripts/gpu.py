"""Manage only this project's GPUs. Credentials stay in the AWS profile."""
import argparse,json,pathlib,subprocess,signal,time
ROOT=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('action',choices=['status','start','stop','tunnel','deploy','logs','terminate']);parser.add_argument('--confirm-instance');parser.add_argument('--worker',choices=['all','core','speech'],default='all')
args=parser.parse_args();action=args.action
paths={'core':ROOT/'.runtime/aws.json','speech':ROOT/'.runtime/speech-aws.json'}
states={name:json.loads(path.read_text()) for name,path in paths.items() if path.exists() and args.worker in ('all',name)}
if not states:raise SystemExit('이 GPU의 생성 기록이 없습니다.')
def aws(state,*arguments):
 p=subprocess.run(['aws','--profile',state['profile'],'--region',state['region'],*arguments,'--output','json'],capture_output=True,text=True,check=True)
 return json.loads(p.stdout) if p.stdout.strip() else {}
def describe(state):return aws(state,'ec2','describe-instances','--instance-ids',state['instanceId'])['Reservations'][0]['Instances'][0]
def ssh_args(ip):return ['-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+str(ROOT/'.runtime/known_hosts'),'-i',str(ROOT/'.runtime/vehicle-key'),'ubuntu@'+ip]
def status(name,state):
 instance=describe(state);state['publicIp']=instance.get('PublicIpAddress');paths[name].write_text(json.dumps(state,indent=2))
 return {'instanceId':state['instanceId'],'state':instance['State']['Name'],'type':instance['InstanceType'],'region':state['region'],'publicIp':state['publicIp'],'autoStopHours':state.get('autoStopHours',4)}
if action=='status':
 rows={name:status(name,state) for name,state in states.items()}
 if 'core' in rows:result={**rows['core'],**({'speech':rows['speech']} if 'speech'in rows else {})}
 else:result=next(iter(rows.values()))
 print(json.dumps(result,indent=2))
elif action in ('start','stop'):
 for name,state in states.items():
  current=describe(state)['State']['Name']
  if action=='start' and current in ('running','pending'):continue
  if action=='stop' and current in ('stopped','stopping'):continue
  aws(state,'ec2',action+'-instances','--instance-ids',state['instanceId']);print(name+' GPU '+('시작' if action=='start' else '중지')+' 요청 완료.')
 if action=='stop':print('GPU 시간 요금은 중지 완료 후 멈추며 EBS 저장 비용은 남습니다.')
elif action=='terminate':
 if len(states)!=1:raise SystemExit('삭제할 GPU를 --worker core 또는 speech로 지정하세요.')
 state=next(iter(states.values()))
 if args.confirm_instance!=state['instanceId']:raise SystemExit('삭제할 인스턴스를 --confirm-instance로 정확히 지정하세요.')
 aws(state,'ec2','terminate-instances','--instance-ids',state['instanceId']);print('종료 요청 완료.')
elif action=='tunnel':
 processes=[]
 def stop(*_):
  for process in processes:process.terminate()
  raise SystemExit()
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 try:
  for name,state in states.items():
   s=status(name,state)
   if s['state']!='running' or not s['publicIp']:raise RuntimeError(name+' GPU를 시작한 후 다시 실행하세요.')
   ports=[(19104,9104)] if name=='speech' else [(19101,9101),(19102,9102),(19103,9103)]+([(19105,9105)] if state.get('whisperEnabled') else [])
   command=['ssh','-N','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3']
   for local,remote in ports:command+=['-L',f'127.0.0.1:{local}:127.0.0.1:{remote}']
   processes.append(subprocess.Popen(command+ssh_args(s['publicIp'])))
  while all(p.poll() is None for p in processes):time.sleep(1)
 finally:
  for process in processes:
   if process.poll() is None:process.terminate()
else:
 for name,state in states.items():
  s=status(name,state);ip=s['publicIp']
  if s['state']!='running' or not ip:raise SystemExit(name+' GPU가 실행 중이 아닙니다.')
  if action=='logs':
   units=['vehicle-speech'] if name=='speech' else ['vehicle-core','vehicle-tts','vehicle-minicpm','vehicle-whisper']
   subprocess.run(['ssh',*ssh_args(ip),'sudo journalctl '+' '.join('-u '+unit for unit in units)+' -n 60 --no-pager'],check=True)
  elif action=='deploy':
   files=['speech_manager.py','speech_worker.py','speech_protocol.py','mimo-planner-prompt.txt','planner-schema.json','bootstrap_speech.sh','cache_speech.py'] if name=='speech' else ['model_server.py','vehicle_plan_schema.py','bootstrap.sh','minicpm_server.py','minicpm_protocol.py','bootstrap_minicpm.sh','whisper_server.py','bootstrap_whisper.sh','cache_planners.py']
   directory='/opt/vehicle-speech/' if name=='speech' else '/opt/vehicle-voice/'
   subprocess.run(['scp',*ssh_args(ip)[:-1],*[str(ROOT/'runtime'/f) for f in files],*([str(ROOT/'public/reference-neutral.wav')] if name=='core' else []),'ubuntu@'+ip+':'+directory],check=True)
   command='sudo systemctl restart vehicle-speech' if name=='speech' else 'sudo systemctl restart vehicle-core vehicle-tts; if systemctl is-enabled --quiet vehicle-whisper; then sudo systemctl restart vehicle-whisper; fi; if systemctl is-enabled --quiet vehicle-minicpm; then sudo systemctl restart vehicle-minicpm; fi'
   subprocess.run(['ssh',*ssh_args(ip),command],check=True)
