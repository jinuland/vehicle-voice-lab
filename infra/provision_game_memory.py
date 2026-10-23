"""Create/reuse a scoped AgentCore Memory for Channel 07. No keys leave the workstation."""
import argparse,json,os,pathlib,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--profile',default='game-forge');p.add_argument('--region',default='ap-northeast-1');p.add_argument('--runtime-role');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
def aws(service,op,data):
 with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
  json.dump(data,f);f.flush();r=subprocess.run(['aws','--profile',a.profile,'--region',a.region,service,op,'--cli-input-json','file://'+f.name,'--output','json'],text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return json.loads(r.stdout) if r.stdout.strip() else {}
name='channel07_game_memory'
items=aws('bedrock-agentcore-control','list-memories',{'maxResults':100}).get('memories',[])
m=next((x for x in items if x['name']==name),None)
if m:m=aws('bedrock-agentcore-control','get-memory',{'memoryId':m['id']})['memory']
else:m=aws('bedrock-agentcore-control','create-memory',{'name':name,'description':'Channel 07 verified gameplay incidents and cross-session character recollections. Namespace per anonymous player.','eventExpiryDuration':30,'memoryStrategies':[{'semanticMemoryStrategy':{'name':'VerifiedGameplayFacts','description':'Remember only verified game events, actual promises, and escape outcomes. Requests are not completed actions.','namespaces':['/channel07/{actorId}/facts']}}],'tags':{'Project':'vehicle-voice-lab','Feature':'channel07'}})['memory']
if a.runtime_role:
 aws('iam','put-role-policy',{'RoleName':a.runtime_role,'PolicyName':'Channel07MemoryOnly','PolicyDocument':json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':['bedrock-agentcore:CreateEvent','bedrock-agentcore:RetrieveMemoryRecords'],'Resource':m['arn']}]})})
state={'memoryId':m['id'],'region':a.region,'status':m['status']};path=root/'.runtime/game-memory-deployment.json';path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(state,indent=2));os.chmod(path,0o600)
print(json.dumps(state))
