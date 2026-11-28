"""Chatterbox text-to-speech in a cloned voice, for the video pipeline.

The second way to narrate in your own voice, for when Kokoro with voice conversion is not
close enough. Chatterbox (Resemble AI, MIT licence) speaks the text itself in the voice of
a reference clip, so it also picks up some of how that person talks. It is slower than
Kokoro, and it marks its audio with an inaudible watermark (Resemble's Perth).

Speaks the same JSON job as python/kokoro/kokoro_tts.py and prints the same result. Every
item needs "clone": {"referenceFile": "/abs/voices/me/reference.wav"}.

Chatterbox does not say when each word is spoken. The text is spoken a sentence or two at
a time, so the start and end of each piece are exact, and inside a piece the words are
placed by listening for them (wav2vec2 forced alignment, when torchaudio offers it) or,
failing that, spread by their length.

Runs in its own environment, .venv-chatterbox, because Chatterbox pins versions of PyTorch
and other libraries that differ from Kokoro's. Installed by: npm run setup:chatterbox

Exit code 2 means Chatterbox is not installed.
"""

import json
import re
import sys

PIECE_CHARS = 160
GAP_SEC = 0.12


def log(message):
    print(message, file=sys.stderr, flush=True)


def resample(audio, src_rate, dst_rate, np):
    if src_rate == dst_rate or len(audio) == 0:
        return audio
    n_out = int(round(len(audio) * dst_rate / src_rate))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


def pieces_of(text):
    """Sentences, joined up to a length Chatterbox speaks reliably in one go."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?;:])\s+|\n+", text) if s.strip()]
    pieces = []
    for sentence in sentences:
        if pieces and len(pieces[-1]) + 1 + len(sentence) <= PIECE_CHARS:
            pieces[-1] += " " + sentence
        else:
            pieces.append(sentence)
    return pieces


def words_of(text):
    """The words as Kokoro would list them: no surrounding punctuation, nothing without a letter or digit."""
    out = []
    for raw in text.split():
        word = raw.strip("\"'“”‘’()[]{}.,;:!?…—–-")
        if any(c.isalnum() for c in word):
            out.append(word)
    return out


def trim_silence(audio, rate, np, threshold=0.01):
    """Cut the quiet that Chatterbox sometimes leaves before and after a piece."""
    loud = np.flatnonzero(np.abs(audio) > threshold)
    if len(loud) == 0:
        return audio
    keep = int(0.03 * rate)
    return audio[max(0, loud[0] - keep) : min(len(audio), loud[-1] + keep)]


def spread_words(words, duration):
    """Place words across a piece by their length. Used when they cannot be listened for."""
    weights = [len(re.sub(r"[^A-Za-z0-9]", "", w)) + 1 for w in words]
    total = float(sum(weights)) or 1.0
    out, at = [], 0.0
    for word, weight in zip(words, weights):
        span = duration * weight / total
        out.append({"text": word, "startSec": at, "endSec": at + span * 0.92})
        at += span
    return out


class Aligner:
    """Finds when each word of a known sentence is spoken (wav2vec2 forced alignment)."""

    def __init__(self, torch, device):
        import torchaudio

        self.torch = torch
        self.F = torchaudio.functional
        if not hasattr(self.F, "forced_align") or not hasattr(self.F, "merge_tokens"):
            raise RuntimeError("this torchaudio has no forced alignment")
        bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
        self.rate = bundle.sample_rate
        self.index = {label: i for i, label in enumerate(bundle.get_labels())}
        self.device = device
        self.model = bundle.get_model().to(device).eval()

    def align(self, audio, rate, words, np):
        torch = self.torch
        spelled = [re.sub(r"[^A-Z']", "", w.upper().replace("’", "'")) for w in words]
        if not words or any(not s or any(c not in self.index for c in s) for s in spelled):
            return None  # A number or a symbol: nothing to listen for letter by letter.
        wave = torch.from_numpy(resample(audio, rate, self.rate, np)).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            emission, _ = self.model(wave)
            log_probs = torch.log_softmax(emission, dim=-1)
        targets = [self.index[c] for c in "|".join(spelled)]
        if log_probs.shape[1] < len(targets):
            return None
        aligned, scores = self.F.forced_align(log_probs, torch.tensor([targets], dtype=torch.int32, device=self.device), blank=0)
        spans = [s for s in self.F.merge_tokens(aligned[0], scores[0].exp()) if s.token != self.index["|"]]
        if len(spans) != sum(len(s) for s in spelled):
            return None
        sec_per_frame = wave.shape[1] / log_probs.shape[1] / self.rate
        out, at = [], 0
        for word, letters in zip(words, spelled):
            mine = spans[at : at + len(letters)]
            at += len(letters)
            out.append({"text": word, "startSec": mine[0].start * sec_per_frame, "endSec": mine[-1].end * sec_per_frame})
        return out


def synthesize(item, model, aligner, out_rate, np, sf):
    rate = int(model.sr)
    speed = float(item.get("speed", 1.0))
    chunks, words, offset = [], [], 0.0
    gap = np.zeros(int(GAP_SEC * rate), dtype=np.float32)
    for piece in pieces_of(item["text"]):
        audio = model.generate(piece).squeeze().detach().cpu().numpy().astype(np.float32)
        audio = trim_silence(audio, rate, np)
        if abs(speed - 1.0) > 0.01 and len(audio) > rate // 4:
            import librosa

            audio = librosa.effects.time_stretch(audio, rate=speed).astype(np.float32)
        piece_words = words_of(piece)
        timed = None
        if aligner is not None:
            try:
                timed = aligner.align(audio, rate, piece_words, np)
            except Exception as err:  # Timing by ear is a refinement; never lose the narration over it.
                log(f"Could not listen for the words of one sentence ({err}); spreading them by length.")
        for w in timed or spread_words(piece_words, len(audio) / rate):
            words.append({"text": w["text"], "startSec": offset + w["startSec"], "endSec": offset + w["endSec"]})
        if chunks:
            chunks.append(gap)
        chunks.append(audio)
        offset += (len(audio) + len(gap)) / rate

    speech = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    pad_before = np.zeros(int(round(item["padBeforeSec"] * rate)), dtype=np.float32)
    pad_after = np.zeros(int(round(item["padAfterSec"] * rate)), dtype=np.float32)
    full = resample(np.concatenate([pad_before, speech, pad_after]), rate, out_rate, np)
    sf.write(item["outFile"], full, out_rate, subtype="PCM_16")

    lead = len(pad_before) / rate
    return {
        "id": item["id"],
        "durationSec": round(len(full) / out_rate, 3),
        "speechStartSec": round(lead, 3),
        "speechEndSec": round(lead + len(speech) / rate, 3),
        "words": [{"text": w["text"], "startSec": round(w["startSec"] + lead, 3), "endSec": round(w["endSec"] + lead, 3)} for w in words],
    }


def main():
    job = json.load(sys.stdin)
    try:
        import numpy as np
        import soundfile as sf
        import torch
        from chatterbox.tts import ChatterboxTTS
    except ImportError as err:
        log(f"Chatterbox is not installed for this Python ({sys.executable}): {err}. Run: npm run setup:chatterbox")
        sys.exit(2)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"Loading Chatterbox ({device})...")
    model = ChatterboxTTS.from_pretrained(device=device)
    aligner = None
    if job.get("alignWords", True):
        try:
            aligner = Aligner(torch, device)
        except Exception as err:
            log(f"Word timing by ear is not available ({err}); words are spread across each sentence by length.")

    out_rate = int(job.get("sampleRate", 24000))
    results, prepared = [], None
    items = job.get("items", [])
    for i, item in enumerate(items, 1):
        reference = (item.get("clone") or {}).get("referenceFile")
        if not reference:
            log(f"Item {item['id']} has no voice clip. Chatterbox only speaks in a cloned voice.")
            sys.exit(1)
        if reference != prepared:
            model.prepare_conditionals(reference)
            prepared = reference
        log(f"Speaking {item['id']} ({i}/{len(items)}) in a cloned voice...")
        results.append(synthesize(item, model, aligner, out_rate, np, sf))

    print(json.dumps({"items": results}))


if __name__ == "__main__":
    main()
