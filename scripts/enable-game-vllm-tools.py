"""Run on the existing vLLM host. Preserve reviewed runtime options, rollback on failed health."""
import json,subprocess,time,urllib.request
run=lambda *a,**kw:subprocess.run(a,check=True,**kw)
c=json.loads(subprocess.check_output(['docker','inspect','vehicle-vllm']))[0];args=c['Config']['Cmd'];image=c['Image'];backup='vehicle-vllm-before-tools'
if '--tool-call-parser' in args:print('Tool parser already configured');raise SystemExit(0)
# Existing loopback port, GPU memory limit, image digest, model revision and model cache are retained.
run('docker','stop','vehicle-vllm');run('docker','rename','vehicle-vllm',backup)
try:
 run('docker','run','-d','--name','vehicle-vllm','--restart','unless-stopped','--gpus','all','--shm-size=2g','-p','127.0.0.1:8000:8000','-v','/opt/vehicle-compact/models:/models-cache','-e','HF_HOME=/models-cache','-e','HF_HUB_OFFLINE=1','-e','OMP_NUM_THREADS=2',image,*args,'--enable-auto-tool-choice','--tool-call-parser','qwen3_coder')
 for i in range(100):
  try:
   urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2);print('Native game tool calling ready');break
  except Exception:time.sleep(2)
 else:raise RuntimeError('New tool-enabled server failed health check')
 run('docker','rm',backup)
except Exception:
 subprocess.run(['docker','rm','-f','vehicle-vllm']);run('docker','rename',backup,'vehicle-vllm');run('docker','start','vehicle-vllm');raise
