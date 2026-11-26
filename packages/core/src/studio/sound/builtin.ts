/**
 * The studio's own sound effects, made from arithmetic instead of files, so every
 * project has a few without anyone having to find and license them. Each is mono,
 * peaks below full scale, and is the same every time it is made.
 */

export const SOUNDS = ["pop", "click", "tick", "ding", "thud", "whoosh"] as const;
export type SoundName = (typeof SOUNDS)[number];

/** What each sound is for. Shown to the agents that choose them. */
export const SOUND_GUIDE: Record<SoundName, string> = {
  pop: "A soft, round pop. For something appearing.",
  click: "A short, dry click. For a switch, a selection, or a small part snapping into place.",
  tick: "A light, high tick. For counting steps or items appearing one by one.",
  ding: "A small bell. For an answer, a success, or the point the scene was building to.",
  thud: "A low, soft thud. For something heavy landing.",
  whoosh: "A rush of air. For something sliding or flying in; its loudest moment lands on the cue.",
};

export interface Sound {
  sampleRate: number;
  /** Mono samples between -1 and 1. */
  samples: Float32Array;
  /** How far into the sound its moment is: what should land on the cue. 0 for sounds that start with a bang. */
  leadSec: number;
}

/** Repeatable noise, so a sound made twice is the same sound. */
function noise(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x80000000 - 1;
  };
}

const cache = new Map<string, Sound>();

export function builtInSound(name: SoundName, sampleRate = 48000): Sound {
  const key = `${name}@${sampleRate}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const make = (seconds: number, leadSec: number, at: (t: number, i: number) => number): Sound => {
    const samples = new Float32Array(Math.round(seconds * sampleRate));
    for (let i = 0; i < samples.length; i++) samples[i] = at(i / sampleRate, i);
    // A few milliseconds of fade at the very end, so no sound stops on a step.
    const tail = Math.min(samples.length, Math.round(0.004 * sampleRate));
    for (let i = 0; i < tail; i++) samples[samples.length - 1 - i]! *= i / tail;
    return { sampleRate, samples, leadSec };
  };
  const tau = 2 * Math.PI;
  /** Rises over `attack` seconds, then dies away with time constant `decay`. */
  const strike = (t: number, attack: number, decay: number) => Math.min(1, t / attack) * Math.exp(-t / decay);
  let sound: Sound;
  switch (name) {
    case "pop": {
      // A pitch that falls quickly: 520 Hz down to 180 Hz.
      let phase = 0;
      sound = make(0.16, 0, (t) => {
        phase += (tau * (180 + 340 * Math.exp(-t / 0.03))) / sampleRate;
        return 0.8 * Math.sin(phase) * strike(t, 0.002, 0.035);
      });
      break;
    }
    case "click": {
      const rand = noise(7);
      let last = 0;
      sound = make(0.05, 0, (t) => {
        const white = rand();
        const bright = white - last; // differencing keeps the high end only
        last = white;
        return 0.3 * bright * Math.exp(-t / 0.003) + 0.35 * Math.sin(tau * 2100 * t) * strike(t, 0.0005, 0.006);
      });
      break;
    }
    case "tick":
      sound = make(0.07, 0, (t) => 0.6 * Math.sin(tau * 1250 * t) * strike(t, 0.001, 0.012));
      break;
    case "ding":
      // A bell: a note and two overtones that are slightly out of tune with it, each dying faster than the one below.
      sound = make(1.3, 0, (t) => 0.45 * Math.sin(tau * 880 * t) * strike(t, 0.002, 0.38) + 0.22 * Math.sin(tau * 880 * 2.76 * t) * strike(t, 0.002, 0.16) + 0.1 * Math.sin(tau * 880 * 5.4 * t) * strike(t, 0.002, 0.07));
      break;
    case "thud": {
      const rand = noise(11);
      let phase = 0;
      sound = make(0.45, 0, (t) => {
        phase += (tau * (48 + 60 * Math.exp(-t / 0.04))) / sampleRate;
        return 0.9 * Math.sin(phase) * strike(t, 0.003, 0.09) + 0.12 * rand() * Math.exp(-t / 0.008);
      });
      break;
    }
    case "whoosh": {
      // Noise through a filter that opens and closes again, swelling to its peak and falling away.
      const rand = noise(23);
      const peak = 0.3;
      const length = 0.55;
      let low = 0;
      let band = 0;
      sound = make(length, peak, (t) => {
        const swell = t < peak ? Math.pow(t / peak, 2) : Math.pow(1 - (t - peak) / (length - peak), 1.5);
        const cutoff = 400 + 3200 * swell;
        const f = 2 * Math.sin((Math.PI * cutoff) / sampleRate);
        // A state-variable filter: `band` is the band-passed noise.
        low += f * band;
        band += f * (rand() - low - 0.9 * band);
        return 0.7 * band * swell;
      });
      break;
    }
  }
  cache.set(key, sound);
  return sound;
}
