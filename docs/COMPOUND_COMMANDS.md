# Compound commands and full conversation history · 2026-10-28

The vehicle UI keeps its fixed-height scrolling panel and retains earlier bubbles instead of deleting everything before the last six. New messages follow the bottom only while the user is already following the conversation; scrolling up suspends automatic following. “Load previous session” reads a locally exported JSON file and adds its text to the panel. It does not upload that file, change vehicle state, or restore the model's conversation context. Refresh still starts a new simulator session.

## Investigation

The visitor's actual session export was preserved locally before deployment. It showed an unsuccessful long request with no committed vehicle actions, followed by a shorter request that applied temperatures and climate settings. The shorter request's radio instruction became simulated `media=play`; successful real radio playback was not recorded. The original unsuccessful turn did not retain its rejected tool arguments or exception, so its exact cause cannot be established retrospectively. No visitor transcript or destination is committed here.

Synthetic reproduction found several concrete integration problems:

- The vehicle schema/parser capped each call at six actions. Longer valid cabin bundles could be rejected before actions were recorded. Sonic's vehicle capacity is now bounded at 16, with a larger 1024-token response budget. Value/type/range validation and atomic commit within each vehicle call remain.
- Sonic could substitute simulated playlist playback for actual radio. Native instructions now explicitly split cabin operations and real radio calls, and a guard rejects that substitution when the user requested radio without a music request.
- In repeated 19.6-second synthetic speech, the visible transcript contained `운전석은니십오도` while the native tool correctly requested 25°C. The old number normalizer matched the suffix `십오`, manufacturing an explicit 15°C target; the bounds guard then rejected the valid 25/27°C tool call. Numeric normalization now requires a complete numeric word or a recognized device label. Spaced forms such as `이십 오 도` are also supported. A genuine `조수석사십오도` is still rejected.
- A bounds rejection returned `ok:true` with an empty action list. It now returns `ok:false` and the validation reason, so the model can distinguish rejection from completion.
- One intermediate run applied every requested state change but produced JSON fragments in the spoken transcript. This was a speech-output failure, not an execution success. JSON-field fragments are now blocked along with tool-name/special-token leaks, queued playback is cleared, and the error tells the visitor to check actual cabin results. Settings already executed are not undone by a narration failure.

Each native tool event now records arguments (or bounded raw malformed JSON), success/failure, error stage, actual actions, the input snapshot at that moment, and any external effect in the session-private `toolTrace`. Stream/speech errors are recorded separately. These records are exposed only in that visitor's session export; they are not broadcast or added to public logs. Mixed tool workflows are not a single transaction: one native call can succeed while another fails.

## Validation

- 98 automated tests passed, including seven-action atomic execution, invalid-last-action rollback, radio substitution rejection, error trace capture, numeric normalization regressions and retention of earlier messages while reading.
- Three synthetic text compound scenarios passed through the deployed Sonic WebSocket, checking full cabin state, actual radio tool effect and stored tool traces.
- Final 19.645-second synthetic Korean speech passed: driver 25°C, passenger 27°C, AC off, defrost on, seat heating 1, volume 20, simulated Seoul Station destination and real jazz radio preparation; simulated music stayed paused. Five tool events were recorded. This is a small functional check, not a general long-speech quality score or physical microphone test. Earlier failed reproductions are described above rather than treated as passes.
- Browser validation imported 24 synthetic messages, received a new user/assistant pair, retained all 26 messages, and kept scrollTop at zero while reading the first message.

```sh
npm test
TEST_BASE=https://d3q7tlfor72b22.cloudfront.net node scripts/sonic-compound-smoke.mjs
AWS_PROFILE=game-forge TEST_BASE=https://d3q7tlfor72b22.cloudfront.net TEST_INPUT=audio TEST_CASE=seven-controls-plus-radio node scripts/sonic-compound-smoke.mjs
python3 scripts/deploy-sonic-turn-taking.py --include-compound
```

Deployment patches only the Sonic hooks in each target's backend, preserving the original deployment's older game modules. Web services restart to load code; GPU workers, configuration and model weights remain unchanged. Session exports should be saved before such a restart because server-side sessions are in memory.
