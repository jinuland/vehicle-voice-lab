"""Enable an already-created private CloudFront origin on the compact replica.

Never prints origin verification secrets or copies developer credentials.
Finish loopback benchmarks before this step: cloud mode requires the origin key.
"""
import argparse,json,pathlib,os,subprocess
p=argparse.ArgumentParser()
p.add_argument('--host',required=True);p.add_argument('--key',required=True)
p.add_argument('--known-hosts',required=True);p.add_argument('--cloud-state',required=True)
p.add_argument('--tools-state');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];state=json.loads(pathlib.Path(a.cloud_state).read_text())
assert state['url'].startswith('https://') and len(state['originSecret'])>=32
values={'BIND_HOST':'0.0.0.0','PUBLIC_ORIGIN':state['url'],'ORIGIN_HOST':state['originPrivateDns'],'ORIGIN_VERIFY_SECRET':state['originSecret']}
if a.tools_state:
 tools=json.loads(pathlib.Path(a.tools_state).read_text());values.update(AGENTCORE_GATEWAY_URL=tools['gatewayUrl'],AGENTCORE_REGION=tools['region'])
for value in values.values():
 if any(c in value for c in '\n\r"\\'):raise ValueError('Unsupported environment value')
envfile=root/'.runtime/compact-cloud.env';envfile.write_text('\n'.join(k+'='+v for k,v in values.items())+'\n');os.chmod(envfile,0o600)
options=['-F','/dev/null','-o','ConnectTimeout=15','-o','UserKnownHostsFile="'+str(pathlib.Path(a.known_hosts).resolve())+'"','-i',str(pathlib.Path(a.key).resolve())];host='ubuntu@'+a.host
subprocess.run(['scp',*options,str(envfile),host+':/tmp/vehicle-compact-cloud.env'],check=True)
command='''sudo install -m 600 -o root -g root /tmp/vehicle-compact-cloud.env /etc/vehicle-compact-cloud.env && rm /tmp/vehicle-compact-cloud.env && sudo mkdir -p /etc/systemd/system/vehicle-compact-web.service.d && printf '[Service]\\nEnvironmentFile=/etc/vehicle-compact-cloud.env\\n' | sudo tee /etc/systemd/system/vehicle-compact-web.service.d/cloud.conf >/dev/null && sudo systemctl daemon-reload && sudo systemctl restart vehicle-compact-web'''
# NVIDIA's Docker/cgroup caveat: reload systemd before (re)starting GPU
# containers, if any. Restarting these named experiment containers retains the
# selected serving mode and avoids invalidated GPU access after daemon-reload.
command+=' && for name in vehicle-vllm vehicle-hf-a vehicle-hf-b; do if sudo docker container inspect "$name" >/dev/null 2>&1; then sudo docker restart "$name" >/dev/null; fi; done'
command+=' && sudo /opt/vehicle-compact/core-env/bin/python /opt/vehicle-compact/runtime/warm_compact.py'
subprocess.run(['ssh',*options,host,command],check=True)
print(json.dumps({'url':state['url'],'origin':'private CloudFront VPC origin','developerCredentialsUploaded':False}))
