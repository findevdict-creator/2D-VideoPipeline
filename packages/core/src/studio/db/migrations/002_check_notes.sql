-- Things a scene's check found that are worth knowing but do not stop a render,
-- such as equations shown as plain text because LaTeX is not installed.
ALTER TABLE scene_versions ADD COLUMN check_notes_json TEXT NOT NULL DEFAULT '[]';
