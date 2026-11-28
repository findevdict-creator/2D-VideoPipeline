import React, { useEffect, useRef, useState } from "react";
import { api, type Snapshot } from "./api";
import { useAction, useToast } from "./ui";
import { startRecording, toWav } from "./voiceClip";

type Voices = Snapshot["voices"];

/** Something to read aloud: about 20 seconds, with the mix of sounds a clone needs. */
const READ_ALOUD =
  "Hello, this is my voice, recorded for my own videos. I am speaking the way I would to a friend, at an easy pace, not too fast and not too slow. " +
  "Every satellite carries a clock, and my phone listens for it. Does that sound right? I think it does. Seven, eighteen, forty-two: numbers, questions and long sentences all help the copy sound like me.";

const RECORD_LIMIT_SEC = 45;

/**
 * Record or choose a short clip of your own voice and keep it as a narrator. The clip is
 * turned into a WAV file here in the page, so any format the browser plays will do.
 */
export function CloneVoice({ voices, onSaved, onClose }: { voices: Voices; onSaved: (id: string) => void; onClose: () => void }) {
  const toast = useToast();
  const [busy, act] = useAction();
  const [name, setName] = useState(voices.clones.length ? "" : "My voice");
  const [base, setBase] = useState("am_michael");
  const [clip, setClip] = useState<{ wav: Blob; seconds: number; url: string }>();
  const [recording, setRecording] = useState<{ since: number }>();
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<Awaited<ReturnType<typeof startRecording>> | undefined>(undefined);
  const replaces = voices.clones.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());

  const take = async (source: Blob) => {
    try {
      const made = await toWav(source);
      setClip((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { ...made, url: URL.createObjectURL(made.wav) };
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
  const stop = async () => {
    const r = recorder.current;
    recorder.current = undefined;
    setRecording(undefined);
    if (r) await take(await r.stop());
  };
  const start = async () => {
    try {
      recorder.current = await startRecording();
      setElapsed(0);
      setRecording({ since: Date.now() });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => {
      const s = (Date.now() - recording.since) / 1000;
      setElapsed(s);
      if (s >= RECORD_LIMIT_SEC) void stop();
    }, 200);
    return () => clearInterval(tick);
  }, [recording]);
  // Leaving the panel lets go of the microphone.
  useEffect(() => () => recorder.current?.cancel(), []);

  const { minSec, maxSec } = voices.clip;
  const length = clip ? (clip.seconds < minSec ? `Too short: record at least ${minSec} seconds.` : clip.seconds > maxSec ? `Too long: keep it under ${maxSec} seconds.` : clip.seconds < 10 ? "A little short. 10 to 30 seconds gives a closer voice." : "") : "";
  const usable = clip && clip.seconds >= minSec && clip.seconds <= maxSec;

  const save = () =>
    act(async () => {
      const saved = await api.saveVoice(name.trim(), clip!.wav, base);
      for (const w of saved.warnings) toast(w);
      onSaved(saved.id);
    }, "Voice saved. Choose Listen to hear it.");

  return (
    <div className="clone-voice">
      <h4>Clone my voice</h4>
      <p className="muted small">
        Record 10 to 30 seconds of yourself in a quiet room, close to the microphone, speaking the way you want your videos to sound. Only clone a voice that is yours, or one you have permission to use. The recording stays on this computer.
      </p>
      <p className="read-aloud">{READ_ALOUD}</p>
      <div className="row wrap">
        {recording ? (
          <button className="btn btn-danger" onClick={() => void stop()}>
            Stop ({Math.floor(elapsed)} s)
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => void start()}>
            {clip ? "Record again" : "Record"}
          </button>
        )}
        <label className="btn btn-quiet file-button">
          Choose a recording
          <input
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
            hidden
            disabled={busy || !!recording}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void take(file);
            }}
          />
        </label>
        {recording && <span className="muted small">Recording… read the text above. It stops by itself at {RECORD_LIMIT_SEC} seconds.</span>}
      </div>
      {clip && (
        <>
          <audio src={clip.url} controls style={{ width: "100%", marginTop: 10 }} />
          <p className={`small ${length ? "warn" : "muted"}`}>{length || `${Math.round(clip.seconds)} seconds. Listen back: if there is noise, an echo or another voice in it, record again.`}</p>
        </>
      )}
      <div className="row wrap">
        <label>
          Name
          <input type="text" value={name} maxLength={60} placeholder="My voice" disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Starts from
          <select value={base} disabled={busy} onChange={(e) => setBase(e.target.value)}>
            {voices.list.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.accent}, {v.gender})
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" disabled={busy || !usable || !name.trim() || !!recording} onClick={save}>
          {busy ? "Saving…" : replaces ? "Replace this voice" : "Save voice"}
        </button>
        <button className="btn btn-quiet" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="muted small">
        "Starts from" is the built-in voice that speaks first and is then turned into yours. Its rhythm and accent carry over, so pick one of your gender with the accent closest to yours. You can change it later.
        {replaces ? ` A voice called ${replaces.name} exists: saving replaces its recording.` : ""}
      </p>
    </div>
  );
}
