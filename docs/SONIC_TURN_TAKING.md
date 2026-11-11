# Sonic turn-taking and interruption

Updated: 2026-10-28 (KST).

Sonic uses a continuous 16 kHz PCM input stream. The browser must keep sending real microphone samples even after a user transcript arrives or while an assistant reply is pending. A transcript is not a reliable client-side signal that the person has finished speaking.

The previous client replaced microphone samples with zeros when the generic interruption checkbox was off and either `awaiting` or the playback queue was active. That checkbox defaulted to off. This could suppress the rest of a request following an early end-of-turn prediction, and prevented native barge-in. The Sonic path now always forwards PCM; the generic checkbox applies only to utterance-based models. On Sonic's interruption signal, both scheduled playback and held audio are discarded.

## Two different waiting settings

- **Model turn detection:** `SonicSession` defaults to `endpointingSensitivity: LOW`. The system instruction treats fillers such as “um”, “uh”, “어”, and “음” as an unfinished request. LOW is more patient than MEDIUM, but does not guarantee that the model will wait through every hesitation. [AWS turn-taking documentation](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-turn-taking.html).
- **Client playback waiting:** when the microphone is active, generated audio is held until the selected quiet period after the last detected voice activity. The default is **2.5 seconds**; the Sonic settings offer **1 / 2.5 / 4 seconds**. This is an application audio buffer, separate from Bedrock's end-of-turn setting. It does not stop input streaming. Resumed speech extends the playback deadline, and an interruption discards the old held reply. Text/file submissions do not use the microphone guard.

A sufficiently long pause can still allow a reply to play. A longer setting trades responsiveness for more time to think. Microphone voice activity currently uses the existing RMS threshold of 0.018; background noise and speaker echo need validation on real devices. Browser echo cancellation remains enabled. The guard delays audio playback; it does not defer model-side reasoning or tool execution.

Sonic's barge-in is a supported native feature. The application handles its interruption signal and removes buffered output, as required by the [AWS client implementation guidance](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-barge-in.html).

## Verification

1. Regression tests stream over 40 seconds of synthetic microphone frames through the client while transcript/pending/playback states change. Speech is never replaced with zeros. Additional tests cover the quiet-period deadline, resumed fillers, pending playback completion, and discarding interrupted buffers.
2. `scripts/sonic-turn-taking-smoke.mjs` sends 24.43 seconds of English PCM through a deployed Sonic WebSocket: a request introduction, three “um, uh, let me think” clips with 1.4-second gaps, and a final command for passenger temperature 23°C and fan level 3. This raw transport comparison bypasses the browser guard. In the initial LOW-only checks, audio packets arrived before the final command, so the stricter no-early-output assertion failed even though the final vehicle actions succeeded. Audio packet arrival alone is not an audibility measurement.
3. `scripts/sonic-client-stream-probe.mjs` runs the actual client microphone/queue code against the deployed WebSocket, using a WebAudio test double to inspect scheduled PCM. It verifies no audible scheduled output before the input ends and checks the final vehicle state. With the 2.5-second guard, both demos passed; first audible playback was approximately 2.51 seconds after the synthetic input ended. This test is not a physical microphone, echo-cancellation, or human conversation evaluation.

Prepare the synthetic inputs and run the guarded test:

```sh
AWS_PROFILE=game-forge node scripts/sonic-turn-taking-smoke.mjs --prepare-only
TEST_BASE=https://d3q7tlfor72b22.cloudfront.net node scripts/sonic-client-stream-probe.mjs
TEST_BASE=https://dys3pnz3y08gk.cloudfront.net node scripts/sonic-client-stream-probe.mjs
```

The synthetic traces are written under `.runtime/sonic-turn-tests/`, which is excluded from Git. This change does not introduce persistent recording of visitor conversations.

For a human test, reload the demo, select Sonic and English (or Korean), enable the microphone, and speak a longer request with brief fillers. Check that the last instruction is applied. Then talk during an assistant response and confirm playback stops. Try the 4-second setting for longer thinking pauses. Keep speaker/headset, browser and the selected waiting time with the test result.

## Korean ASR comparison mode

Added on 2026-11-11 (KST) to the [compact demo](https://d3q7tlfor72b22.cloudfront.net/?lang=ko). Choose **Nova 2.5 Sonic → Sonic input mode → Whisper + Sonic**. Use the same sample, file or spoken request in both modes. The default Sonic mode still streams microphone PCM to Bedrock in Tokyo and supports native barge-in.

The comparison mode transcribes each utterance using the existing Whisper large-v3-turbo worker on the Seoul L4 instance. It sends only the resulting text as a user message over the [Sonic cross-modal API](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-cross-modal.html). Sonic still performs reasoning, calls the same tools and streams its own audio. This path is turn-based and has no hands-free barge-in; use **Stop** to interrupt. Neither path establishes official support for Korean Sonic speech. See the [AWS service card](https://docs.aws.amazon.com/ai/responsible-ai/nova-2-sonic/overview.html).

For microphones, the browser opens Sonic ahead of time and captures an utterance locally. End-of-speech wait is 850 ms by default, configurable to 650 or 1,400 ms. Only a short tail of silence is sent to Whisper, and there is no additional 2.5 s native playback hold. Files need no end-of-speech wait. If the Sonic connection is cold, it opens concurrently with transcription. The first playback metric includes the endpointing wait and ASR for microphone turns.

| Ten synthetic utterances, same demo and tools | Native Sonic | Whisper + Sonic |
| --- | ---: | ---: |
| Task check and audio passed | 9/10 | 10/10 |
| First audio packet, median | 1,462 ms | 870 ms |
| First audio packet, observed range | 364–2,774 ms | 731–1,481 ms |
| External ASR endpoint processing range | — | 112–236 ms |

Five routine prompts plus five cases selected from the old benchmark failures were replayed once per mode. Timings are from the end of native file playback or external ASR upload start, with the Sonic connection ready. Browser VAD, microphone noise, and playback delay are excluded. The selection is a functional check and cannot estimate population error rates or real microphone latency. In one paired case the native transcript rendered “음량” as “응량” and did not set the volume; Whisper rendered it correctly and Sonic set volume 20. Whisper itself rendered “열선” as “열성” in another case, but the action still succeeded.

Re-run with `AWS_PROFILE=game-forge TEST_BASE=https://d3q7tlfor72b22.cloudfront.net node scripts/sonic-asr-ab.mjs`; set `TEST_SUITE=regression` for the five historical failure cases. Output stays in `output/` and contains only synthetic data.

The compact demo also offers **Amazon Transcribe + Sonic · Streaming**. [Amazon Transcribe](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html) supports Korean streaming and [custom vocabularies](https://docs.aws.amazon.com/transcribe/latest/dg/custom-vocabulary-using.html). This demo uses `ko-KR` in Seoul. The server starts Transcribe when speech begins, sends 16 kHz mono PCM in 100 ms chunks, and gathers final segments until the utterance ends. It submits one transcript to the existing Tokyo Sonic session. The user's PCM is sent only to Transcribe; the server sends silence to Sonic to maintain cross-modal input. No partial transcript can call a tool. The runtime permission is limited to starting a Transcribe stream from the compact instance in Seoul.

The streaming mode uses the same configurable microphone endpointing wait as the Whisper mode, with no extra Sonic playback hold. For Transcribe the ASR metric is time to finalize **after** the endpoint, since recognition starts while the user speaks. The first playback metric includes the browser's endpointing wait. A user who pauses for a second while correcting a request can select **1.4 s** in voice settings; the default 0.85 s can split that speech into two turns. Full-duplex barge-in is still a feature of native Sonic only.

### Original shared demo comparison modes

On 2026-11-12 (KST), the same three input choices and numeric commit guard were enabled on the [original shared demo](https://dys3pnz3y08gk.cloudfront.net/?lang=ko), using the original instance's local Whisper endpoint and Seoul Transcribe streaming. Both demo URLs are separate backends. A three-case synthetic smoke run on the original passed compound-seven and negative in all modes; the correction case passed in native and Whisper, while Transcribe missed the final number and asked again without changing either seat temperature. Native blocked the premature 29°C action and applied 24°C once. These are functional checks, not a quality or latency benchmark. The run is in `output/original-sonic-comparison/`.

### Difficult Korean utterance comparison

On 2026-11-11 (KST), 12 identical synthetic utterances were replayed through each of the three deployed modes. The fixtures use Polly Seoyeon, Jihye, and Hyunduk. Cases include a seven-action command, a 1.25 s correction pause, a negative instruction, place names, an English initialism, native Korean numbers, a range rejection, a quiet sample and three synthetic low-frequency noise conditions (3, 5 and 7 dB target SNR). They contain no human or customer recordings.

| Metric | Native Sonic | Whisper + Sonic | Transcribe + Sonic |
| --- | ---: | ---: | ---: |
| Character error rate (lower is better) | 5.9% | 3.4% | 3.1% |
| Final task and audio checks passed | 11/12 | 11/12 | 10/12 |
| First audio packet, median / p95 | 1,552 / 2,694 ms | 1,005 / 1,855 ms | 826 / 1,519 ms |
| Final transcript after input end, median | 736 ms | 267 ms | 92 ms |
| Cases with a vehicle action before input ended | 1/12 | 0/12 | 0/12 |

The character metric compares the emitted transcript to the written fixture. It ignores punctuation, spaces and case, and treats the fixture's equivalent Korean and Arabic numerals as the same. A wrong value can have low character edit cost but still fail the task. The task check uses the resulting simulated settings and a normal audio reply; the early action count is separate. First audio is measured after the last audio frame for the two streaming inputs, or the start of the complete WAV upload for Whisper. Sonic was already connected. The results exclude microphone endpointing and browser playback. At 12 samples, p95 is the highest observation.

| Test | Native Sonic | Whisper + Sonic | Transcribe + Sonic |
| --- | --- | --- | --- |
| Seven settings in one request | Pass | Pass | Pass |
| Pause then correct passenger 29°C to 24°C | Passed final state; temporarily set 29°C before speech ended | Pass | Lost the corrected value; applied neither |
| Keep A/C on; turn only defrost on | Pass | Pass | Pass |
| Suwon Convention Center to Gwanggyo Jungang Station | Pass | Pass | Pass |
| KTX Gwangmyeong Station and A/C off | Pass | Pass | Pass |
| Two seat temperatures and seat heater, 7 dB noise | Pass | Pass | Pass |
| Volume 45 and fan 6, 3 dB noise | Pass | Set volume 40 | Set fan 1 |
| Quiet passenger temperature and seat heater | Pass | Pass | Pass |
| 90-second break timer | Pass | Pass | Pass |
| Reject 40°C request | Pass | Pass | Pass |
| Native Korean number forms for 23°C and level 1 | Pass | Pass | Pass |
| Abbreviated defrost and volume instruction, 5 dB noise | Turned defrost off | Pass | Pass |

Run with `AWS_PROFILE=game-forge TEST_BASE=https://d3q7tlfor72b22.cloudfront.net node scripts/sonic-asr-challenge.mjs`. Add `TEST_CASE=correction-pause` to repeat just that case. WAVs and the full report are written to `output/sonic-asr-challenge/`. The degree symbol normalization added after the comparison does not affect these 12 clips: none of their Transcribe transcripts contained that symbol. The built-in passenger temperature clip exercised that notation separately.

### Human speech and real cabin noise

The human-speech pilot uses eight Korean test clips from [Google FLEURS](https://huggingface.co/datasets/google/fleurs) (CC BY 4.0; `ko_kr/test` row indices 0, 1, 2, 9, 24, 31, 37, 40). The same 16 kHz utterances were replayed unchanged and mixed offline with channel 08 of [DEMAND TCAR](https://zenodo.org/records/1227121) (Thiemann, Ito and Vincent; CC BY-SA 3.0), recorded in a passenger cabin. Noise starts at 12 s plus 19 s per clip and is scaled to +5 dB RMS SNR. These are real recordings of speech and real recordings of vehicle noise combined offline. They were not captured together in a moving vehicle. The source clips are read speech, not vehicle commands, so the table does not score control success.

| Condition | Metric | Native Sonic | Whisper + Sonic | Transcribe + Sonic |
| --- | --- | ---: | ---: | ---: |
| Original human speech | Normalized character error | 4.8% | 2.2% | 1.5% |
| Original human speech | Median first response audio after input | 1,049 ms | 619 ms | 451 ms |
| Human speech + recorded cabin noise | Normalized character error | 6.3% | 2.2% | 1.5% |
| Human speech + recorded cabin noise | Median first response audio after input | 1,035 ms | 676 ms | 427 ms |

The timing basis is the last streamed frame or the start of complete WAV upload for Whisper. It excludes browser playback and microphone endpointing. Native Sonic began generating audio before the end of two clips in each condition, so its medians include six of eight clips; these are server packets, not proof that the browser played them before the user finished. The other medians include eight clips. The small, fixed pilot cannot estimate fleet accuracy. The secondary score normalizes spaces, punctuation, date and unit forms, and equivalent number or score notation; the raw harness score and normalized report are both retained.

All three transcripts deviated from the published reference in two clips in each condition. In row 0, the phrase “다리 밑” became “다리미” or “다리 및.” In row 24, all three rendered “오늘날” as “어느 날.” No vehicle command failed in all three modes in the earlier 12-command synthetic comparison.

The replay script accepts `TEST_MANIFEST` and `TEST_OUT`. The manifest has a `cases` array with `id`, `file` (16 kHz PCM WAV), `text` (reference), and optionally `expected` (a map such as `{"temperature.passenger":24}`), `sourceId`, `condition`, and `snr`. With no `expected`, the task is recognition only. Apply `scripts/sonic-human-score.py` to the FLEURS reports to reproduce the normalized score.

### Commit protection for corrected numbers

Native Sonic may start a tool call before the whole request has finished. The vehicle simulator now checks elapsed quiet time before committing a temperature, fan, seat heat or volume action from native audio. It waits only the remainder of a 1.4 s quiet window and cancels the pending action if voice resumes. A new Sonic user transcript can propose a new action. An explicit file end releases a pending action without an extra quiet wait. The voice activity estimate uses PCM amplitude, so physical cabin noise, echo, and long pauses still need field testing.

All three Sonic inputs check a model's temperature proposal against a clearly spoken correction in the transcript. A stale proposal, conflicting seat, or missing/out-of-range final value leaves settings unchanged and returns a tool result for clarification. This check adds no separate service call. It cannot detect that a recognizer confidently turned 24 into another plausible value such as 25. Whisper and Transcribe microphone modes still use the configured utterance boundary; select 1.4 s for users who pause during corrections.

On the same prior 1.25 s correction fixture (synthetic), native Sonic previously applied 29°C then 24°C. With the guard it canceled the first call after 101 ms of waiting and only applied 24°C, with no action before speech end. First audio was 1,621 ms after input in the guarded replay without an explicit end event versus 1,335 ms in the earlier replay. With the explicit file end event, a second replay also committed only 24°C and returned first audio at 1,340 ms. In the seven-setting replay the tool already arrived after the quiet window; the guard recorded 0 ms of wait. These are individual observations, not a latency SLA. Whisper applied 24°C; Transcribe still missed “24” and asked for the final temperature without changing it. This fixture verifies the commit behavior separately from the human-speech recognition pilot.

### Transcribe input level experiment

An opt-in CPU-only gain stage (`SONIC_TRANSCRIBE_GAIN=2`) raises each Korean PCM chunk by up to 2×, limiting gain to available headroom. It retains the same stream cadence and makes no second inference request. In the unchanged 12-command fixtures replayed from the same local backend against AWS, control success improved from 10/12 to 11/12 and normalized character error remained 3.1% in both runs. Median final-transcript latency was 96 → 90 ms; median first audio was 855 → 900 ms and p95 was 1,622 → 1,437 ms. These are single small paired runs, not claims about production latency. On the 29°C → 24°C correction, the baseline clarified without applying a setting; the gain candidate recognized 24°C and applied it exactly once. The strong-noise fan case still failed. Low partial-result stabilization recovered 24°C in the ASR probe but lost 23°C on a separate clip; the 16–30°C vocabulary alone did not recover 24°C. The gain experiment is off by default and has not been deployed to the public demo.

### Google Cloud comparison

Run two separate evaluations. Compare [Chirp 3 streaming](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3) with Amazon Transcribe on the same [FLEURS Korean](https://huggingface.co/datasets/google/fleurs) and TCAR files, using character error and end-to-final-transcript latency. Feed the resulting transcripts into the same Sonic backend if the goal is to isolate ASR impact on commands. Separately compare the customer's [Gemini Live](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api) configuration with native Sonic and Transcribe + Sonic using the same 12 commands, tool schema, and simulator. Report final state, first audio, wrong intermediate actions, and clarification separately. Google-published [ComplexFuncBench Audio results](https://blog.google/products-and-platforms/products/gemini/gemini-audio-model-updates/) provide a reference for tool use; their score is not directly comparable to the Korean vehicle cases. [Full-Duplex-Bench v3](https://github.com/DanielLin94144/Full-Duplex-Bench/tree/main/v3) provides public human recordings and tooling for pauses, self-corrections and multi-step tool use.

The Chirp 3 replay utility uses the same 16 kHz mono PCM files and 100 ms pacing. It expects Application Default Credentials, an enabled Speech-to-Text API and a billed Google Cloud project. Run in a Python environment with `google-cloud-speech` installed:

```sh
python scripts/chirp-ko-replay.py .runtime/sonic-human/clean.json --project YOUR_PROJECT --out output/chirp-clean/report.json
python scripts/chirp-ko-replay.py .runtime/sonic-human/tcar5.json --project YOUR_PROJECT --out output/chirp-tcar5/report.json
python scripts/sonic-human-score.py output/chirp-clean/report.json output/chirp-tcar5/report.json
```

The local fixture validation passed for both sets. Google Cloud API measurements are pending project access.

Whisper or Transcribe in front of Sonic does not remove the Sonic session quota. The [Bedrock model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-5-sonic.html) lists 20 concurrent sessions by default per account per supported Region and directs customers to their AWS account team for increases. A separate ASR → text model → Polly path can be evaluated independently of that quota and for voice requirements that Sonic cannot meet. Standard Korean Polly voices and managed custom Brand Voice are separate offerings; confirm Korean custom voice access for the target account and Region with AWS.

## Deploy

```sh
python3 scripts/deploy-sonic-turn-taking.py
# UI/client-only updates can preserve the running backend sessions:
python3 scripts/deploy-sonic-turn-taking.py --static-only
```

This helper deploys only the allowlisted Sonic module and vehicle UI files over SSM and a private temporary S3 bundle. It preserves site-specific navigation, creates source backups, and does not modify environment files, GPU workers, or systemd units. Backend changes restart the web services; reconnect the demo afterwards. Invalidate the updated root page, app.js, sonic-client.js and i18n-strings.js on both CloudFront distributions after deployment.
