#!/usr/bin/env bash
set -euo pipefail
cd /opt/vehicle-compact
model_id=${VLLM_MODEL_ID:-microsoft/Phi-4-mini-instruct}
revision=${VLLM_MODEL_REVISION:-cfbefacb99257ffa30c83adab238a50856ac3083}
image=${VLLM_IMAGE:-vllm/vllm-openai:v0.32.0@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34}
sudo docker image inspect "$image" >/dev/null 2>&1 || sudo docker pull "$image"
/opt/vehicle-compact/core-env/bin/python -c 'import httpx'
sudo systemctl disable --now --no-reload vehicle-compact-core
for name in vehicle-hf-a vehicle-hf-b vehicle-vllm; do
 if sudo docker container inspect "$name" >/dev/null 2>&1; then sudo docker rm -f "$name"; fi
done
sudo tee /etc/systemd/system/vehicle-vllm-adapter.service >/dev/null <<EOF
[Unit]
Description=Vehicle validated planner adapter to continuous-batching vLLM
After=network-online.target
[Service]
User=ubuntu
WorkingDirectory=/opt/vehicle-compact
Environment=VLLM_MODEL_ID=$model_id
Environment=VLLM_MODEL_REVISION=$revision
ExecStart=/opt/vehicle-compact/core-env/bin/python -m uvicorn runtime.vllm_adapter:app --host 127.0.0.1 --port 9101
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo mkdir -p /etc/systemd/system/vehicle-compact-web.service.d
sudo tee /etc/systemd/system/vehicle-compact-web.service.d/engine.conf >/dev/null <<'EOF'
[Service]
Environment=CORE_URL=http://127.0.0.1:9101
Environment=CORE_URLS=http://127.0.0.1:9101
EOF
sudo systemctl daemon-reload
extra_args=()
if [ "${VLLM_TEXT_ONLY:-0}" = 1 ]; then extra_args+=(--language-model-only); fi
sudo docker run -d --name vehicle-vllm --restart unless-stopped --gpus all --shm-size=2g \
 -p 127.0.0.1:8000:8000 -v /opt/vehicle-compact/models:/models-cache \
 -e HF_HOME=/models-cache -e HF_HUB_OFFLINE=1 -e OMP_NUM_THREADS=2 \
 "$image" --model "$model_id" --revision "$revision" \
 --served-model-name vehicle-planner --dtype bfloat16 --max-model-len 4096 \
 --max-num-seqs 16 --gpu-memory-utilization 0.75 \
 --structured-outputs-config '{"backend":"xgrammar","disable_any_whitespace":true}' "${extra_args[@]}"
sudo systemctl enable vehicle-vllm-adapter
sudo systemctl restart vehicle-vllm-adapter
for attempt in $(seq 1 120); do
 if [ "$(sudo docker inspect --format '{{.RestartCount}}' vehicle-vllm)" != 0 ]; then sudo docker logs --tail 100 vehicle-vllm; exit 1; fi
 if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then break; fi
 sleep 5
done
curl -fsS http://127.0.0.1:8000/health
/opt/vehicle-compact/core-env/bin/python runtime/check_planner.py --url http://127.0.0.1:9101 --model "$model_id"
sudo systemctl restart vehicle-compact-web
