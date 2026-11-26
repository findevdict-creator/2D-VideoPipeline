/**
 * The 3D half of the library, for scenes of type "r3f". Import it as "@pipeline/lib/three".
 * See packages/lib/README-3D.md for how to use it.
 */
export { Ground, Lights, Scene3D } from "./Scene3D";
export type { LightPreset, Scene3DProps } from "./Scene3D";
export { mix3, orbit, projectToScreen, useScreenPoint } from "./camera";
export type { CameraSpec, ScreenPoint, Vec3 } from "./camera";
export { Model, useAssetTexture, useModelInfo } from "./Model";
export type { ModelProps, PartChange } from "./Model";
export { makeModelPreviewRoot, MODEL_VIEWS } from "./ModelPreview";
