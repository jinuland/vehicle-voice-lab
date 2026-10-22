#!/usr/bin/env bash
set -euo pipefail
cd /opt/vehicle-compact
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq python3-venv ffmpeg libsndfile1
if ! command -v uv >/dev/null; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi
export PATH="$HOME/.local/bin:$PATH"
base_python=/opt/pytorch/bin/python
if [ ! -x "$base_python" ]; then base_python=python3; fi
uv venv --system-site-packages --python "$base_python" core-env
uv pip install --python core-env/bin/python 'torch==2.14.1' 'transformers==5.20.0' accelerate fastapi uvicorn python-multipart soundfile librosa 'xgrammar==0.2.8' 'bitsandbytes==0.49.2' 'httpx==0.28.1'
HF_HOME=/opt/vehicle-compact/models core-env/bin/python - <<'PY'
from huggingface_hub import snapshot_download
models={
 'Qwen/Qwen3.5-4B':'851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',
 'microsoft/Phi-4-mini-instruct':'cfbefacb99257ffa30c83adab238a50856ac3083',
 'openai/whisper-large-v3-turbo':'41f01f3fe87f28c78e2fbf8b568835947dd65ed9',
}
for repo,revision in models.items():
 snapshot_download(repo,revision=revision,allow_patterns=['*.json','*.jinja','*.safetensors','*.model','tokenizer*','*.txt','*.tiktoken'])
 print('Cached',repo,flush=True)
PY
planner_model=${COMPACT_DEFAULT_MODEL:-Qwen/Qwen3.5-4B}
planner_quantization=${COMPACT_DEFAULT_QUANTIZATION:-nf4}
for role in core whisper; do
  script=model_server.py; port=9101
  if [ "$role" = whisper ]; then script=whisper_server.py; port=9105; fi
  sudo tee /etc/systemd/system/vehicle-compact-${role}.service >/dev/null <<EOF
[Unit]
Description=Compact vehicle ${role} serving replica
After=network-online.target
[Service]
User=ubuntu
WorkingDirectory=/opt/vehicle-compact
Environment=HF_HOME=/opt/vehicle-compact/models
Environment=HF_HUB_OFFLINE=1
Environment=TOKENIZERS_PARALLELISM=false
Environment=COMPACT_SERVING=1
Environment=DEFAULT_PLANNER=${planner_model}
Environment=DEFAULT_QUANTIZATION=${planner_quantization}
ExecStart=/opt/vehicle-compact/core-env/bin/python -m uvicorn ${script%.py}:app --host 127.0.0.1 --port ${port}
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
done
if [ ! -x /opt/vehicle-node/bin/node ]; then
  node_build_dir=$(mktemp -d)
  (cd "$node_build_dir"
   curl -fsS https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o sums.txt
   node_archive=$(awk '/node-v22\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ {print $2}' sums.txt)
   [[ "$node_archive" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]]
   curl -fsS "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$node_archive"
   awk -v file="$node_archive" '$2==file' sums.txt | sha256sum -c -
   sudo mkdir -p /opt/vehicle-node
   sudo tar -xJf "$node_archive" -C /opt/vehicle-node --strip-components=1)
  rm -rf "$node_build_dir"
fi
export PATH=/opt/vehicle-node/bin:$PATH
npm ci --omit=dev --no-audit --no-fund
sudo tee /etc/systemd/system/vehicle-compact-web.service >/dev/null <<EOF
[Unit]
Description=Loopback-only compact voice evaluation backend
After=network-online.target
[Service]
User=ubuntu
WorkingDirectory=/opt/vehicle-compact
Environment=PORT=18887
Environment=BIND_HOST=127.0.0.1
Environment=AWS_CREDENTIAL_MODE=instance
Environment=AWS_REGION=ap-northeast-2
Environment=CORE_URL=http://127.0.0.1:9101
Environment=WHISPER_URL=http://127.0.0.1:9105
Environment=COMPACT_SERVING=1
Environment=INSTANCE_TYPE=${COMPACT_INSTANCE_TYPE:-g6.xlarge}
ExecStart=/opt/vehicle-node/bin/node server.mjs
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
sudo systemctl enable --now vehicle-compact-core vehicle-compact-whisper vehicle-compact-web
echo 'COMPACT BOOTSTRAP COMPLETE'
