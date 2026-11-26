import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, listen, type Asset, type Snapshot } from "./api";
import { Markdown } from "./markdown";
import { RunLog } from "./RunLog";
import { SceneDrawer } from "./SceneDrawer";
import { ago, Chip, duration, Link, NotesBox, RUN_KIND, RUN_STATUS, SCENE_STATUS, STAGES, TYPE_NAME, useAction, useRoute, useToast } from "./ui";

const TABS = [
  { id: "plan", name: "Plan" },
  { id: "shared", name: "Shared parts" },
  { id: "scenes", name: "Scenes" },
  { id: "assets", name: "Assets" },
  { id: "activity", name: "Activity" },
  { id: "video", name: "Video" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const HOME_TAB: Record<string, Tab> = { outline: "plan", bible: "plan", foundation: "shared", chapters: "scenes", scenes: "scenes", assembly: "video", done: "video" };

export function ProjectPage({ slug, tab }: { slug: string; tab?: string }) {
  const { go } = useRoute();
  const toast = useToast();
  const [snap, setSnap] = useState<Snapshot>();
  const [missing, setMissing] = useState<string>();
  const [openScene, setOpenScene] = useState<string>();
  const [version, setVersion] = useState(0);
  const projectId = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next = await api.project(slug);
      projectId.current = next.project.id;
      setSnap(next);
      setVersion((v) => v + 1);
    } catch (err) {
      setMissing(err instanceof Error ? err.message : String(err));
    }
  }, [slug]);

  // Reload when the studio says something about this project changed, at most a few times a second.
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = listen((event) => {
      if (event.projectId && event.projectId !== projectId.current) return;
      if (event.kind === "notice") toast(String(event.data.message ?? ""), event.data.level === "error" ? "bad" : "good");
      timer ??= setTimeout(() => {
        timer = undefined;
        void load();
      }, 300);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [load, toast]);

  if (missing) return <main className="page"><p className="notice notice-bad">{missing}</p><Link to="/">Back to your videos</Link></main>;
  if (!snap) return <main className="page"><p className="muted">Loading…</p></main>;

  const current: Tab = (TABS.find((t) => t.id === tab)?.id ?? HOME_TAB[snap.project.stage]) as Tab;
  const base = `/p/${encodeURIComponent(slug)}`;
  const counts: Partial<Record<Tab, number>> = {
    scenes: snap.scenes.filter((s) => s.status === "needs_review").length,
    activity: snap.runs.filter((r) => r.status === "running" || r.status === "queued").length + snap.jobs.filter((j: any) => j.status === "running" || j.status === "queued").length,
    shared: snap.sharedRequests.length,
  };

  return (
    <main className={`page ${openScene ? "with-drawer" : ""}`}>
      <div className="project-head">
        <div>
          <h1>{snap.project.title}</h1>
          <p className="muted">
            {duration(snap.project.targetDurationSec)} · {snap.project.aspect} · {snap.scenes.length ? `${snap.scenes.length} scenes` : "no scenes yet"}
          </p>
        </div>
      </div>
      <StageBar
        snap={snap}
        onChanged={() => {
          // An approved stage hands over to the next one, so show the tab where that stage's work appears.
          go(base);
          void load();
        }}
      />

      <nav className="tabs">
        {TABS.map((t) => (
          <Link key={t.id} to={`${base}/${t.id}`} className={`tab ${t.id === current ? "tab-on" : ""}`}>
            {t.name}
            {counts[t.id] ? <span className="count">{counts[t.id]}</span> : null}
          </Link>
        ))}
      </nav>

      {current === "plan" && <PlanTab snap={snap} />}
      {current === "shared" && <SharedTab snap={snap} />}
      {current === "scenes" && <ScenesTab snap={snap} onOpen={setOpenScene} open={openScene} />}
      {current === "assets" && <AssetsTab snap={snap} slug={slug} />}
      {current === "activity" && <ActivityTab snap={snap} />}
      {current === "video" && <VideoTab snap={snap} slug={slug} onOpenScenes={() => go(`${base}/scenes`)} />}

      {openScene && <SceneDrawer sceneId={openScene} snapshot={snap} refreshKey={version} onClose={() => setOpenScene(undefined)} />}
    </main>
  );
}

// ---------- The stage: where the project stands and what it needs from you ----------

function StageBar({ snap, onChanged }: { snap: Snapshot; onChanged: () => void }) {
  const [busy, act] = useAction();
  const [asking, setAsking] = useState(false);
  const { stage } = snap;
  const at = STAGES.findIndex((s) => s.stage === stage.stage);
  const done = stage.stage === "done";
  const slug = snap.project.slug;
  const working = stage.running > 0;
  const ready = !stage.waitingOn.length;
  const failed = snap.runs.find((r) => r.status === "failed" && r.targetKind === ({ outline: "outline", bible: "bible", foundation: "foundation", chapters: "chapter" } as Record<string, string>)[stage.stage]);
  const lastOfKind = snap.runs.find((r) => r.targetKind === failed?.targetKind);
  const stuck = !working && !ready && ["outline", "bible", "foundation", "chapters"].includes(stage.stage);
  const canAsk = ["outline", "bible", "foundation", "chapters"].includes(stage.stage) && !working && ready;
  const sceneWork = stage.stage === "scenes" && snap.scenes.some((s) => ["planned", "spec_ready", "failed"].includes(s.status)) && !working;

  return (
    <section className="card stage">
      <ol className="steps">
        {STAGES.map((s, i) => (
          <li key={s.stage} className={done || i < at ? "step step-done" : i === at ? "step step-now" : "step"}>
            <span className="step-dot">{done || i < at ? "✓" : i + 1}</span>
            {s.name}
          </li>
        ))}
      </ol>
      <div className="stage-body">
        <div className="stage-text">
          <strong>{stage.about}</strong>
          {working && (
            <p className="busy-line">
              <span className="spinner" /> Claude is working on it. You can watch under Activity.
            </p>
          )}
          {!working && ready && !done && <p>Ready for you. Look it over, then approve it or ask for changes.</p>}
          {stage.stage === "scenes" && !ready && <p>Open a scene to watch it, then approve it or say what should change. Each scene is rebuilt on its own.</p>}
          {!working && !ready && (
            <ul className="waiting">
              {stage.waitingOn.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {stuck && failed && lastOfKind?.id === failed.id && <p className="notice notice-bad">The last run failed: {failed.error}</p>}
        </div>
        {!done && (
          <div className="stage-actions">
            {ready && !working && (
              <button className="btn btn-primary" disabled={busy} onClick={() => act(async () => (await api.approveStage(slug), onChanged()))}>
                {stage.stage === "assembly" ? "Mark the video finished" : "Approve and continue"}
              </button>
            )}
            {canAsk && !asking && (
              <button className="btn" disabled={busy} onClick={() => setAsking(true)}>
                Ask for changes
              </button>
            )}
            {(stuck || sceneWork) && (
              <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.startStage(slug))}>
                {sceneWork ? "Build the remaining scenes" : "Start"}
              </button>
            )}
          </div>
        )}
      </div>
      {asking && (
        <NotesBox
          label="Send to Claude"
          placeholder="What should change?"
          busy={busy}
          onCancel={() => setAsking(false)}
          onSend={async (notes) => {
            if (await act(() => api.startStage(slug, notes))) setAsking(false);
          }}
        />
      )}
    </section>
  );
}

// ---------- Plan ----------

function Doc({ title, doc, empty }: { title: string; doc: Snapshot["documents"]["outline"]; empty: string }) {
  return (
    <section className="card doc">
      <div className="row">
        <h3>{title}</h3>
        {doc && <Chip tone={doc.status === "approved" ? "good" : "warn"}>{doc.status === "approved" ? "Approved" : "Needs your review"}</Chip>}
        {doc && <span className="muted small nowrap">version {doc.version}</span>}
      </div>
      {doc ? <Markdown text={doc.markdown} /> : <p className="muted">{empty}</p>}
    </section>
  );
}

function PlanTab({ snap }: { snap: Snapshot }) {
  const theme = snap.project.settings.theme;
  return (
    <div className="columns">
      <div>
        <section className="card">
          <h3>What you asked for</h3>
          <p>{snap.project.description}</p>
        </section>
        <Doc title="Outline" doc={snap.documents.outline} empty="Not written yet." />
        {snap.chapters.length > 0 && (
          <section className="card">
            <h3>Chapters</h3>
            <ol className="chapters">
              {snap.chapters.map((c) => (
                <li key={c.id}>
                  <strong>{c.title}</strong> <span className="muted small">· {duration(c.targetDurationSec)}</span>
                  <div className="muted">{c.goal}</div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
      <div>
        <Doc title="Bible" doc={snap.documents.bible} empty="Written after you approve the outline: the voice, the look, and the things that recur." />
        <section className="card">
          <h3>Look</h3>
          <div className="swatches">
            {Object.entries(theme.palette).map(([name, colour]) => (
              <div key={name} className="swatch">
                <span style={{ background: colour }} />
                {name}
              </div>
            ))}
          </div>
          <p className="muted">
            {theme.fontFamily} · {theme.visualStyle}
          </p>
        </section>
      </div>
    </div>
  );
}

// ---------- Shared parts ----------

function SharedTab({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  return (
    <>
      <p className="muted lead">Things that appear in more than one scene are built once, here, before any scene. Every scene then draws them the same way.</p>
      {!snap.shared.length && <p className="muted">Nothing shared is planned{snap.project.stage === "outline" || snap.project.stage === "bible" ? " yet. The bible decides what recurs." : "."}</p>}
      <div className="grid">
        {snap.shared.map((s) => {
          const preview = s.versions.at(-1)?.previewUrl;
          return (
            <section key={s.id} className="card shared-card">
              {preview ? <img className="thumb" src={preview} alt={`${s.name} demo`} /> : <div className="thumb thumb-empty">{s.currentVersion ? "No picture" : "Not built yet"}</div>}
              <div className="row wrap centred">
                <h3>{s.name}</h3>
                <Chip tone={s.status === "approved" ? "good" : s.status === "needs_review" ? "warn" : "quiet"}>
                  {s.status === "approved" ? "Approved" : s.status === "needs_review" ? "Needs your review" : "Planned"}
                </Chip>
                {s.currentVersion > 0 && <span className="muted small nowrap">version {s.currentVersion}</span>}
              </div>
              <p>{s.brief}</p>
              {s.code && (
                <details>
                  <summary>Code</summary>
                  <pre className="code">{s.code}</pre>
                </details>
              )}
            </section>
          );
        })}
      </div>
      {snap.sharedRequests.length > 0 && (
        <section className="card">
          <h3>Asked for by scenes</h3>
          <ul className="history">
            {snap.sharedRequests.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong> <span className="muted small">from scene {snap.scenes.find((s) => s.id === r.sceneId)?.label}</span>
                <div>{r.why}</div>
                <button className="link" disabled={busy} onClick={() => act(() => api.closeSharedRequest(r.id, "declined"))}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ---------- Scenes ----------

function ScenesTab({ snap, open, onOpen }: { snap: Snapshot; open?: string; onOpen: (id: string) => void }) {
  const [busy, act] = useAction();
  const [revising, setRevising] = useState<string>();
  if (!snap.chapters.length) return <p className="muted">Scenes come after the outline: each chapter gets its scene list, and you approve the list before anything is built.</p>;
  const planning = snap.project.stage === "chapters";
  return (
    <>
      {planning && <p className="muted lead">This is the scene list. Open a scene to edit its narration or type by hand, or ask Claude to rewrite a chapter. Nothing is built until you approve the list.</p>}
      {snap.chapters.map((chapter) => {
        const scenes = snap.scenes.filter((s) => s.chapterId === chapter.id);
        const words = scenes.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);
        const run = snap.runs.find((r) => r.targetKind === "chapter" && r.targetId === chapter.id && (r.status === "running" || r.status === "queued"));
        return (
          <section key={chapter.id} className="chapter">
            <div className="row">
              <h3>
                {chapter.position}. {chapter.title}
              </h3>
              <span className="muted small">
                {scenes.length} scenes · about {duration((words / 150) * 60)} of {duration(chapter.targetDurationSec)}
              </span>
              {run && (
                <span className="busy-line">
                  <span className="spinner" /> being written
                </span>
              )}
              {planning && !run && scenes.length > 0 && revising !== chapter.id && (
                <button className="link" onClick={() => setRevising(chapter.id)}>
                  Ask for changes to this chapter
                </button>
              )}
            </div>
            {revising === chapter.id && (
              <NotesBox
                label="Send to Claude"
                placeholder="What should change in this chapter's scenes?"
                busy={busy}
                onCancel={() => setRevising(undefined)}
                onSend={async (notes) => {
                  if (await act(() => api.reviseChapter(chapter.id, notes))) setRevising(undefined);
                }}
              />
            )}
            <div className="grid scenes">
              {scenes.map((scene) => {
                const status = SCENE_STATUS[scene.status] ?? { label: scene.status, tone: "quiet" };
                const still = scene.current?.stills.at(-1)?.url;
                return (
                  <button key={scene.id} className={`card scene-card ${open === scene.id ? "scene-open" : ""}`} onClick={() => onOpen(scene.id)}>
                    {still ? <img className="thumb" src={still} alt="" loading="lazy" /> : <div className="thumb thumb-empty">{scene.status === "in_production" ? <span className="spinner" /> : (TYPE_NAME[scene.type] ?? scene.type)}</div>}
                    <div className="row">
                      <span className="label">{scene.label}</span>
                      <strong className="grow">{scene.title}</strong>
                    </div>
                    <p className="clamp muted">{scene.narration}</p>
                    <div className="row">
                      <Chip tone={status.tone}>{status.label}</Chip>
                      <span className="muted small">{TYPE_NAME[scene.type] ?? scene.type}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}

// ---------- Assets ----------

function AssetsTab({ snap, slug }: { snap: Snapshot; slug: string }) {
  const [busy, act] = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const upload = (files: FileList | File[]) =>
    act(async () => {
      for (const file of Array.from(files)) await api.upload(slug, file);
    }, "Added");
  return (
    <>
      <div
        className={`drop ${over ? "drop-over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
        }}
      >
        <p>
          <strong>Drop images, video clips or sounds here</strong>
        </p>
        <p className="muted">
          Use them in image and video-clip scenes, or mark one as a reference to show Claude a style, a layout or a kind of motion. A reference is a direction, not something to copy.
        </p>
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Adding…" : "Choose files"}
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files?.length && upload(e.target.files).then(() => (e.target.value = ""))} />
      </div>
      <div className="grid">
        {snap.assets.map((asset) => (
          <AssetCard key={asset.id} asset={asset} />
        ))}
      </div>
    </>
  );
}

function AssetCard({ asset }: { asset: Asset }) {
  const [busy, act] = useAction();
  const [note, setNote] = useState(asset.reference?.note ?? "");
  const role = asset.reference?.role ?? "";
  const canBeReference = asset.kind === "image" || asset.kind === "video";
  return (
    <section className="card asset-card">
      {asset.kind === "image" && asset.url ? (
        <img className="thumb" src={asset.url} alt={asset.label} loading="lazy" />
      ) : asset.kind === "video" && asset.url ? (
        <video className="thumb" src={asset.url} controls preload="metadata" />
      ) : asset.kind.startsWith("audio") && asset.url ? (
        <audio className="audio" src={asset.url} controls preload="none" />
      ) : (
        <div className="thumb thumb-empty">{asset.kind}</div>
      )}
      <strong>{asset.label}</strong>
      <span className="muted small">
        {asset.kind.replace("audio_", "")} {asset.width ? `· ${asset.width}×${asset.height}` : ""} {asset.durationSec ? `· ${duration(asset.durationSec)}` : ""}
      </span>
      {canBeReference && (
        <label className="small">
          Use as a reference for
          <select value={role} disabled={busy} onChange={(e) => act(() => api.editAsset(asset.id, { reference: { role: e.target.value || null, note } }))}>
            <option value="">nothing</option>
            <option value="style">style</option>
            <option value="layout">layout</option>
            <option value="motion">motion</option>
          </select>
        </label>
      )}
      {role && (
        <input
          className="small"
          value={note}
          placeholder="What to take from it, for example: the colours, not the characters"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (asset.reference?.note ?? "") && act(() => api.editAsset(asset.id, { reference: { role, note } }))}
        />
      )}
      <button className="link danger" disabled={busy} onClick={() => confirm(`Remove “${asset.label}”?`) && act(() => api.deleteAsset(asset.id))}>
        Remove
      </button>
    </section>
  );
}

// ---------- Activity ----------

function ActivityTab({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  const active = snap.runs.find((r) => r.status === "running") ?? snap.runs[0];
  const [chosen, setChosen] = useState<string>();
  const shown = snap.runs.find((r) => r.id === chosen) ?? active;
  const target = (run: Snapshot["runs"][number]) => {
    if (run.targetKind === "scene") return `Scene ${snap.scenes.find((s) => s.id === run.targetId)?.label ?? ""}`;
    if (run.targetKind === "chapter") return `Scene list, chapter ${snap.chapters.find((c) => c.id === run.targetId)?.position ?? ""}`;
    return RUN_KIND[run.targetKind] ?? run.targetKind;
  };
  const jobs = snap.jobs as { id: string; kind: string; targetId: string | null; status: string; progress: number; error: string | null }[];
  const liveJobs = jobs.filter((j) => j.status === "running" || j.status === "queued");
  if (!snap.runs.length && !jobs.length) return <p className="muted">Nothing has run yet.</p>;
  return (
    <div className="columns activity">
      <div>
        {liveJobs.length > 0 && (
          <section className="card">
            <h3>Rendering</h3>
            {liveJobs.map((j) => (
              <div key={j.id} className="job">
                <span>{j.kind === "clip" ? `Scene ${snap.scenes.find((s) => s.id === j.targetId)?.label ?? ""}` : "The video"}</span>
                <progress value={j.status === "queued" ? 0 : j.progress} max={1} />
                <span className="muted small">{j.status === "queued" ? "waiting" : `${Math.round(j.progress * 100)}%`}</span>
              </div>
            ))}
          </section>
        )}
        <section className="card">
          <h3>Claude runs</h3>
          <ul className="runs">
            {snap.runs.map((run) => (
              <li key={run.id}>
                <button className={`run ${shown?.id === run.id ? "run-on" : ""}`} onClick={() => setChosen(run.id)}>
                  <span className="grow">
                    {target(run)}
                    {run.task === "revise" ? " · changes" : ""}
                  </span>
                  <Chip tone={RUN_STATUS[run.status]?.tone}>{RUN_STATUS[run.status]?.label ?? run.status}</Chip>
                  <span className="muted small">{ago(run.startedAt ?? run.queuedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div>
        {shown && (
          <section className="card">
            <div className="row">
              <h3 className="grow">{target(shown)}</h3>
              {shown.durationMs ? <span className="muted small">{duration(shown.durationMs / 1000)}</span> : null}
              {(shown.status === "running" || shown.status === "queued") && (
                <button className="btn" disabled={busy} onClick={() => act(() => api.cancelRun(shown.id))}>
                  Stop
                </button>
              )}
            </div>
            {shown.payload.notes && <p className="notice">Your notes: {shown.payload.notes}</p>}
            <RunLog runId={shown.id} live={shown.status === "running" || shown.status === "queued"} />
          </section>
        )}
      </div>
    </div>
  );
}

// ---------- Video ----------

function VideoTab({ snap, slug, onOpenScenes }: { snap: Snapshot; slug: string; onOpenScenes: () => void }) {
  const [busy, act] = useAction();
  const approved = snap.scenes.filter((s) => s.status === "approved").length;
  const built = snap.scenes.filter((s) => s.current).length;
  const jobs = snap.jobs as { id: string; kind: string; status: string; progress: number }[];
  const job = jobs.find((j) => j.kind === "assemble" && (j.status === "running" || j.status === "queued"));
  const allApproved = snap.scenes.length > 0 && approved === snap.scenes.length;
  return (
    <>
      <section className="card">
        <h3>Put the video together</h3>
        <p className="muted">
          Scenes are joined in order with their narration. Joining takes seconds because every scene already has its own clip. {approved} of {snap.scenes.length} scenes are approved.
        </p>
        <div className="row wrap centred">
          <button className="btn" disabled={busy || Boolean(job) || !built} onClick={() => act(() => api.assemble(slug, "preview"))}>
            Make a preview
          </button>
          <button className="btn btn-primary" disabled={busy || Boolean(job) || !allApproved} onClick={() => act(() => api.assemble(slug, "final"))} title={allApproved ? "" : "Every scene must be approved first"}>
            Render the final video
          </button>
          {!allApproved && snap.scenes.length > 0 && (
            <button className="link" onClick={onOpenScenes}>
              See which scenes are still open
            </button>
          )}
        </div>
        {job && (
          <div className="job">
            <span className="spinner" /> <span>Working</span>
            <progress value={job.progress} max={1} />
          </div>
        )}
      </section>
      {snap.renders.map((r, i) => (
        <section key={r.id} className="card render">
          <div className="row">
            <h3>{r.kind === "final" ? "Final video" : "Preview"}</h3>
            <span className="muted small">
              {duration(r.durationSec)} · {r.sceneVersions.length} scenes · {ago(r.createdAt)}
            </span>
            <span className="grow" />
            {r.url && (
              <a className="btn" href={r.url} download>
                Download
              </a>
            )}
            {r.srtUrl && (
              <a className="btn btn-quiet" href={r.srtUrl} download>
                Subtitles
              </a>
            )}
          </div>
          {r.url && (i === 0 ? <video className="player" src={r.url} controls /> : <details><summary>Watch</summary><video className="player" src={r.url} controls preload="none" /></details>)}
        </section>
      ))}
    </>
  );
}
