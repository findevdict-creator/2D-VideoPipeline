-- A video exported in one format, as a folder with everything an upload needs.
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  folder TEXT NOT NULL,
  files_json TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  duration_sec REAL NOT NULL,
  scene_versions_json TEXT NOT NULL,
  notes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX exports_project ON exports (project_id, created_at);
