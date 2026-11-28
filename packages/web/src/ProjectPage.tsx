import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, listen, type Asset, type Snapshot } from "./api";
import { Markdown } from "./markdown";
import { RunLog } from "./RunLog";
import { SceneDrawer } from "./SceneDrawer";
import { CloneVoice } from "./VoiceClone";
import { ago, CHAPTER_STATUS, Chip, closedMidRun, duration, Link, NotesBox, RUN_KIND, RUN_STATUS, SCENE_STATUS, STAGES, TYPE_NAME, useAction, useRoute, useToast } from "./ui";

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
  // The newest run of this stage was stopped by the studio closing. What it saved is kept, and Continue lets it finish.
  const stageKind = ({ outline: "outline", bible: "bible", foundation: "foundation", chapters: "chapter" } as Record<string, string>)[stage.stage];
  const newest = snap.runs.find((r) => r.targetKind === stageKind);
  const cutShort = !working && closedMidRun(newest);
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
          {cutShort ? (
            <p className="notice">
              The studio was closed before Claude finished this.{ready ? " What it saved is shown here: approve it as it is, or continue to let Claude finish." : " Continue to pick up where it stopped."}
            </p>
          ) : (
            stuck && failed && lastOfKind?.id === failed.id && <p className="notice notice-bad">The last run failed: {failed.error}</p>
          )}
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
            {(stuck || sceneWork || cutShort) && (
              <button className={`btn ${ready ? "" : "btn-primary"}`} disabled={busy} onClick={() => act(() => api.startStage(slug))}>
                {sceneWork ? "Build the remaining scenes" : cutShort ? "Continue" : "Start"}
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
          <Colours snap={snap} />
          <p className="muted">{theme.visualStyle}</p>
          <LookSwitch snap={snap} />
        </section>
        <Voice snap={snap} />
        <Subtitles snap={snap} />
        <Sound snap={snap} />
        <SceneTypes snap={snap} />
      </div>
    </div>
  );
}

/** Who narrates and how fast, with a sample to listen to before choosing. A narrator is a built-in voice or one cloned from your own. */
function Voice({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  const toast = useToast();
  const current = snap.project.settings.voice;
  const { list, paces, silent, clones, engines } = snap.voices;
  const [voice, setVoice] = useState(current.kokoroVoice);
  const [pace, setPace] = useState<string>(current.pace);
  const [line, setLine] = useState("");
  const [sample, setSample] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [cloning, setCloning] = useState(false);
  useEffect(() => {
    setVoice(current.kokoroVoice);
    setPace(current.pace);
  }, [current.kokoroVoice, current.pace]);
  const changed = voice !== current.kokoroVoice || pace !== current.pace;
  const recorded = snap.scenes.filter((s) => s.status !== "planned").length;
  const groups = [
    { name: "American, female", match: (v: (typeof list)[number]) => v.accent === "American" && v.gender === "female" },
    { name: "American, male", match: (v: (typeof list)[number]) => v.accent === "American" && v.gender === "male" },
    { name: "British, female", match: (v: (typeof list)[number]) => v.accent === "British" && v.gender === "female" },
    { name: "British, male", match: (v: (typeof list)[number]) => v.accent === "British" && v.gender === "male" },
  ];
  const clone = clones.find((c) => c.id === voice || c.chatterboxId === voice);
  const chatterbox = clone?.chatterboxId === voice;
  const known = list.some((v) => v.id === voice) || !!clone;
  // A project can still name a cloned voice that was deleted since.
  const gone = !known && voice.startsWith("clone.");
  const listen = async () => {
    setLoading(true);
    setSample(undefined);
    try {
      const got = await api.previewVoice(snap.project.slug, { voice, pace, text: line.trim() || undefined });
      setSample(got.url);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  const forget = () => {
    if (!clone || !confirm(`Delete the voice "${clone.name}" and its recording? Videos that use it will need another narrator.`)) return;
    void act(() => api.deleteVoice(clone.slug), "Voice deleted").then((ok) => ok && (setVoice(current.kokoroVoice === clone.id || current.kokoroVoice === clone.chatterboxId ? "af_heart" : current.kokoroVoice), setSample(undefined)));
  };
  return (
    <section className="card">
      <h3>Voice</h3>
      <div className="row wrap">
        <label>
          Narrator
          <select value={voice} disabled={busy} onChange={(e) => (setVoice(e.target.value), setSample(undefined))}>
            {!known && <option value={voice}>{gone ? "A deleted voice" : voice}</option>}
            {clones.length > 0 && (
              <optgroup label="Your voices">
                {clones.flatMap((c) => [
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>,
                  <option key={c.chatterboxId} value={c.chatterboxId}>
                    {c.name} (Chatterbox)
                  </option>,
                ])}
              </optgroup>
            )}
            {groups.map((g) => (
              <optgroup key={g.name} label={g.name}>
                {list.filter(g.match).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.id})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Pace
          <select value={pace} disabled={busy} onChange={(e) => (setPace(e.target.value), setSample(undefined))}>
            {paces.map((p) => (
              <option key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={loading || gone} onClick={listen}>
          {loading ? "Recording a sample…" : "Listen"}
        </button>
        <button className="btn btn-primary" disabled={busy || !changed || gone} onClick={() => act(() => api.setVoice(snap.project.slug, { voice, pace }), "Voice changed")}>
          Use this voice
        </button>
        {!cloning && (
          <button className="btn" disabled={busy} onClick={() => setCloning(true)}>
            Clone my voice
          </button>
        )}
      </div>
      <label className="test-line">
        <span>
          Test line <span className="muted small">· optional: a sentence of your own for Listen to speak</span>
        </span>
        <input type="text" value={line} maxLength={400} placeholder="This is how your video will sound. Each satellite carries a clock, and your phone listens for it." onChange={(e) => (setLine(e.target.value), setSample(undefined))} />
      </label>
      {sample && <audio src={sample} controls autoPlay style={{ width: "100%", marginTop: 10 }} />}
      {gone && <p className="warn small">This video was narrated by a cloned voice that has been deleted. Choose another narrator, or clone the voice again under the same name.</p>}
      {clone && (
        <div className="row wrap clone-row">
          <label>
            {clone.name} starts from
            <select value={clone.baseVoice} disabled={busy || chatterbox} onChange={(e) => (setSample(undefined), void act(() => api.setVoiceBase(clone.slug, e.target.value)))}>
              {!list.some((v) => v.id === clone.baseVoice) && <option value={clone.baseVoice}>{clone.baseVoice}</option>}
              {list.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.accent}, {v.gender})
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-quiet btn-danger" disabled={busy} onClick={forget}>
            Delete this voice
          </button>
          <span className="muted small">
            {chatterbox
              ? "Chatterbox speaks the line itself in your voice: closer to how you talk, but several times slower to record, and what happens on screen is timed a little less exactly."
              : `Made from a ${Math.round(clone.clipSec)} second recording. A built-in voice speaks and is then turned into yours. If it is not close enough, try another voice to start from, a cleaner recording, or ${clone.name} (Chatterbox).`}
          </span>
        </div>
      )}
      {clone && !silent && !chatterbox && !engines.kokoclone && <p className="warn small">Voice cloning is not installed yet. Run npm run setup:clone once (about 1 GB), then restart the studio.</p>}
      {clone && !silent && chatterbox && !engines.chatterbox && <p className="warn small">Chatterbox is not installed yet. Run npm run setup:chatterbox once (several GB), then restart the studio.</p>}
      {cloning && (
        <CloneVoice
          voices={snap.voices}
          onClose={() => setCloning(false)}
          onSaved={(id) => {
            setCloning(false);
            setVoice(id);
            setSample(undefined);
          }}
        />
      )}
      {silent && <p className="warn small">The stand-in voice is in use, so samples and narration are silent. Install the voice model (npm run setup:voice) to hear them.</p>}
      <p className="muted small">
        {recorded > 0 && changed
          ? `The narration of ${recorded} scene${recorded === 1 ? "" : "s"} is recorded again in the new voice the next time a preview or the final video is put together. Scenes keep their approval, and what happens on screen follows the new timing.`
          : "The first sample of a voice takes a few seconds while the voice model loads. Narration is recorded again only for a voice it has not been recorded in."}
      </p>
    </section>
  );
}

/** Whether the narration is also drawn in the picture, word by word. The subtitle file next to a video is written either way. */
function Subtitles({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  const on = snap.project.settings.captions;
  return (
    <section className="card">
      <h3>Subtitles</h3>
      <label className="check">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => act(() => api.updateSettings(snap.project.slug, { captions: e.target.checked }), e.target.checked ? "Subtitles are on" : "Subtitles are off")} />
        <span>
          <strong>Draw subtitles in the video</strong>
          <span className="muted small"> · the words of the narration, with the one being spoken highlighted</span>
        </span>
      </label>
      <p className="muted small">
        Scenes are drawn again {on ? "with" : "without"} them the next time a preview or the final video is put together; no scene is built again. A subtitle file (.srt) is always written next to the video, and one export can be made with or
        without them on the Video tab.
      </p>
    </section>
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

/**
 * The video's six colours and its font. Claude picks them when it writes the bible; here the
 * person can pick a ready-made scheme or any colour of their own, at any stage. Their choice
 * is kept by Claude from then on. Built scenes go out of date and one action renders them again.
 */
function Colours({ snap }: { snap: Snapshot }) {
  const [busy, act] = useAction();
  const theme = snap.project.settings.theme;
  const { schemes, fonts, use } = snap.colours;
  const [editing, setEditing] = useState(false);
  const [palette, setPalette] = useState<Record<string, string>>(theme.palette);
  const [font, setFont] = useState(theme.fontFamily);
  // What is saved changed under the editor (Claude set the theme, or another window did): show that.
  const saved = JSON.stringify([theme.palette, theme.fontFamily]);
  useEffect(() => {
    setPalette(theme.palette);
    setFont(theme.fontFamily);
  }, [saved]);
  const drawn = snap.scenes.filter((s) => ["rendered", "needs_review", "approved"].includes(s.status)).length;
  const changed = JSON.stringify([palette, font.trim() || theme.fontFamily]) !== saved;
  const scheme = schemes.find((s) => JSON.stringify(s.palette).toLowerCase() === JSON.stringify(palette).toLowerCase());
  const valid = Object.values(palette).every((c) => /^#[0-9a-fA-F]{6}$/.test(c));

  const save = () => {
    if (drawn && !confirm(`${drawn} scene${drawn === 1 ? " is" : "s are"} already drawn in the current colours. They will be marked out of date; “Render all again” on the Scenes tab redraws them without a Claude run. Change the colours?`)) return;
    void act(async () => {
      await api.chooseColours(snap.project.slug, { palette, fontFamily: font.trim() || undefined });
      setEditing(false);
    }, "Colours changed");
  };

  if (!editing) {
    return (
      <>
        <div className="swatches">
          {Object.entries(theme.palette).map(([name, colour]) => (
            <div key={name} className="swatch" title={`${use[name as keyof typeof use]}: ${colour}`}>
              <span style={{ background: colour }} />
              {name}
            </div>
          ))}
        </div>
        {snap.colours.warnings.map((w) => (
          <p key={w} className="warn small">
            {w}
          </p>
        ))}
        <p className="muted small">
          Font: {theme.fontFamily}. {theme.locked ? "You chose these colours and this font, so Claude keeps them." : "Claude chooses these when it writes the bible. Change them and it keeps yours."}
        </p>
        <div className="row">
          <button className="btn" onClick={() => setEditing(true)}>
            Change colours and font
          </button>
          {theme.locked && (
            <button className="link" disabled={busy} onClick={() => act(() => api.chooseColours(snap.project.slug, { locked: false }), "Claude will choose the colours the next time it writes the bible")}>
              Let Claude choose again
            </button>
          )}
        </div>
      </>
    );
  }
  return (
    <div className="colours">
      <label className="small">
        Scheme
        <select value={scheme?.id ?? ""} onChange={(e) => setPalette(schemes.find((s) => s.id === e.target.value)?.palette ?? palette)}>
          {!scheme && <option value="">Your own colours</option>}
          {schemes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="colour-grid">
        {Object.entries(palette).map(([name, colour]) => (
          <label key={name} className="small colour">
            <span>
              {name} <span className="muted">· {use[name as keyof typeof use]}</span>
            </span>
            <span className="row">
              <input type="color" aria-label={`${name} colour`} value={/^#[0-9a-fA-F]{6}$/.test(colour) ? colour : "#000000"} onChange={(e) => setPalette({ ...palette, [name]: e.target.value.toUpperCase() })} />
              <input type="text" aria-label={`${name} hex code`} value={colour} maxLength={7} spellCheck={false} onChange={(e) => setPalette({ ...palette, [name]: e.target.value.trim() })} />
            </span>
          </label>
        ))}
      </div>
      <div className="colour-sample" style={{ background: palette.background, color: palette.text, fontFamily: `${JSON.stringify(font)}, Inter, sans-serif` }}>
        <strong>How a title looks</strong>
        <span className="colour-card" style={{ background: palette.surface }}>
          A label on a card, with <span style={{ color: palette.primary }}>primary</span>, <span style={{ color: palette.secondary }}>secondary</span> and <span style={{ color: palette.accent }}>accent</span>
        </span>
      </div>
      <label className="small">
        Font
        <input type="text" list="studio-fonts" value={font} onChange={(e) => setFont(e.target.value)} />
        <datalist id="studio-fonts">
          {fonts.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <span className="muted" style={{ fontWeight: 400 }}>
          Any font installed on this computer works. Type its name as it appears in your font list.
        </span>
      </label>
      {!valid && <p className="warn small">Each colour is a hex code such as #1A2B3C.</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !changed || !valid} onClick={save}>
          Save colours and font
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setPalette(theme.palette);
            setFont(theme.fontFamily);
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
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
      <GeneratedImages snap={snap} slug={slug} />
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
          <strong>Drop images, video clips, sounds, 3D models or documents here</strong>
        </p>
        <p className="muted">
          Use them in image and video-clip scenes, or mark one as a reference to show Claude a style, a layout or a kind of motion. A reference is a direction, not something to copy. A model made in Blender
          goes in as a .glb file, and 3D scenes can move its named parts and play its animations. A report the video should be built on goes in as a PDF, a Word file or plain text: Claude reads it before it
          plans, takes its facts from it, and can show its charts.
        </p>
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Adding…" : "Choose files"}
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files?.length && upload(e.target.files).then(() => (e.target.value = ""))} />
      </div>
      <AddLink slug={slug} />
      <div className="grid">
        {snap.assets.map((asset) => (
          <AssetCard key={asset.id} asset={asset} />
        ))}
      </div>
    </>
  );
}

/** Add an article or a YouTube video by its address, as what the video is about or what it should be like. */
function AddLink({ slug }: { slug: string }) {
  const [busy, act] = useAction();
  const [url, setUrl] = useState("");
  const [use, setUse] = useState("");
  const [note, setNote] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const video = /youtu\.?be/i.test(url);
  const chosen = use || (video ? "model" : "source");
  return (
    <section className="card">
      <h3>Add a link</h3>
      <p className="muted small">
        Paste the address of an article to build the video on it, or of a YouTube video to make yours like it. An article's text is fetched and kept as a document. For a YouTube video the studio gets the title,
        the thumbnail and the transcript, not the pictures: to have Claude follow how a video looks and moves, add a clip of it as a file and mark it as a reference.
      </p>
      <div className="row wrap">
        <label className="grow">
          Address
          <input value={url} placeholder="https://…" onChange={(e) => (setUrl(e.target.value), setWarnings([]))} />
        </label>
        <label>
          Use it as
          <select value={chosen} onChange={(e) => setUse(e.target.value)}>
            <option value="source">what the video is about</option>
            <option value="model">what the video should be like</option>
          </select>
        </label>
      </div>
      <label>
        What Claude should do with it
        <input value={note} placeholder={chosen === "model" ? "For example: the same fast opening and one idea per scene" : "For example: explain the three findings, leave out the history"} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button
        className="btn primary"
        disabled={busy || url.trim().length < 4}
        onClick={() =>
          act(async () => {
            const added = await api.addLink(slug, { url: url.trim(), use: chosen, note: note.trim() || undefined });
            setWarnings(added.warnings);
            setUrl("");
            setNote("");
            setUse("");
          }, "Added")
        }
      >
        {busy ? "Fetching…" : "Add link"}
      </button>
      {warnings.map((w) => (
        <p key={w} className="notice small">
          {w}
        </p>
      ))}
    </section>
  );
}

/** The switch that allows AI-generated images for this video, the key, and a box to ask for one. */
function GeneratedImages({ snap, slug }: { snap: Snapshot; slug: string }) {
  const [busy, act] = useAction();
  const im = snap.images;
  const [prompt, setPrompt] = useState("");
  const [label, setLabel] = useState("");
  const [aspect, setAspect] = useState<string>(snap.project.aspect);
  const [key, setKey] = useState("");
  const [editKey, setEditKey] = useState(false);
  const needsKey = im.engine !== "mock" && !im.keyFrom;
  return (
    <section className="card">
      <h3>AI images</h3>
      <label className="check">
        <input type="checkbox" checked={im.enabled} disabled={busy} onChange={(e) => act(() => api.allowImages(slug, e.target.checked), e.target.checked ? "Generated images are allowed for this video" : "Generated images are off for this video")} />
        Allow AI-generated images in this video
      </label>
      <p className="muted small">
        Off: Claude draws everything in code and uses only the files you add. On: Claude may also make pictures with Google's image model ({im.model}) for image scenes, and you can ask for one here. Each image
        is charged to your Google key. Claude has made {im.madeByClaude} of at most {im.limit} for this video.
      </p>
      {im.engine === "mock" && <p className="notice small">The stand-in image engine is in use, so pictures are plain coloured placeholders and nothing is charged.</p>}
      {im.enabled && (needsKey || editKey) && (
        <div className="row wrap">
          <label className="grow">
            Google AI Studio key
            <input type="password" value={key} placeholder="Paste the key from aistudio.google.com/apikey" autoComplete="off" onChange={(e) => setKey(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy || !key.trim()} onClick={() => act(async () => (await api.saveImageKey(key), setKey(""), setEditKey(false)), "Key saved")}>
            Save key
          </button>
        </div>
      )}
      {im.enabled && needsKey && <p className="muted small">The key is kept in your projects folder on this computer, not in the repository, and is sent only to Google.</p>}
      {im.enabled && !needsKey && im.engine !== "mock" && !editKey && (
        <p className="muted small">
          A key is set{im.keyFrom === "environment" ? " (GEMINI_API_KEY)" : im.keyFrom === "config" ? " (pipeline.config.json)" : ""}.{" "}
          {im.keyFrom === "studio" && (
            <>
              <button className="link" onClick={() => setEditKey(true)}>
                Change it
              </button>{" "}
              ·{" "}
              <button className="link danger" disabled={busy} onClick={() => confirm("Forget the key?") && act(() => api.saveImageKey(""), "Key removed")}>
                Forget it
              </button>
            </>
          )}
        </p>
      )}
      {im.ready && (
        <>
          <label>
            Make an image
            <textarea rows={3} value={prompt} placeholder="Describe the picture: the subject, the setting, the style and the light. For example: a watercolour of a lighthouse on a cliff at dusk, soft warm light, no text" onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <div className="row wrap">
            <label>
              Name
              <input value={label} placeholder="optional" maxLength={60} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label>
              Shape
              <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {im.aspects.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={busy || prompt.trim().length < 10} onClick={() => act(async () => (await api.generateImage(slug, { prompt, label: label || undefined, aspect }), setPrompt(""), setLabel("")), "Image added below")}>
              {busy ? "Generating…" : "Generate"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function AssetCard({ asset }: { asset: Asset }) {
  const [again, setAgain] = useState<string | null>(null);
  const [docNote, setDocNote] = useState(asset.sourceNote);
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
      ) : asset.kind === "document" && asset.previewUrl ? (
        <a href={asset.url ?? undefined} target="_blank" rel="noreferrer" title="Open the document">
          <img className="thumb thumb-page" src={asset.previewUrl} alt={asset.label} loading="lazy" />
        </a>
      ) : (
        <div className="thumb thumb-empty">{asset.kind === "model" ? "3D model" : asset.kind}</div>
      )}
      <strong>{asset.label}</strong>
      <span className="muted small">
        {asset.kind === "model" ? "3D model" : asset.kind.replace("audio_", "")} {asset.width ? `· ${asset.width}×${asset.height}` : ""} {asset.durationSec ? `· ${duration(asset.durationSec)}` : ""}
        {asset.document ? `· ${asset.document.pages} ${asset.document.format === "pdf" ? "page" : "part"}${asset.document.pages === 1 ? "" : "s"} · ${asset.document.words.toLocaleString()} words ` : ""}
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
      {asset.document && (
        <>
          {!asset.document.hasText && <p className="notice small">This PDF is pictures of pages, like a scan, with no text in it. Claude can look at its pages one by one, which is slower and less exact than reading. A copy with real text works better.</p>}
          {asset.link && (
            <p className="muted small">
              {asset.link.kind === "youtube" ? "YouTube video" : "From"} {asset.link.from ? `${asset.link.kind === "youtube" ? "by " : ""}${asset.link.from}` : ""}:{" "}
              <a href={asset.link.url} target="_blank" rel="noreferrer">
                open the original
              </a>
              {asset.link.kind === "youtube" && !asset.link.transcript ? ". Its transcript could not be fetched." : ""}
            </p>
          )}
          <label className="small">
            Use it as:
            <select value={asset.use ?? "source"} disabled={busy} onChange={(e) => act(() => api.editAsset(asset.id, { use: e.target.value }))}>
              <option value="source">what the video is about</option>
              <option value="model">what the video should be like</option>
            </select>
          </label>
          <label className="small">
            What Claude should do with it:
            <textarea
              className="small"
              rows={2}
              value={docNote}
              placeholder="For example: build the case for closing the outfall from section 3. Or: background only"
              onChange={(e) => setDocNote(e.target.value)}
              onBlur={() => docNote !== asset.sourceNote && act(() => api.editAsset(asset.id, { sourceNote: docNote }), "Saved")}
            />
          </label>
          {asset.url && (
            <a className="small" href={asset.url} target="_blank" rel="noreferrer">
              Open the document
            </a>
          )}
        </>
      )}
      {asset.fromDocument && <p className="muted small">{asset.sourceNote}</p>}
      {asset.generated && (
        <>
          <p className="muted small" title={asset.generated.prompt}>
            Generated {asset.generated.by === "claude" ? "by Claude" : "by you"}: {asset.generated.prompt.length > 140 ? `${asset.generated.prompt.slice(0, 140)}…` : asset.generated.prompt}
          </p>
          {again === null ? (
            <button className="link small" disabled={busy} onClick={() => setAgain(asset.generated!.prompt)}>
              Generate again
            </button>
          ) : (
            <>
              <textarea className="small" rows={4} value={again} onChange={(e) => setAgain(e.target.value)} />
              <div className="row">
                <button
                  className="btn small"
                  disabled={busy || again.trim().length < 10}
                  onClick={() =>
                    act(async () => {
                      const r = await api.regenerateImage(asset.id, again);
                      setAgain(null);
                      return r;
                    }, "Generated again. Scenes that use it are marked out of date")
                  }
                >
                  {busy ? "Generating…" : "Generate"}
                </button>
                <button className="link small" disabled={busy} onClick={() => setAgain(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </>
      )}
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

/** The picture that decides whether someone clicks: designed by Claude, shown at full size and at the size it is seen at. */
function ThumbnailCard({ snap, slug }: { snap: Snapshot; slug: string }) {
  const [busy, act] = useAction();
  const [asking, setAsking] = useState(false);
  const { design, designing, failed } = snap.thumbnail;
  const hasOutline = Boolean(snap.documents.outline);
  return (
    <section className="card">
      <h3>Thumbnail</h3>
      <p className="muted">
        Claude designs a thumbnail for the video, 1280 by 720, following the studio's guide for thumbnails that get clicked: one subject, at most four words, strong contrast, and a reason to be curious. It goes into every 16:9 export.
      </p>
      {design?.url ? (
        <div className="thumbnail">
          <img src={design.url} alt="The designed thumbnail" />
          <div>
            {design.smallUrl && (
              <>
                <img className="thumbnail-small" src={design.smallUrl} alt="The thumbnail at the size it is seen at in a list" />
                <p className="muted small">The size most people see it at. If you cannot read it here, ask for larger text.</p>
              </>
            )}
            {design.text && (
              <p>
                <strong>{design.text}</strong>
              </p>
            )}
            {design.idea && <p className="muted small">{design.idea}</p>}
            {design.others.length > 0 && (
              <div className="muted small">
                Other ideas Claude considered. YouTube can test up to three thumbnails against each other, so one of these is worth asking for:
                <ul>
                  {design.others.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
            <a className="btn btn-quiet" href={design.url} download="thumbnail.png">
              Download
            </a>
          </div>
        </div>
      ) : design ? (
        <p className="muted">A design is saved, but it has not been drawn on this computer.</p>
      ) : null}
      {failed && !designing && <p className="notice notice-bad">The last design run failed: {failed.split("\n")[0]}</p>}
      {designing ? (
        <p className="notice">Claude is designing the thumbnail. It draws a version, looks at it small, and improves it, which takes a few minutes. Progress is on the Activity tab.</p>
      ) : asking ? (
        <NotesBox
          label="Send to Claude"
          placeholder="What should change? For example: make the number larger, use the character, try a different idea."
          busy={busy}
          onCancel={() => setAsking(false)}
          onSend={(notes) => act(async () => (await api.designThumbnail(slug, notes), setAsking(false)), "Claude is on it")}
        />
      ) : (
        <div className="row">
          <button className={`btn ${design ? "" : "btn-primary"}`} disabled={busy || !hasOutline} title={hasOutline ? "" : "The thumbnail is designed from the outline, which is not written yet"} onClick={() => act(() => api.designThumbnail(slug), "Claude is designing the thumbnail")}>
            {design ? "Design a new one" : "Design a thumbnail"}
          </button>
          {design && (
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>
              Ask for changes
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The script read for what would make a viewer leave: the opening, the stretches that drag, the ending. */
function RetentionCard({ snap, slug }: { snap: Snapshot; slug: string }) {
  const [busy, act] = useAction();
  const [asking, setAsking] = useState(false);
  const r = snap.retention;
  const hasScript = snap.scenes.length > 0;
  return (
    <section className="card">
      <h3>Will people keep watching?</h3>
      <p className="muted">
        Claude reads the script against the studio's retention guide, as a viewer who owes the video nothing: does the first sentence deliver on the title, where would a bored viewer leave, does it end on its answer. It changes nothing. Send
        a finding as a review note on the chapter or scene it names. It is best run when the scene lists are written and before the scenes are built.
      </p>
      {r && (
        <div>
          <p>
            <strong>{r.verdict === "ready" ? "Ready." : "Fix first."}</strong> {r.summary}
          </p>
          {r.promise && <p className="muted small">Promise: {r.promise}</p>}
          <p className="muted small">
            Opens with: “{r.measures.firstSentence}” · {r.measures.words} words in {r.measures.scenes} scenes
          </p>
          {r.findings.length > 0 && (
            <ul>
              {r.findings.map((f, i) => (
                <li key={i} style={{ marginBottom: 8 }}>
                  <strong>
                    {f.where} ({f.severity})
                  </strong>
                  : {f.problem}
                  <br />
                  <span className="muted">Change: {f.fix}</span>
                </li>
              ))}
            </ul>
          )}
          {r.short && (
            <p className="muted small">
              Best Short: chapter {r.short.chapter}, opening on “{r.short.openingLine}”
            </p>
          )}
        </div>
      )}
      {asking ? (
        <NotesBox
          label="Check with these numbers"
          placeholder="Numbers from YouTube Studio for this or an earlier video. For example: 42% still watching at 0:30, a drop at 1:10, average view duration 0:55 of 3:20."
          busy={busy}
          onCancel={() => setAsking(false)}
          onSend={(notes) => act(async () => (await api.checkRetention(slug, notes), setAsking(false)), "Checked")}
        />
      ) : (
        <div className="row">
          <button className={`btn ${r ? "" : "btn-primary"}`} disabled={busy || !hasScript} title={hasScript ? "" : "The check reads the scene lists, which are not written yet"} onClick={() => act(() => api.checkRetention(slug), "Checked")}>
            {busy ? "Claude is reading…" : r ? "Check again" : "Check the script"}
          </button>
          <button className="btn" disabled={busy || !hasScript} onClick={() => setAsking(true)}>
            Add analytics numbers
          </button>
        </div>
      )}
    </section>
  );
}

/** One field of the upload form, with a button that copies it. */
function CopyField({ label, value, rows, count, onChange }: { label: string; value: string; rows: number; count?: string; onChange: (value: string) => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, "good");
    } catch {
      toast("Copying is not allowed in this browser. Select the text and copy it.");
    }
  };
  return (
    <label className="copy-field">
      <span className="row">
        <span className="grow">
          {label} {count && <span className="muted small">· {count}</span>}
        </span>
        <button type="button" className="link" onClick={copy}>
          Copy
        </button>
      </span>
      {rows === 1 ? <input type="text" value={value} onChange={(e) => onChange(e.target.value)} /> : <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

/** The title, description and tags for uploading, written by Claude from the outline and the narration, and editable. */
function UploadDetails({ snap, slug }: { snap: Snapshot; slug: string }) {
  const [busy, act] = useAction();
  const [asking, setAsking] = useState(false);
  const y = snap.youtube;
  const [title, setTitle] = useState(y?.title ?? "");
  const [description, setDescription] = useState(y?.description ?? "");
  const [tags, setTags] = useState(y?.tags.join(", ") ?? "");
  const [hashtags, setHashtags] = useState(y?.hashtags.join(", ") ?? "");
  const saved = JSON.stringify(y);
  useEffect(() => {
    setTitle(y?.title ?? "");
    setDescription(y?.description ?? "");
    setTags(y?.tags.join(", ") ?? "");
    setHashtags(y?.hashtags.join(", ") ?? "");
  }, [saved]);
  const changed = y && (title !== y.title || description !== y.description || tags !== y.tags.join(", ") || hashtags !== y.hashtags.join(", "));
  const hasOutline = Boolean(snap.documents.outline);
  return (
    <section className="card">
      <h3>Title, description and tags</h3>
      <p className="muted">
        What YouTube asks for when you upload, written from the video's outline and narration. Edit anything; an export puts it in the folder as youtube.txt, with the chapter times and hashtags added to the description.
      </p>
      {y && (
        <div className="upload-details">
          <CopyField label="Title" value={title} rows={1} count={`${title.length} of 100 characters`} onChange={setTitle} />
          {y.alternativeTitles.length > 0 && (
            <p className="muted small">
              Other titles:{" "}
              {y.alternativeTitles.map((t) => (
                <button key={t} className="link" style={{ marginRight: 12 }} onClick={() => setTitle(t)}>
                  {t}
                </button>
              ))}
            </p>
          )}
          <CopyField label="Description" value={description} rows={8} onChange={setDescription} />
          <CopyField label="Tags" value={tags} rows={3} count={`${tags.length} of 500 characters`} onChange={setTags} />
          <CopyField label="Hashtags" value={hashtags} rows={1} count="up to three" onChange={setHashtags} />
        </div>
      )}
      {asking ? (
        <NotesBox
          label="Write them again"
          placeholder="What should be different? For example: aim the title at students, mention the prize."
          busy={busy}
          onCancel={() => setAsking(false)}
          onSend={(notes) => act(async () => (await api.writeYouTube(slug, notes), setAsking(false)), "Written")}
        />
      ) : (
        <div className="row">
          {changed && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.saveYouTube(slug, { title, description, tags, hashtags }), "Saved")}>
              Save changes
            </button>
          )}
          <button className={`btn ${y ? "" : "btn-primary"}`} disabled={busy || !hasOutline} title={hasOutline ? "" : "They are written from the outline, which is not there yet"} onClick={() => act(() => api.writeYouTube(slug), "Written")}>
            {busy ? "Claude is writing…" : y ? "Write them again" : "Write title, description and tags"}
          </button>
          {y && (
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>
              Ask for changes
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const FRAMINGS = [
  { id: "fill", fit: "fill", zoom: undefined, name: "Fill the frame (crops what does not fit)" },
  { id: "blur", fit: "blur", zoom: 1, name: "The whole picture, on a blurred copy of itself" },
  { id: "whole", fit: "whole", zoom: 1, name: "The whole picture, on the background colour" },
  { id: "closer", fit: "blur", zoom: 1.5, name: "Halfway: closer, on a blurred copy (crops a third of the width)" },
] as const;

/** Export the approved video in a shape, as a package: the video, subtitles, a thumbnail and a description. */
function ExportCard({ snap, slug, ready }: { snap: Snapshot; slug: string; ready: boolean }) {
  const [busy, act] = useAction();
  const [format, setFormat] = useState(snap.exportFormats.find((f) => f.asBuilt)?.format ?? snap.exportFormats[0]!.format);
  const [chapterId, setChapterId] = useState("");
  const [framing, setFraming] = useState<string>("fill");
  const [captions, setCaptions] = useState(snap.project.settings.captions);
  // The project's own switch is where this starts; changing it there moves this one too.
  useEffect(() => setCaptions(snap.project.settings.captions), [snap.project.settings.captions]);
  const jobs = snap.jobs as { id: string; kind: string; status: string; progress: number }[];
  const job = jobs.find((j) => j.kind === "export" && (j.status === "running" || j.status === "queued"));
  const chosen = snap.exportFormats.find((f) => f.format === format)!;
  const reshaped = !chosen.asBuilt;
  const frame = FRAMINGS.find((f) => f.id === framing)!;
  const chapter = snap.chapters.find((c) => c.id === chapterId);
  const open = snap.scenes.filter((s) => (!chapter || s.chapterId === chapter.id) && s.status !== "approved").length;
  const can = snap.scenes.length > 0 && (chapter ? open === 0 : ready);
  return (
    <>
      <section className="card">
        <h3>Export</h3>
        <p className="muted">
          The approved video in the shape a site wants, as a folder with the video, its subtitles, a thumbnail and a description with chapter times. Another shape is made from the same scenes: nothing is built again, and the
          subtitles are laid out again to fit. A wide video cannot fill a vertical frame without losing its sides; for a video laid out for phones, choose 9:16 when you create the project.
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
          {reshaped && (
            <label>
              How the picture fits
              <select value={framing} onChange={(e) => setFraming(e.target.value)}>
                {FRAMINGS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
            <span>
              <strong>Subtitles in the picture</strong>
              <span className="muted small"> · the subtitle file is in the folder either way</span>
            </span>
          </label>
          <button
            className="btn btn-primary"
            disabled={busy || Boolean(job) || !can}
            title={can ? "" : "Every scene in it must be approved first"}
            onClick={() => act(() => api.exportVideo(slug, { format, ...(reshaped ? { fit: frame.fit, zoom: frame.zoom } : {}), captions, chapterId: chapterId || undefined }), "Exporting")}
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
                  {e.youtubeUrl && (
                    <li>
                      <a className="btn btn-quiet" href={e.youtubeUrl} target="_blank" rel="noreferrer">
                        Title, description and tags
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
      <RetentionCard snap={snap} slug={slug} />
      <ThumbnailCard snap={snap} slug={slug} />
      <UploadDetails snap={snap} slug={slug} />
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
