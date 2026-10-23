"""Deploy Channel 07 to an existing compact host over SSM; private temporary S3 artifact."""
import argparse,json,pathlib,subprocess,tarfile,tempfile,uuid
p=argparse.ArgumentParser();p.add_argument('--instance',required=True);p.add_argument('--profile',default='game-forge');p.add_argument('--region',default='ap-northeast-2');p.add_argument('--bucket',required=True);p.add_argument('--memory-state',default='.runtime/game-memory-deployment.json');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
def aws(service,op,data,query=None):
 with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
  json.dump(data,f);f.flush();cmd=['aws','--profile',a.profile,'--region',a.region,service,op,'--cli-input-json','file://'+f.name,'--output','json'];r=subprocess.run(cmd+(['--query',query] if query else []),capture_output=True,text=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return json.loads(r.stdout) if r.stdout.strip() else {}
memory=json.loads((root/a.memory_state).read_text())
bundle=root/'.runtime/channel07-release.tar.gz'
files=[root/x for x in ['server.mjs','game-api.mjs','game-engine.mjs','game-memory.mjs','package.json','package-lock.json','public/index.html']]
files+=list((root/'public/channel07').rglob('*'))+list((root/'public/vendor/three').glob('*'))
with tarfile.open(bundle,'w:gz') as tar:
 for file in files:
  if file.is_file():tar.add(file,arcname=str(file.relative_to(root)))
key='channel07/releases/'+str(uuid.uuid4())+'.tar.gz'
subprocess.run(['aws','--profile',a.profile,'--region',a.region,'s3','cp',str(bundle),'s3://'+a.bucket+'/'+key,'--only-show-errors'],check=True)
url=subprocess.check_output(['aws','--profile',a.profile,'--region',a.region,'s3','presign','s3://'+a.bucket+'/'+key,'--expires-in','900'],text=True).strip()
# The signed URL is never printed. The object contains public source, never .env or credentials.
commands=['set -eu',"curl -fsSL '"+url+"' -o /tmp/channel07-release.tar.gz",'tar -xzf /tmp/channel07-release.tar.gz -C /opt/vehicle-compact','cd /opt/vehicle-compact','sudo -u ubuntu env PATH=/opt/vehicle-node/bin:/usr/bin:/bin /opt/vehicle-node/bin/npm ci --omit=dev --no-audit --no-fund',"sudo sed -i '/^GAME_MEMORY_ID=/d; /^GAME_MEMORY_REGION=/d' /etc/vehicle-compact-cloud.env",f"printf '\\nGAME_MEMORY_ID={memory['memoryId']}\\nGAME_MEMORY_REGION={memory['region']}\\n' | sudo tee -a /etc/vehicle-compact-cloud.env >/dev/null",'sudo chown -R ubuntu:ubuntu /opt/vehicle-compact/public/channel07 /opt/vehicle-compact/public/vendor','sudo systemctl restart vehicle-compact-web','rm -f /tmp/channel07-release.tar.gz','sleep 2','systemctl is-active vehicle-compact-web']
r=aws('ssm','send-command',{'InstanceIds':[a.instance],'DocumentName':'AWS-RunShellScript','Parameters':{'commands':commands},'TimeoutSeconds':180})
state={'commandId':r['Command']['CommandId'],'instance':a.instance,'bucket':a.bucket,'key':key};(root/'.runtime/channel07-deploy.json').write_text(json.dumps(state,indent=2));print(json.dumps({'commandId':state['commandId'],'transport':'SSM','artifact':'private temporary S3 object'}))
