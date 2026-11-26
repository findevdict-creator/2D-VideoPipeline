-- References the person attached to one scene: an image, or one moment of a video,
-- to take the style, the layout or the motion from. References for the whole video
-- stay in project_references.
CREATE TABLE scene_references (
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  -- For a video: the moment the person picked, in seconds. Null means the whole clip.
  at_sec REAL,
  PRIMARY KEY (scene_id, asset_id)
);
