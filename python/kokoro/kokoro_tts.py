"""Kokoro text-to-speech for the video pipeline.

Reads one JSON job on stdin, writes WAV files, and prints one JSON result on stdout.
Progress messages go to stderr.

Job:
  {
    "sampleRate": 24000,
    "items": [
      {"id": "s01", "text": "...", "voice": "af_heart", "lang": "a", "speed": 1.0,
       "padBeforeSec": 0.3, "padAfterSec": 0.3, "outFile": "/abs/path/s01.wav",
       "clone": {"engine": "kokoclone", "referenceFile": "/abs/voices/me/reference.wav"}}   (clone is optional)
    ],
    "concat": {"files": ["/abs/s01.wav", "/abs/s02.wav"], "outFile": "/abs/full.wav"}   (optional)
  }

Result:
  {"items": [{"id": "s01", "durationSec": 9.4, "speechStartSec": 0.3, "speechEndSec": 9.1,
              "words": [{"text": "Your", "startSec": 0.31, "endSec": 0.52}, ...]}],
   "concat": {"outFile": "...", "durationSec": 80.2}}

An item with "clone" is spoken by Kokoro and then re-voiced as the person in the reference
clip (see voice_clone.py). Its timings are Kokoro's, because conversion keeps them.

Exit codes: 2 when Kokoro is not installed, 3 when voice cloning is not installed.
"""

import json
import sys

KOKORO_RATE = 24000


def log(message):
    print(message, file=sys.stderr, flush=True)


def to_numpy(audio, np):
    if audio is None:
        return None
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    return np.asarray(audio, dtype=np.float32).reshape(-1)


def resample(audio, src_rate, dst_rate, np):
    if src_rate == dst_rate or len(audio) == 0:
        return audio
    n_out = int(round(len(audio) * dst_rate / src_rate))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


def synthesize(item, pipelines, out_rate, np, sf, KPipeline, cloner=None):
    lang = item["lang"]
    if lang not in pipelines:
        log(f"Loading Kokoro ({lang})...")
        pipelines[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
    pipeline = pipelines[lang]

    chunks, words, offset = [], [], 0.0
    for result in pipeline(item["text"], voice=item["voice"], speed=item["speed"], split_pattern=r"\n+"):
        audio = to_numpy(getattr(result, "audio", None), np)
        if audio is None or len(audio) == 0:
            continue
        for token in getattr(result, "tokens", None) or []:
            start, end = getattr(token, "start_ts", None), getattr(token, "end_ts", None)
            text = getattr(token, "text", "") or ""
            if start is None or end is None or not any(c.isalnum() for c in text):
                continue
            words.append({"text": text, "startSec": offset + float(start), "endSec": offset + float(end)})
        chunks.append(audio)
        offset += len(audio) / KOKORO_RATE

    speech = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    if cloner is not None:
        speech = cloner.convert(speech, KOKORO_RATE, item["clone"]["referenceFile"], np, sf, resample)
    pad_before = np.zeros(int(round(item["padBeforeSec"] * KOKORO_RATE)), dtype=np.float32)
    pad_after = np.zeros(int(round(item["padAfterSec"] * KOKORO_RATE)), dtype=np.float32)
    full = resample(np.concatenate([pad_before, speech, pad_after]), KOKORO_RATE, out_rate, np)
    sf.write(item["outFile"], full, out_rate, subtype="PCM_16")

    lead = len(pad_before) / KOKORO_RATE
    for word in words:
        word["startSec"] = round(word["startSec"] + lead, 3)
        word["endSec"] = round(word["endSec"] + lead, 3)
    return {
        "id": item["id"],
        "durationSec": round(len(full) / out_rate, 3),
        "speechStartSec": round(lead, 3),
        "speechEndSec": round(lead + len(speech) / KOKORO_RATE, 3),
        "words": words,
    }


def concat(files, out_file, out_rate, np, sf):
    parts = []
    for f in files:
        audio, rate = sf.read(f, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        parts.append(resample(audio, rate, out_rate, np))
    full = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    sf.write(out_file, full, out_rate, subtype="PCM_16")
    return {"outFile": out_file, "durationSec": round(len(full) / out_rate, 3)}


def load_cloner():
    import os

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from voice_clone import NotInstalled, VoiceCloner

    try:
        return VoiceCloner(log)
    except NotInstalled as err:
        log(f"Voice cloning is not installed for this Python ({sys.executable}): {err}. Run: npm run setup:clone")
        sys.exit(3)


def main():
    job = json.load(sys.stdin)
    try:
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline
    except ImportError as err:
        log(f"Kokoro is not installed for this Python ({sys.executable}): {err}. Run: npm run setup:voice")
        sys.exit(2)

    out_rate = int(job.get("sampleRate", KOKORO_RATE))
    pipelines = {}
    results = []
    items = job.get("items", [])
    cloner = None
    for i, item in enumerate(items, 1):
        cloned = bool(item.get("clone"))
        if cloned and cloner is None:
            cloner = load_cloner()
        log(f"Speaking {item['id']} ({i}/{len(items)}){' in a cloned voice' if cloned else ''}...")
        results.append(synthesize(item, pipelines, out_rate, np, sf, KPipeline, cloner if cloned else None))

    output = {"items": results}
    if job.get("concat"):
        output["concat"] = concat(job["concat"]["files"], job["concat"]["outFile"], out_rate, np, sf)
    print(json.dumps(output))


if __name__ == "__main__":
    main()
