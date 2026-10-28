# Assistant function check · 2026-10-28

The vehicle demo was checked through the deployed tool API, native Sonic tool calling and browser effects. Results are in [the machine-readable report](../research/assistant-functional-audit.json).

| Check | Result |
| --- | --- |
| Tool API | 12 enabled cases across all 11 enabled operations passed, including note write/read |
| Sonic with Korean text requests | 11/11 operations invoked the native tool and generated speech |
| Sonic with synthetic Korean speech | Suwon weather, radio channel list, five-second timer: 3/3 passed |
| Browser timer | Actual Sonic tool result triggered expiry banner and a conversation message; the audio context scheduled the chime |
| Browser radio | Listing did not start playback; selecting Secret Agent reached media readyState 4 and played for over 41 seconds |
| Nearby places | Remains explicitly disabled after the earlier latency/reliability screen; the disabled response was verified |
| Automated regression suite | 87 tests passed |

These are functional checks with synthetic inputs, not a new model-quality benchmark or load test. HTTP measurements include warm caches. Physical microphone recognition, actual OS speaker audibility, background OS suspension and road use are not established by these checks.

## Corrections

**Named weather locations.** Previously, only a short city list was recognized; “수원 날씨” fell through to the Seoul demo coordinate even though the tool returned success. Suwon and other common Korean cities now have fast location matches. Explicit unknown places use cached geocoding; a failed lookup requests a clearer city instead of silently using Seoul/GPS. A named place takes precedence over the selected GPS coordinate. Sources: [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api), [MET Norway location forecast](https://api.met.no/weatherapi/locationforecast/2.0/documentation).

**Radio catalog versus playback.** Questions such as “라디오 채널 뭐가 있어?” now return the four configured stations with no playback effect. The panel lists each station with a Play button. Explicit play/stop requests still control the player. The catalog is a local registry and no longer needs an AgentCore hop. Playback success is established by the browser media event, not the model's spoken claim.

**Timer durations and delivery.** Korean number words such as “오 초”, “십오 분”, “한 시간”, “스물다섯 초” and “두 시간” now produce numeric deadlines. Previously some such inputs returned a clarification instead of creating a timer. Sonic is instructed to preserve duration/units, call the timer tool and wait for a returned deadline before confirming.

The countdown appears beside the conversation and in the cabin panel. Expiry adds a chat message and a fixed banner, with a three-tone chime repeated every four seconds for up to 30 seconds. Dismiss/cancel stops the repetitions. If audio is blocked, the banner asks the user to test/unlock sound. The tab must stay open; reload clears this session's timers. Closed-tab notifications are not implemented.

**Malformed Sonic output.** The reported screenshot contained a serialized `assistant_tool{...}` string and special tokens in the conversational response. Exact wording did not reproduce in three initial text probes, which produced valid tool calls. The integration now separates TOOL blocks from speech, holds ambiguous tool-name prefixes across chunks, rejects tool syntax/special-token leaks, clears queued playback and shows a localized retry message. It never executes a string pretending to be a native tool call. Native tool-use events remain the only executable path. Regression tests inject fragmented versions of the reported syntax. See [AWS's output event contract](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-output-events.html).

## Reproduce

```sh
npm test
TEST_BASE=https://d3q7tlfor72b22.cloudfront.net node scripts/sonic-tools-audit.mjs
AWS_PROFILE=game-forge TEST_BASE=https://d3q7tlfor72b22.cloudfront.net TEST_INPUT=audio TEST_CASES=weather,radio,timer node scripts/sonic-tools-audit.mjs
```

Speech fixtures use Polly Seoyeon; they contain no visitor audio. Both vehicle web deployments and the existing provider Lambda were updated. GPU model services and their configuration were preserved. Deploy the allowlisted assistant files with `python3 scripts/deploy-sonic-turn-taking.py --include-assistant`; update the existing Lambda provider bundle separately when its shared provider module changes.
