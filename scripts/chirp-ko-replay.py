"""Replay the same 16 kHz fixtures against Google Cloud Speech-to-Text V2."""
import argparse
import json
from pathlib import Path
import time
import wave


def read_pcm(path):
    with wave.open(str(path), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
            raise ValueError(f"{path}: expected mono 16 kHz 16-bit PCM WAV")
        return wav.readframes(wav.getnframes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="JSON with cases containing id, file, text")
    parser.add_argument("--project", help="Google Cloud project for the Speech API")
    parser.add_argument("--location", default="asia-northeast1")
    parser.add_argument("--out", type=Path, default=Path("output/chirp-ko-replay.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    clips = [(case, read_pcm(case["file"])) for case in manifest["cases"]]
    if args.dry_run:
        print(json.dumps({"clips": len(clips), "totalAudioSeconds": sum(len(x[1]) for x in clips) / 32000}))
        return
    if not args.project:
        parser.error("--project is required for live API calls")
    from google.api_core.client_options import ClientOptions
    from google.cloud.speech_v2 import SpeechClient
    from google.cloud.speech_v2.types import cloud_speech as stt

    client = SpeechClient(client_options=ClientOptions(api_endpoint=f"{args.location}-speech.googleapis.com"))
    config = stt.StreamingRecognizeRequest(
        recognizer=f"projects/{args.project}/locations/{args.location}/recognizers/_",
        streaming_config=stt.StreamingRecognitionConfig(
            config=stt.RecognitionConfig(
                explicit_decoding_config=stt.ExplicitDecodingConfig(
                    encoding=stt.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                    sample_rate_hertz=16000, audio_channel_count=1),
                language_codes=["ko-KR"], model="chirp_3"),
            streaming_features=stt.StreamingRecognitionFeatures(interim_results=False)))
    rows = []
    for case, pcm in clips:
        audio_end = last_final = None

        def requests():
            nonlocal audio_end
            yield config
            start = time.monotonic()
            for pos in range(0, len(pcm), 3200):
                chunk = pcm[pos:pos + 3200]
                time.sleep(max(0, start + (pos + len(chunk)) / 32000 - time.monotonic()))
                if pos + len(chunk) == len(pcm):
                    audio_end = time.monotonic()
                yield stt.StreamingRecognizeRequest(audio=chunk)

        final_segments = []
        for reply in client.streaming_recognize(requests=requests(), timeout=60, retry=None):
            for result in reply.results:
                if result.is_final and result.alternatives:
                    final_segments.append(result.alternatives[0].transcript.strip())
                    last_final = time.monotonic()
        row = {"id": case["id"], "mode": "chirp_3", "reference": case["text"], "condition": case.get("condition"),
               "transcript": " ".join(final_segments),
               "asrFinalMs": round((last_final - audio_end) * 1000) if last_final and audio_end else None}
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"model": "chirp_3", "location": args.location, "source": manifest.get("source"),
                                   "summary": {"chirp_3": {"n": len(rows)}}, "rows": rows}, ensure_ascii=False, indent=2) + "\n")
    client.transport.close()


if __name__ == "__main__":
    main()
