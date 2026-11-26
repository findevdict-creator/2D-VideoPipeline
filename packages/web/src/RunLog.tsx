import React, { useEffect, useRef, useState } from "react";
import { api, type LogLine } from "./api";

/** What a run is saying, kept up to date while the run works. */
export function RunLog({ runId, live }: { runId: string; live: boolean }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let stopped = false;
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLines([]);
    setError(null);
    const tick = async () => {
      try {
        const log = await api.runLog(runId, after);
        if (stopped) return;
        after = log.next;
        if (log.lines.length) setLines((all) => [...all, ...log.lines]);
        setError(log.error);
        if (log.status === "queued" || log.status === "running") timer = setTimeout(tick, 1000);
      } catch {
        if (!stopped) timer = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, live]);

  // Follow the newest line unless the person has scrolled up to read.
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      className="log"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {!lines.length && <div className="log-line log-info">{live ? "Waiting for the first line…" : "This run left no log."}</div>}
      {lines.map((line, i) => (
        <div key={i} className={`log-line log-${line.kind}`}>
          <span className="log-time">{new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          <span className="log-text">{line.kind === "tool" ? `→ ${line.text}` : line.text}</span>
        </div>
      ))}
      {error && !lines.some((l) => l.kind === "error") && <div className="log-line log-error">{error}</div>}
    </div>
  );
}
