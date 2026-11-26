import {
  Color3,
  Constants,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PhysicsShapeSphere,
  StandardMaterial,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import { BOLT, DRONES, type DroneType } from "./config";

/**
 * Shared, invisible template meshes + materials. Every drone / bolt / warp effect is built
 * from InstancedMeshes of these, so N drones cost a handful of instanced draw calls.
 * Each drone's local space faces +Z with the hull centred on the origin.
 */

export interface RotorMount {
  mesh: Mesh;
  position: Vector3;
  /** Fixed tilt (euler) of the ring relative to the spinner. */
  tilt: Vector3;
  scale: number;
  /** Spin around the ring's own axis (rad/s). */
  spin: number;
  /** Spin of the whole tilted ring around the drone's Y axis (rad/s, gyroscope wobble). */
  precess: number;
}

export interface DroneTemplate {
  hull: Mesh;
  plates: Mesh;
  /** Hull + plates geometry, slightly inflated, white unlit: the hit flash. */
  flash: Mesh;
  eye: Mesh;
  eyePosition: Vector3;
  thruster: Mesh;
  thrusterPosition: Vector3;
  rotors: RotorMount[];
  /** Local muzzle points (bolts spawn here). */
  muzzles: Vector3[];
}

export interface EnemyAssets {
  drones: Record<DroneType, DroneTemplate>;
  shapes: Record<DroneType, PhysicsShapeSphere>;
  boltCore: Mesh;
  boltTrail: Mesh;
  warpRing: Record<DroneType, Mesh>;
  warpCore: Record<DroneType, Mesh>;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

function hideTemplate(mesh: Mesh, name: string): Mesh {
  mesh.name = name;
  mesh.isVisible = false;
  mesh.isPickable = false;
  mesh.position.setAll(0);
  mesh.rotation.setAll(0);
  mesh.scaling.setAll(1);
  return mesh;
}

/** Positions a builder mesh; MergeMeshes bakes these transforms. */
function place(mesh: Mesh, pos: Vector3, rot?: Vector3, scale?: Vector3): Mesh {
  mesh.position.copyFrom(pos);
  if (rot) mesh.rotation.copyFrom(rot);
  if (scale) mesh.scaling.copyFrom(scale);
  return mesh;
}

function merge(parts: Mesh[], name: string, scale: number, material: StandardMaterial | PBRMaterial): Mesh {
  if (scale !== 1) {
    for (const p of parts) {
      p.position.scaleInPlace(scale);
      p.scaling.scaleInPlace(scale);
    }
  }
  const merged = Mesh.MergeMeshes(parts, true, true);
  if (!merged) throw new Error(`[enemies] failed to merge ${name}`);
  merged.material = material;
  return hideTemplate(merged, name);
}

/** Builds a centred single-part template (eye, thruster...) at a given scale. */
function single(mesh: Mesh, name: string, scale: number, material: StandardMaterial | PBRMaterial, bake?: Matrix): Mesh {
  if (bake) mesh.bakeTransformIntoVertices(bake);
  if (scale !== 1) mesh.bakeTransformIntoVertices(Matrix.Scaling(scale, scale, scale));
  mesh.material = material;
  return hideTemplate(mesh, name);
}

// ---------------------------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------------------------

function ctx2d(tex: DynamicTexture): CanvasRenderingContext2D {
  return tex.getContext() as unknown as CanvasRenderingContext2D;
}

/** Light-grey base with panel seams, rivets and wear; multiplied by the material albedo. */
function makePanelTexture(scene: Scene): DynamicTexture {
  const S = 256;
  const tex = new DynamicTexture("enemy-panels", { width: S, height: S }, scene, true);
  const g = ctx2d(tex);
  g.fillStyle = "#d4d6db";
  g.fillRect(0, 0, S, S);
  // Mottled wear.
  for (let i = 0; i < 1600; i++) {
    const c = 150 + Math.floor(Math.random() * 105);
    g.fillStyle = `rgba(${c},${c},${c + 6},0.28)`;
    const w = 1 + Math.random() * 4;
    g.fillRect(Math.random() * S, Math.random() * S, w, w * (0.5 + Math.random()));
  }
  // Panel seams: rows with staggered vertical splits.
  g.strokeStyle = "rgba(28,30,36,0.95)";
  g.lineWidth = 2;
  const rows = [0, 58, 122, 186, 256];
  for (let r = 0; r < rows.length - 1; r++) {
    const y0 = rows[r];
    const y1 = rows[r + 1];
    g.beginPath();
    g.moveTo(0, y0 + 1);
    g.lineTo(S, y0 + 1);
    g.stroke();
    let x = (r * 37) % 64;
    while (x < S) {
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x, y1);
      g.stroke();
      // Rivets along the seam.
      g.fillStyle = "rgba(245,246,250,0.8)";
      for (let y = y0 + 8; y < y1 - 4; y += 14) {
        g.beginPath();
        g.arc(x + 5, y, 1.6, 0, Math.PI * 2);
        g.fill();
      }
      x += 48 + Math.floor(Math.random() * 40);
    }
  }
  // Bright edge scratches.
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 8);
    g.stroke();
  }
  tex.update(true);
  tex.anisotropicFilteringLevel = 4;
  return tex;
}

/** Diagonal hazard stripes (bomber armour). */
function makeStripeTexture(scene: Scene): DynamicTexture {
  const S = 128;
  const tex = new DynamicTexture("enemy-stripes", { width: S, height: S }, scene, true);
  const g = ctx2d(tex);
  g.fillStyle = "#f0a020";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#1a1a1c";
  for (let i = -S; i < S * 2; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 16, 0);
    g.lineTo(i + 16 - S, S);
    g.lineTo(i - S, S);
    g.closePath();
    g.fill();
  }
  // Grime.
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(40,30,20,${0.08 + Math.random() * 0.2})`;
    g.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 5, 1 + Math.random() * 3);
  }
  tex.update(true);
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

interface Materials {
  hull: PBRMaterial;
  rotor: PBRMaterial;
  plates: Record<DroneType, PBRMaterial>;
  eye: Record<DroneType, StandardMaterial>;
  thruster: Record<DroneType, StandardMaterial>;
  flash: StandardMaterial;
  boltCore: StandardMaterial;
  boltTrail: StandardMaterial;
  warp: Record<DroneType, StandardMaterial>;
}

function pbr(scene: Scene, name: string, albedo: Color3, metallic: number, roughness: number): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = albedo;
  // Full metallic: the world always installs an environment map (its sky probe), but only a few
  // frames after boot, so checking scene.environmentTexture here would always see null.
  m.metallic = metallic;
  m.roughness = roughness;
  return m;
}

function unlit(scene: Scene, name: string, color: Color3, additiveAlpha?: number): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.emissiveColor = color.clone();
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  if (additiveAlpha !== undefined) {
    m.alpha = additiveAlpha;
    m.alphaMode = Constants.ALPHA_ADD;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
  }
  return m;
}

function createMaterials(scene: Scene): Materials {
  const panels = makePanelTexture(scene);
  const stripes = makeStripeTexture(scene);

  const hull = pbr(scene, "enemy-hull", new Color3(0.2, 0.21, 0.24), 0.85, 0.36);
  hull.albedoTexture = panels;
  const rotor = pbr(scene, "enemy-rotor", new Color3(0.48, 0.5, 0.54), 0.9, 0.28);

  const seekerPlates = pbr(scene, "enemy-plates-seeker", new Color3(0.33, 0.35, 0.39), 0.8, 0.3);
  seekerPlates.albedoTexture = panels;
  const bomberPlates = pbr(scene, "enemy-plates-bomber", new Color3(0.85, 0.8, 0.75), 0.25, 0.55);
  bomberPlates.albedoTexture = stripes;
  const brutePlates = pbr(scene, "enemy-plates-brute", new Color3(0.36, 0.09, 0.06), 0.45, 0.48);
  brutePlates.albedoTexture = panels;

  const eye = {} as Record<DroneType, StandardMaterial>;
  const thruster = {} as Record<DroneType, StandardMaterial>;
  const warp = {} as Record<DroneType, StandardMaterial>;
  for (const type of Object.keys(DRONES) as DroneType[]) {
    const c = DRONES[type].color;
    eye[type] = unlit(scene, `enemy-eye-${type}`, c);
    thruster[type] = unlit(scene, `enemy-thruster-${type}`, Color3.Lerp(c, Color3.White(), 0.45), 0.7);
    warp[type] = unlit(scene, `enemy-warp-${type}`, Color3.Lerp(c, Color3.White(), 0.2), 0.85);
  }

  return {
    hull,
    rotor,
    plates: { seeker: seekerPlates, bomber: bomberPlates, brute: brutePlates },
    eye,
    thruster,
    flash: unlit(scene, "enemy-flash", new Color3(1, 1, 1)),
    boltCore: unlit(scene, "enemy-bolt-core", BOLT.core),
    boltTrail: unlit(scene, "enemy-bolt-trail", BOLT.glow, 0.75),
    warp,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared part builders
// ---------------------------------------------------------------------------------------------

/** Thruster flame: cone pointing down with its top at the origin (so scaling.y stretches it). */
function thrusterCone(scene: Scene, name: string, diameter: number, length: number): Mesh {
  const m = MeshBuilder.CreateCylinder(name, { height: length, diameterTop: diameter, diameterBottom: diameter * 0.08, tessellation: 12 }, scene);
  m.bakeTransformIntoVertices(Matrix.Translation(0, -length / 2, 0));
  return m;
}

/** Ring with 4 nubs: a gyroscope ring orbiting the body. Diameter 1. */
function buildGyroRing(scene: Scene, mats: Materials): Mesh {
  const parts: Mesh[] = [MeshBuilder.CreateTorus("gyro-ring", { diameter: 1, thickness: 0.04, tessellation: 40 }, scene)];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    parts.push(place(MeshBuilder.CreateBox("gyro-nub", { width: 0.1, height: 0.07, depth: 0.07 }, scene), v(Math.sin(a) * 0.5, 0, Math.cos(a) * 0.5), v(0, a, 0)));
  }
  return merge(parts, "enemy-tpl-gyro", 1, mats.rotor);
}

/** Ducted rotor: ring + hub + 3 blades. Diameter 1. */
function buildDuct(scene: Scene, mats: Materials): Mesh {
  const parts: Mesh[] = [
    MeshBuilder.CreateTorus("duct-ring", { diameter: 1, thickness: 0.14, tessellation: 32 }, scene),
    MeshBuilder.CreateCylinder("duct-hub", { height: 0.12, diameter: 0.16, tessellation: 12 }, scene),
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(place(MeshBuilder.CreateBox("duct-blade", { width: 0.42, height: 0.02, depth: 0.12 }, scene), v(Math.cos(a) * 0.24, 0, -Math.sin(a) * 0.24), v(0.35, a, 0)));
  }
  return merge(parts, "enemy-tpl-duct", 1, mats.rotor);
}

function buildFlash(hull: Mesh, plates: Mesh, mats: Materials, type: DroneType): Mesh {
  const a = hull.clone(`flash-a-${type}`);
  const b = plates.clone(`flash-b-${type}`);
  a.scaling.setAll(1.05);
  b.scaling.setAll(1.05);
  const merged = Mesh.MergeMeshes([a, b], true, true);
  if (!merged) throw new Error("[enemies] failed to build flash mesh");
  merged.material = mats.flash;
  return hideTemplate(merged, `enemy-tpl-flash-${type}`);
}

// ---------------------------------------------------------------------------------------------
// Drone models
// ---------------------------------------------------------------------------------------------

function buildSeeker(scene: Scene, mats: Materials, gyro: Mesh): DroneTemplate {
  const S = DRONES.seeker.scale;
  const hullParts: Mesh[] = [
    MeshBuilder.CreateIcoSphere("s-core", { radius: 0.4, subdivisions: 3, flat: false }, scene),
    // Eye socket (dark recess shows when the eye flickers).
    place(MeshBuilder.CreateCylinder("s-socket", { height: 0.12, diameter: 0.28, tessellation: 24 }, scene), v(0, 0, 0.35), v(Math.PI / 2, 0, 0)),
    place(MeshBuilder.CreateTorus("s-rim", { diameter: 0.27, thickness: 0.05, tessellation: 24 }, scene), v(0, 0, 0.41), v(Math.PI / 2, 0, 0)),
    // Thruster housing.
    place(MeshBuilder.CreateCylinder("s-thr", { height: 0.16, diameterTop: 0.3, diameterBottom: 0.2, tessellation: 16 }, scene), v(0, -0.38, 0)),
    // Side sensor pods.
    place(MeshBuilder.CreateCylinder("s-podL", { height: 0.14, diameter: 0.17, tessellation: 12 }, scene), v(-0.41, 0.02, -0.02), v(0, 0, Math.PI / 2)),
    place(MeshBuilder.CreateCylinder("s-podR", { height: 0.14, diameter: 0.17, tessellation: 12 }, scene), v(0.41, 0.02, -0.02), v(0, 0, Math.PI / 2)),
    // Antenna.
    place(MeshBuilder.CreateCylinder("s-ant", { height: 0.2, diameter: 0.025, tessellation: 6 }, scene), v(0.1, 0.44, -0.1), v(-0.2, 0, 0.15)),
  ];
  const plateParts: Mesh[] = [
    place(MeshBuilder.CreateCylinder("s-cap", { height: 0.06, diameterTop: 0.3, diameterBottom: 0.46, tessellation: 20 }, scene), v(0, 0.38, 0)),
  ];
  for (const deg of [55, 125, 235, 305]) {
    const a = (deg * Math.PI) / 180;
    plateParts.push(place(MeshBuilder.CreateBox("s-plate", { width: 0.3, height: 0.24, depth: 0.05 }, scene), v(Math.sin(a) * 0.4, 0.06, Math.cos(a) * 0.4), v(-0.12, a, 0)));
  }
  const hull = merge(hullParts, "enemy-tpl-seeker-hull", S, mats.hull);
  const plates = merge(plateParts, "enemy-tpl-seeker-plates", S, mats.plates.seeker);
  const eye = single(MeshBuilder.CreateSphere("s-eye", { diameter: 0.2, segments: 12 }, scene), "enemy-tpl-seeker-eye", S, mats.eye.seeker, Matrix.Scaling(1, 1, 0.55));
  const thruster = single(thrusterCone(scene, "s-flame", 0.18, 0.5), "enemy-tpl-seeker-flame", S, mats.thruster.seeker);
  return {
    hull,
    plates,
    flash: buildFlash(hull, plates, mats, "seeker"),
    eye,
    eyePosition: v(0, 0, 0.43 * S),
    thruster,
    thrusterPosition: v(0, -0.46 * S, 0),
    rotors: [
      { mesh: gyro, position: v(0, 0, 0), tilt: v(0, 0, 0), scale: 1.15 * S, spin: 4.5, precess: 0 },
      { mesh: gyro, position: v(0, 0, 0), tilt: v(0, 0, 1.15), scale: 1.32 * S, spin: -6, precess: 1.7 },
    ],
    muzzles: [v(0, 0, 0.55 * S)],
  };
}

function buildBomber(scene: Scene, mats: Materials, duct: Mesh): DroneTemplate {
  const S = DRONES.bomber.scale;
  const armR = 0.64;
  const armAngles = [60, 180, 300].map((d) => (d * Math.PI) / 180);
  const hullParts: Mesh[] = [
    MeshBuilder.CreateIcoSphere("b-core", { radiusX: 0.36, radiusY: 0.33, radiusZ: 0.42, subdivisions: 3, flat: false }, scene),
    place(MeshBuilder.CreateCylinder("b-socket", { height: 0.12, diameter: 0.3, tessellation: 24 }, scene), v(0, 0, 0.37), v(Math.PI / 2, 0, 0)),
    place(MeshBuilder.CreateTorus("b-rim", { diameter: 0.3, thickness: 0.05, tessellation: 24 }, scene), v(0, 0, 0.43), v(Math.PI / 2, 0, 0)),
    place(MeshBuilder.CreateCylinder("b-thr", { height: 0.14, diameterTop: 0.26, diameterBottom: 0.18, tessellation: 16 }, scene), v(0, -0.33, -0.02)),
    // Tail fins.
    place(MeshBuilder.CreateBox("b-finT", { width: 0.03, height: 0.2, depth: 0.22 }, scene), v(0, 0.28, -0.32), v(-0.5, 0, 0)),
  ];
  for (const a of armAngles) {
    hullParts.push(place(MeshBuilder.CreateBox("b-arm", { width: 0.06, height: 0.05, depth: 0.25 }, scene), v(Math.sin(a) * 0.365, 0.05, Math.cos(a) * 0.365), v(0, a, 0)));
  }
  const plateParts: Mesh[] = [
    // Hazard band around the warhead.
    place(MeshBuilder.CreateCylinder("b-band", { height: 0.14, diameter: 0.76, tessellation: 28 }, scene), v(0, 0, 0)),
    place(MeshBuilder.CreateBox("b-plateT", { width: 0.26, height: 0.05, depth: 0.3 }, scene), v(0, 0.31, 0.04), v(-0.1, 0, 0)),
    place(MeshBuilder.CreateBox("b-plateL", { width: 0.05, height: 0.2, depth: 0.28 }, scene), v(-0.35, 0.12, 0.05), v(0, 0, 0.35)),
    place(MeshBuilder.CreateBox("b-plateR", { width: 0.05, height: 0.2, depth: 0.28 }, scene), v(0.35, 0.12, 0.05), v(0, 0, -0.35)),
  ];
  const hull = merge(hullParts, "enemy-tpl-bomber-hull", S, mats.hull);
  const plates = merge(plateParts, "enemy-tpl-bomber-plates", S, mats.plates.bomber);
  const eye = single(MeshBuilder.CreateSphere("b-eye", { diameter: 0.24, segments: 12 }, scene), "enemy-tpl-bomber-eye", S, mats.eye.bomber, Matrix.Scaling(1, 1, 0.5));
  const thruster = single(thrusterCone(scene, "b-flame", 0.17, 0.55), "enemy-tpl-bomber-flame", S, mats.thruster.bomber);
  return {
    hull,
    plates,
    flash: buildFlash(hull, plates, mats, "bomber"),
    eye,
    eyePosition: v(0, 0, 0.45 * S),
    thruster,
    thrusterPosition: v(0, -0.4 * S, -0.02 * S),
    rotors: armAngles.map((a, i) => ({
      mesh: duct,
      position: v(Math.sin(a) * armR * S, 0.05 * S, Math.cos(a) * armR * S),
      tilt: v(0, 0, 0),
      scale: 0.36 * S,
      spin: i % 2 ? -24 : 24,
      precess: 0,
    })),
    muzzles: [v(0, 0, 0.5 * S)],
  };
}

function buildBrute(scene: Scene, mats: Materials, duct: Mesh): DroneTemplate {
  const S = DRONES.brute.scale;
  const armR = 0.74;
  const armAngles = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);
  const hullParts: Mesh[] = [
    MeshBuilder.CreateIcoSphere("r-core", { radiusX: 0.5, radiusY: 0.4, radiusZ: 0.46, subdivisions: 3, flat: false }, scene),
    // Visor block housing the slit eye.
    place(MeshBuilder.CreateBox("r-visor", { width: 0.5, height: 0.17, depth: 0.16 }, scene), v(0, 0.06, 0.38)),
    // Side cannons.
    place(MeshBuilder.CreateBox("r-gunL", { width: 0.14, height: 0.14, depth: 0.28 }, scene), v(-0.42, -0.12, 0.16)),
    place(MeshBuilder.CreateBox("r-gunR", { width: 0.14, height: 0.14, depth: 0.28 }, scene), v(0.42, -0.12, 0.16)),
    place(MeshBuilder.CreateCylinder("r-barL", { height: 0.34, diameter: 0.07, tessellation: 10 }, scene), v(-0.42, -0.12, 0.42), v(Math.PI / 2, 0, 0)),
    place(MeshBuilder.CreateCylinder("r-barR", { height: 0.34, diameter: 0.07, tessellation: 10 }, scene), v(0.42, -0.12, 0.42), v(Math.PI / 2, 0, 0)),
    place(MeshBuilder.CreateCylinder("r-thr", { height: 0.16, diameterTop: 0.36, diameterBottom: 0.26, tessellation: 16 }, scene), v(0, -0.4, 0)),
  ];
  for (const a of armAngles) {
    hullParts.push(place(MeshBuilder.CreateBox("r-arm", { width: 0.09, height: 0.07, depth: 0.24 }, scene), v(Math.sin(a) * 0.4, 0.1, Math.cos(a) * 0.4), v(0, a, 0)));
  }
  const plateParts: Mesh[] = [
    place(MeshBuilder.CreateBox("r-shL", { width: 0.32, height: 0.08, depth: 0.46 }, scene), v(-0.3, 0.32, 0), v(0, 0, 0.45)),
    place(MeshBuilder.CreateBox("r-shR", { width: 0.32, height: 0.08, depth: 0.46 }, scene), v(0.3, 0.32, 0), v(0, 0, -0.45)),
    place(MeshBuilder.CreateBox("r-crest", { width: 0.12, height: 0.1, depth: 0.62 }, scene), v(0, 0.42, -0.02)),
    place(MeshBuilder.CreateBox("r-chin", { width: 0.44, height: 0.08, depth: 0.22 }, scene), v(0, -0.24, 0.36), v(0.45, 0, 0)),
    place(MeshBuilder.CreateBox("r-brow", { width: 0.56, height: 0.07, depth: 0.2 }, scene), v(0, 0.2, 0.38), v(-0.35, 0, 0)),
    place(MeshBuilder.CreateBox("r-back", { width: 0.5, height: 0.36, depth: 0.08 }, scene), v(0, 0.02, -0.46)),
  ];
  const hull = merge(hullParts, "enemy-tpl-brute-hull", S, mats.hull);
  const plates = merge(plateParts, "enemy-tpl-brute-plates", S, mats.plates.brute);
  const eye = single(MeshBuilder.CreateBox("r-eye", { width: 0.38, height: 0.06, depth: 0.04 }, scene), "enemy-tpl-brute-eye", S, mats.eye.brute);
  const thruster = single(thrusterCone(scene, "r-flame", 0.3, 0.6), "enemy-tpl-brute-flame", S, mats.thruster.brute);
  return {
    hull,
    plates,
    flash: buildFlash(hull, plates, mats, "brute"),
    eye,
    eyePosition: v(0, 0.06 * S, 0.47 * S),
    thruster,
    thrusterPosition: v(0, -0.47 * S, 0),
    rotors: armAngles.map((a, i) => ({
      mesh: duct,
      position: v(Math.sin(a) * armR * S, 0.1 * S, Math.cos(a) * armR * S),
      tilt: v(0, 0, 0),
      scale: 0.42 * S,
      spin: i % 2 ? -15 : 15,
      precess: 0,
    })),
    muzzles: [v(-0.42 * S, -0.12 * S, 0.6 * S), v(0.42 * S, -0.12 * S, 0.6 * S)],
  };
}

// ---------------------------------------------------------------------------------------------

export function createEnemyAssets(scene: Scene): EnemyAssets {
  const mats = createMaterials(scene);
  const gyro = buildGyroRing(scene, mats);
  const duct = buildDuct(scene, mats);

  const drones: Record<DroneType, DroneTemplate> = {
    seeker: buildSeeker(scene, mats, gyro),
    bomber: buildBomber(scene, mats, duct),
    brute: buildBrute(scene, mats, duct),
  };

  const shapes = {} as Record<DroneType, PhysicsShapeSphere>;
  const warpRing = {} as Record<DroneType, Mesh>;
  const warpCore = {} as Record<DroneType, Mesh>;
  for (const type of Object.keys(DRONES) as DroneType[]) {
    shapes[type] = new PhysicsShapeSphere(Vector3.Zero(), DRONES[type].hitRadius, scene);
    warpRing[type] = single(
      MeshBuilder.CreateTorus(`warp-ring-${type}`, { diameter: 1, thickness: 0.05, tessellation: 40 }, scene),
      `enemy-tpl-warp-ring-${type}`,
      1,
      mats.warp[type],
    );
    warpCore[type] = single(MeshBuilder.CreateSphere(`warp-core-${type}`, { diameter: 1, segments: 10 }, scene), `enemy-tpl-warp-core-${type}`, 1, mats.eye[type]);
  }

  // Bolt: hot core sphere + additive streak along -Z (head at origin, tail at z = -1).
  const boltCore = single(MeshBuilder.CreateSphere("bolt-core", { diameter: 0.32, segments: 8 }, scene), "enemy-tpl-bolt-core", 1, mats.boltCore);
  const trail = MeshBuilder.CreateCylinder("bolt-trail", { height: 1, diameterTop: 0.3, diameterBottom: 0.0, tessellation: 8 }, scene);
  // Cylinder axis +Y -> +Z (head at z = +0.5), then shift so the head sits on the origin.
  trail.bakeTransformIntoVertices(Matrix.RotationX(Math.PI / 2).multiply(Matrix.Translation(0, 0, -0.5)));
  const boltTrail = single(trail, "enemy-tpl-bolt-trail", 1, mats.boltTrail);

  return { drones, shapes, boltCore, boltTrail, warpRing, warpCore };
}
