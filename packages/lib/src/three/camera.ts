import { PerspectiveCamera, Vector3 } from "three";
import { useVideoConfig } from "remotion";

export type Vec3 = [number, number, number];

/** Where the camera is and what it looks at. Compute it from the frame to move the camera. */
export interface CameraSpec {
  position: Vec3;
  /** The point in the centre of the picture. Default: the origin. */
  lookAt?: Vec3;
  /** Vertical field of view in degrees. Small (20 to 30) flattens like a long lens; large (50 to 70) exaggerates depth. Default 35. */
  fov?: number;
  near?: number;
  far?: number;
}

export const CAMERA_DEFAULTS = { lookAt: [0, 0, 0] as Vec3, fov: 35, near: 0.1, far: 200 };

/** Point a three.js camera the way a CameraSpec says. */
export function applyCamera(camera: PerspectiveCamera, spec: CameraSpec, aspect: number) {
  const { lookAt, fov, near, far } = { ...CAMERA_DEFAULTS, ...spec };
  camera.position.set(...spec.position);
  camera.up.set(0, 1, 0);
  camera.fov = fov;
  camera.near = near;
  camera.far = far;
  camera.aspect = aspect;
  camera.lookAt(...lookAt);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** Mix two points or two colours given as triples. */
export const mix3 = (from: Vec3, to: Vec3, p: number): Vec3 => [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p, from[2] + (to[2] - from[2]) * p];

/**
 * A point on a circle around `center`, for cameras that circle a subject.
 * 0 degrees is straight in front (+z), 90 is to the right (+x).
 */
export function orbit(angleDeg: number, radius: number, height = 0, center: Vec3 = [0, 0, 0]): Vec3 {
  const a = (angleDeg * Math.PI) / 180;
  return [center[0] + Math.sin(a) * radius, center[1] + height, center[2] + Math.cos(a) * radius];
}

export interface ScreenPoint {
  /** Pixels from the left and top of the frame, the same coordinates <Label> and <Canvas> use. */
  x: number;
  y: number;
  /** False when the point is behind the camera or outside the frame. */
  visible: boolean;
}

/** Where a point in the 3D scene lands on screen for a given camera. */
export function projectToScreen(spec: CameraSpec, point: Vec3, width: number, height: number): ScreenPoint {
  const camera = new PerspectiveCamera();
  applyCamera(camera, spec, width / height);
  const v = new Vector3(...point).project(camera);
  const x = ((v.x + 1) / 2) * width;
  const y = ((1 - v.y) / 2) * height;
  return { x, y, visible: v.z > -1 && v.z < 1 && x >= 0 && x <= width && y >= 0 && y <= height };
}

/**
 * Where a 3D point is on screen, so a 2D <Label> or <Arrow> can point at it.
 * Pass the same camera you give <Scene3D>.
 */
export function useScreenPoint(camera: CameraSpec, point: Vec3): ScreenPoint {
  const { width, height } = useVideoConfig();
  return projectToScreen(camera, point, width, height);
}
