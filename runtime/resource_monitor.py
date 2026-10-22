"""Sample whole-instance resources; run on the GPU host, no credentials collected.

GPU utilization is a sampled busy percentage, not achieved FLOPS or a capacity
guarantee. GPU memory includes reservations. Host RAM uses MemAvailable.
"""
import argparse,datetime,json,pathlib,signal,subprocess,time

p=argparse.ArgumentParser()
p.add_argument('--output',required=True)
p.add_argument('--seconds',type=int,default=1800)
a=p.parse_args()
running=True
def stop(*_):
    global running
    running=False
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
def cpu():
    fields=[int(v) for v in pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    return sum(fields),fields[3]+fields[4]
previous=cpu();deadline=time.monotonic()+a.seconds
with open(a.output,'w',buffering=1) as f:
    while running and time.monotonic()<deadline:
        started=time.monotonic()
        result=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,power.draw','--format=csv,noheader,nounits'],capture_output=True,text=True,check=True)
        values=[float(v.strip()) for v in result.stdout.strip().split(',')]
        current=cpu();delta=current[0]-previous[0]
        host_busy=100*(1-(current[1]-previous[1])/delta) if delta else None
        previous=current
        mem={line.split(':')[0]:int(line.split()[1]) for line in pathlib.Path('/proc/meminfo').read_text().splitlines()}
        row=dict(zip(['gpuBusyPercent','gpuMemoryBusyPercent','gpuUsedMiB','gpuTotalMiB','gpuPowerW'],values))
        row.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),hostCpuBusyPercent=host_busy,hostMemAvailableMiB=mem['MemAvailable']/1024,hostMemTotalMiB=mem['MemTotal']/1024)
        f.write(json.dumps(row)+'\n')
        time.sleep(max(0,1-(time.monotonic()-started)))
