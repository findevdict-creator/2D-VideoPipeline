import React, { useCallback, useEffect, useState } from "react";
import { api, type SceneDetail, type Snapshot } from "./api";
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
