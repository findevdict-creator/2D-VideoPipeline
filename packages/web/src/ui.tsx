import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Stage } from "./api";

// ---------- Words for states ----------

export const STAGES: { stage: Stage; name: string }[] = [
  { stage: "outline", name: "Outline" },
  { stage: "bible", name: "Bible" },
  { stage: "foundation", name: "Shared parts" },
  { stage: "chapters", name: "Scene list" },
  { stage: "scenes", name: "Scenes" },
  { stage: "assembly", name: "Video" },
];

export const SCENE_STATUS: Record<string, { label: string; tone: string }> = {
  planned: { label: "Planned", tone: "quiet" },
  spec_ready: { label: "Waiting to be built", tone: "quiet" },
  in_production: { label: "Being built", tone: "busy" },
  rendered: { label: "Rendered", tone: "quiet" },
  needs_review: { label: "Needs your review", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  stale: { label: "Out of date", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
};

export const CHAPTER_STATUS: Record<string, { label: string; tone: string }> = {
  planned: { label: "Not written yet", tone: "quiet" },
  scripting: { label: "Being written", tone: "busy" },
  script_review: { label: "Scene list needs your approval", tone: "warn" },
  in_production: { label: "In production", tone: "busy" },
  done: { label: "Done", tone: "good" },
};

export const RUN_STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: "Waiting", tone: "quiet" },
  running: { label: "Working", tone: "busy" },
  done: { label: "Done", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "quiet" },
};

/** True for a run that stopped because the studio closed. Starting the same work again continues it. */
export function closedMidRun(run: { status: string; error?: string | null } | undefined): boolean {
  return run?.status === "failed" && /studio was closed/.test(run.error ?? "");
}

export const RUN_KIND: Record<string, string> = {
  outline: "Outline",
  bible: "Bible",
  foundation: "Shared parts",
  chapter: "Scene list",
  scene: "Scene",
};

export const TYPE_NAME: Record<string, string> = {
  "remotion-2d": "2D animation",
  r3f: "3D",
  manim: "Manim",
  illustration: "Image",
  footage: "Video clip",
};

export function Chip({ tone = "quiet", children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- Messages ----------

interface Toast {
  id: number;
  tone: "bad" | "good";
  text: string;
}
const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function Toasts({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, tone: Toast["tone"] = "bad") => {
    const id = next.current++;
    setToasts((all) => [...all.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === "bad" ? 9000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Wrap a request: shows that it is under way and puts a failure where the person will see it. */
export function useAction(): [boolean, (work: () => Promise<unknown>, done?: string) => Promise<boolean>] {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (work: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await work();
        if (done) toast(done, "good");
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return [busy, run];
}

// ---------- Getting around ----------

const RouteContext = createContext<{ path: string; go: (path: string) => void }>({ path: "/", go: () => {} });
export const useRoute = () => useContext(RouteContext);

export function Router({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    history.pushState(null, "", to);
    setPath(to);
  }, []);
  return <RouteContext.Provider value={{ path, go }}>{children}</RouteContext.Provider>;
}

export function Link({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  const { go } = useRoute();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

/** A box for saying what should change, with the button that sends it. */
export function NotesBox({ label, placeholder, busy, onSend, onCancel }: { label: string; placeholder: string; busy: boolean; onSend: (notes: string) => void; onCancel?: () => void }) {
  const [notes, setNotes] = useState("");
  return (
    <div className="notes">
      <textarea value={notes} placeholder={placeholder} rows={3} onChange={(e) => setNotes(e.target.value)} autoFocus />
      <div className="row">
        <button className="btn" disabled={busy || !notes.trim()} onClick={() => onSend(notes.trim())}>
          {label}
        </button>
        {onCancel && (
          <button className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
