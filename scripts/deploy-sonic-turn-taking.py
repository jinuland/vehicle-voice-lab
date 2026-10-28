"""Deploy only Sonic conversation code; preserve model workers, env files, and site-specific navigation."""
import argparse,io,json,pathlib,subprocess,tarfile,tempfile,uuid
p=argparse.ArgumentParser();p.add_argument('--static-only',action='store_true');p.add_argument('--include-assistant',action='store_true',help='Also deploy assistant provider/service and UI fixes');p.add_argument('--include-compound',action='store_true',help='Include compound vehicle hooks and full conversation history');p.add_argument('--target',choices=['all','original','compact'],default='all');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];bucket='channel07-releases-748254788664-ap-northeast-2'
targets={'original':('i-07da229472ba89e86','/opt/vehicle-web','vehicle-web'),'compact':('i-0080baccbaf0ca34a','/opt/vehicle-compact','vehicle-compact-web')}
files=['sonic.mjs','public/sonic-client.js','public/app.js','public/index.html','public/i18n-strings.js']
if a.include_assistant:files+=['assistant-service.mjs','assistant-providers.mjs','public/assistant-ui.js','public/timer-monitor.js']
if a.include_compound:files+=['vehicle.mjs','transcript.mjs','sonic-tool-trace.mjs','public/conversation-history.js','runtime/patch_sonic_compound.py']
if a.static_only:files=[file for file in files if file.startswith('public/')]
def aws(*args):return subprocess.check_output(['aws','--profile','game-forge','--region','ap-northeast-2',*args],text=True)
results=[]
for name,(instance,directory,unit) in targets.items():
 if a.target not in ('all',name):continue
 release=str(uuid.uuid4());bundle=root/'.runtime'/('sonic-turn-'+name+'.tar.gz')
 with tarfile.open(bundle,'w:gz') as tar:
  for file in files:
   data=(root/file).read_bytes()
   if name=='original' and file=='public/index.html':data=data.replace('<a class="pill" href="/channel07/" data-no-translate>채널 07 · 음성 게임 ↗</a>'.encode(),b'')
   info=tarfile.TarInfo(file);info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))
 key='channel07/releases/sonic-turn-'+release+'.tar.gz';aws('s3','cp',str(bundle),'s3://'+bucket+'/'+key,'--only-show-errors')
 url=aws('s3','presign','s3://'+bucket+'/'+key,'--expires-in','900').strip()
 # No unit/env changes or daemon-reload: GPU services and their cgroups remain untouched.
 backupfiles=files+(['server.mjs'] if a.include_compound and not a.static_only else [])
 patch='python3 runtime/patch_sonic_compound.py server.mjs' if a.include_compound and not a.static_only else ':'
 restart=f'systemctl restart {unit}\nsleep 2' if not a.static_only else ':'
 command=f'''set -eu
cd {directory}
backup=.runtime/sonic-turn-backup-{release}.tar.gz
for file in {' '.join(backupfiles)}; do if [ -f "$file" ]; then echo "$file"; fi; done | tar -czf "$backup" -T -
curl -fsSL '{url}' -o /tmp/sonic-turn-{release}.tar.gz
tar -xzf /tmp/sonic-turn-{release}.tar.gz
{patch}
for file in {' '.join(file for file in backupfiles if file.endswith(('.js','.mjs')))}; do
 if ! /opt/vehicle-node/bin/node --check "$file"; then tar -xzf "$backup"; exit 1; fi
done
chown ubuntu:ubuntu {' '.join(files)}
{restart}
if ! systemctl is-active {unit}; then tar -xzf "$backup"; systemctl restart {unit}; exit 1; fi
rm -f /tmp/sonic-turn-{release}.tar.gz
'''
 with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
  json.dump({'InstanceIds':[instance],'DocumentName':'AWS-RunShellScript','Parameters':{'commands':[command]},'TimeoutSeconds':90},f);f.flush()
  result=json.loads(aws('ssm','send-command','--cli-input-json','file://'+f.name,'--output','json'))
 results.append({'target':name,'instance':instance,'commandId':result['Command']['CommandId']})
(root/'.runtime/sonic-turn-deploy.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
