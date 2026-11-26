import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Comparison, type SceneDetail } from "./api";
import { ago, Chip, duration, useAction } from "./ui";

/**
 * Two versions of one scene side by side: watch both at once, read what was asked for
 * in between and what changed, and go back to either. Opens over the page, because two
 * pictures need the width.
 */
export function VersionCompare({ scene, working, onClose, onChanged }: { scene: SceneDetail; working: boolean; onClose: () => void; onChanged: () => void }) {
  const numbers = scene.versions.map((v) => v.version).sort((x, y) => x - y);
  const newest = scene.version ?? numbers.at(-1)!;
  // By default: the current version against the one you approved, or else the one before it.
  const start = scene.approvedVersion && scene.approvedVersion !== newest ? scene.approvedVersion : (numbers.filter((n) => n !== newest).at(-1) ?? newest);
  const [left, setLeft] = useState(Math.min(start, newest));
  const [right, setRight] = useState(Math.max(start, newest));
  const [data, setData] = useState<Comparison>();
  const [busy, act] = useAction();
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const videos = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];

  useEffect(() => {
    setData(undefined);
    setPlaying(false);
    setAt(0);
    void act(async () => setData(await api.compare(scene.id, left, right)));
  }, [act, scene.id, left, right, scene.version]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const both = () => videos.map((v) => v.current).filter((v): v is HTMLVideoElement => v !== null);
  const length = Math.max(0, ...(data?.versions.map((v) => v.durationSec ?? 0) ?? []));
  const seek = (sec: number) => {
    setAt(sec);
    for (const v of both()) v.currentTime = Math.min(sec, Number.isFinite(v.duration) ? v.duration : sec);
  };
  const toggle = () => {
    const all = both();
    if (playing) {
      for (const v of all) v.pause();
      setPlaying(false);
      return;
    }
    // Start both from the same moment, so they stay in step.
    const from = at >= length - 0.05 ? 0 : at;
    for (const v of all) {
      v.currentTime = Math.min(from, Number.isFinite(v.duration) ? v.duration : from);
      void v.play().catch(() => {});
    }
    setPlaying(all.length > 0);
  };

  const same = left === right;
  // Drawn on the page itself, not inside the drawer, so it can cover everything.
  return createPortal(
    <div className="versus-shade" onClick={onClose}>
      <div className="versus" role="dialog" aria-label={`Versions of scene ${scene.label}`} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <div className="grow">
            <div className="muted small">Scene {scene.label}</div>
            <h2>Compare versions of “{scene.title}”</h2>
          </div>
          <button className="btn btn-quiet" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="versus-sides">
          {[left, right].map((number, side) => {
            const v = data?.versions[same ? 0 : side];
            const set = side === 0 ? setLeft : setRight;
            return (
              <div key={side} className="versus-side">
                <div className="row wrap centred">
                  <select aria-label={side === 0 ? "Version on the left" : "Version on the right"} value={number} onChange={(e) => set(Number(e.target.value))}>
                    {numbers.map((n) => (
                      <option key={n} value={n}>
                        Version {n}
                      </option>
                    ))}
                  </select>
                  {number === scene.version && <Chip>Current</Chip>}
                  {number === scene.approvedVersion && <Chip tone="good">Approved</Chip>}
                  {v && <span className="muted small">{[v.durationSec ? duration(v.durationSec) : "", ago(v.createdAt)].filter(Boolean).join(" · ")}</span>}
                  <span className="grow" />
                  {v && number !== scene.version && v.hasClip && !working && (
                    <button
                      className="btn"
                      disabled={busy}
                      title="Its clip is kept, so nothing is rendered again"
                      onClick={async () => {
                        if (await act(() => api.rollbackScene(scene.id, number), `Back on version ${number}`)) onChanged();
                      }}
                    >
                      Go back to version {number}
                    </button>
                  )}
                </div>
                {v?.reviewUrl ? (
                  <video
                    ref={videos[side]}
                    key={v.reviewUrl}
                    className="player"
                    src={v.reviewUrl}
                    // Before it plays, show the scene at its end, when everything has arrived, instead of its empty first frame.
                    poster={v.stills.at(-1)?.url ?? undefined}
                    // One voice at a time: the right-hand side is the one you hear.
                    muted={side === 0 && !same}
                    playsInline
                    onTimeUpdate={(e) => side === 1 && setAt(e.currentTarget.currentTime)}
                    onEnded={() => side === 1 && setPlaying(false)}
                  />
                ) : v?.stills.length ? (
                  <img className="player" src={v.stills.at(-1)!.url!} alt="" />
                ) : (
                  <div className="player player-empty">{v ? "This version was never rendered" : "Loading…"}</div>
                )}
                {v?.summary && <p className="small">{v.summary}</p>}
              </div>
            );
          })}
        </div>

        {length > 0 && (
          <div className="row versus-controls">
            <button className="btn btn-primary" onClick={toggle}>
              {playing ? "Pause" : "Play both"}
            </button>
            <input type="range" aria-label="Position in the scene" min={0} max={length} step={0.01} value={Math.min(at, length)} onChange={(e) => seek(Number(e.target.value))} />
            <span className="muted small">
              {at.toFixed(1)} of {length.toFixed(1)} s
            </span>
          </div>
        )}

        {data && !same && (
          <>
            {data.asked.length > 0 && (
              <>
                <h4>What you asked for in between</h4>
                <ul className="history">
                  {data.asked.map((a, i) => (
                    <li key={i}>
                      <span className="muted small">after version {a.version}</span>
                      <div>{a.notes}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h4>What changed</h4>
            {data.changes.length === 0 ? (
              <p className="muted">Nothing. The two versions have the same plan, words and code.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th />
                    <th>Version {data.before}</th>
                    <th>Version {data.after}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.changes.map((c) => (
                    <tr key={c.what}>
                      <td>{c.what}</td>
                      <td>{c.before}</td>
                      <td>{c.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.narration.some((p) => p.op !== "same") && (
              <>
                <h4>Narration</h4>
                <p className="narration diff">
                  {data.narration.map((p, i) => (p.op === "same" ? <span key={i}>{p.text}</span> : p.op === "removed" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>))}
                </p>
              </>
            )}
            {data.code && data.code.added + data.code.removed > 0 && (
              <details>
                <summary>
                  Scene code: {data.code.added} {data.code.added === 1 ? "line" : "lines"} added, {data.code.removed} removed
                </summary>
                <pre className="code diff">
                  {data.code.parts.map((p, i) => {
                    const lines = p.text.split("\n");
                    // Long stretches that did not change are folded to their first and last lines.
                    const shown = p.op === "same" && lines.length > 8 ? [...lines.slice(0, 3), `… ${lines.length - 6} lines the same …`, ...lines.slice(-3)] : lines;
                    return (
                      <span key={i} className={p.op === "same" ? undefined : p.op}>
                        {shown.map((line) => `${p.op === "added" ? "+ " : p.op === "removed" ? "- " : "  "}${line}\n`).join("")}
                      </span>
                    );
                  })}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
