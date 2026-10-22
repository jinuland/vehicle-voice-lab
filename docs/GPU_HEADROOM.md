# GPU headroom and cheaper 4-bit serving

[Live cost/performance report](https://d3q7tlfor72b22.cloudfront.net/costs.html) · [Raw follow-up results](../research/rightsizing-followup/) · [Korean explanation](GPU_HEADROOM.ko.md)

## Final comparison with the same corrected tool schema

**T4 + Qwen AWQ 4bit + vLLM preserves approximately one-second sequential responses and the same common-suite pass count as L4 BF16 in this experiment.** L4 handles higher concurrency better.

| Configuration, typed-actions-v2 | Common / holdout | Common median / p95 first audio | Concurrency 4 p95 | Observed throughput, p95 ≤3 s | Compute/month, 730h |
| --- | ---: | ---: | ---: | ---: | ---: |
| L4, BF16, vLLM | 30/31 · 9/10 | 1.083 / 1.693 s | 2.699 s | 1.832/s | $722.41 |
| T4, AWQ 4bit, vLLM | 30/31 · 9/10 | 1.005 / 1.582 s | 3.159 s | 1.255/s | $472.31 |

Both pass 96/96 final load requests and all nine cabin-control holdouts. The legacy weather expectation remains a recorded holdout failure. Both share the same remaining common-suite ASR error. Equal counts in a small sample and differences of tens of milliseconds do not establish general quality equivalence or a speed advantage.

T4 instance compute is about 35% cheaper, but measured throughput at the same three-second p95 criterion is also lower. At full utilization of these observed rates, compute per 1,000 requests is approximately $0.150 for L4 and $0.143 for T4, before Polly, storage, network and operations. This is not a production capacity promise. T4 is a low-volume candidate; peak demand determines how many servers are needed. The shared public deployment stays on L4.

## Integration correction and matched re-evaluation

The first AWQ result was 29/31. A relative-temperature request omitted `zone`, while the legacy generic JSON schema required only `type`. The executor correctly rejected the invalid arguments. The [shared typed schema](../runtime/vehicle_plan_schema.py) now requires each action's actual arguments and forbids irrelevant fields. Existing range guards and execution behavior remain intact; no expected answer is injected or output normalized after inference.

Both GPUs were re-evaluated using this same schema: 31 common cases, ten holdouts and 96 load requests each. AWQ's missing-zone failure is resolved, reaching 30/31; L4 also reaches 30/31. All 657 actual vLLM input token IDs match the original pinned HF tokenizer. Before-fix data remains archived. `PLANNER_SCHEMA_VERSION=legacy-generic-v1` reproduces the generic schema; `typed-actions-v2` is the default.

T4's first successful AWQ inference took approximately 560 seconds from container creation with weights already cached but empty compiler caches. Profiling confirmed Qwen GDN kernel compilation/autotuning. This is separate from warmed request latency. Cached restart time and sustained stability have not been measured; scale-out readiness needs its own validation.

## Sharing a GPU does not mean all useful capacity has been exhausted

The selected L4 already hosts Whisper and one Qwen BF16 vLLM engine. Additional model weights can still fit in its memory. Docker separates execution environments; ordinary `--gpus all` sharing does not guarantee each container a share of GPU execution time or a latency budget.

The previous two-Phi-HF-worker experiment duplicated the **planner** and did not improve throughput. This follow-up duplicates **Whisper**, a different pipeline stage whose sequential recognition became a bottleneck. The second ASR worker ran as an isolated systemd process, without hard GPU compute or memory partitioning. Request counters of 145 and 144 verify both ASR workers were used.

## One versus two Whisper workers, on the same L4

Both configurations use the same pinned Qwen3.5-4B BF16 checkpoint on vLLM 0.32.0, the same Whisper checkpoint, Seoul Polly, validated vehicle actions, and fresh sessions. Each concurrency level contains 48 recorded Korean requests drawn from six commands. Both configurations passed 240/240 load requests.

| Concurrent request slots | One ASR, successful requests/s | Two ASRs, successful requests/s | One ASR, first-audio p95 | Two ASRs, first-audio p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.843 | 0.812 | 1.515 s | 1.533 s |
| 4 | 1.924 | 2.048 | 2.528 s | 2.429 s |
| 8 | 2.583 | 2.991 | 3.987 s | 3.531 s |
| 16 | 2.561 | 3.586 | 6.701 s | 5.822 s |
| 32 | 2.547 | 3.620 | 12.672 s | 9.706 s |

The highest observed throughput improves by about 42%, **with a 9.706-second p95**. Under the existing p95 ≤3-second comparison criterion, observed throughput improves by about 6%, from 1.924 to 2.048 requests/s. Neither is a production SLA, a sustained capacity limit, or a count of always-listening vehicles.

The two-ASR configuration also passes 30/31 common cases and 9/10 legacy holdouts. The common failure follows Whisper transcribing the navigation-stop command as a different phrase. The holdout failure is a known rubric mismatch: `holdout-weather` historically expects denial, while the current application correctly retrieves real weather. Raw scores are retained; all nine cabin-control holdouts pass. These are application results, including validators and routing, not intrinsic language-model scores.

## Resource observations

At 32 concurrent slots, mean GPU busy is 100% in both arrangements. Host CPU averages approximately 32% with one ASR and 54% with two. Minimum available GPU memory decreases from about 3.34 GiB to 1.16 GiB; minimum host `MemAvailable` decreases from about 8.83 GiB to 7.57 GiB.

GPU busy is a sampled time-busy metric, not proof that all compute units or memory bandwidth are saturated. Adding ASR still improves throughput. The earlier throughput plateau was a pipeline limit, not a proven hardware maximum. Exact hardware bottlenecks have not been profiled.

vLLM's `--gpu-memory-utilization 0.75` sets its memory budget, including reserved KV cache. It does not isolate 75% of GPU execution capacity. Spare host RAM can accommodate CPU services; spare GPU memory can accommodate additional weights, but interactive latency under peak load must be remeasured.

## Reproduction

Use `WHISPER_URLS=http://127.0.0.1:9105,http://127.0.0.1:9106` on the evaluation API to route independent sessions to the least-active ASR worker. The default remains one worker. Worker health, active requests, and counters appear in `/api/health`.

Run [serving-load-benchmark.mjs](../scripts/serving-load-benchmark.mjs) with `BENCH_CONCURRENCY=1,4,8,16,32`, `BENCH_REQUESTS=48`, and `BENCH_WARMUP_REQUESTS=4` for two ASR workers. Both must have completed real inference before measurements. Run [resource_monitor.py](../runtime/resource_monitor.py) on the GPU host and collect its JSONL output; [summarize-rightsizing-followup.mjs](../scripts/summarize-rightsizing-followup.mjs) joins samples to each load stage's timestamps.

The public API's per-IP request protection remains enabled. An initial load attempt hit that limit and is excluded. Measured follow-up runs use a separate loopback Node evaluation backend sharing the existing GPU workers, so rate limiting is not mistaken for GPU capacity. Timing includes the developer-to-Seoul SSH tunnel, excludes speech capture/endpointing/playback, and benefits from short repeated prompts and prefix caching. Long conversations, diverse traffic, soak tests, and real vehicle microphones remain outside scope.

## Cheaper T4 with NF4

A separate Seoul `g4dn.xlarge` serves the same pinned base checkpoint in bitsandbytes NF4. Because T4 has no native BF16 arithmetic, NF4 computation and remaining modules use FP16. We verify 346 Linear4bit layers and approximately 3.08 GiB of planner CUDA allocation. Models are warmed after package maintenance finishes; an initial warmup interrupted by Ubuntu's service restarts is recorded and excluded from quality scores.

| Configuration | Common suite | Holdout suite | Common median first audio | Common p95 first audio | Compute/month, 730h |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing L4, BF16, vLLM | 30/31 | Not repeated for one ASR | 1.208 s | 2.284 s | $722.41 |
| T4, NF4, HF / FP16 compute | 30/31 | 8/10 | 2.879 s | 3.930 s | $472.31 |

Instance compute is about 35% cheaper, with slower responses. The common-suite p95 already exceeds the 3-second comparison target at sequential load. The legacy weather holdout has the rubric mismatch described above. Another strict-action mismatch adds an unnecessary `zone: driver` to seat heating: the vehicle state is correct, but the raw action is not an exact match. Cabin-control final states pass 9/9, while strict cabin-control actions pass 8/9; the raw overall holdout score remains 8/10. These results establish the measured **T4 + HF NF4/FP16** behavior, not a universal disadvantage of 4-bit inference.

| T4 NF4 concurrency | Passed | Successful requests/s | First-audio p95 | Planner queue p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 24/24 | 0.284 | 4.710 s | 0 s |
| 2 | 24/24 | 0.325 | 7.305 s | 2.974 s |
| 4 | 24/24 | 0.317 | 13.690 s | 10.156 s |
| 8 | 24/24 | 0.324 | 25.559 s | 21.763 s |

All 96 load requests preserve state and receive audio. At concurrency eight, mean GPU busy is approximately 48%, minimum free GPU memory is 9.52 GiB, and mean host CPU is approximately 30%. Consequently, 0.32 requests/s is **not a proven T4 hardware maximum**. The serial HF planner queues requests without efficiently using all available hardware. Other engines or replica configurations require their own measurements.

For low request volume with a p95 ≤5-second tolerance, T4 NF4 remains a cost-saving candidate. Under that criterion, observed throughput is 0.284 requests/s for T4 versus 2.583 for the existing L4 arrangement. Compare instance price and throughput at the same latency criterion together.

The installed vLLM 0.32.0 image has no bitsandbytes backend. A vLLM 4-bit comparison therefore uses a separately pinned [community AWQ checkpoint](../research/rightsizing-followup/awq-checkpoint.json). AWQ differs from NF4 and requires its own compatibility and quality checks; it is not represented as an official Qwen AWQ release.
