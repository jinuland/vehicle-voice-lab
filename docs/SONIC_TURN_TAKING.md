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

## Deploy

```sh
python3 scripts/deploy-sonic-turn-taking.py
# UI/client-only updates can preserve the running backend sessions:
python3 scripts/deploy-sonic-turn-taking.py --static-only
```

This helper deploys only the allowlisted Sonic module and vehicle UI files over SSM and a private temporary S3 bundle. It preserves site-specific navigation, creates source backups, and does not modify environment files, GPU workers, or systemd units. Backend changes restart the web services; reconnect the demo afterwards. Invalidate the updated root page, app.js, sonic-client.js and i18n-strings.js on both CloudFront distributions after deployment.
