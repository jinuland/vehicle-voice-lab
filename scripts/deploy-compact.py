"""Deploy a compact voice replica over verified SSH; never copies local credentials.

Provision an x86 NVIDIA GPU instance with an instance role for Polly first.
Register its SSH host key in the supplied known_hosts after checking the EC2 console.
The UI/API remains on loopback port 18887; use an SSH tunnel to test it.
"""
import argparse,io,json,pathlib,subprocess,tarfile,shlex

parser=argparse.ArgumentParser()
parser.add_argument('--host',required=True)
parser.add_argument('--key',required=True)
parser.add_argument('--known-hosts',required=True)
parser.add_argument('--engine',choices=['hf','vllm'],default='hf')
parser.add_argument('--planner',choices=['qwen35-4b','qwen35-4b-nf4','phi4-mini'],default='qwen35-4b-nf4')
args=parser.parse_args()
if args.engine=='vllm' and args.planner=='qwen35-4b-nf4':parser.error('This vLLM experiment supports reviewed BF16 planners only')
root=pathlib.Path(__file__).resolve().parents[1]
bundle=root/'.runtime/compact-release.tar.gz';bundle.parent.mkdir(exist_ok=True)
catalog=json.loads((root/'model-catalog.json').read_text())
catalog['defaultPlannerId']=args.planner
selected=next(model for model in catalog['models'] if model['id']==args.planner)
for model in catalog['models']:
 if model['id'] not in ([args.planner] if args.engine=='vllm' else ['qwen35-4b','qwen35-4b-nf4','phi4-mini']):model['status']='not-deployed'
files=list(root.glob('*.mjs'))+[root/n for n in ['package.json','package-lock.json','runtime/model_server.py','runtime/whisper_server.py','runtime/bootstrap_compact.sh','runtime/vllm_adapter.py','runtime/planner-schema.json','runtime/run_vllm.sh','runtime/run_two_planners.sh','runtime/Dockerfile.planner','runtime/check_planner.py','runtime/check_tokenization.py','runtime/warm_compact.py']]
files+=list((root/'public').rglob('*'))
files+=[root/n for n in ['research/vehicle-benchmark-summary.json','research/vehicle-model-comparison.csv','research/assistant-tool-latency.json']]
with tarfile.open(bundle,'w:gz') as tar:
 for file in files:
  if file.is_file():tar.add(file,arcname=file.name if file.name in ['model_server.py','whisper_server.py'] else str(file.relative_to(root)))
 data=json.dumps(catalog,ensure_ascii=False).encode();entry=tarfile.TarInfo('model-catalog.json');entry.size=len(data);tar.addfile(entry,io.BytesIO(data))
options=['-o','ConnectTimeout=15','-o','UserKnownHostsFile="'+str(pathlib.Path(args.known_hosts).resolve())+'"','-i',str(pathlib.Path(args.key).resolve())]
host='ubuntu@'+args.host
subprocess.run(['ssh',*options,host,'sudo mkdir -p /opt/vehicle-compact && sudo chown ubuntu:ubuntu /opt/vehicle-compact'],check=True)
subprocess.run(['scp',*options,str(bundle),host+':/tmp/vehicle-compact.tar.gz'],check=True)
bootstrap_env='COMPACT_DEFAULT_MODEL='+shlex.quote(selected['repo'])+' COMPACT_DEFAULT_QUANTIZATION='+shlex.quote(selected.get('quantization','bf16'))
subprocess.run(['ssh',*options,host,'tar -xzf /tmp/vehicle-compact.tar.gz -C /opt/vehicle-compact && '+bootstrap_env+' bash /opt/vehicle-compact/runtime/bootstrap_compact.sh'],check=True)
if args.engine=='vllm':
 serving_env='VLLM_MODEL_ID='+shlex.quote(selected['repo'])+' VLLM_MODEL_REVISION='+shlex.quote(selected['revision'])+' VLLM_TEXT_ONLY=1'
 subprocess.run(['ssh',*options,host,serving_env+' bash /opt/vehicle-compact/runtime/run_vllm.sh'],check=True)
