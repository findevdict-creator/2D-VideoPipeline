import React, { useLayoutEffect, useMemo } from "react";
import { useLoader } from "@react-three/fiber";
import { AnimationMixer, Color, Euler, LoopOnce, Quaternion, SRGBColorSpace, TextureLoader, Vector3, type AnimationClip, type Material, type Mesh, type Object3D, type Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { useAsset, useTheme } from "../context";
import type { Vec3 } from "./camera";

/** A change to one named part of a model, on top of how the part sits in the file. */
export interface PartChange {
  /** Move the part by this much, in the model's own units, from where it sits in the file. */
  offset?: Vec3;
  /** Turn the part by these angles in radians (x, y, z), around its own origin. */
  rotate?: Vec3;
  /** Scale the part. 1 leaves it as it is. */
  scale?: number | Vec3;
  visible?: boolean;
  /** A palette key or CSS colour, replacing the part's own colour. */
  color?: string;
  /** 0 is invisible, 1 is solid. */
  opacity?: number;
}

export interface ModelProps {
  /** The model's asset id. The scene's spec must list it under "assets". */
  asset: string;
  position?: Vec3;
  /** Radians, x y z. */
  rotation?: Vec3;
  scale?: number;
  /**
   * Resize the model so its longest side is this many scene units, and centre it on its
   * position. Use it: models come out of Blender at any size. Leave it out to keep the file's own size and origin.
   */
  fit?: number;
  /** Changes to named parts: move, turn, hide or recolour them. Compute them from the frame to animate. */
  parts?: Record<string, PartChange>;
  /** Animations from the file to show, by name, each at a time in seconds. The studio never plays them by itself. */
  animations?: Record<string, number>;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

interface Rest {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  visible: boolean;
}

const isMesh = (o: Object3D): o is Mesh => (o as Mesh).isMesh === true;

/**
 * A 3D model from the project's assets, such as one exported from Blender as .glb.
 * It is drawn exactly as its props say on every frame: parts are moved with `parts`,
 * and the file's own animations are scrubbed with `animations`.
 */
export const Model: React.FC<ModelProps> = ({ asset, position, rotation, scale = 1, fit, parts, animations, castShadow = true, receiveShadow = true }) => {
  const info = useAsset(asset);
  const t = useTheme();
  if (info.kind !== "model") throw new Error(`Asset "${asset}" (${info.label}) is ${info.kind}, not a 3D model.`);
  const gltf = useLoader(GLTFLoader, info.url);

  // Each <Model> gets its own copy, so two of them can show different poses.
  const copy = useMemo(() => {
    const object = cloneSkinned(gltf.scene);
    const byName = new Map<string, Object3D>();
    const rest = new Map<Object3D, Rest>();
    const unwanted: Object3D[] = [];
    object.traverse((o) => {
      // Scenes bring their own lights and camera.
      if ((o as { isLight?: boolean }).isLight || (o as { isCamera?: boolean }).isCamera) unwanted.push(o);
      if (o.name && !byName.has(o.name)) byName.set(o.name, o);
      rest.set(o, { position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone(), visible: o.visible });
      if (isMesh(o)) {
        // Materials are copied so recolouring one part does not recolour another model.
        o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        o.userData.restMaterial = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => ({
          color: (m as Material & { color?: Color }).color?.clone(),
          opacity: m.opacity,
          transparent: m.transparent,
        }));
      }
    });
    for (const o of unwanted) o.removeFromParent();
    return { object, byName, rest, mixer: new AnimationMixer(object), clips: new Map(gltf.animations.map((c: AnimationClip) => [c.name, c])) };
  }, [gltf]);

  // Runs on every frame, before the frame is drawn: put the model back as it is in the file, then apply what the props ask for.
  useLayoutEffect(() => {
    const { object, byName, rest, mixer, clips } = copy;
    for (const [o, r] of rest) {
      o.position.copy(r.position);
      o.quaternion.copy(r.quaternion);
      o.scale.copy(r.scale);
      o.visible = r.visible;
      if (isMesh(o)) {
        o.castShadow = castShadow;
        o.receiveShadow = receiveShadow;
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        (o.userData.restMaterial as { color?: Color; opacity: number; transparent: boolean }[]).forEach((m, i) => {
          const material = materials[i] as Material & { color?: Color };
          if (m.color && material.color) material.color.copy(m.color);
          material.opacity = m.opacity;
          material.transparent = m.transparent;
        });
      }
    }

    mixer.stopAllAction();
    for (const [name, seconds] of Object.entries(animations ?? {})) {
      const clip = clips.get(name);
      if (!clip) throw new Error(`Model "${info.label}" has no animation named "${name}". It has: ${[...clips.keys()].join(", ") || "none"}.`);
      const action = mixer.clipAction(clip);
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      action.time = Math.min(clip.duration, Math.max(0, seconds));
    }
    if (animations && Object.keys(animations).length) mixer.update(0);

    for (const [name, change] of Object.entries(parts ?? {})) {
      const part = byName.get(name);
      if (!part) throw new Error(`Model "${info.label}" has no part named "${name}". It has: ${[...byName.keys()].join(", ")}.`);
      if (change.offset) part.position.add(new Vector3(...change.offset));
      if (change.rotate) part.quaternion.multiply(new Quaternion().setFromEuler(new Euler(...change.rotate)));
      if (change.scale !== undefined) part.scale.multiply(typeof change.scale === "number" ? new Vector3(change.scale, change.scale, change.scale) : new Vector3(...change.scale));
      if (change.visible !== undefined) part.visible = change.visible;
      if (change.color !== undefined || change.opacity !== undefined) {
        part.traverse((o) => {
          if (!isMesh(o)) return;
          for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
            const m = material as Material & { color?: Color };
            if (change.color !== undefined && m.color) m.color.set(t.color(change.color));
            if (change.opacity !== undefined) {
              m.opacity = change.opacity;
              m.transparent = change.opacity < 1;
            }
          }
        });
      }
    }
    object.updateMatrixWorld(true);
  });

  // "fit" uses the size measured when the file was added, so it does not depend on the pose.
  const longest = Math.max(...(info.model?.size ?? [1, 1, 1]), 1e-6);
  const k = fit ? fit / longest : 1;
  const c = fit ? (info.model?.center ?? [0, 0, 0]) : [0, 0, 0];
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <group scale={k} position={[-c[0]! * k, -c[1]! * k, -c[2]! * k]}>
        <primitive object={copy.object} />
      </group>
    </group>
  );
};

/** What a model asset holds: its parts, animations and size. The same list asset_list gives. */
export function useModelInfo(asset: string) {
  const info = useAsset(asset);
  if (!info.model) throw new Error(`Asset "${asset}" (${info.label}) is ${info.kind}, not a 3D model.`);
  return info.model;
}

/** One of the project's images as a texture, for <meshStandardMaterial map={...} />. The spec must list it under "assets". */
export function useAssetTexture(asset: string): Texture {
  const info = useAsset(asset);
  if (info.kind !== "image") throw new Error(`Asset "${asset}" (${info.label}) is ${info.kind}, not an image.`);
  const texture = useLoader(TextureLoader, info.url);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
