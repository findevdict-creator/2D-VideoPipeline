import React, { useCallback, useEffect, useState } from "react";
import { api, type Keyframes, type SceneDetail, type Snapshot } from "./api";
import { RunLog } from "./RunLog";
import { ago, Chip, duration, NotesBox, RUN_STATUS, SCENE_STATUS, TYPE_NAME, useAction } from "./ui";

/** One scene, opened: watch it, approve it or say what to change, and see how it got here. */
export function SceneDrawer({ sceneId, snapshot, refreshKey, onClose }: { sceneId: string; snapshot: Snapshot; refreshKey: number; onClose: () => void }) {
  const [scene, setScene] = useState<SceneDetail>();
  const [busy, act] = useAction();
  const [asking, setAsking] = useState(false);
  const [shown, setShown] = useState<number | null>(null);

  const load = useCallback(() => act(async () => setScene(await api.scene(sceneId))), [act, sceneId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!scene) return <aside className="drawer" />;
  const status = SCENE_STATUS[scene.status] ?? { label: scene.status, tone: "quiet" };
  const version = scene.versions.find((v) => v.version === shown) ?? scene.current;
  const viewingOld = Boolean(version && scene.current && version.version !== scene.current.version);
  const run = scene.runs[0];
  const working = scene.status === "in_production";
  const planning = !scene.current;
  const stageIsScenes = snapshot.project.stage === "scenes" || snapshot.project.stage === "assembly";

  return (
    <aside className="drawer" aria-label={`Scene ${scene.label}`}>
      <div className="drawer-head">
        <div>
          <div className="muted small">
            Scene {scene.label} · {TYPE_NAME[scene.type] ?? scene.type}
            {scene.version ? ` · version ${scene.version}` : ""}
          </div>
          <h2>{scene.title}</h2>
        </div>
        <Chip tone={status.tone}>{status.label}</Chip>
        <button className="btn btn-quiet" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="drawer-body">
        {scene.reason && <p className={`notice ${scene.status === "failed" ? "notice-bad" : ""}`}>{scene.reason}</p>}

        {version?.reviewUrl ? (
          <video key={version.reviewUrl} className="player" src={version.reviewUrl} controls />
        ) : version?.stills.length ? (
          <img className="player" src={version.stills[0]!.url!} alt="" />
        ) : (
          <div className="player player-empty">{working ? "Being built…" : "Nothing rendered yet"}</div>
        )}
        {version && version.stills.length > 0 && (
          <div className="stills">
            {version.stills.map((s) => (
              <a key={s.frame} href={s.url!} target="_blank" rel="noreferrer" title={`Frame ${s.frame}`}>
                <img src={s.url!} alt={`Frame ${s.frame}`} />
              </a>
            ))}
          </div>
        )}
        <Compare scene={scene} still={version?.stills.at(-1)?.url ?? null} />
        {viewingOld && <p className="notice">You are looking at version {version!.version}. The current one is version {scene.current!.version}.</p>}

        {/* What you can do */}
        {planning ? (
          <PlanForm scene={scene} types={snapshot.sceneTypes} locked={stageIsScenes || working} onSaved={load} />
        ) : (
          <div className="actions">
            {scene.status === "needs_review" && !asking && (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.approveScene(scene.id), "Approved")}>
                  Approve this scene
                </button>
                <button className="btn" disabled={busy} onClick={() => setAsking(true)}>
                  Ask for changes
                </button>
              </>
            )}
            {scene.status === "approved" && !asking && (
              <button className="btn" disabled={busy} onClick={() => setAsking(true)}>
                Ask for changes
              </button>
            )}
            {scene.status === "failed" && (
              <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.buildScene(scene.id))}>
                Build it again
              </button>
            )}
            {(scene.status === "stale" || scene.status === "rendered") && (
              <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.renderScene(scene.id))}>
                Render it again
              </button>
            )}
            {(scene.status === "stale" || scene.status === "failed") && scene.current?.hasClip && !asking && (
              <button className="btn" disabled={busy} onClick={() => setAsking(true)}>
                Ask for changes
              </button>
            )}
            {working && run && (
              <button className="btn" disabled={busy} onClick={() => act(() => api.cancelRun(run.id))}>
                Stop this run
              </button>
            )}
            {asking && (
              <NotesBox
                label="Send to Claude"
                placeholder="What should change? For example: make the satellite larger, and bring the label in when the narrator says “atomic clock”."
                busy={busy}
                onCancel={() => setAsking(false)}
                onSend={async (notes) => {
                  if (await act(() => api.reviseScene(scene.id, notes))) setAsking(false);
                }}
              />
            )}
          </div>
        )}

        <h4>Narration {version?.durationSec ? <span className="muted small">· {duration(version.durationSec)}</span> : null}</h4>
        <p className="narration">{scene.narration}</p>
        {scene.visualIdea && (
          <>
            <h4>What the viewer sees</h4>
            <p>{scene.spec?.visual.description || scene.visualIdea}</p>
          </>
        )}
        <References scene={scene} snapshot={snapshot} onChanged={load} />
        {version?.summary && (
          <>
            <h4>What Claude says it built</h4>
            <p>{version.summary}</p>
          </>
        )}
        {version && version.checkProblems.length > 0 && (
          <>
            <h4>Problems found by the check</h4>
            <ul className="problems">
              {version.checkProblems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </>
        )}
        {version && version.checkNotes.length > 0 && (
          <>
            <h4>Worth knowing</h4>
            <ul className="notes">
              {version.checkNotes.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </>
        )}
        {scene.spec && scene.spec.cues.length > 0 && (
          <>
            <h4>Cues</h4>
            <table className="table">
              <tbody>
                {scene.spec.cues.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap">“{c.phrase}”</td>
                    <td>{c.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {scene.spec && scene.spec.sfx.length > 0 && (
          <>
            <h4>
              Sound effects {!snapshot.project.settings.sfx.enabled && <span className="muted small">· switched off for this video on the Plan tab</span>}
            </h4>
            <table className="table">
              <tbody>
                {scene.spec.sfx.map((s, i) => {
                  const cue = scene.spec!.cues.find((c) => c.id === s.at.cue);
                  return (
                    <tr key={i}>
                      <td className="nowrap">{s.sound ?? snapshot.assets.find((a) => a.id === s.assetId)?.label ?? "a sound file"}</td>
                      <td>{cue ? `as the narrator says “${cue.phrase}”` : `${s.at.sec ?? 0} s into the scene`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {scene.reviews.length > 0 && (
          <>
            <h4>Your reviews</h4>
            <ul className="history">
              {scene.reviews.map((r) => (
                <li key={r.id}>
                  <Chip tone={r.decision === "approve" ? "good" : "warn"}>{r.decision === "approve" ? "Approved" : "Asked for changes"}</Chip>
                  <span className="muted small">
                    version {r.targetVersion} · {ago(r.createdAt)}
                  </span>
                  {r.notes && <div>{r.notes}</div>}
                </li>
              ))}
            </ul>
          </>
        )}

        {scene.versions.length > 1 && (
          <>
            <h4>Versions</h4>
            <ul className="history">
              {scene.versions.map((v) => (
                <li key={v.id}>
                  <button className="link" onClick={() => setShown(v.version)}>
                    Version {v.version}
                  </button>
                  {v.version === scene.version && <Chip>Current</Chip>}
                  {v.version === scene.approvedVersion && <Chip tone="good">Approved</Chip>}
                  <span className="muted small">{ago(v.createdAt)}</span>
                  {v.version !== scene.version && v.hasClip && !working && (
                    <button className="link" disabled={busy} onClick={() => act(() => api.rollbackScene(scene.id, v.version), `Back on version ${v.version}`)}>
                      Go back to this version
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {run && (
          <>
            <h4>
              Latest run <Chip tone={RUN_STATUS[run.status]?.tone}>{RUN_STATUS[run.status]?.label ?? run.status}</Chip>
            </h4>
            <RunLog runId={run.id} live={run.status === "queued" || run.status === "running"} />
          </>
        )}

        {scene.code && (
          <details>
            <summary>Scene code</summary>
            <pre className="code">{scene.code}</pre>
          </details>
        )}
        {scene.spec && (
          <details>
            <summary>Scene spec</summary>
            <pre className="code">{JSON.stringify(scene.spec, null, 2)}</pre>
          </details>
        )}
      </div>
    </aside>
  );
}

const ROLE_TAKES: Record<string, string> = { style: "the look", layout: "the composition", motion: "the motion" };
const clock = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

/** The reference the scene was built after, next to the scene as it is now, so you can judge how well it was followed. */
function Compare({ scene, still }: { scene: SceneDetail; still: string | null }) {
  const ref = scene.references.find((r) => r.pictureUrl && r.role === "layout") ?? scene.references.find((r) => r.pictureUrl);
  if (!ref?.pictureUrl || !still) return null;
  return (
    <div className="compare">
      <figure>
        <img src={ref.pictureUrl} alt="" />
        <figcaption>
          Reference: {ref.label}
          {ref.atSec != null ? ` at ${clock(ref.atSec)}` : ""} · for {ROLE_TAKES[ref.role] ?? ref.role}
        </figcaption>
      </figure>
      <figure>
        <img src={still} alt="" />
        <figcaption>This scene, at its end</figcaption>
      </figure>
    </div>
  );
}

/** Pictures and clips you want this one scene to follow. */
function References({ scene, snapshot, onChanged }: { scene: SceneDetail; snapshot: Snapshot; onChanged: () => void }) {
  const [busy, act] = useAction();
  const [adding, setAdding] = useState(false);
  const [assetId, setAssetId] = useState("");
  const [role, setRole] = useState("layout");
  const [note, setNote] = useState("");
  const [atSec, setAtSec] = useState<number | null>(null);
  const [frames, setFrames] = useState<Keyframes>();
  const candidates = snapshot.assets.filter((a) => a.kind === "image" || a.kind === "video");
  const asset = candidates.find((a) => a.id === assetId);

  useEffect(() => {
    setFrames(undefined);
    setAtSec(null);
    if (asset?.kind !== "video") return;
    let live = true;
    api.keyframes(asset.id).then((k) => live && setFrames(k), () => undefined);
    return () => {
      live = false;
    };
  }, [asset?.id, asset?.kind]);

  const save = async () => {
    if (await act(() => api.setSceneReference(scene.id, { assetId, role, note: note.trim(), atSec }), "Attached")) {
      setAdding(false);
      setAssetId("");
      setNote("");
      onChanged();
    }
  };
  if (!candidates.length && !scene.references.length) return null;
  return (
    <>
      <h4>References for this scene</h4>
      {scene.references.length > 0 && (
        <ul className="refs">
          {scene.references.map((r) => (
            <li key={r.assetId}>
              {r.pictureUrl ? <img src={r.pictureUrl} alt="" /> : <span className="ref-empty" />}
              <div className="grow">
                <strong>{r.label}</strong>
                <span className="muted small">
                  {" "}
                  · for {ROLE_TAKES[r.role] ?? r.role}
                  {r.atSec != null ? ` · the moment at ${clock(r.atSec)}` : ""}
                </span>
                {r.note && <div className="small">{r.note}</div>}
              </div>
              <button className="link danger" disabled={busy} onClick={async () => (await act(() => api.setSceneReference(scene.id, { assetId: r.assetId, role: null }))) && onChanged()}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="form">
          <label>
            Picture or clip
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">Choose one of the project's files</option>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({a.kind})
                </option>
              ))}
            </select>
          </label>
          {asset?.kind === "video" && (
            <div>
              <span className="small">Which moment? {frames ? "One frame of each shot is shown." : "Finding the shots…"}</span>
              {frames && (
                <div className="keyframes">
                  {frames.keyframes.map((k) => (
                    <button key={k.index} className={`keyframe ${atSec === k.atSec ? "keyframe-on" : ""}`} onClick={() => setAtSec(atSec === k.atSec ? null : k.atSec)} title={`Shot from ${clock(k.shotStartSec)} to ${clock(k.shotEndSec)}`}>
                      {k.url && <img src={k.url} alt={`Frame at ${clock(k.atSec)}`} />}
                      <span>{clock(k.atSec)}</span>
                    </button>
                  ))}
                </div>
              )}
              <span className="muted small">{atSec === null ? "No frame chosen: Claude looks at the whole clip." : `Claude builds this scene after the frame at ${clock(atSec)}.`}</span>
            </div>
          )}
          <label>
            Follow it for
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="layout">the composition: what is where, and how large</option>
              <option value="style">the look: colours and line</option>
              <option value="motion">the motion: how things move</option>
            </select>
          </label>
          <label>
            Anything to add
            <input value={note} placeholder="For example: same arrangement, but with our satellite instead of the rocket" onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={busy || !assetId} onClick={save}>
              Attach to this scene
            </button>
            <button className="btn btn-quiet" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        candidates.length > 0 && (
          <button className="link" onClick={() => setAdding(true)}>
            Attach a reference
          </button>
        )
      )}
      <p className="muted small">
        A reference is a direction, not something to copy. Claude follows it the next time it builds this scene{scene.current ? ": use “Ask for changes” to have it rebuilt." : "."}
      </p>
    </>
  );
}

/** Before a scene is built, its plan can be edited by hand. */
function PlanForm({ scene, types, locked, onSaved }: { scene: SceneDetail; types: Snapshot["sceneTypes"]; locked: boolean; onSaved: () => void }) {
  const [busy, act] = useAction();
  const [title, setTitle] = useState(scene.title);
  const [narration, setNarration] = useState(scene.narration);
  const [visualIdea, setVisualIdea] = useState(scene.visualIdea);
  const [type, setType] = useState<string>(scene.type);
  const changed = title !== scene.title || narration !== scene.narration || visualIdea !== scene.visualIdea || type !== scene.type;
  const words = narration.split(/\s+/).filter(Boolean).length;
  return (
    <div className="form">
      <label>
        Title
        <input value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>
          Narration <span className="muted small">· {words} words, about {duration((words / 150) * 60)}</span>
        </span>
        <textarea rows={4} value={narration} disabled={locked} onChange={(e) => setNarration(e.target.value)} />
      </label>
      <label>
        What the viewer sees
        <textarea rows={2} value={visualIdea} disabled={locked} onChange={(e) => setVisualIdea(e.target.value)} />
      </label>
      <label>
        Made as
        <select value={type} disabled={locked} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {TYPE_NAME[t.type] ?? t.type}
            </option>
          ))}
        </select>
        <span className="muted small">{types.find((t) => t.type === type)?.about}</span>
      </label>
      {!locked && (
        <button
          className="btn btn-primary"
          disabled={busy || !changed || narration.trim().length < 3 || !title.trim()}
          onClick={async () => {
            if (await act(() => api.editPlan(scene.id, { title: title.trim(), narration: narration.trim(), visualIdea: visualIdea.trim(), type }), "Saved")) onSaved();
          }}
        >
          Save changes
        </button>
      )}
    </div>
  );
}
