# UI and response language

The vehicle demo's language selector controls the language of **new replies and speech**. `?lang=en` also selects English on the first load; the saved UI preference is used when the URL has no valid language parameter. Existing conversation text, benchmark fixtures and scores retain their original language.

- **Nova 2.5 Sonic:** switching languages closes the previous stream, clears queued playback and reconnects with the new language instruction. Cabin state and displayed conversation history remain. An active microphone resumes after the language switch. Sonic's advanced conversation-language selector can still override the automatic selection for experiments.
- **STT → sLLM → TTS:** English requests use Whisper's English transcription setting, an English planner reply instruction, English confirmations from the validated vehicle executor, and Polly Joanna (`en-US`, neural). English mode automatically uses Polly rather than the current Korean Qwen TTS configuration. Korean retains Whisper/Korean and Polly Seoyeon or the selected Korean GPU TTS.
- **Audio control models:** their planner receives the same response-language instruction and their validated results use the selected language. Native voice comparison modes receive their model-specific language parameter; this does not establish language support or quality for every model.
- **Utilities:** timer and other assistant tool requests receive the selected language. Retrieved sources and user-provided names/notes are not translated automatically.

Language switching interrupts any in-progress response. It does not reset the vehicle or rewrite old transcripts. Sonic is a new model stream after switching, so its internal conversation context restarts with the current cabin state. Generic model turns retain recent conversation history and apply the newly selected reply instruction.

English transcription and synthesis configuration follow the [Whisper model card](https://huggingface.co/openai/whisper-large-v3-turbo) and [Polly voice documentation](https://docs.aws.amazon.com/polly/latest/dg/available-voices.html).

## Validation, 2026-10-28

`npm test`: 80 tests passed, including request-language propagation, English executor receipts, rejected invalid actions, Korean game voice defaults, and switching an existing Sonic client without resetting cabin state.

On both deployed CloudFront vehicle sites, `scripts/response-language-smoke.mjs` passed five sequential synthetic cases in one session: Korean baseline command, English audio recognition + control + audio output, English answer to a Korean state question with mixed-language history, English timer, and switching back to a Korean answer while retaining temperatures.

On the compact deployment, `scripts/sonic-smoke.mjs` passed English and Korean synthetic speech commands with native speech output. Browser checks also verified English → Korean → English switching on an existing Sonic conversation while retaining the passenger temperature at 26°C and the defroster state. These are integration checks, not a new English benchmark or a physical microphone/road test.

```sh
npm test
TEST_BASE=https://d3q7tlfor72b22.cloudfront.net node scripts/response-language-smoke.mjs
TEST_BASE=https://d3q7tlfor72b22.cloudfront.net node scripts/sonic-smoke.mjs
```

Both vehicle web backends, the shared Sonic instructions, and each Whisper worker were updated. Original-site backend differences were preserved with targeted edits; GPU planner services, model weights and runtime settings were not changed.
