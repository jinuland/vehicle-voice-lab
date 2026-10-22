# GPU right-sizing and shared serving experiment

This experiment deploys **one Seoul g6.xlarge (one L4, 4 vCPU, 16 GiB host RAM)** beside the existing L40S demo. Existing sharing GPUs stay on. Prices were retrieved from the AWS Price List API on 2026-10-22; performance is measured on the new instance, not extrapolated from a larger GPU.

**Selected configuration:** Qwen3.5-4B BF16 text-only on vLLM, colocated with Whisper. Common-suite pass 30/31; median first audio 1.208 s. At 8 closed-loop request slots: 2.405 successful requests/s, p95 first audio 4.197 s. Same-model Phi comparisons demonstrate the batching benefit; Qwen is a separate candidate selected for its stronger common-suite accuracy. See the [Korean result explanation](GPU_RIGHTSIZING.ko.md).

[Interactive cost and performance report](https://d3q7tlfor72b22.cloudfront.net/costs.html) · [Raw experiment summary](../research/rightsizing-l4/summary.json) · [Cost assumptions](../research/rightsizing-l4/cost-assumptions.json)

## What is being measured

1. Run the same 31 Korean recorded vehicle commands through Qwen3.5-4B BF16, Qwen3.5-4B NF4 and Phi-4 mini BF16. They include seat-specific temperature, relative changes, compound actions, questions, clarification, unsupported requests, correction and undo. Reuse the historical pass rules: actions, resulting state, required answers and audio must all pass.
2. Select a fast model with at least 90% on this small application suite. This is an experiment gate, not a production quality target or a general model benchmark.
3. Compare **one serial Hugging Face worker**, **two Docker copies on the same L4**, and **one vLLM server with continuous batching**. Use 24 requests at each closed-loop concurrency level 1/2/4/8. Each request creates an independent cabin session and includes real Whisper recognition, planner inference, validated state changes and Polly audio. The six-command load pool is distinct from the 31-case quality suite.
4. Recheck the full quality suite after changing the engine. Check complete state and received audio under load; model output alone does not count as success.

First-audio latency starts before session creation/file submission and ends at the first received audio event. It includes the developer-to-Seoul SSH tunnel RTT; it excludes microphone endpointing, playback, and human speech duration. Cold model loading is reported separately. HF planner queue time is measured at its lock; vLLM adapter planner time includes upstream scheduling and inference, so its queue column is left blank rather than fabricated. Compare end-to-end latency and successful throughput across engines. p95 over 24 or 31 samples is noisy. This is a short closed-loop experiment, not an open-loop arrival test, soak test, maximum capacity estimate or production SLA. Repeated inputs and common system prompts can benefit vLLM prefix caching.

The same-model engine experiment uses Phi for all three modes. A further Qwen BF16 text-only vLLM candidate is measured separately after Phi loses one common-suite case under the new engine; it is not mixed into the three-way same-model comparison. Qwen disables thinking explicitly via chat-template kwargs and skips multimodal input/vision profiling using the official `--language-model-only` configuration.

## Same GPU, different ways to share it

| Arrangement | What shares the GPU | Memory behavior | Who manages requests / instances |
| --- | --- | --- | --- |
| One HF worker | Whisper and one planner | One planner copy; planner lock serializes inference | Application handles sessions; no GPU batching |
| Two Docker workers | Whisper and two independent planners | Two copies of weights and CUDA contexts | Application routes to the least-active worker, round-robin on ties; Docker does not schedule inference |
| One vLLM worker | Whisper and one planner engine | One weight copy plus shared KV-cache pool | vLLM continuously batches planner requests; application owns cabin state and validation |
| Multiple GPU machines | Separate worker pools | Weights copied per GPU / replica | ECS/Kubernetes/SageMaker or an explicit autoscaler places and scales instances |

Docker containers can see the same GPU, but `--gpus all` does not reserve a fixed share of memory or compute. Two replicas compete for the same hardware and need not improve throughput. These tests use neither MIG partitions nor CUDA MPS. A two-container failure also has the same single-host failure domain.

This deployment already colocates two different models: Whisper ASR and a text planner. Polly speech synthesis runs as an external AWS service. Two planner containers below mean two copies of the same model, not two physical GPUs. Different base models can also have separate containers on one GPU when their weights, KV caches, CUDA contexts and request peaks fit together; this experiment does not measure every mixed-model combination. A normal vLLM engine serves one base model and batches its requests; it does not automatically place an arbitrary catalog of different base models.

vLLM does not automatically create EC2 instances, scale Whisper, execute vehicle tools or isolate cabin sessions. It accelerates supported model inference. Scale the GPU fleet separately using queue delay, end-to-end p95, throughput and memory pressure; GPU utilization alone is insufficient. Keep capacity for bursts and at least one warm replica if cold-start latency matters. High availability requires separate instances and raises the break-even point.

## Cost model you can change

```text
GPU option = sum(instance on-hours) × hourly price + requests × Polly characters × $16 / 1,000,000
Sonic option = requests × measured example inference cost
Break-even requests = fixed GPU cost / (Sonic example cost per request − Polly cost per request)
```

At **$0.9896/hour × 730 hours**, one L4 costs **$722.41/month** before storage and networking. With 20 Polly characters per response, voice synthesis adds $0.00032/request. One new-session Sonic 2.5 calibration had 5.12 seconds of input audio, 3.04 seconds of output, 256/64 input/output speech tokens and 1354/79 text tokens. Tokyo list rates imply **$0.0027131898/request** for that one example. It is not a representative conversation average or an invoice. Korean is not an officially supported Sonic language; the comparison does not assert equal language quality.

Under those assumptions one always-on L4 crosses at **about 302,000 commands/month (about 10,000/day)**. Two always-on L4 instances cross near 604,000/month. **Two containers on one L4 still have one instance's fixed GPU cost**. Extra replicas are useful only when they improve successful throughput at the required latency. If two servers run only during peaks, count their actual aggregate on-hours instead of pricing them both for 730 hours.

The calculator excludes common web/backend cost, EBS, CloudFront/network, external tools, operations, taxes and discounts. Keeping the existing L40S experiment running adds its cost to the account; the comparison is between dedicated service designs. Current model latency is not proof that one L4 can serve any monthly volume or peak arrival pattern.

A T4 g4dn.xlarge lists at $0.647/hour in Seoul but has 16 GB VRAM and needs FP16/runtime adaptation; it is an untested alternative, not a measured recommendation. g6.2xlarge has the same L4 with more host CPU/RAM at $1.20208/hour: consider it if host-side recognition or scheduling becomes the bottleneck. These prices do not imply measured performance.

## Reproduce without changing the existing demo

Use an x86 NVIDIA GPU instance with a reviewed AMI, NVIDIA driver/container toolkit, an instance role allowing the required Polly calls, and a verified SSH host key. `scripts/deploy-compact.py` copies an explicit allowlist; local AWS credentials and `.runtime` secrets are excluded. `runtime/bootstrap_compact.sh` installs pinned core inference dependencies and separate loopback core/Whisper/web services. It initially enables Qwen BF16/NF4 and Phi; do not expose modes that the selected engine cannot serve.

For the final selected configuration, use `--engine vllm --planner qwen35-4b` with `scripts/deploy-compact.py`; it prepares the catalog for only the pinned Qwen planner and starts the text-only vLLM adapter/engine. An official compatible NVIDIA GPU AMI must already provide Docker and the NVIDIA container runtime. With no engine override the helper retains the three-candidate HF comparison profile.

```bash
python3 scripts/deploy-compact.py --host YOUR_GPU_HOST --key /secure/key --known-hosts /secure/known_hosts
# Open an SSH tunnel to the loopback backend on 18887 before running the benchmarks.
BENCH_BASE=http://localhost:18887/api/ BENCH_ASR=whisper BENCH_PROMPT=compact-v2 \
 BENCH_REPORT_DIR=research/rightsizing-l4/common \
 node scripts/vehicle-benchmark.mjs qwen35-4b qwen35-4b-nf4 phi4-mini
BENCH_BASE=http://localhost:18887/api/ BENCH_MODELS=phi4-mini \
 BENCH_CONCURRENCY=1,2,4,8 BENCH_REQUESTS=24 \
 BENCH_REPORT_DIR=research/rightsizing-l4/single node scripts/serving-load-benchmark.mjs
```

Readiness probes run a synthetic `/plan` request after weights load; a bare `/health` response does not prove that lazy Triton compilation or generation works. The Docker image includes a compiler and Python headers required for that first inference.

After copying the `runtime` helper files and latest backend, use `runtime/run_two_planners.sh` for the same-host Docker trial, then `runtime/run_vllm.sh` for the vLLM trial. These scripts operate only on `/opt/vehicle-compact`, its compact services and their specifically named experiment containers; they do not manage the original demo. Mode changes disable the unused HF core/adapter at boot to avoid a second model process or port conflict after an instance restart. The selected vLLM container uses `unless-stopped`; Whisper, the API and adapter have enabled systemd services. Replacing an existing compact deployment stops only this experiment’s named services/containers and resets its internal engine ports, so it requires a maintenance window. A full instance reboot was not part of this benchmark.

The Docker HF image mounts the already pinned venv/cache from the same host, so it is a reproducible experiment helper, not a portable production image. Build an immutable image and pin its digest for production.

vLLM uses official image tag `v0.32.0` pinned to digest `sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34`, pinned Phi model revision, BF16, context 4096, max 16 sequences, a 75% GPU memory pool, and an xgrammar JSON schema with unbounded whitespace disabled. Its adapter keeps the same validated `/plan` contract, rejects mismatched models and incomplete output, and leaves Whisper and Polly unchanged. Rerun the common suite and load test into separate `two-workers` / `vllm` directories, then run `node scripts/summarize-rightsizing.mjs`. Do not pull/build images during latency measurement.

After configuring a precreated distribution, `scripts/publish-compact.py` reads the private cloud state, enables the origin environment and waits for `runtime/warm_compact.py` to complete a real synthetic audio → state → audio turn. This warms lazy schema/first-request work as well as checking the selected deployment. On the public URL, the first post-restart browser request took 7.54 s; a warm recorded voice request reached browser playback in 1.256 s and a typed compound request in 1.407 s. These are individual smoke checks, not replacements for the benchmark distribution.

The public deployment uses a separate CloudFront VPC origin, origin verification secret and private-only inference ports. Origin secrets remain in ignored runtime files or root-owned environment files. The original public distribution is untouched.

The first controlled single-request result also illustrates a memory/speed tradeoff: Qwen BF16 and NF4 both passed 30/31, but BF16 first-audio median was 1.577 s versus NF4 2.024 s. Planner allocation fell from about 8.46 GiB to 3.08 GiB with NF4. Quantization saved memory here; it did not improve this deployment’s latency. Phi BF16 passed 29/31 with a 1.462 s median and was selected for the engine-sharing experiment. These small differences do not establish a universal model ranking.

References: [AWS G6](https://aws.amazon.com/ec2/instance-types/g6/), [AWS inference autoscaling](https://docs.aws.amazon.com/eks/latest/userguide/ml-inference-autoscaling.html), [vLLM Phi recipe](https://docs.vllm.ai/projects/recipes/en/stable/Microsoft/Phi-4.html), [vLLM Docker](https://docs.vllm.ai/en/stable/deployment/docker/), [vLLM structured outputs](https://docs.vllm.ai/en/stable/features/structured_outputs/), [NVIDIA container setup](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
