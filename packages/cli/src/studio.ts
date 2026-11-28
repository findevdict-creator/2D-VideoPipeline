import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { loadConfig, type RunnerKind } from "@studio/core/config";
import { importProduction } from "@studio/core/studio/importProduction";
import { Studio } from "@studio/core/studio/studio";
import { listChapters } from "@studio/core/studio/store/chapters";
import { createProject, getProject, listProjects, projectPaths, updateProject } from "@studio/core/studio/store/projects";
import { listRuns, readRunLog } from "@studio/core/studio/store/runs";
import { getThumbnail } from "@studio/core/studio/thumbnail";
import { PACES, setVoice, VOICES } from "@studio/core/studio/voices";
import { uploadSheet, writeYouTubeDetails } from "@studio/core/studio/youtube";
import { retentionReport, writeRetentionCheck } from "@studio/core/studio/retention";
import { Orchestrator } from "@studio/core/studio/workflow";
import { chooseColours, type ColourChoice, deleteScene, findScene, getScene, listReviews, listScenes, listVersions, moveScene, rollbackScene, sceneLabel, setTheme } from "@studio/core/studio/store/scenes";
import { compareVersions } from "@studio/core/studio/scenes/compare";
import { type Fit, EXPORT_FORMATS, exportFormat, exportVideo, listExports } from "@studio/core/studio/export";
import { ensureVoice } from "@studio/core/studio/voice";
import { REFERENCE_ROLES } from "@studio/core/studio/model/asset";
import type { ModelInfo } from "@studio/core/studio/assets/gltf";
import { importAsset, listAssets, listProjectReferences, setProjectReference, setSceneReference } from "@studio/core/studio/store/assets";
import { clock, referenceKeyframes } from "@studio/core/studio/assets/keyframes";
import { LOOKS, MAX_DURATION_SEC, MIN_DURATION_SEC, PALETTE_KEYS, PALETTE_USE, PALETTES } from "@studio/core/studio/model/project";
import { assemble } from "@studio/core/studio/assemble";
import { recommendLength } from "@studio/core/studio/length";
import { prepareDocument } from "@studio/core/studio/documents";
import { addLink } from "@studio/core/studio/links";
import { generateImage, imageStatus, saveImageKey, setImagesEnabled } from "@studio/core/studio/images";
import { gpuReport } from "@studio/core/studio/renderers/gpu";
import { checkScene, renderSceneClip, renderSceneStills } from "@studio/core/studio/scenes/render";

const HELP = `Scene studio

Usage:
  npm run studio                                     open the studio in your browser (--port, --no-open)
  npm run studio -- new "<description>"              start a project (--minutes or --seconds for any length from 10 seconds to 60 minutes, --title)
  npm run studio -- length "<description>"           ask Claude how long a video with this description should be
  npm run studio -- gpu                              check what the graphics card is used for on this machine
  npm run studio -- status <project>                 where the project stands and what it is waiting on
  npm run studio -- start <project>                  run the current stage's work (--notes to ask for changes)
  npm run studio -- approve <project>                approve the current stage and start the next one
  npm run studio -- approve-chapter <project> <number>   approve one chapter's scene list and build its scenes
  npm run studio -- approve-scene <project> <scene|all>
  npm run studio -- revise <project> <scene> --notes "<what to change>"
  npm run studio -- move-scene <project> <scene> <earlier|later>   play a scene one place earlier or later; nothing is built again
  npm run studio -- delete-scene <project> <scene>   remove a scene and everything built for it (--yes to skip the question)
  npm run studio -- refresh <project>                render every out-of-date scene again, after a shared part changed
  npm run studio -- projects                         list projects in the workspace
  npm run studio -- import <production-folder>       bring a pipeline production in as a project
  npm run studio -- scenes <project>                 list a project's scenes and their status
  npm run studio -- assets <project>                 list a project's images, clips, sounds and models
  npm run studio -- asset add <project> <file...>    add files to a project: images, clips, sounds, models, or a report as .pdf, .docx, .txt or .md (--label, --note, --reference style|layout|motion)
  npm run studio -- link <project> <address>         add an article or a YouTube video by its address (--about: the video is about it; --like: make the video like it; --note)
  npm run studio -- keyframes <project> <asset>      one frame of each shot of a reference video, and a contact sheet
  npm run studio -- reference <project> <scene> <asset>   attach a reference to one scene (--reference <role>, --at <seconds>, --note; "none" as the role removes it)
  npm run studio -- look <project> <clean|hand-drawn>     change the look; scenes already drawn are marked out of date
  npm run studio -- colours <project> [scheme] [name=#hex ...] [font="Name"]   show or change the colours and font; "claude" lets Claude choose again
  npm run studio -- music <project> <asset|file|off>      choose the music (--volume under the voice, --pause-volume in pauses, --steady for no dipping)
  npm run studio -- sfx <project> <on|off>           play or leave out the sound effects scenes ask for
  npm run studio -- check <project> <scene>          report what would stop a scene from rendering
  npm run studio -- stills <project> <scene>         render still frames of a scene for a quick look
  npm run studio -- render <project> [scene...]      render scene clips (all scenes when none is named)
  npm run studio -- assemble <project>               join the scene clips into one video (--chapter <number> for one chapter)
  npm run studio -- versions <project> <scene>       list a scene's versions
  npm run studio -- compare <project> <scene> <version> <version>   what differs between two versions of a scene
  npm run studio -- rollback <project> <scene> <version>            make an earlier version the current one again; its clip is reused
  npm run studio -- export <project>                 export the approved video as a package (--format landscape|shorts|square, --chapter, --fit, --zoom, --subtitles)
  npm run studio -- voice <project> [voice] [slow|normal|fast]   show the voices, or choose who narrates and how fast
  npm run studio -- thumbnail <project>              have Claude design the thumbnail (--notes to ask for changes)
  npm run studio -- youtube <project>                have Claude write the title, description and tags for uploading (--notes)
  npm run studio -- retention <project>              have Claude read the script for what would make a viewer leave (--notes for numbers from YouTube's analytics)
  npm run studio -- images <project> [on|off]        allow or forbid AI-generated images for one video (off unless you switch it on)
  npm run studio -- image <project> "<prompt>"       generate an image into the project's assets (--label; --again <asset id> to make that one again)
  npm run studio -- image-key <key>                  keep your Google AI Studio key in the workspace ("" forgets it)
  npm run studio -- subtitles <project> <on|off>     show or hide the subtitles drawn in the video (the .srt file is always written)
  npm run studio -- exports <project>                list what was exported

A scene is named by its label, such as 1.3, or by its id.

Options:
  --workspace <folder>                   where studio.db and projects live (default: ~/VideoStudio, or STUDIO_WORKSPACE)
  --runner <claude-cli|mock>             how Claude runs: your Claude Code login, or a stand-in that writes fixed samples
  --model <name>                         model for every agent
  --final                                render or assemble at full quality (default: fast preview)
  --chapter <number>                     assemble one chapter only
  --label <text>                         name for an added asset
  --reference <style|layout|motion>      also mark an added asset as a reference for the whole video
  --note <text>                          what to take from the reference
  --at <seconds>                         for a video attached to a scene: the moment to follow
  --volume <0 to 1>                      how loud the music is under the voice (default 0.12)
  --pause-volume <0 to 1>                how loud the music is where nobody speaks (default 0.4)
  --steady                               keep the music at one level instead of dipping it under the voice
  --format <landscape|shorts|square>     the shape to export: 16:9, 9:16 for Shorts and Reels, or 1:1 (default: the shape the video was built in)
  --fit <fill|whole|blur>                for another shape: fill the frame and crop (the default), show the whole picture, or the whole picture on a blurred copy of itself
  --zoom <1 to 2>                        with the whole picture in a taller shape: draw it larger and crop its sides
  --subtitles <on|off>                   for this export only: draw the subtitles in the picture or leave them out
  --notes <text>                         what should change, for start and revise
  -h, --help
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      runner: { type: "string" },
      model: { type: "string" },
      final: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      chapter: { type: "string" },
      label: { type: "string" },
      minutes: { type: "string" },
      seconds: { type: "string" },
      title: { type: "string" },
      notes: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      reference: { type: "string" },
      again: { type: "string" },
      like: { type: "boolean", default: false },
      about: { type: "boolean", default: false },
      note: { type: "string" },
      at: { type: "string" },
      volume: { type: "string" },
      "pause-volume": { type: "string" },
      steady: { type: "boolean", default: false },
      format: { type: "string" },
      zoom: { type: "string" },
      fit: { type: "string" },
      subtitles: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "serve", ...rest] = positionals;
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (command === "serve") return serveStudio(values);
  const config = studioConfig(values);
  const studio = new Studio(config, values.workspace);
  try {
    await run(studio, command, rest, { ...values, final: values.final });
  } finally {
    studio.close();
  }
}

async function run(
  studio: Studio,
  command: string,
  rest: string[],
  flags: { final: boolean; yes?: boolean; chapter?: string; label?: string; reference?: string; again?: string; like?: boolean; about?: boolean; note?: string; minutes?: string; seconds?: string; title?: string; notes?: string; at?: string; volume?: string; "pause-volume"?: string; steady?: boolean; format?: string; zoom?: string; fit?: string; subtitles?: string },
) {
  const log = (message: string) => console.log(message);
  const quality = flags.final ? "final" : "preview";
  if (command === "length") {
    const description = required(rest[0], "description");
    console.log("Asking Claude for a length...");
    const advice = await recommendLength(studio, description);
    console.log(`Claude recommends ${readable(advice.seconds)}. ${advice.reason}`);
    console.log(`To start with it: npm run studio -- new ${JSON.stringify(description)} --seconds ${advice.seconds}`);
    return;
  }
  if (command === "gpu") {
    console.log("Checking the graphics card. This starts Chrome and encodes a few test frames...");
    const report = await gpuReport(studio);
    console.log(`\nSetting: render.gpu is "${report.mode}".`);
    console.log("\nDrawing frames (Chrome):");
    for (const d of report.drawing) {
      const what = d.problem ? `did not start: ${d.problem}` : `${d.device}${d.software ? "  <- software, not a graphics card" : ""}`;
      console.log(`  ${d.gl.padEnd(8)} ${what}`);
    }
    const card = report.drawing[0]!;
    const drawsOnCard = !card.problem && !card.software;
    console.log(`\nEncoding video: ${report.encoding.encoder ? `${report.encoding.encoder} works.` : report.encoding.reason}`);
    console.log("\nWhat a render will do:");
    if (report.mode === "off") console.log("  Nothing runs on the graphics card, because render.gpu is \"off\".");
    else {
      console.log(`  Frames are drawn ${drawsOnCard ? "with the graphics card" : "in software"}.`);
      console.log(`  Video is encoded ${report.encoding.encoder ? "on the graphics card" : "on the processor"}.`);
      if (report.mode === "on" && !report.encoding.encoder) console.log("  render.gpu is \"on\", so renders will stop with an error until encoding works or the setting is \"auto\".");
    }
    return;
  }
  if (command === "new") {
    // --minutes and --seconds add up, so 7 and a half minutes is "--minutes 7 --seconds 30" or "--minutes 7.5".
    const seconds = flags.seconds || flags.minutes ? Math.round(Number(flags.minutes ?? 0) * 60 + Number(flags.seconds ?? 0)) : undefined;
    if (seconds !== undefined && !(seconds >= MIN_DURATION_SEC && seconds <= MAX_DURATION_SEC)) {
      throw new Error(`A video is between ${MIN_DURATION_SEC} seconds and ${MAX_DURATION_SEC / 60} minutes long. Give --minutes, --seconds or both as numbers.`);
    }
    const project = createProject(studio, { description: required(rest[0], "description"), title: flags.title, targetDurationSec: seconds });
    console.log(`Created project ${project.slug} ("${project.title}", ${readable(project.targetDurationSec)}).\nNext: npm run studio -- start ${project.slug}`);
    return;
  }
  if (command === "move-scene") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const direction = required(rest[2], "direction: earlier or later");
    if (direction !== "earlier" && direction !== "later") throw new Error('Say which way: "earlier" or "later".');
    const moved = moveScene(studio, scene.id, direction);
    console.log(`"${moved.title}" is now scene ${sceneLabel(studio, moved)}. Videos joined before this are out of date: assemble again.`);
    return;
  }
  if (command === "delete-scene") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const label = sceneLabel(studio, scene);
    if (!flags.yes) {
      const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Delete scene ${label}, "${scene.title}", and everything built for it? This cannot be undone. Type yes: `);
      rl.close();
      if (answer.trim().toLowerCase() !== "yes") return console.log("Nothing was deleted.");
    }
    deleteScene(studio, scene.id);
    console.log(`Deleted scene ${label}, "${scene.title}". The scenes after it were renumbered.`);
    return;
  }
  if (command === "status") {
    const project = getProject(studio, required(rest[0], "project"));
    const o = new Orchestrator(studio);
    printStatus(studio, o, project.id);
    o.stop();
    return;
  }
  if (command === "start" || command === "approve" || command === "approve-chapter" || command === "approve-scene" || command === "revise" || command === "refresh") {
    const project = getProject(studio, required(rest[0], "project"));
    const o = new Orchestrator(studio);
    if (command === "start") o.startStage(project.id, flags.notes);
    if (command === "approve") console.log(`Approved. The project is now at: ${o.approveStage(project.id, flags.notes).stage}`);
    if (command === "approve-chapter") {
      const chapter = chapterByNumber(studio, project.id, required(rest[1], "chapter number"));
      o.approveChapter(chapter.id);
      console.log(`Approved the scene list of chapter ${chapter.position}, "${chapter.title}". Building its scenes.`);
    }
    if (command === "approve-scene") {
      const which = required(rest[1], "scene");
      const scenes = which === "all" ? listScenes(studio, project.id).filter((s) => s.status === "needs_review") : [findScene(studio, project.id, which)];
      for (const scene of scenes) console.log(`Approved ${sceneLabel(studio, o.approveScene(scene.id, flags.notes))} ${scene.title}`);
    }
    if (command === "refresh") console.log(`Rendering ${o.rebuildStale(project.id).length} out-of-date scene(s) again.`);
    if (command === "revise") o.reviseScene(findScene(studio, project.id, required(rest[1], "scene")).id, required(flags.notes, "--notes"));
    await follow(studio, o, project.id);
    printStatus(studio, o, project.id);
    o.stop();
    return;
  }
  if (command === "projects") {
    const all = listProjects(studio);
    console.log(`Workspace: ${studio.workspaceDir}`);
    if (!all.length) console.log("No projects yet.");
    for (const p of all) console.log(`${p.slug.padEnd(40)} ${p.stage.padEnd(11)} ${p.title}`);
    return;
  }
  if (command === "import") {
    const result = await importProduction(studio, required(rest[0], "production folder"));
    console.log(
      `Imported "${result.project.title}" as project ${result.project.slug}: ${result.scenes} scenes, ` +
        `${result.withCode} with code, ${result.withVoice} with recorded narration.\nFolder: ${studio.projectDir(result.project.slug)}`,
    );
    return;
  }
  if (command === "scenes") {
    const project = getProject(studio, required(rest[0], "project"));
    for (const chapter of listChapters(studio, project.id)) {
      console.log(`\n${chapter.position}. ${chapter.title}`);
      for (const s of listScenes(studio, project.id, chapter.id)) {
        console.log(`  ${sceneLabel(studio, s).padEnd(6)} ${s.type.padEnd(13)} ${s.status.padEnd(14)} ${s.title}  (${s.id})`);
      }
    }
    return;
  }
  if (command === "assets") {
    const project = getProject(studio, required(rest[0], "project"));
    const refs = new Map(listProjectReferences(studio, project.id).map((r) => [r.assetId, r.role]));
    const all = listAssets(studio, project.id);
    if (!all.length) console.log("No assets yet.");
    for (const a of all) {
      const size = a.width ? `${a.width}x${a.height}` : "";
      const length = a.durationSec ? `${a.durationSec.toFixed(1)}s` : "";
      const ref = refs.has(a.id) ? `${refs.get(a.id)} reference` : "";
      console.log(`${a.id}  ${a.kind.padEnd(11)} ${[size, length].filter(Boolean).join(" ").padEnd(16)} ${a.label}  ${ref}`);
    }
    return;
  }
  if (command === "asset" && rest[0] === "add") {
    const project = getProject(studio, required(rest[1], "project"));
    const files = rest.slice(2);
    if (!files.length) throw new Error("Name at least one file to add.");
    const role = flags.reference;
    if (role && !(REFERENCE_ROLES as readonly string[]).includes(role)) throw new Error(`--reference must be one of: ${REFERENCE_ROLES.join(", ")}`);
    for (const file of files) {
      const asset = await importAsset(studio, project.id, file, { label: files.length === 1 ? flags.label : undefined, sourceNote: !role ? flags.note : undefined });
      if (role) setProjectReference(studio, project.id, { assetId: asset.id, role: role as (typeof REFERENCE_ROLES)[number], note: flags.note ?? "" });
      console.log(`${asset.id}  ${asset.kind}  ${asset.label}${role ? `  (${role} reference)` : ""}`);
      const doc = asset.meta.document as { pages: number; words: number; hasText: boolean } | undefined;
      // Its text is read and its first page drawn now, so the studio shows it and the first run does not wait.
      if (doc) await prepareDocument(studio, asset);
      if (doc) console.log(`  ${doc.pages} pages, ${doc.words.toLocaleString("en-US")} words${doc.hasText ? "" : ". It holds no text, as a scan does: Claude can only look at its pages"}`);
      const model = asset.meta.model as ModelInfo | undefined;
      if (model) {
        console.log(`  ${model.triangles.toLocaleString("en-US")} triangles, ${model.size.join(" x ")} units`);
        console.log(`  parts: ${model.parts.map((p) => p.name).join(", ") || "none with a name"}`);
        console.log(`  animations: ${model.animations.map((a) => `${a.name} (${a.durationSec}s)`).join(", ") || "none"}`);
        for (const warning of model.warnings) console.log(`  Warning: ${warning}`);
      }
    }
    return;
  }
  if (command === "link") {
    const project = getProject(studio, required(rest[0], "project"));
    console.log("Fetching...");
    const added = await addLink(studio, project.id, { url: required(rest[1], "address"), use: flags.like ? "model" : flags.about ? "source" : undefined, note: flags.note });
    const doc = added.asset.meta.document as { pages: number; words: number };
    console.log(`${added.asset.id}  ${added.asset.label}  (${doc.words.toLocaleString("en-US")} words, used as ${added.asset.meta.use === "model" ? "what the video should be like" : "what the video is about"})`);
    if (added.thumbnail) console.log(`${added.thumbnail.id}  its thumbnail, kept as a style reference`);
    for (const warning of added.warnings) console.log(`Note: ${warning}`);
    return;
  }
  if (command === "keyframes") {
    const project = getProject(studio, required(rest[0], "project"));
    const asset = assetNamed(studio, project.id, required(rest[1], "asset"));
    const found = await referenceKeyframes(studio, asset.id);
    for (const k of found.keyframes) console.log(`#${k.index}  ${clock(k.atSec)}  (shot ${clock(k.shotStartSec)} to ${clock(k.shotEndSec)})  ${k.file}`);
    if (found.sheet) console.log(`Contact sheet: ${found.sheet}`);
    return;
  }
  if (command === "reference") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const asset = assetNamed(studio, project.id, required(rest[2], "asset"));
    const role = flags.reference ?? "layout";
    if (role === "none") {
      setSceneReference(studio, scene.id, { assetId: asset.id, role: null });
      console.log(`"${asset.label}" is no longer a reference for scene ${sceneLabel(studio, scene)}.`);
      return;
    }
    if (!(REFERENCE_ROLES as readonly string[]).includes(role)) throw new Error(`--reference must be one of: ${REFERENCE_ROLES.join(", ")}, or none`);
    const atSec = flags.at !== undefined ? Number(flags.at) : null;
    if (atSec !== null && !(atSec >= 0)) throw new Error("--at is a time in seconds, such as 12.5");
    setSceneReference(studio, scene.id, { assetId: asset.id, role: role as (typeof REFERENCE_ROLES)[number], note: flags.note ?? "", atSec });
    console.log(`Scene ${sceneLabel(studio, scene)} now follows "${asset.label}" for its ${role}${atSec !== null ? `, at ${clock(atSec)}` : ""}.${scene.currentVersionId ? " It is already built: ask for changes to have it rebuilt." : ""}`);
    return;
  }
  if (command === "look") {
    const project = getProject(studio, required(rest[0], "project"));
    const look = required(rest[1], "look");
    if (!(LOOKS as readonly string[]).includes(look)) throw new Error(`The look is one of: ${LOOKS.join(", ")}`);
    const stale = setTheme(studio, project.id, { ...project.settings.theme, look: look as (typeof LOOKS)[number] });
    console.log(`The look is now ${look}.${stale.length ? ` ${stale.length} scene(s) were drawn in the old one: npm run studio -- refresh ${project.slug}` : ""}`);
    return;
  }
  if (command === "colours" || command === "colors") {
    const project = getProject(studio, required(rest[0], "project"));
    const show = (theme: typeof project.settings.theme) => {
      for (const key of PALETTE_KEYS) console.log(`  ${key.padEnd(11)} ${theme.palette[key]}  ${PALETTE_USE[key]}`);
      console.log(`  ${"font".padEnd(11)} ${theme.fontFamily}`);
      console.log(theme.locked ? "  Chosen by you. Claude keeps these." : "  Chosen by Claude. It may change them when it writes the bible.");
    };
    const words = rest.slice(1);
    if (!words.length) {
      show(project.settings.theme);
      console.log(`\nSchemes: ${PALETTES.map((p) => p.id).join(", ")}`);
      console.log(`Change them: npm run studio -- colours ${project.slug} paper   or   npm run studio -- colours ${project.slug} primary=#FF6B00 font=Georgia`);
      return;
    }
    const choice: ColourChoice = { palette: {} };
    for (const word of words) {
      const eq = word.indexOf("=");
      if (eq < 0) {
        if (word.toLowerCase() === "claude") choice.locked = false;
        else choice.scheme = word;
      } else if (word.slice(0, eq).toLowerCase() === "font") choice.fontFamily = word.slice(eq + 1);
      else (choice.palette as Record<string, string>)[word.slice(0, eq).toLowerCase()] = word.slice(eq + 1);
    }
    const done = chooseColours(studio, project.id, choice);
    show(done.theme);
    for (const warning of done.warnings) console.log(`  Note: ${warning}`);
    if (done.stale.length) console.log(`${done.stale.length} scene(s) were drawn in the old colours: npm run studio -- refresh ${project.slug}`);
    return;
  }
  if (command === "music") {
    const project = getProject(studio, required(rest[0], "project"));
    const what = required(rest[1], "music file, asset id, or off");
    const level = (value: string | undefined, name: string) => {
      if (value === undefined) return undefined;
      const n = Number(value);
      if (!(n >= 0 && n <= 1)) throw new Error(`${name} is a number from 0 to 1`);
      return n;
    };
    const music = { ...project.settings.music, ...(flags.steady ? { duck: false } : {}) };
    const volume = level(flags.volume, "--volume");
    const gapVolume = level(flags["pause-volume"], "--pause-volume");
    if (volume !== undefined) music.volume = volume;
    if (gapVolume !== undefined) music.gapVolume = gapVolume;
    if (what === "off") music.assetId = null;
    else music.assetId = (listAssets(studio, project.id).find((a) => a.id === what) ?? (await importAsset(studio, project.id, what, { kind: "audio_music" }))).id;
    updateProject(studio, project.id, { settings: { music } });
    console.log(music.assetId ? `Music set. It plays at ${music.volume} under the voice${music.duck ? ` and ${music.gapVolume} in pauses` : ""}, from the next preview on.` : "The video has no music now.");
    return;
  }
  if (command === "sfx") {
    const project = getProject(studio, required(rest[0], "project"));
    const on = required(rest[1], "on or off");
    if (on !== "on" && on !== "off") throw new Error("Say on or off.");
    updateProject(studio, project.id, { settings: { sfx: { ...project.settings.sfx, enabled: on === "on" } } });
    console.log(`Sound effects are ${on}.`);
    return;
  }
  if (command === "check") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const problems = await checkScene(studio, scene.id, log);
    console.log(problems.length ? `Problems:\n  - ${problems.join("\n  - ")}` : "No problems found.");
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (command === "stills") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const stills = await renderSceneStills(studio, scene.id, {}, log);
    for (const s of stills) console.log(`frame ${String(s.frame).padStart(5)}  ${studio.projectDir(project.slug)}/${s.file}`);
    return;
  }
  if (command === "render") {
    const project = getProject(studio, required(rest[0], "project"));
    const scenes = rest.length > 1 ? rest.slice(1).map((ref) => findScene(studio, project.id, ref)) : listScenes(studio, project.id);
    await ensureVoice(studio, scenes.filter((s) => s.currentVersionId).map((s) => s.id), log);
    for (const scene of scenes) {
      const label = `${sceneLabel(studio, scene)} ${scene.title}`;
      const started = Date.now();
      const { clip, cached } = await renderSceneClip(studio, scene.id, quality, () => {}, log);
      const how = cached ? "unchanged, kept" : `rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`;
      console.log(`${label}: ${clip.durationFrames} frames, ${how}  (${clip.path})`);
    }
    return;
  }
  if (command === "assemble") {
    const project = getProject(studio, required(rest[0], "project"));
    const chapter = flags.chapter ? chapterByNumber(studio, project.id, flags.chapter) : undefined;
    const result = await assemble(studio, project.id, { quality, chapterId: chapter?.id, log });
    console.log(`${result.rendered} clip(s) rendered, ${result.reused} reused. ${result.render.durationSec.toFixed(1)}s video: ${result.file}`);
    for (const s of result.skipped) console.log(`Left out ${s.label} ${s.title}: ${s.reason}`);
    return;
  }
  if (command === "versions") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const asked = new Map(listReviews(studio, "scene", scene.id).filter((r) => r.decision === "revise").map((r) => [r.targetVersion, r.notes]));
    console.log(`${sceneLabel(studio, scene)} ${scene.title}`);
    for (const v of listVersions(studio, scene.id)) {
      const marks = [v.id === scene.currentVersionId ? "current" : "", v.id === scene.approvedVersionId ? "approved" : ""].filter(Boolean).join(", ");
      console.log(`  v${v.version}  ${v.createdAt.slice(0, 16).replace("T", " ")}  ${marks.padEnd(18)} ${v.summary?.split("\n")[0] ?? ""}`);
      if (asked.has(v.version)) console.log(`      then asked: ${asked.get(v.version)}`);
    }
    return;
  }
  if (command === "compare") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const c = compareVersions(studio, scene.id, versionNumber(rest[2]), versionNumber(rest[3]));
    console.log(`${sceneLabel(studio, scene)} ${scene.title}: version ${c.before} and version ${c.after}`);
    for (const a of c.asked) console.log(`Asked after version ${a.version}: ${a.notes}`);
    if (!c.changes.length) console.log("The two versions are the same.");
    for (const change of c.changes) console.log(`\n${change.what}\n  version ${c.before}: ${change.before}\n  version ${c.after}: ${change.after}`);
    if (c.narration.some((part) => part.op !== "same")) {
      console.log(`\nNarration, word by word ([-taken out-] {+put in+}):\n  ${c.narration.map((part) => (part.op === "same" ? part.text : part.op === "removed" ? `[-${part.text.trim()}-] ` : `{+${part.text.trim()}+} `)).join("")}`);
    }
    if (c.code && (c.code.added || c.code.removed)) {
      console.log("\nScene file:");
      for (const part of c.code.parts) {
        if (part.op !== "same") for (const line of part.text.split("\n")) console.log(`  ${part.op === "added" ? "+" : "-"} ${line}`);
      }
    }
    return;
  }
  if (command === "rollback") {
    const project = getProject(studio, required(rest[0], "project"));
    const scene = findScene(studio, project.id, required(rest[1], "scene"));
    const back = rollbackScene(studio, scene.id, versionNumber(rest[2]));
    console.log(`${sceneLabel(studio, back)} ${back.title} is on version ${versionNumber(rest[2])} again (${back.status}). Its clip is reused; nothing is rendered again.`);
    return;
  }
  if (command === "image-key") {
    saveImageKey(studio, rest[0] ?? "");
    console.log(rest[0] ? `The key is saved in ${studio.workspaceDir}, outside the repository.` : "The key is forgotten.");
    return;
  }
  if (command === "images") {
    const project = getProject(studio, required(rest[0], "project"));
    if (rest[1]) setImagesEnabled(studio, project.id, onOff(rest[1]));
    const s = imageStatus(studio, project.id);
    console.log(`AI-generated images are ${s.enabled ? "allowed" : "off"} for ${project.slug}.`);
    if (s.enabled) console.log(s.engine === "mock" ? "The stand-in engine is in use: placeholders, nothing charged." : s.keyFrom ? `Model ${s.model}. A key is set. Claude has made ${s.madeByClaude} of at most ${s.limit}.` : "No key yet: npm run studio -- image-key <key>, or set GEMINI_API_KEY.");
    return;
  }
  if (command === "image") {
    const project = getProject(studio, required(rest[0], "project"));
    console.log("Generating...");
    const { asset, stale } = await generateImage(studio, project.id, { prompt: required(rest[1], "prompt"), label: flags.label, replaceAssetId: flags.again, by: "you" });
    console.log(`${asset.label} (${asset.id}), ${asset.width} by ${asset.height}: ${projectPaths(studio, project).abs(asset.path)}`);
    if (stale.length) console.log(`${stale.length} scene(s) that use it are marked out of date: npm run studio -- refresh ${project.slug}`);
    return;
  }
  if (command === "voice") {
    const project = getProject(studio, required(rest[0], "project"));
    const words = rest.slice(1);
    if (!words.length) {
      console.log(`${project.slug} is narrated by ${project.settings.voice.kokoroVoice} at a ${project.settings.voice.pace} pace.\n`);
      for (const accent of ["American", "British"] as const) for (const gender of ["female", "male"] as const) console.log(`${accent}, ${gender}: ${VOICES.filter((v) => v.accent === accent && v.gender === gender).map((v) => v.id).join(", ")}`);
      console.log(`\nChoose one: npm run studio -- voice ${project.slug} bm_george slow`);
      return;
    }
    const pace = words.find((w) => (PACES as readonly string[]).includes(w.toLowerCase()))?.toLowerCase();
    const voice = words.find((w) => !(PACES as readonly string[]).includes(w.toLowerCase()));
    const changed = setVoice(studio, project.id, { voice, pace });
    console.log(`${project.slug} is now narrated by ${changed.settings.voice.kokoroVoice} at a ${changed.settings.voice.pace} pace. Narration is recorded again the next time a preview or the final video is put together.`);
    return;
  }
  if (command === "youtube") {
    const project = getProject(studio, required(rest[0], "project"));
    console.log("Asking Claude for the title, description and tags...");
    const details = await writeYouTubeDetails(studio, project.id, { notes: flags.notes });
    console.log(`\n${uploadSheet(details, [])}`);
    console.log("Saved with the project. An export adds the chapter times and writes it all to youtube.txt in the export folder.");
    return;
  }
  if (command === "retention") {
    const project = getProject(studio, required(rest[0], "project"));
    console.log("Asking Claude to read the script against the retention guide...");
    const check = await writeRetentionCheck(studio, project.id, { notes: flags.notes });
    console.log(`\n${retentionReport(check)}`);
    console.log("Saved with the project. To act on a finding, send it as a review note on the outline, the chapter or the scene it names.");
    return;
  }
  if (command === "thumbnail") {
    const project = getProject(studio, required(rest[0], "project"));
    const o = new Orchestrator(studio);
    try {
      o.designThumbnail(project.id, flags.notes);
      console.log("Claude is designing the thumbnail. This takes a few minutes...");
      await o.idle();
    } finally {
      o.stop();
    }
    const run = listRuns(studio, project.id, { limit: 20 }).find((r) => r.targetKind === "thumbnail");
    if (run?.status !== "done") throw new Error(`The thumbnail was not finished: ${run?.error ?? run?.status ?? "no run"}`);
    const t = getThumbnail(studio, project.id);
    if (!t) throw new Error("Claude finished without saving a thumbnail. Run the command again.");
    console.log(t.image ? `Thumbnail: ${projectPaths(studio, project).abs(t.image)}` : "The design is saved, but it was not drawn on this computer.");
    if (t.text) console.log(`Words on it: ${t.text}`);
    if (t.idea) console.log(`The idea: ${t.idea}`);
    return;
  }
  if (command === "subtitles" || command === "captions") {
    const project = getProject(studio, required(rest[0], "project"));
    if (rest[1] === undefined) {
      console.log(`Subtitles are ${project.settings.captions ? "on" : "off"} for ${project.slug}.`);
      return;
    }
    const on = onOff(rest[1]);
    updateProject(studio, project.id, { settings: { captions: on } });
    console.log(`Subtitles are now ${on ? "on" : "off"}. Clips are drawn again ${on ? "with" : "without"} them the next time a preview or the final video is put together. The .srt file is written either way.`);
    return;
  }
  if (command === "export") {
    const project = getProject(studio, required(rest[0], "project"));
    const chapter = flags.chapter ? chapterByNumber(studio, project.id, flags.chapter) : undefined;
    const zoom = flags.zoom === undefined ? undefined : Number(flags.zoom);
    const result = await exportVideo(studio, project.id, { format: flags.format ? exportFormat(flags.format) : undefined, chapterId: chapter?.id, zoom, fit: flags.fit as Fit | undefined, captions: flags.subtitles === undefined ? undefined : onOff(flags.subtitles), concurrency: studio.config.studio.lanes.renders, log });
    const e = result.export;
    console.log(`${result.rendered} clip(s) rendered, ${result.reused} reused. ${EXPORT_FORMATS[e.format].name}, ${e.width} by ${e.height}, ${e.durationSec.toFixed(1)}s.`);
    console.log(`Package: ${result.folder}`);
    for (const note of e.notes) console.log(`Note: ${note}`);
    return;
  }
  if (command === "exports") {
    const project = getProject(studio, required(rest[0], "project"));
    const all = listExports(studio, project.id);
    if (!all.length) console.log("Nothing exported yet.");
    for (const e of all) console.log(`${e.createdAt.slice(0, 16).replace("T", " ")}  ${e.format.padEnd(10)} ${`${e.width}x${e.height}`.padEnd(10)} ${e.durationSec.toFixed(1).padStart(7)}s  ${projectPaths(studio, project).abs(e.folder)}`);
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

function versionNumber(value: string | undefined): number {
  const n = Number(String(value ?? "").replace(/^v/i, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error('Name a version by its number, such as 2. "versions <project> <scene>" lists them.');
  return n;
}

/** Start the GUI server and keep it running until the terminal is closed. */
/** The studio runs Claude through Claude Code, so a run can be continued later. The API-key runner is for the older pipeline only. */
function studioConfig(values: { runner?: string; model?: string }) {
  const config = loadConfig({ runner: values.runner as RunnerKind | undefined, model: values.model });
  if (config.runner === "agent-sdk") {
    throw new Error('The studio does not use the agent-sdk runner yet. Use "claude-cli" (your Claude Code login) or "mock".');
  }
  return config;
}

async function serveStudio(values: { workspace?: string; runner?: string; model?: string; port?: string; "no-open"?: boolean }) {
  const { startServer } = await import("@studio/server/src/server");
  const config = studioConfig(values);
  const studio = new Studio(config, values.workspace);
  const server = await startServer(studio, { port: values.port ? Number(values.port) : undefined });
  console.log(`Scene Studio is running at ${server.url}\nProjects are kept in ${studio.workspaceDir}\nPress Ctrl+C to stop.`);
  if (config.runner === "mock") console.log("Using the stand-in runner: plans and scenes are fixed samples, and Claude is not called.");
  if (!values["no-open"]) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // Closing the terminal window: SIGHUP everywhere, and Ctrl+Break on Windows. Both still get a tidy stop.
    process.once("SIGHUP", stop);
    if (process.platform === "win32") process.once("SIGBREAK", stop);
  });
  await server.close();
  // Claude runs started from here end with the studio. What they saved stays, and they can be started again.
  server.orchestrator.stop();
  await Promise.race([server.orchestrator.idle(), new Promise((r) => setTimeout(r, 3000))]);
  studio.close();
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    // A missing opener is not worth stopping for: the address is printed above.
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // Same.
  }
}

/** Print what the runs say while they work, until everything has finished. */
async function follow(studio: Studio, o: Orchestrator, projectId: string) {
  const seen = new Map<string, number>();
  let done = false;
  const idle = o.idle().then(() => (done = true));
  const print = () => {
    for (const run of listRuns(studio, projectId, { limit: 50 }).reverse()) {
      const log = readRunLog(studio, run.id, seen.get(run.id) ?? 0);
      seen.set(run.id, log.next);
      const who = run.targetKind === "scene" ? `scene ${sceneLabel(studio, getScene(studio, run.targetId!))}` : run.targetKind;
      for (const line of log.lines) console.log(`[${who}] ${line.kind === "tool" ? "> " : line.kind === "result" ? "  " : ""}${line.text.split("\n")[0]!.slice(0, 200)}`);
    }
  };
  for (const run of listRuns(studio, projectId, { limit: 500 })) if (!["queued", "running"].includes(run.status)) seen.set(run.id, Number.MAX_SAFE_INTEGER);
  while (!done) {
    print();
    await new Promise((r) => setTimeout(r, 700));
  }
  await idle;
  print();
}

function chapterByNumber(studio: Studio, projectId: string, number: string) {
  const chapter = listChapters(studio, projectId).find((c) => String(c.position) === number);
  if (!chapter) throw new Error(`There is no chapter ${number} in this project.`);
  return chapter;
}

const CHAPTER_STATUS: Record<string, string> = {
  planned: "not written yet",
  scripting: "being written",
  script_review: "scene list waiting for your approval",
  in_production: "in production",
  done: "done",
};

function printStatus(studio: Studio, o: Orchestrator, projectId: string) {
  const status = o.stageStatus(projectId);
  console.log(`\nStage: ${status.stage}. ${status.about}`);
  const scenes = listScenes(studio, projectId);
  for (const chapter of listChapters(studio, projectId)) {
    console.log(`Chapter ${chapter.position}: ${chapter.title}  (${CHAPTER_STATUS[chapter.status] ?? chapter.status})`);
    for (const scene of scenes.filter((s) => s.chapterId === chapter.id)) {
      console.log(`  ${sceneLabel(studio, scene).padEnd(6)} ${scene.type.padEnd(13)} ${scene.status.padEnd(14)} ${scene.title}${scene.staleReason ? `  (${scene.staleReason})` : ""}`);
    }
  }
  if (status.waitingOn.length) console.log(`Waiting on:\n  - ${status.waitingOn.join("\n  - ")}`);
  else if (status.stage !== "done") console.log("Ready for you to approve.");
}

/** An asset by its id, or by its label when exactly one has it. */
function assetNamed(studio: Studio, projectId: string, name: string) {
  const all = listAssets(studio, projectId);
  const found = all.find((a) => a.id === name) ?? (all.filter((a) => a.label === name).length === 1 ? all.find((a) => a.label === name) : undefined);
  if (!found) throw new Error(`There is no asset "${name}" in this project. List them with: npm run studio -- assets <project>`);
  return found;
}

function onOff(word: string): boolean {
  const w = word.trim().toLowerCase();
  if (["on", "yes", "true", "add"].includes(w)) return true;
  if (["off", "no", "false", "remove"].includes(w)) return false;
  throw new Error(`Say "on" or "off", not "${word}".`);
}

/** A length as a person says it: "45 seconds", "7 minutes", "7 minutes 30 seconds". */
function readable(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return [m ? part(m, "minute") : "", s || !m ? part(s, "second") : ""].filter(Boolean).join(" ");
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. Run with --help for usage.`);
  return value;
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
