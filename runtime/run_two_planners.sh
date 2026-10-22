#!/usr/bin/env bash
# Two independent HF model copies share one GPU; no memory/compute isolation claimed.
set -euo pipefail
cd /opt/vehicle-compact
model_id=${PLANNER_MODEL_ID:-microsoft/Phi-4-mini-instruct}
quantization=${PLANNER_QUANTIZATION:-bf16}
sudo docker build -f runtime/Dockerfile.planner -t vehicle-planner-benchmark:20261022 runtime
if sudo systemctl cat vehicle-vllm-adapter.service >/dev/null 2>&1; then sudo systemctl disable --now --no-reload vehicle-vllm-adapter; fi
sudo systemctl disable --now --no-reload vehicle-compact-core
sudo mkdir -p /etc/systemd/system/vehicle-compact-web.service.d
sudo tee /etc/systemd/system/vehicle-compact-web.service.d/engine.conf >/dev/null <<'EOF'
[Service]
Environment=CORE_URL=http://127.0.0.1:19111
Environment=CORE_URLS=http://127.0.0.1:19111,http://127.0.0.1:19112
EOF
sudo systemctl daemon-reload
for name in vehicle-hf-a vehicle-hf-b vehicle-vllm; do
 if sudo docker container inspect "$name" >/dev/null 2>&1; then sudo docker rm -f "$name"; fi
done
for spec in vehicle-hf-a:19111 vehicle-hf-b:19112; do
 name=${spec%:*}; port=${spec#*:}
 sudo docker run -d --name "$name" --restart unless-stopped --gpus all --shm-size=1g --user 1000:1000 \
  -p "127.0.0.1:${port}:9101" -v /opt/vehicle-compact:/opt/vehicle-compact:ro \
  -e HOME=/tmp -e HF_HUB_OFFLINE=1 -e OMP_NUM_THREADS=2 \
  -e "DEFAULT_PLANNER=$model_id" -e "DEFAULT_QUANTIZATION=$quantization" \
  vehicle-planner-benchmark:20261022
 # Avoid two simultaneous checkpoint-load peaks in host RAM.
 for attempt in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${port}/health" | python3 -c 'import sys,json;raise SystemExit(not json.load(sys.stdin).get("ready"))' 2>/dev/null; then break; fi
  sleep 5
 done
 curl -fsS "http://127.0.0.1:${port}/health" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d);raise SystemExit(not d.get("ready"))'
 /opt/vehicle-compact/core-env/bin/python runtime/check_planner.py --url "http://127.0.0.1:${port}" --model "$model_id" --quantization "$quantization"
done
sudo systemctl restart vehicle-compact-web
