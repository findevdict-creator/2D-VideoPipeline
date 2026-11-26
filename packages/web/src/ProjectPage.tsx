import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, listen, type Asset, type Snapshot } from "./api";
import { Markdown } from "./markdown";
import { RunLog } from "./RunLog";
import { SceneDrawer } from "./SceneDrawer";
import { ago, CHAPTER_STATUS, Chip, duration, Link, NotesBox, RUN_KIND, RUN_STATUS, SCENE_STATUS, STAGES, TYPE_NAME, useAction, useRoute, useToast } from "./ui";

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
      {snap.usage && <UsageBanner usage={snap.usage} />}
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

// ---------- Claude's usage limit ----------

function UsageBanner({ usage }: { usage: NonNullable<Snapshot["usage"]> }) {
  const [busy, act] = useAction();
  const until = new Date(usage.until);
  const today = until.toDateString() === new Date().toDateString();
  const when = `${today ? "at" : `on ${until.toLocaleDateString([], { weekday: "long" })} at`} ${until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const runs = usage.waiting === 1 ? "1 run is" : `${usage.waiting} runs are`;
  return (
    <section className="notice notice-warn usage">
      <div>
        <strong>{usage.cause === "busy" ? "Claude is overloaded right now." : "Claude's usage limit was reached."}</strong>{" "}
        {usage.known ? `${runs} waiting and will carry on by ${usage.waiting === 1 ? "itself" : "themselves"} ${when}, when the limit lifts.` : `${runs} waiting. Claude did not say when the limit lifts, so the studio tries again ${when}.`}{" "}
        Nothing is lost, and you can keep reviewing and rendering in the meantime.
      </div>
      <button className="btn" disabled={busy} onClick={() => act(() => api.resumeUsage())}>
        Try now
      </button>
    </section>
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
          {working && stage.stage === "chapters" && snap.chapters.some((c) => c.status === "script_review") && (
            <p>You do not have to wait for the rest: a chapter whose scene list is ready can be approved under Scenes, and its scenes are built while the others are written.</p>
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
                {stage.stage === "assembly" ? "Mark the video finished" : stage.stage === "chapters" ? "Approve every scene list and build" : "Approve and continue"}
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
          <LookSwitch snap={snap} />
        </section>
        <Sound snap={snap} />
        <SceneTypes snap={snap} />
      </div>
    </div>
  );
}

/** Music under the narration, and the sound effects scenes ask for. Mixed when the video is put together, so nothing has to be rendered again. */
function Sound({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  const { music, sfx } = snap.project.settings;
  const files = snap.assets.filter((a) => a.kind === "audio_music" || a.kind === "audio_sfx");
  const set = (settings: { music?: Record<string, unknown>; sfx?: Record<string, unknown> }) => void act(() => api.updateSettings(snap.project.slug, settings));
  const percent = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <section className="card">
      <h3>Sound</h3>
      <div className="form">
        <label>
          Music
          <select value={music.assetId ?? ""} disabled={busy} onChange={(e) => set({ music: { assetId: e.target.value || null } })}>
            <option value="">No music</option>
            {files.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.durationSec ? ` (${duration(a.durationSec)})` : ""}
              </option>
            ))}
          </select>
          {!files.length && <span className="muted small">Add a music file on the Assets tab to choose it here. A file shorter than the video is repeated.</span>}
        </label>
        {music.assetId && (
          <>
            <label>
              <span>
                How loud under the voice <span className="muted small">· {percent(music.volume)}</span>
              </span>
              <input type="range" min={0} max={0.5} step={0.01} defaultValue={music.volume} disabled={busy} onPointerUp={(e) => set({ music: { volume: Number(e.currentTarget.value) } })} onKeyUp={(e) => set({ music: { volume: Number(e.currentTarget.value) } })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={music.duck} disabled={busy} onChange={(e) => set({ music: { duck: e.target.checked } })} />
              <span>Bring the music up in the pauses, and back down before the next words</span>
            </label>
            {music.duck && (
              <label>
                <span>
                  How loud in the pauses <span className="muted small">· {percent(music.gapVolume)}</span>
                </span>
                <input type="range" min={0} max={1} step={0.01} defaultValue={music.gapVolume} disabled={busy} onPointerUp={(e) => set({ music: { gapVolume: Number(e.currentTarget.value) } })} onKeyUp={(e) => set({ music: { gapVolume: Number(e.currentTarget.value) } })} />
              </label>
            )}
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={sfx.enabled} disabled={busy} onChange={(e) => set({ sfx: { enabled: e.target.checked } })} />
          <span>
            Sound effects <span className="muted small">· the pops, clicks and whooshes scenes put on their cues</span>
          </span>
        </label>
        {sfx.enabled && (
          <label>
            <span>
              How loud the effects are <span className="muted small">· {percent(sfx.volume)}</span>
            </span>
            <input type="range" min={0} max={2} step={0.05} defaultValue={sfx.volume} disabled={busy} onPointerUp={(e) => set({ sfx: { volume: Number(e.currentTarget.value) } })} onKeyUp={(e) => set({ sfx: { volume: Number(e.currentTarget.value) } })} />
          </label>
        )}
      </div>
      <p className="muted small">Music is added when a preview or the final video is put together. Effects are also in each scene's own clip the next time it is rendered. No scene has to be built again.</p>
    </section>
  );
}

/** Clean lines, or the slight wobble of something drawn by hand. Changing it puts built scenes out of date, and one action renders them again. */
function LookSwitch({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  const look = snap.project.settings.theme.look;
  const drawn = snap.scenes.filter((s) => ["rendered", "needs_review", "approved"].includes(s.status)).length;
  const change = (next: string) => {
    if (next === look) return;
    if (drawn && !confirm(`${drawn} scene${drawn === 1 ? " is" : "s are"} already drawn in the ${look === "hand-drawn" ? "hand-drawn" : "clean"} look. They will be marked out of date; “Render all again” on the Scenes tab redraws them without a Claude run. Change the look?`)) return;
    void act(() => api.updateSettings(snap.project.slug, { theme: { look: next } }), "Look changed");
  };
  return (
    <label className="small">
      Lines
      <select value={look} disabled={busy} onChange={(e) => change(e.target.value)}>
        <option value="clean">Clean</option>
        <option value="hand-drawn">Hand-drawn: everything wobbles slightly, like a sketch</option>
      </select>
    </label>
  );
}

/** Which kinds of scene Claude may choose when it plans a chapter. A scene's own kind can always be changed by hand. */
function SceneTypes({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  const allowed = snap.project.settings.sceneTypes;
  const toggle = (type: string) => {
    const next = allowed.includes(type) ? allowed.filter((t) => t !== type) : [...allowed, type];
    if (!next.some((t) => snap.sceneTypes.some((s) => s.type === t))) return;
    void act(() => api.updateSettings(snap.project.slug, { sceneTypes: next }));
  };
  return (
    <section className="card">
      <h3>Kinds of scene</h3>
      <p className="muted small">Claude picks one of these for each scene when it plans a chapter. You can change a scene's kind before it is built.</p>
      <ul className="types">
        {snap.sceneTypes.map((t) => (
          <li key={t.type}>
            <label className="check">
              <input type="checkbox" checked={allowed.includes(t.type)} disabled={busy} onChange={() => toggle(t.type)} />
              <span>
                <strong>{TYPE_NAME[t.type] ?? t.type}</strong>
                <span className="muted small"> · {t.about}</span>
              </span>
            </label>
          </li>
        ))}
        {snap.missingSceneTypes.map((t) => (
          <li key={t.type}>
            <label className="check">
              <input type="checkbox" checked={false} disabled readOnly />
              <span>
                <strong>{TYPE_NAME[t.type] ?? t.type}</strong>
                <span className="muted small"> · Not set up on this computer. {t.why}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Shared parts ----------

function SharedTab({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  return (
    <>
      <p className="muted lead">
        Things that appear in more than one scene are built once, here, before any scene. Every scene then draws them the same way. A character is built with fixed proportions and colours and a set of poses and expressions; scenes can only place
        and pose it.
      </p>
      {!snap.shared.length && <p className="muted">Nothing shared is planned{snap.project.stage === "outline" || snap.project.stage === "bible" ? " yet. The bible decides what recurs." : "."}</p>}
      <div className="grid">
        {snap.shared.map((s) => {
          const preview = s.versions.at(-1)?.previewUrl;
          return (
            <section key={s.id} className="card shared-card">
              {preview ? (
                <a href={preview} target="_blank" rel="noreferrer">
                  <img className="thumb" src={preview} alt={s.kind === "character" ? `${s.name}: every pose and expression` : `${s.name} demo`} />
                </a>
              ) : <div className="thumb thumb-empty">{s.currentVersion ? "No picture" : "Not built yet"}</div>}
              <div className="row wrap centred">
                <h3>{s.name}</h3>
                {s.kind === "character" && <Chip>Character</Chip>}
                <Chip tone={s.status === "approved" ? "good" : s.status === "needs_review" ? "warn" : "quiet"}>
                  {s.status === "approved" ? "Approved" : s.status === "needs_review" ? "Needs your review" : "Planned"}
                </Chip>
                {s.currentVersion > 0 && <span className="muted small nowrap">version {s.currentVersion}</span>}
              </div>
              <p>{s.brief}</p>
              {s.character && (
                <p className="small">
                  <span className="muted">Poses:</span> {s.character.poses.join(", ") || "none"} <span className="muted">· Expressions:</span> {s.character.expressions.join(", ") || "none"}
                </p>
              )}
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

const SCENE_FILTERS: { id: string; name: string; statuses?: string[] }[] = [
  { id: "all", name: "Every scene" },
  { id: "review", name: "Needs your review", statuses: ["needs_review", "rendered"] },
  { id: "working", name: "Being built", statuses: ["in_production", "spec_ready"] },
  { id: "attention", name: "Failed or out of date", statuses: ["failed", "stale"] },
  { id: "approved", name: "Approved", statuses: ["approved"] },
];

function ScenesTab({ snap, open, onOpen }: { snap: Snapshot; open?: string; onOpen: (id: string) => void }) {
  const [busy, act] = useAction();
  const [revising, setRevising] = useState<string>();
  const [watching, setWatching] = useState<string>();
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("all");
  if (!snap.chapters.length) return <p className="muted">Scenes come after the outline: each chapter gets its scene list, and you approve the list before anything is built.</p>;
  const planning = snap.project.stage === "chapters";
  const statuses = SCENE_FILTERS.find((f) => f.id === filter)?.statuses;
  const jobs = snap.jobs as { id: string; kind: string; targetId: string | null; status: string; progress: number }[];
  const many = snap.chapters.length > 2;
  const stale = snap.scenes.filter((s) => s.status === "stale");
  return (
    <>
      {planning && (
        <p className="muted lead">
          Scene lists are written one chapter after another. Open a scene to edit its narration or type by hand, or ask Claude to rewrite a chapter. Approve a chapter's list and its scenes are built straight away, while later chapters are still being
          written.
        </p>
      )}
      {stale.length > 0 && (
        <section className="notice notice-warn usage">
          <div>
            <strong>{stale.length === 1 ? "1 scene is out of date." : `${stale.length} scenes are out of date.`}</strong> {[...new Set(stale.map((s) => s.reason).filter(Boolean))].join(". ")}
            {". "}Rendering them again draws them with the shared parts as they are now, and puts them back up for your review.
          </div>
          <button className="btn" disabled={busy} onClick={() => act(() => api.rebuildStale(snap.project.slug))}>
            {stale.length === 1 ? "Render it again" : `Render all ${stale.length} again`}
          </button>
        </section>
      )}
      <div className="row wrap centred board-tools">
        {many && (
          <nav className="chapter-strip">
            {snap.chapters.map((c) => {
              const scenes = snap.scenes.filter((s) => s.chapterId === c.id);
              const approved = scenes.filter((s) => s.status === "approved").length;
              const tone = (CHAPTER_STATUS[c.status] ?? { tone: "quiet" }).tone;
              return (
                <a key={c.id} href={`#chapter-${c.position}`} className={`chip chip-${tone}`} title={`${c.title}: ${(CHAPTER_STATUS[c.status] ?? { label: c.status }).label}`}>
                  {c.position}
                  {scenes.length > 0 && c.status !== "planned" && c.status !== "scripting" ? ` · ${approved}/${scenes.length}` : ""}
                </a>
              );
            })}
          </nav>
        )}
        <span className="grow" />
        {snap.scenes.length > 0 && (
          <label className="check small">
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {SCENE_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.statuses ? ` (${snap.scenes.filter((s) => f.statuses!.includes(s.status)).length})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {snap.chapters.map((chapter) => {
        const all = snap.scenes.filter((s) => s.chapterId === chapter.id);
        const scenes = statuses ? all.filter((s) => statuses.includes(s.status)) : all;
        if (statuses && !scenes.length) return null;
        const words = all.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);
        const run = snap.runs.find((r) => r.targetKind === "chapter" && r.targetId === chapter.id && (r.status === "running" || r.status === "queued"));
        const status = CHAPTER_STATUS[chapter.status] ?? { label: chapter.status, tone: "quiet" };
        const approvedList = chapter.status === "in_production" || chapter.status === "done";
        const approved = all.filter((s) => s.status === "approved").length;
        const building = all.some((s) => s.status === "in_production");
        const unbuilt = all.filter((s) => ["planned", "spec_ready", "failed"].includes(s.status)).length;
        const built = all.filter((s) => s.current?.hasClip).length;
        const joining = jobs.find((j) => j.kind === "assemble" && j.targetId === chapter.id && (j.status === "running" || j.status === "queued"));
        const isFolded = folded[chapter.id] ?? false;
        return (
          <section key={chapter.id} className="chapter" id={`chapter-${chapter.position}`}>
            <div className="row centred">
              <button className="fold" aria-expanded={!isFolded} title={isFolded ? "Show this chapter's scenes" : "Hide this chapter's scenes"} onClick={() => setFolded((f) => ({ ...f, [chapter.id]: !isFolded }))}>
                {isFolded ? "▸" : "▾"}
              </button>
              <h3>
                {chapter.position}. {chapter.title}
              </h3>
              {(planning || approvedList || chapter.status === "scripting" || chapter.status === "script_review") && <Chip tone={status.tone}>{approvedList && all.length ? `${status.label} · ${approved} of ${all.length} approved` : status.label}</Chip>}
              {all.length > 0 && (
                <span className="muted small">
                  {all.length} scenes · about {duration((words / 150) * 60)} of {duration(chapter.targetDurationSec)}
                </span>
              )}
              {run && (
                <span className="busy-line">
                  <span className="spinner" /> being written
                </span>
              )}
            </div>
            <div className="row wrap centred chapter-actions">
              {chapter.status === "script_review" && !run && (
                <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.approveChapter(chapter.id))}>
                  Approve this scene list and build it
                </button>
              )}
              {approvedList && unbuilt > 0 && !building && (
                <button className="btn" disabled={busy} onClick={() => act(() => api.buildChapter(chapter.id))}>
                  Build the remaining {unbuilt === 1 ? "scene" : `${unbuilt} scenes`}
                </button>
              )}
              {approvedList && built > 0 && !joining && (
                <button className="btn" disabled={busy} onClick={() => act(() => api.previewChapter(chapter.id))}>
                  {chapter.preview ? "Make a new chapter preview" : "Preview this chapter"}
                </button>
              )}
              {joining && (
                <span className="busy-line">
                  <span className="spinner" /> joining the chapter preview
                </span>
              )}
              {chapter.preview?.url && (
                <button className="link" onClick={() => setWatching(watching === chapter.id ? undefined : chapter.id)}>
                  {watching === chapter.id ? "Hide the preview" : `Watch the preview (${duration(chapter.preview.durationSec)}${chapter.preview.current ? "" : ", scenes changed since"})`}
                </button>
              )}
              {!run && all.length > 0 && !building && revising !== chapter.id && (
                <button className="link" onClick={() => setRevising(chapter.id)}>
                  Ask for changes to this scene list
                </button>
              )}
            </div>
            {watching === chapter.id && chapter.preview?.url && <video className="player" src={chapter.preview.url} controls />}
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
            {!isFolded && (
              <div className="grid scenes">
                {scenes.map((scene) => {
                  const sceneStatus = SCENE_STATUS[scene.status] ?? { label: scene.status, tone: "quiet" };
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
                        <Chip tone={sceneStatus.tone}>{sceneStatus.label}</Chip>
                        <span className="muted small">{TYPE_NAME[scene.type] ?? scene.type}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
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
          <strong>Drop images, video clips, sounds or 3D models here</strong>
        </p>
        <p className="muted">
          Use them in image and video-clip scenes, or mark one as a reference to show Claude a style, a layout or a kind of motion. A reference is a direction, not something to copy. A model made in Blender
          goes in as a .glb file, and 3D scenes can move its named parts and play its animations.
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
  const [sheet, setSheet] = useState<string | null>();
  return (
    <section className="card asset-card">
      {asset.kind === "image" && asset.url ? (
        <img className="thumb" src={asset.url} alt={asset.label} loading="lazy" />
      ) : asset.kind === "video" && asset.url ? (
        <video className="thumb" src={asset.url} controls preload="metadata" />
      ) : asset.kind.startsWith("audio") && asset.url ? (
        <audio className="audio" src={asset.url} controls preload="none" />
      ) : asset.kind === "model" && asset.previewUrl ? (
        <img className="thumb thumb-model" src={asset.previewUrl} alt={asset.label} loading="lazy" />
      ) : (
        <div className="thumb thumb-empty">{asset.kind === "model" ? "3D model" : asset.kind}</div>
      )}
      <strong>{asset.label}</strong>
      <span className="muted small">
        {asset.kind === "model" ? "3D model" : asset.kind.replace("audio_", "")} {asset.width ? `· ${asset.width}×${asset.height}` : ""} {asset.durationSec ? `· ${duration(asset.durationSec)}` : ""}
        {asset.model ? `· ${asset.model.parts.length} parts · ${asset.model.triangles.toLocaleString()} triangles` : ""}
      </span>
      {asset.model && (
        <>
          <details className="small">
            <summary>Parts and animations</summary>
            <p>
              <span className="muted">Parts Claude can move, hide or recolour:</span> {asset.model.parts.map((p) => p.name).join(", ") || "none with a name"}
            </p>
            <p>
              <span className="muted">Animations:</span> {asset.model.animations.map((a) => `${a.name} (${a.durationSec} s)`).join(", ") || "none"}
            </p>
          </details>
          {asset.model.warnings.map((w) => (
            <p key={w} className="notice small">
              {w}
            </p>
          ))}
        </>
      )}
      {asset.kind === "video" &&
        (sheet ? (
          <a href={sheet} target="_blank" rel="noreferrer" title="One frame of each shot. Click to see it large.">
            <img className="sheet" src={sheet} alt={`Keyframes of ${asset.label}`} />
          </a>
        ) : (
          <button className="link small" disabled={busy} onClick={() => act(async () => setSheet((await api.keyframes(asset.id)).sheetUrl))}>
            {busy ? "Finding the shots…" : "Show one frame of each shot"}
          </button>
        ))}
      {canBeReference && (
        <label className="small">
          Use as a reference for the whole video:
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

const FRAMINGS = [
  { zoom: 1, name: "The whole picture" },
  { zoom: 1.25, name: "A little closer (crops the sides)" },
  { zoom: 1.5, name: "Close (crops a third of the width)" },
];

/** Export the approved video in a shape, as a package: the video, subtitles, a thumbnail and a description. */
function ExportCard({ snap, slug, ready }: { snap: Snapshot; slug: string; ready: boolean }) {
  const [busy, act] = useAction();
  const [format, setFormat] = useState(snap.exportFormats.find((f) => f.asBuilt)?.format ?? snap.exportFormats[0]!.format);
  const [chapterId, setChapterId] = useState("");
  const [zoom, setZoom] = useState(1);
  const jobs = snap.jobs as { id: string; kind: string; status: string; progress: number }[];
  const job = jobs.find((j) => j.kind === "export" && (j.status === "running" || j.status === "queued"));
  const chosen = snap.exportFormats.find((f) => f.format === format)!;
  const taller = chosen.width / chosen.height < snap.project.width / snap.project.height;
  const chapter = snap.chapters.find((c) => c.id === chapterId);
  const open = snap.scenes.filter((s) => (!chapter || s.chapterId === chapter.id) && s.status !== "approved").length;
  const can = snap.scenes.length > 0 && (chapter ? open === 0 : ready);
  return (
    <>
      <section className="card">
        <h3>Export</h3>
        <p className="muted">
          The approved video in the shape a site wants, as a folder with the video, its subtitles, a thumbnail and a description with chapter times. Another shape is made from the same scenes: nothing is built again, and the
          captions are laid out again to fit.
        </p>
        <div className="formats">
          {snap.exportFormats.map((f) => (
            <label key={f.format} className={`format ${f.format === format ? "chosen" : ""}`}>
              <input type="radio" name="export-format" checked={f.format === format} onChange={() => setFormat(f.format)} />
              <span className="grow">
                <strong>
                  {f.name} {f.asBuilt && <Chip>As built</Chip>}
                </strong>
                <span className="muted small">
                  {f.width} by {f.height}. {f.about}
                </span>
              </span>
              <span className="format-shape" style={{ width: Math.round((34 * f.width) / Math.max(f.width, f.height)), height: Math.round((34 * f.height) / Math.max(f.width, f.height)) }} />
            </label>
          ))}
        </div>
        <div className="row wrap">
          <label>
            What
            <select value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
              <option value="">The whole video</option>
              {snap.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  Chapter {c.position}: {c.title}
                </option>
              ))}
            </select>
          </label>
          {taller && (
            <label>
              Framing
              <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                {FRAMINGS.map((f) => (
                  <option key={f.zoom} value={f.zoom}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="btn btn-primary"
            disabled={busy || Boolean(job) || !can}
            title={can ? "" : "Every scene in it must be approved first"}
            onClick={() => act(() => api.exportVideo(slug, { format, zoom: taller ? zoom : 1, chapterId: chapterId || undefined }), "Exporting")}
          >
            Export
          </button>
          {!can && snap.scenes.length > 0 && <span className="muted small">{open || snap.scenes.filter((s) => s.status !== "approved").length} scenes are not approved yet.</span>}
        </div>
        {job && (
          <div className="job">
            <span className="spinner" /> <span>Exporting</span>
            <progress value={job.progress} max={1} />
          </div>
        )}
      </section>
      {snap.exports.map((e) => {
        const f = snap.exportFormats.find((x) => x.format === e.format);
        const part = e.scope !== "project" ? `chapter ${snap.chapters.find((c) => c.id === e.scope)?.position ?? ""}` : "the whole video";
        return (
          <section key={e.id} className="card">
            <div className="row">
              <h3>Export: {f?.name ?? e.format}</h3>
              <span className="muted small">
                {part} · {e.width} by {e.height} · {duration(e.durationSec)} · {ago(e.createdAt)}
              </span>
            </div>
            <div className="export">
              {e.url ? <video src={e.url} controls poster={e.thumbnailUrl ?? undefined} preload="none" /> : <span className="muted">The files were moved or deleted.</span>}
              <div>
                {e.notes.map((note, n) => (
                  <p key={n} className="notice">
                    {note}
                  </p>
                ))}
                <ul className="files">
                  {e.url && (
                    <li>
                      <a className="btn" href={e.url} download>
                        Download the video
                      </a>
                    </li>
                  )}
                  {e.subtitlesUrl && (
                    <li>
                      <a className="btn btn-quiet" href={e.subtitlesUrl} download>
                        Subtitles
                      </a>
                    </li>
                  )}
                  {e.thumbnailUrl && (
                    <li>
                      <a className="btn btn-quiet" href={e.thumbnailUrl} download>
                        Thumbnail
                      </a>
                    </li>
                  )}
                  {e.descriptionUrl && (
                    <li>
                      <a className="btn btn-quiet" href={e.descriptionUrl} target="_blank" rel="noreferrer">
                        Description
                      </a>
                    </li>
                  )}
                </ul>
                <div className="muted small">
                  All of it is in this folder: <code>{e.folderPath}</code>
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}

function VideoTab({ snap, slug, onOpenScenes }: { snap: Snapshot; slug: string; onOpenScenes: () => void }) {
  const [busy, act] = useAction();
  const approved = snap.scenes.filter((s) => s.status === "approved").length;
  const built = snap.scenes.filter((s) => s.current).length;
  const jobs = snap.jobs as { id: string; kind: string; targetId: string | null; status: string; progress: number }[];
  const job = jobs.find((j) => j.kind === "assemble" && !j.targetId && (j.status === "running" || j.status === "queued"));
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
      <ExportCard snap={snap} slug={slug} ready={allApproved} />
      {snap.renders.map((r, i) => (
        <section key={r.id} className="card render">
          <div className="row">
            <h3>{r.scope !== "project" ? `Preview of chapter ${snap.chapters.find((c) => c.id === r.scope)?.position ?? ""}` : r.kind === "final" ? "Final video" : "Preview"}</h3>
            <span className="muted small">
              {duration(r.durationSec)} · {r.sceneVersions.length} scenes · {ago(r.createdAt)}
              {r.changed > 0 && ` · ${r.changed === 1 ? "1 scene" : `${r.changed} scenes`} changed since`}
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
