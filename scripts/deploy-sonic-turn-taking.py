"""Deploy only Sonic conversation code; preserve model workers, env files, and site-specific navigation."""
import argparse,io,json,pathlib,subprocess,tarfile,tempfile,uuid
p=argparse.ArgumentParser();p.add_argument('--static-only',action='store_true');p.add_argument('--include-assistant',action='store_true',help='Also deploy assistant provider/service and UI fixes');p.add_argument('--include-compound',action='store_true',help='Include compound vehicle hooks and full conversation history');p.add_argument('--asr-only',action='store_true',help='Deploy the Whisper + Sonic mode without replacing Sonic or other demo backends');p.add_argument('--transcribe',action='store_true',help='Add the streaming Transcribe comparison to the compact demo');p.add_argument('--target',choices=['all','original','compact'],default='all')
p.add_argument('--number-guard',action='store_true',help='Deploy the vehicle Sonic numeric commit guard')
a=p.parse_args()
if a.number_guard and (a.target not in ('compact','original') or a.static_only or a.asr_only or a.transcribe or a.include_assistant or a.include_compound):
 p.error('--number-guard requires --target compact or original and is a standalone deployment')
if a.asr_only and (a.static_only or a.include_assistant or a.include_compound):
 p.error('--asr-only is a standalone deployment')
if a.transcribe and (a.target not in ('compact','original') or a.static_only or a.asr_only or a.include_assistant or a.include_compound):
 p.error('--transcribe requires --target compact or original and is a standalone deployment')
root=pathlib.Path(__file__).resolve().parents[1];bucket='channel07-releases-748254788664-ap-northeast-2'
targets={'original':('i-07da229472ba89e86','/opt/vehicle-web','vehicle-web'),'compact':('i-0080baccbaf0ca34a','/opt/vehicle-compact','vehicle-compact-web')}
files=['sonic.mjs','public/sonic-client.js','public/app.js','public/index.html','public/i18n-strings.js']
if a.include_assistant:files+=['assistant-service.mjs','assistant-providers.mjs','public/assistant-ui.js','public/timer-monitor.js']
if a.include_compound:files+=['vehicle.mjs','transcript.mjs','sonic-tool-trace.mjs','public/conversation-history.js','runtime/patch_sonic_compound.py']
if a.static_only:files=[file for file in files if file.startswith('public/')]
if a.asr_only:files=[file for file in files if file.startswith('public/')]+['sonic-asr.mjs','runtime/patch_sonic_asr.py']
if a.number_guard:files=['public/sonic-client.js','sonic-number-guard.mjs','runtime/patch_sonic_numbers.py']
sources={}
if a.transcribe:
 sdk_entry=subprocess.check_output(['node','-p',"require.resolve('@aws-sdk/client-transcribe-streaming')"],cwd=root,text=True).strip()
 sdk_bundle=root/'.runtime'/'transcribe-sdk.cjs'
 subprocess.run(['npm','exec','--yes','--package=esbuild@0.28.2','--','esbuild',sdk_entry,'--bundle','--platform=node','--target=node22','--format=cjs','--legal-comments=eof',f'--outfile={sdk_bundle}'],cwd=root,check=True)
 sources['runtime/transcribe-sdk.cjs']=sdk_bundle
 files=[file for file in files if file.startswith('public/')]+['sonic-transcribe.mjs','runtime/patch_sonic_transcribe.py',*sources]
def aws(*args):return subprocess.check_output(['aws','--profile','game-forge','--region','ap-northeast-2',*args],text=True)
results=[]
for name,(instance,directory,unit) in targets.items():
 if a.target not in ('all',name):continue
 release=str(uuid.uuid4());bundle=root/'.runtime'/('sonic-turn-'+name+'.tar.gz')
 with tarfile.open(bundle,'w:gz') as tar:
  for file in files:
   data=sources.get(file,root/file).read_bytes()
   if name=='original' and file=='public/index.html':data=data.replace('<a class="pill" href="/channel07/" data-no-translate>채널 07 · 음성 게임 ↗</a>'.encode(),b'')
   info=tarfile.TarInfo(file);info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))
 key='channel07/releases/sonic-turn-'+release+'.tar.gz';aws('s3','cp',str(bundle),'s3://'+bucket+'/'+key,'--only-show-errors')
 url=aws('s3','presign','s3://'+bucket+'/'+key,'--expires-in','900').strip()
 # No unit/env changes or daemon-reload: GPU services and their cgroups remain untouched.
 backupfiles=files+(['server.mjs'] if (a.include_compound or a.asr_only or a.transcribe or a.number_guard) and not a.static_only else [])
 patch='python3 runtime/patch_sonic_numbers.py server.mjs' if a.number_guard else 'python3 runtime/patch_sonic_transcribe.py server.mjs' if a.transcribe else 'python3 runtime/patch_sonic_asr.py server.mjs' if a.asr_only else 'python3 runtime/patch_sonic_compound.py server.mjs' if a.include_compound and not a.static_only else ':'
 probe_port=8787 if name=='original' else 18887
 restart=f"""if ! systemctl restart {unit}; then tar -xzf "$backup"; systemctl restart {unit}; exit 1; fi
for attempt in $(seq 1 30); do
 if systemctl is-active --quiet {unit} && curl -s --max-time 1 -o /dev/null http://127.0.0.1:{probe_port}/api/health; then break; fi
 sleep 1
done
if ! systemctl is-active --quiet {unit} || ! curl -s --max-time 1 -o /dev/null http://127.0.0.1:{probe_port}/api/health; then tar -xzf "$backup"; systemctl restart {unit}; exit 1; fi
""" if not a.static_only else ':'
 command=f'''set -eu
cd {directory}
backup=.runtime/sonic-turn-backup-{release}.tar.gz
for file in {' '.join(backupfiles)}; do if [ -f "$file" ]; then echo "$file"; fi; done | tar -czf "$backup" -T -
curl -fsSL '{url}' -o /tmp/sonic-turn-{release}.tar.gz
tar -xzf /tmp/sonic-turn-{release}.tar.gz
if ! {patch}; then tar -xzf "$backup"; exit 1; fi
for file in {' '.join(file for file in backupfiles if file.endswith(('.js','.mjs','.cjs')))}; do
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
