"""Voice cloning for Kokoro narration, the way KokoClone does it.

Kokoro speaks the line in one of its own voices, then the Kanade voice-conversion model
re-voices that audio so it sounds like the person in a short reference clip. Conversion
keeps the timing of the speech, so the word timings Kokoro reports stay true.

The approach, and the chunking in convert(), follow KokoClone
(https://github.com/Ashish-Patnaik/kokoclone, Apache License 2.0), which pairs Kokoro with
Kanade (https://github.com/frothywater/kanade-tokenizer, MIT). KokoClone itself runs
Kokoro through ONNX and returns no word timings, so the studio keeps its own Kokoro and
uses only the conversion step.

Installed by: npm run setup:clone
"""

KANADE_MODEL = "frothywater/kanade-12.5hz"

# Kanade draws one mel frame per HOP samples, and frame i sits at sample i * HOP.
HOP = 256
# Its decoder has positions for 1024 mel frames, so one pass takes about 10.9 s at most.
# A chunk and the context on both sides of it stay well inside that.
CHUNK_FRAMES = 660  # about 7 s
CONTEXT_FRAMES = 47  # about 0.5 s of context on each side, cut off again afterwards
# A longer reference than this adds time and memory, not likeness.
REFERENCE_MAX_SEC = 30


class NotInstalled(Exception):
    pass


class VoiceCloner:
    def __init__(self, log):
        try:
            import torch
            from kanade_tokenizer import KanadeModel, load_vocoder, vocode
        except ImportError as err:
            raise NotInstalled(str(err)) from err
        self.torch = torch
        self.vocode = vocode
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        log(f"Loading the voice cloning model ({self.device.type})...")
        self.model = KanadeModel.from_pretrained(KANADE_MODEL).to(self.device).eval()
        self.vocoder = load_vocoder(self.model.config.vocoder_name).to(self.device)
        self.rate = int(self.model.config.sample_rate)
        self.references = {}

    def reference(self, path, np, sf, resample):
        """The reference clip as Kanade wants it: mono, at its rate, peak at 1."""
        if path not in self.references:
            audio, rate = sf.read(path, dtype="float32", always_2d=True)
            audio = resample(audio.mean(axis=1), rate, self.rate, np)[: REFERENCE_MAX_SEC * self.rate]
            if len(audio) < self.rate:
                raise ValueError(f"The voice clip {path} is shorter than a second.")
            self.references[path] = self.tensor(audio, np)
        return self.references[path]

    def tensor(self, audio, np):
        peak = float(np.max(np.abs(audio))) + 1e-8
        return self.torch.from_numpy(np.ascontiguousarray(audio / peak, dtype=np.float32)).to(self.device)

    def convert(self, speech, rate, reference_path, np, sf, resample):
        """Re-voice `speech` (float32, mono) as the person in the reference clip.

        Returns audio of exactly the same length and rate, and about as loud.
        """
        if len(speech) < rate // 10:
            return speech
        torch = self.torch
        ref = self.reference(reference_path, np, sf, resample)
        source = self.tensor(resample(speech, rate, self.rate, np), np)
        total = int(source.shape[-1])

        chunk = CHUNK_FRAMES * HOP
        context = CONTEXT_FRAMES * HOP
        parts = []
        with torch.inference_mode():
            if total <= chunk + 2 * context:
                parts.append(self.model.voice_conversion(source_waveform=source, reference_waveform=ref).cpu())
            else:
                for start in range(0, total, chunk):
                    left = min(start, context)
                    window = source[start - left : min(total, start + chunk + context)]
                    mel = self.model.voice_conversion(source_waveform=window, reference_waveform=ref).cpu()
                    first = left // HOP
                    last = start + chunk >= total
                    # Whole frames on a fixed grid: each chunk hands over exactly its own
                    # frames, so the joined audio does not drift against the original.
                    parts.append(mel[..., first:] if last else mel[..., first : first + CHUNK_FRAMES])
            full = torch.cat(parts, dim=-1).to(self.device)
            out = self.vocode(self.vocoder, full.unsqueeze(0)).squeeze().cpu().numpy().astype(np.float32)

        out = resample(fit_length(out, total, np), self.rate, rate, np)
        out = fit_length(out, len(speech), np)
        return match_loudness(out, speech, np)


def fit_length(audio, length, np):
    if len(audio) >= length:
        return audio[:length]
    return np.concatenate([audio, np.zeros(length - len(audio), dtype=np.float32)])


def match_loudness(audio, like, np):
    """Scale `audio` to the loudness of `like`, without clipping."""
    rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
    target = float(np.sqrt(np.mean(np.square(like)))) if len(like) else 0.0
    if rms < 1e-6 or target < 1e-6:
        return audio
    gain = target / rms
    peak = float(np.max(np.abs(audio))) * gain
    if peak > 0.98:
        gain *= 0.98 / peak
    return (audio * gain).astype(np.float32)
