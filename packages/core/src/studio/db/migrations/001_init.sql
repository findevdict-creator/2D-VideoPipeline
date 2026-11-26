-- The studio database. Large content (code, clips, audio, images) stays on disk;
-- rows hold paths relative to the project folder, and hashes.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  aspect TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  fps INTEGER NOT NULL DEFAULT 30,
  target_duration_sec INTEGER NOT NULL CHECK (target_duration_sec BETWEEN 10 AND 3600),
  stage TEXT NOT NULL DEFAULT 'outline',
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  chapter_id TEXT,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX documents_lookup ON documents(project_id, kind, chapter_id, version);

CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  target_duration_sec INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned'
);
CREATE INDEX chapters_by_project ON chapters(project_id, position);

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  plan_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'planned',
  current_version_id TEXT,
  approved_version_id TEXT,
  stale_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX scenes_by_chapter ON scenes(chapter_id, position);
CREATE INDEX scenes_by_project ON scenes(project_id);

CREATE TABLE voice_tracks (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  text_hash TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  spoken_text TEXT NOT NULL,
  audio_path TEXT NOT NULL,
  duration_sec REAL NOT NULL,
  speech_start_sec REAL NOT NULL,
  speech_end_sec REAL NOT NULL,
  words_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scene_id, text_hash, settings_hash)
);

CREATE TABLE scene_versions (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  source_path TEXT,
  source_hash TEXT,
  voice_track_id TEXT REFERENCES voice_tracks(id),
  duration_frames INTEGER,
  stills_json TEXT NOT NULL DEFAULT '[]',
  check_problems_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scene_id, version)
);

CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  scene_version_id TEXT NOT NULL REFERENCES scene_versions(id) ON DELETE CASCADE,
  quality TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  path TEXT NOT NULL,
  duration_frames INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scene_version_id, quality)
);
CREATE INDEX clips_by_key ON clips(cache_key);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime TEXT,
  width INTEGER,
  height INTEGER,
  duration_sec REAL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  label TEXT NOT NULL DEFAULT '',
  source_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (project_id, sha256)
);

CREATE TABLE project_references (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, asset_id)
);

CREATE TABLE shared_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 0,
  approved_version INTEGER,
  status TEXT NOT NULL DEFAULT 'planned',
  UNIQUE (project_id, name)
);

CREATE TABLE shared_asset_versions (
  id TEXT PRIMARY KEY,
  shared_asset_id TEXT NOT NULL REFERENCES shared_assets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  source_hash TEXT,
  source_asset_id TEXT REFERENCES assets(id),
  preview_path TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shared_asset_id, version)
);

CREATE TABLE scene_dependencies (
  scene_version_id TEXT NOT NULL REFERENCES scene_versions(id) ON DELETE CASCADE,
  shared_asset_id TEXT NOT NULL REFERENCES shared_assets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  PRIMARY KEY (scene_version_id, shared_asset_id)
);

CREATE TABLE shared_asset_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  why TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version INTEGER,
  decision TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX reviews_by_target ON reviews(target_kind, target_id);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  agent TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  log_path TEXT,
  result_text TEXT,
  cost_usd REAL,
  duration_ms INTEGER,
  error TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX agent_runs_by_status ON agent_runs(status, queued_at);
CREATE INDEX agent_runs_by_target ON agent_runs(target_kind, target_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  result_json TEXT,
  log_path TEXT,
  error TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_by_status ON jobs(status, queued_at);

CREATE TABLE renders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  path TEXT NOT NULL,
  srt_path TEXT,
  scene_versions_json TEXT NOT NULL,
  duration_sec REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  kind TEXT NOT NULL,
  target_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
