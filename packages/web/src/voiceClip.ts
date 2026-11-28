/** What both cloning engines read: one channel at 24 kHz. */
const RATE = 24000;

/**
 * Turn any recording the browser can play (a microphone take, an MP3, an M4A, a WAV) into
 * a mono 16-bit WAV file, which is what the studio keeps as a voice's reference clip.
 */
export async function toWav(source: Blob): Promise<{ wav: Blob; seconds: number }> {
  const bytes = await source.arrayBuffer();
  const reader = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await reader.decodeAudioData(bytes);
  } catch {
    throw new Error("That file could not be read as audio. Choose a WAV, MP3 or M4A file, or record instead.");
  } finally {
    void reader.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const offline = new OfflineAudioContext(1, frames, RATE);
  const player = offline.createBufferSource();
  player.buffer = decoded;
  player.connect(offline.destination);
  player.start();
  const samples = (await offline.startRendering()).getChannelData(0);

  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return { wav: new Blob([out.buffer], { type: "audio/wav" }), seconds: samples.length / RATE };
}

/** Record from the microphone until `stop` is called. The voice is left as it is: no echo or noise processing. */
export async function startRecording(): Promise<{ stop: () => Promise<Blob>; cancel: () => void }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot record. Choose a recording from a file instead.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  } catch {
    throw new Error("The microphone could not be used. Allow it for this page in the browser, or choose a recording from a file.");
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    },
  };
}
