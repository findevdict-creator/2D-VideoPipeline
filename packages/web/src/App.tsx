import React, { useEffect, useState } from "react";
import { api, type ProjectSummary } from "./api";
import { ProjectPage } from "./ProjectPage";
import { ago, Chip, duration, Link, Router, STAGES, Toasts, useAction, useRoute } from "./ui";

const LENGTHS = [30, 60, 120, 180, 300, 600, 1200, 1800, 2700, 3600];

export function App() {
  return (
    <Toasts>
      <Router>
        <Pages />
      </Router>
    </Toasts>
  );
}

function Pages() {
  const { path } = useRoute();
  const project = /^\/p\/([^/]+)(?:\/([a-z]+))?/.exec(path);
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">▶</span> Scene Studio
        </Link>
      </header>
      {project ? <ProjectPage key={project[1]} slug={decodeURIComponent(project[1]!)} tab={project[2]} /> : <ProjectsPage />}
    </>
  );
}

function ProjectsPage() {
  const { go } = useRoute();
  const [busy, act] = useAction();
  const [data, setData] = useState<{ workspace: string; runner: string; projects: ProjectSummary[] }>();
  const [description, setDescription] = useState("");
  const [title, setTitle] = useState("");
  const [length, setLength] = useState(180);
  const [aspect, setAspect] = useState("16:9");

  useEffect(() => {
    void act(async () => setData(await api.projects()));
  }, [act]);

  const create = () =>
    act(async () => {
      const { slug } = await api.createProject({ description: description.trim(), title: title.trim() || undefined, targetDurationSec: length, aspect });
      go(`/p/${encodeURIComponent(slug)}`);
    });

  return (
    <main className="page">
      <section className="card new-project">
        <h1>New video</h1>
        <p className="muted">Describe the video. Claude drafts an outline first, and nothing is built until you have approved the plan.</p>
        <textarea
          rows={4}
          value={description}
          placeholder="For example: How noise-cancelling headphones work. Start with the airplane hum everyone knows, then show how a second sound wave can cancel the first. For curious adults, no maths."
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="row wrap">
          <label>
            <span>
              Title <span className="muted">(optional)</span>
            </span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Taken from the description" />
          </label>
          <label>
            Length
            <select value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {LENGTHS.map((s) => (
                <option key={s} value={s}>
                  {duration(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Shape
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              <option value="16:9">Wide (16:9)</option>
              <option value="9:16">Tall (9:16)</option>
              <option value="1:1">Square (1:1)</option>
            </select>
          </label>
          <button className="btn btn-primary grow-end" disabled={busy || description.trim().length < 10} onClick={create}>
            Start with the outline
          </button>
        </div>
        {data?.runner === "mock" && <p className="notice">The studio is running with the stand-in runner, which writes a fixed sample plan instead of calling Claude.</p>}
      </section>

      <h2>Your videos</h2>
      {data && !data.projects.length && <p className="muted">None yet. Projects are kept in {data.workspace}.</p>}
      <div className="grid">
        {data?.projects.map((p) => (
          <Link key={p.id} to={`/p/${encodeURIComponent(p.slug)}`} className="card project-card">
            <h3>{p.title}</h3>
            <p className="clamp muted">{p.description}</p>
            <div className="row">
              <Chip tone={p.stage === "done" ? "good" : "quiet"}>{p.stage === "done" ? "Finished" : (STAGES.find((s) => s.stage === p.stage)?.name ?? p.stage)}</Chip>
              <span className="muted small">
                {duration(p.targetDurationSec)}
                {p.scenes ? ` · ${p.approved} of ${p.scenes} scenes approved` : ""} · {ago(p.updatedAt)}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
