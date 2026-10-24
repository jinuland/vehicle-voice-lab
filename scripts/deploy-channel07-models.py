"""Attach existing vehicle workers to the game over a VPC-only, SG-restricted bridge."""
import argparse,json,pathlib,subprocess,tarfile,tempfile,uuid
p=argparse.ArgumentParser();p.add_argument('--only',choices=['core','speech']);p.add_argument('--web-instance',required=True);p.add_argument('--core-instance',required=True);p.add_argument('--speech-instance',required=True);p.add_argument('--bucket',required=True);p.add_argument('--profile',default='game-forge');p.add_argument('--region',default='ap-northeast-2');a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[1]
def aws(service,op,**data):
 with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
  json.dump(data,f);f.flush();r=subprocess.run(['aws','--profile',a.profile,'--region',a.region,service,op,'--cli-input-json','file://'+f.name,'--output','json'],capture_output=True,text=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return json.loads(r.stdout)
instances=aws('ec2','describe-instances',InstanceIds=[a.web_instance,a.core_instance,a.speech_instance]);hosts={i['InstanceId']:i for r in instances['Reservations'] for i in r['Instances']};websg=hosts[a.web_instance]['SecurityGroups'][0]['GroupId'];state={'coreUrl':'http://'+hosts[a.core_instance]['PrivateIpAddress']+':19207','speechUrl':'http://'+hosts[a.speech_instance]['PrivateIpAddress']+':19207','commands':[]}
for instance,kind in [(a.core_instance,'core'),(a.speech_instance,'speech')]:
 if a.only and a.only!=kind:continue
 host=hosts[instance];sg=host['SecurityGroups'][0]['GroupId']
 try:aws('ec2','authorize-security-group-ingress',GroupId=sg,IpPermissions=[{'IpProtocol':'tcp','FromPort':19207,'ToPort':19207,'UserIdGroupPairs':[{'GroupId':websg,'Description':'Channel07 game web to existing models only'}]}])
 except RuntimeError as e:
  if 'InvalidPermission.Duplicate' not in str(e):raise
 files=['game_proxy.py','game-schemas.json']+(['model_server.py','vehicle_plan_schema.py','minicpm_server.py'] if kind=='core' else ['speech_worker.py','speech_manager.py'])
 bundle=root/'.runtime'/('channel07-'+kind+'-workers.tar.gz')
 with tarfile.open(bundle,'w:gz') as t:
  for f in files:t.add(root/'runtime'/f,arcname=f)
 key='channel07/releases/'+str(uuid.uuid4())+'.tar.gz';subprocess.run(['aws','--profile',a.profile,'--region',a.region,'s3','cp',str(bundle),'s3://'+a.bucket+'/'+key,'--only-show-errors'],check=True)
 url=subprocess.check_output(['aws','--profile',a.profile,'--region',a.region,'s3','presign','s3://'+a.bucket+'/'+key,'--expires-in','900'],text=True).strip()
 dest='/opt/vehicle-voice' if kind=='core' else '/opt/vehicle-speech'
 unit='[Unit]\nDescription=Channel07 private model bridge\nAfter=network.target\n[Service]\nUser=ubuntu\nWorkingDirectory='+dest+'\nEnvironment=GAME_PROXY_KIND='+kind+'\nEnvironment=GAME_PROXY_BIND='+host['PrivateIpAddress']+'\nExecStart=/usr/bin/python3 '+dest+'/game_proxy.py\nRestart=always\n[Install]\nWantedBy=multi-user.target\n'
 import base64
 commands=['set -eu',"curl -fsSL '"+url+"' -o /tmp/channel07-workers.tar.gz",'mkdir -p '+dest+'/channel07-backup','cp '+dest+'/*.py '+dest+'/channel07-backup/','tar -xzf /tmp/channel07-workers.tar.gz -C '+dest,"echo '"+base64.b64encode(unit.encode()).decode()+"' | base64 -d > /etc/systemd/system/channel07-model-bridge.service"]
 if kind=='core':commands += ['mkdir -p /etc/systemd/system/vehicle-core.service.d',"printf '[Service]\\nEnvironment=PLANNER_SCHEMA_VERSION=legacy-generic-v1\\n' > /etc/systemd/system/vehicle-core.service.d/channel07-compat.conf"]
 # These two original workers are bare-metal services, not NVIDIA Docker. No reload on the compact vLLM host.
 commands+=['systemctl daemon-reload','systemctl enable --now channel07-model-bridge','systemctl restart vehicle-core vehicle-minicpm' if kind=='core' else 'systemctl restart vehicle-speech','rm /tmp/channel07-workers.tar.gz','systemctl is-active channel07-model-bridge']
 r=aws('ssm','send-command',InstanceIds=[instance],DocumentName='AWS-RunShellScript',Parameters={'commands':commands},TimeoutSeconds=180)
 state['commands'].append({'instance':instance,'commandId':r['Command']['CommandId'],'key':key})
(root/'.runtime/game-shared-workers.json').write_text(json.dumps(state,indent=2));print(json.dumps({'bridges':state['commands'],'network':'VPC private address, ingress only from game web SG'}))
