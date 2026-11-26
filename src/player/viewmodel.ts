import {
  Color3,
  Constants,
  DynamicTexture,
  Material,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Scene,
  type UniversalCamera,
} from "@babylonjs/core";
import { markNoHit } from "../core/damage";
import type { GameContext } from "../core/context";
import { clamp, damp, easeInCubic, easeOutCubic, smoothstep, Spring } from "./util";

/** Rendering group for the first-person weapon (depth cleared so it never clips into walls). */
export const VIEWMODEL_GROUP = 1;

const BASE_POS = new Vector3(0.165, -0.185, 0.34);
const BASE_ROT = new Vector3(0.0, -0.045, 0);

const ACCENT_BASE = new Color3(0.2, 0.75, 1.0);
const ACCENT_LOW = new Color3(1.0, 0.22, 0.12);
const PIP_ON = new Color3(1.0, 0.62, 0.18);

export interface ViewmodelState {
  dt: number;
  /** Look delta this frame (radians). */
  lookYaw: number;
  lookPitch: number;
  stepPhase: number;
  bobAmount: number;
  grounded: boolean;
  sprintPose: boolean;
  strafeSpeed: number;
  /** -1 when not reloading, else 0..1. */
  reloadProgress: number;
  ammoFraction: number;
  charges: number;
  maxCharges: number;
  rechargeProgress: number;
  lowered: boolean;
}

/**
 * Procedural pulse rifle with under-barrel launcher, parented to the camera.
 * All animation is additive offsets on one root node.
 */
export class Viewmodel {
  readonly root: TransformNode;
  readonly muzzle: TransformNode;
  readonly launcherMuzzle: TransformNode;
  /** Emissive meshes (for glow-layer registration if the layer runs in include-only mode). */
  readonly glowMeshes: AbstractMesh[] = [];

  private readonly scene: Scene;
  private readonly meshes: AbstractMesh[] = [];
  private readonly magPivot: TransformNode;
  private readonly pips: Mesh[] = [];
  private readonly rifleFlash: TransformNode;
  private readonly launcherFlash: TransformNode;
  private readonly flashStar: Mesh;
  private readonly launcherStar: Mesh;
  private readonly accentMat: StandardMaterial;
  private readonly sightMat: StandardMaterial;
  private readonly pipOn: StandardMaterial;
  private readonly pipOff: StandardMaterial;
  private readonly pipCharging: StandardMaterial;
  private readonly metalMat: PBRMaterial;
  private readonly tubeMat: PBRMaterial;
  private envChecked = false;

  private time = 0;
  private flashT = 0;
  private launcherFlashT = 0;
  private accentPulse = 0;
  private swayRotX = 0;
  private swayRotY = 0;
  private swayPosX = 0;
  private swayPosY = 0;
  private sprintBlend = 0;
  private lowerBlend = 1;
  private strafeTilt = 0;
  private airBlend = 0;
  private lastReload = -1;

  private readonly kPosX = new Spring(300, 24);
  private readonly kPosY = new Spring(300, 24);
  private readonly kPosZ = new Spring(320, 26);
  private readonly kRotX = new Spring(260, 20);
  private readonly kRotY = new Spring(240, 20);
  private readonly kRotZ = new Spring(220, 18);

  constructor(ctx: GameContext) {
    const scene = ctx.scene;
    this.scene = scene;
    const camera: UniversalCamera = ctx.camera;
    scene.setRenderingAutoClearDepthStencil(VIEWMODEL_GROUP, true, true, true);

    // ---------- materials
    const metal = new PBRMaterial("vmGunmetal", scene);
    metal.albedoColor = new Color3(0.3, 0.32, 0.35);
    metal.metallic = 0.85;
    metal.roughness = 0.34;
    this.metalMat = metal;

    const poly = new PBRMaterial("vmPolymer", scene);
    poly.albedoColor = new Color3(0.06, 0.065, 0.07);
    poly.metallic = 0;
    poly.roughness = 0.62;

    const tube = new PBRMaterial("vmLauncher", scene);
    tube.albedoColor = new Color3(0.2, 0.19, 0.15);
    tube.metallic = 0.6;
    tube.roughness = 0.45;
    this.tubeMat = tube;

    const emissive = (name: string, color: Color3): StandardMaterial => {
      const m = new StandardMaterial(name, scene);
      m.disableLighting = true;
      m.diffuseColor = Color3.Black();
      m.specularColor = Color3.Black();
      m.emissiveColor = color.clone();
      m.fogEnabled = false;
      return m;
    };
    this.accentMat = emissive("vmAccent", ACCENT_BASE);
    this.sightMat = emissive("vmSight", new Color3(1.0, 0.45, 0.12));
    this.pipOn = emissive("vmPipOn", PIP_ON);
    this.pipOff = emissive("vmPipOff", new Color3(0.05, 0.035, 0.02));
    this.pipCharging = emissive("vmPipCharging", PIP_ON.scale(0.2));

    // ---------- geometry (built unparented, merged per material)
    const lists = { metal: [] as Mesh[], poly: [] as Mesh[], tube: [] as Mesh[], accent: [] as Mesh[], sight: [] as Mesh[], mag: [] as Mesh[] };
    type ListKey = keyof typeof lists;
    const box = (list: ListKey, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Mesh => {
      const m = MeshBuilder.CreateBox("vmPart", { width: w, height: h, depth: d }, scene);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      lists[list].push(m);
      return m;
    };
    const cyl = (list: ListKey, dFront: number, dBack: number, len: number, x: number, y: number, z: number, tess = 18): Mesh => {
      const m = MeshBuilder.CreateCylinder("vmPart", { diameterTop: dFront, diameterBottom: dBack, height: len, tessellation: tess }, scene);
      m.rotation.x = Math.PI / 2; // cylinder axis Y -> +Z (top faces forward)
      m.position.set(x, y, z);
      lists[list].push(m);
      return m;
    };

    // Upper receiver
    box("metal", 0.064, 0.082, 0.3, 0, 0, 0);
    box("metal", 0.056, 0.03, 0.12, 0, -0.054, 0.065); // mag well
    box("poly", 0.068, 0.046, 0.15, 0, -0.006, -0.06); // side panel band
    box("poly", 0.004, 0.024, 0.06, 0.0335, 0.016, 0.04); // ejection port
    // Top rail + teeth
    box("metal", 0.03, 0.012, 0.29, 0, 0.047, 0.015);
    for (let i = 0; i < 9; i++) box("metal", 0.034, 0.006, 0.012, 0, 0.055, -0.105 + i * 0.03);
    // Optic (housing + glowing reticle lens facing the eye)
    box("poly", 0.042, 0.036, 0.08, 0, 0.078, -0.02);
    box("poly", 0.048, 0.008, 0.08, 0, 0.1, -0.02);
    box("sight", 0.022, 0.014, 0.002, 0, 0.08, -0.061);
    // Handguard (octagonal) + accent strips
    cyl("poly", 0.06, 0.066, 0.25, 0, 0.004, 0.27, 8);
    box("accent", 0.004, 0.009, 0.17, 0.0325, 0.012, 0.27);
    box("accent", 0.004, 0.009, 0.17, -0.0325, 0.012, 0.27);
    box("accent", 0.004, 0.007, 0.11, -0.0335, 0.024, -0.06);
    // Barrel, cooling rings, muzzle brake, front sight
    cyl("metal", 0.024, 0.026, 0.17, 0, 0.004, 0.465);
    for (let i = 0; i < 3; i++) cyl("metal", 0.034, 0.034, 0.008, 0, 0.004, 0.41 + i * 0.022, 12);
    cyl("metal", 0.036, 0.04, 0.065, 0, 0.004, 0.575, 8);
    box("poly", 0.042, 0.007, 0.03, 0, 0.004, 0.58); // brake slot
    box("metal", 0.01, 0.034, 0.012, 0, 0.047, 0.385);
    // Grip, trigger guard, stock
    box("poly", 0.032, 0.105, 0.046, 0, -0.088, -0.1, -0.32);
    box("metal", 0.006, 0.006, 0.075, 0, -0.07, -0.035);
    box("metal", 0.006, 0.03, 0.006, 0, -0.056, 0.0);
    cyl("metal", 0.022, 0.022, 0.13, 0, 0.014, -0.2, 10);
    box("poly", 0.042, 0.066, 0.18, 0, -0.016, -0.25);
    box("metal", 0.046, 0.094, 0.022, 0, -0.022, -0.345);
    // Under-barrel launcher
    cyl("tube", 0.056, 0.056, 0.25, 0, -0.07, 0.245, 20);
    box("tube", 0.05, 0.05, 0.06, 0, -0.07, 0.105);
    box("tube", 0.012, 0.03, 0.16, 0, -0.04, 0.22); // mount rail
    cyl("metal", 0.066, 0.066, 0.02, 0, -0.07, 0.365, 20);
    cyl("poly", 0.04, 0.04, 0.004, 0, -0.07, 0.377, 16); // bore
    box("poly", 0.03, 0.065, 0.034, 0, -0.118, 0.17, -0.18); // launcher foregrip
    // Magazine (separate so it can drop during reload)
    box("mag", 0.036, 0.075, 0.064, 0, -0.03, 0);
    box("mag", 0.036, 0.075, 0.064, 0, -0.095, 0.012, 0.22);
    box("mag", 0.038, 0.012, 0.066, 0, -0.135, 0.022, 0.22); // base plate

    // ---------- hierarchy
    this.root = new TransformNode("viewmodel", scene);
    this.root.parent = camera;
    this.root.position.copyFrom(BASE_POS);
    this.root.rotation.copyFrom(BASE_ROT);

    this.magPivot = new TransformNode("vmMagPivot", scene);
    this.magPivot.parent = this.root;
    this.magPivot.position.set(0, -0.05, 0.065);

    const merge = (name: string, list: Mesh[], mat: Material, parent: TransformNode): Mesh | null => {
      if (!list.length) return null;
      const merged = Mesh.MergeMeshes(list, true, true);
      if (!merged) return null;
      merged.name = name;
      merged.material = mat;
      merged.parent = parent;
      this.register(merged);
      return merged;
    };
    merge("vmMetal", lists.metal, metal, this.root);
    merge("vmPoly", lists.poly, poly, this.root);
    merge("vmLauncherTube", lists.tube, tube, this.root);
    const accent = merge("vmAccent", lists.accent, this.accentMat, this.root);
    const sight = merge("vmSightDot", lists.sight, this.sightMat, this.root);
    if (accent) this.glowMeshes.push(accent);
    if (sight) this.glowMeshes.push(sight);
    // Magazine parts are authored relative to the pivot so the whole mag can drop out.
    merge("vmMag", lists.mag, poly, this.magPivot);

    // Launcher charge pips
    for (let i = 0; i < 3; i++) {
      const pip = MeshBuilder.CreateBox("vmPip", { width: 0.005, height: 0.012, depth: 0.018 }, scene);
      pip.parent = this.root;
      // Left side: the camera sits up and to the left of the gun.
      pip.position.set(-0.0285, -0.058, 0.18 + i * 0.036);
      pip.material = this.pipOn;
      this.register(pip);
      this.pips.push(pip);
      this.glowMeshes.push(pip);
    }

    // ---------- muzzles + flashes
    this.muzzle = new TransformNode("vmMuzzle", scene);
    this.muzzle.parent = this.root;
    this.muzzle.position.set(0, 0.004, 0.615);
    this.launcherMuzzle = new TransformNode("vmLauncherMuzzle", scene);
    this.launcherMuzzle.parent = this.root;
    this.launcherMuzzle.position.set(0, -0.07, 0.385);

    const flashMat = this.createFlashMaterial("vmFlashMat", this.drawStarTexture(), new Color3(1.0, 0.8, 0.55));
    const flareMat = this.createFlashMaterial("vmFlareMat", this.drawFlareTexture(), new Color3(1.0, 0.72, 0.45));
    const rifle = this.createFlash("vmRifleFlash", this.muzzle, flashMat, flareMat, 1);
    this.rifleFlash = rifle.group;
    this.flashStar = rifle.star;
    const launcherFlashMat = this.createFlashMaterial("vmLauncherFlashMat", this.drawStarTexture(), new Color3(1.0, 0.6, 0.25));
    const launcher = this.createFlash("vmLauncherFlash", this.launcherMuzzle, launcherFlashMat, flareMat, 1.5);
    this.launcherFlash = launcher.group;
    this.launcherStar = launcher.star;

    this.applyEnvironmentFallback();
  }

  private register(m: AbstractMesh): void {
    m.renderingGroupId = VIEWMODEL_GROUP;
    m.receiveShadows = false;
    m.alwaysSelectAsActiveMesh = true;
    m.isPickable = false;
    markNoHit(m);
    this.meshes.push(m);
  }

  /** Without an environment texture, PBR metal renders almost black: soften it. */
  private applyEnvironmentFallback(): void {
    if (this.envChecked) return;
    this.envChecked = true;
    if (this.scene.environmentTexture) return;
    this.metalMat.metallic = 0.35;
    this.metalMat.roughness = 0.45;
    this.metalMat.emissiveColor = new Color3(0.015, 0.016, 0.018);
    this.tubeMat.metallic = 0.25;
    this.tubeMat.roughness = 0.55;
  }

  private createFlashMaterial(name: string, tex: DynamicTexture, color: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.disableLighting = true;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.emissiveTexture = tex;
    m.emissiveColor = color;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    m.fogEnabled = false;
    m.transparencyMode = Material.MATERIAL_ALPHABLEND;
    m.alphaMode = Constants.ALPHA_ADD;
    return m;
  }

  private createFlash(
    name: string,
    parent: TransformNode,
    starMat: Material,
    flareMat: Material,
    scale: number,
  ): { group: TransformNode; star: Mesh } {
    const group = new TransformNode(name, this.scene);
    group.parent = parent;
    group.scaling.setAll(scale);

    const star = MeshBuilder.CreatePlane(`${name}Star`, { size: 0.15 }, this.scene);
    star.parent = group;
    star.position.z = 0.015;
    star.material = starMat;
    this.register(star);
    this.glowMeshes.push(star);

    // Two crossed side flares along the barrel axis.
    const flareA = MeshBuilder.CreatePlane(`${name}FlareA`, { width: 0.24, height: 0.075 }, this.scene);
    flareA.parent = group;
    flareA.rotation.y = Math.PI / 2;
    flareA.position.z = 0.1;
    flareA.material = flareMat;
    this.register(flareA);
    this.glowMeshes.push(flareA);

    const crossNode = new TransformNode(`${name}Cross`, this.scene);
    crossNode.parent = group;
    crossNode.rotation.z = Math.PI / 2;
    const flareB = flareA.clone(`${name}FlareB`, crossNode);
    if (flareB) {
      this.register(flareB);
      this.glowMeshes.push(flareB);
    }

    group.setEnabled(false);
    return { group, star };
  }

  private drawStarTexture(): DynamicTexture {
    const size = 128;
    const tex = new DynamicTexture("vmFlashTex", { width: size, height: size }, this.scene, true);
    tex.hasAlpha = false;
    const c = tex.getContext() as unknown as CanvasRenderingContext2D;
    c.fillStyle = "#000";
    c.fillRect(0, 0, size, size);
    c.save();
    c.translate(size / 2, size / 2);
    c.globalCompositeOperation = "lighter";
    const spikes = 7;
    for (let i = 0; i < spikes; i++) {
      c.save();
      c.rotate((i / spikes) * Math.PI * 2 + (Math.random() - 0.5) * 0.4);
      const len = size * (0.36 + Math.random() * 0.12);
      const g = c.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, "rgba(255,240,200,1)");
      g.addColorStop(0.5, "rgba(255,170,80,0.6)");
      g.addColorStop(1, "rgba(255,110,30,0)");
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(0, -size * 0.045);
      c.lineTo(len, 0);
      c.lineTo(0, size * 0.045);
      c.closePath();
      c.fill();
      c.restore();
    }
    const rg = c.createRadialGradient(0, 0, 0, 0, 0, size * 0.3);
    rg.addColorStop(0, "rgba(255,255,245,1)");
    rg.addColorStop(0.35, "rgba(255,200,120,0.85)");
    rg.addColorStop(1, "rgba(255,110,30,0)");
    c.fillStyle = rg;
    c.beginPath();
    c.arc(0, 0, size * 0.3, 0, Math.PI * 2);
    c.fill();
    c.restore();
    tex.update();
    return tex;
  }

  private drawFlareTexture(): DynamicTexture {
    const w = 128;
    const h = 64;
    const tex = new DynamicTexture("vmFlareTex", { width: w, height: h }, this.scene, true);
    tex.hasAlpha = false;
    const c = tex.getContext() as unknown as CanvasRenderingContext2D;
    c.fillStyle = "#000";
    c.fillRect(0, 0, w, h);
    c.save();
    // Plane's -X end sits at the muzzle after rotation; keep the hot end there and taper outwards.
    c.translate(w * 0.5, h / 2);
    c.scale(1, 0.35);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, w * 0.5);
    g.addColorStop(0, "rgba(255,245,220,1)");
    g.addColorStop(0.3, "rgba(255,180,90,0.8)");
    g.addColorStop(1, "rgba(255,100,20,0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, w * 0.5, 0, Math.PI * 2);
    c.fill();
    c.restore();
    tex.update();
    return tex;
  }

  // ---------------------------------------------------------------- triggers

  fireKick(): void {
    this.kPosZ.velocity -= 1.05 + Math.random() * 0.25;
    this.kPosY.velocity += 0.12;
    this.kRotX.velocity -= 6.5 + Math.random() * 1.5;
    this.kRotY.velocity += (Math.random() - 0.5) * 2.4;
    this.kRotZ.velocity += (Math.random() - 0.5) * 3.5;
    this.flashT = 0.05;
    this.accentPulse = 1;
    this.flashStar.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.85 + Math.random() * 0.4;
    this.rifleFlash.scaling.setAll(s);
    this.rifleFlash.rotation.z = (Math.random() - 0.5) * 0.6;
  }

  launcherKick(): void {
    this.kPosZ.velocity -= 2.6;
    this.kPosY.velocity += 0.45;
    this.kRotX.velocity -= 15;
    this.kRotZ.velocity += (Math.random() - 0.5) * 6;
    this.launcherFlashT = 0.06;
    this.launcherStar.rotation.z = Math.random() * Math.PI * 2;
  }

  landKick(impactSpeed: number): void {
    const k = Math.min(impactSpeed, 14);
    this.kPosY.velocity -= k * 0.035;
    this.kRotX.velocity += k * 0.12;
  }

  damageKick(): void {
    this.kRotZ.velocity += (Math.random() - 0.5) * 6;
    this.kPosY.velocity -= 0.3;
  }

  /** Snap the gun fully down (it then rises when lowered becomes false). */
  snapLowered(): void {
    this.lowerBlend = 1;
  }

  /** World-space muzzle position (fresh matrices for this frame). */
  getMuzzleWorldToRef(out: Vector3, launcher = false): Vector3 {
    const node = launcher ? this.launcherMuzzle : this.muzzle;
    this.root.computeWorldMatrix(true);
    node.computeWorldMatrix(true);
    return out.copyFrom(node.getAbsolutePosition());
  }

  // ---------------------------------------------------------------- per frame

  update(s: ViewmodelState): void {
    const dt = s.dt;
    if (dt <= 0) return;
    this.time += dt;
    const t = this.time;

    // Sway: lag behind look velocity.
    const inv = 1 / Math.max(dt, 1 / 240);
    const vYaw = s.lookYaw * inv;
    const vPitch = s.lookPitch * inv;
    this.swayRotY = damp(this.swayRotY, clamp(-vYaw * 0.012, -0.09, 0.09), 11, dt);
    this.swayRotX = damp(this.swayRotX, clamp(-vPitch * 0.012, -0.07, 0.07), 11, dt);
    this.swayPosX = damp(this.swayPosX, clamp(-vYaw * 0.0028, -0.022, 0.022), 9, dt);
    this.swayPosY = damp(this.swayPosY, clamp(vPitch * 0.0028, -0.018, 0.018), 9, dt);

    // Blends
    this.sprintBlend = damp(this.sprintBlend, s.sprintPose ? 1 : 0, 9, dt);
    this.lowerBlend = damp(this.lowerBlend, s.lowered ? 1 : 0, s.lowered ? 5 : 9, dt);
    this.strafeTilt = damp(this.strafeTilt, clamp(-s.strafeSpeed / 9.5, -1, 1) * 0.07, 8, dt);
    this.airBlend = damp(this.airBlend, s.grounded ? 0 : 1, 6, dt);
    this.accentPulse = damp(this.accentPulse, 0, 14, dt);

    // Bob (figure-eight), stronger when sprinting.
    const theta = s.stepPhase * Math.PI;
    const amt = Math.min(s.bobAmount, 1.3) * (1 + this.sprintBlend * 0.8);
    const bobX = Math.sin(theta) * 0.011 * amt;
    const bobY = -Math.cos(2 * theta) * 0.0065 * amt;
    const bobRZ = Math.sin(theta) * 0.022 * amt;
    const bobRX = Math.cos(2 * theta) * 0.012 * amt;

    // Idle breathing
    const breathY = Math.sin(t * 1.7) * 0.0022;
    const breathRX = Math.sin(t * 1.1) * 0.004;

    // Springs
    const kpx = this.kPosX.update(dt);
    const kpy = this.kPosY.update(dt);
    const kpz = this.kPosZ.update(dt);
    const krx = this.kRotX.update(dt);
    const kry = this.kRotY.update(dt);
    const krz = this.kRotZ.update(dt);

    // Reload: dip + tilt, magazine out and back in.
    let rPosY = 0;
    let rPosZ = 0;
    let rRotX = 0;
    let rRotY = 0;
    let rRotZ = 0;
    let magY = 0;
    let magZ = 0;
    let magRX = 0;
    const p = s.reloadProgress;
    if (p >= 0) {
      const env = p < 0.2 ? easeOutCubic(p / 0.2) : p > 0.8 ? 1 - smoothstep((p - 0.8) / 0.2) : 1;
      rPosY = -0.055 * env;
      rPosZ = -0.03 * env;
      rRotX = 0.3 * env;
      rRotY = 0.18 * env;
      rRotZ = 0.6 * env;
      if (p >= 0.15 && p < 0.35) {
        const k = easeInCubic((p - 0.15) / 0.2);
        magY = -0.32 * k;
        magZ = -0.02 * k;
        magRX = 0.4 * k;
      } else if (p >= 0.35 && p < 0.45) {
        magY = -0.32;
        magZ = -0.02;
        magRX = 0.4;
      } else if (p >= 0.45 && p < 0.62) {
        const k = 1 - easeOutCubic((p - 0.45) / 0.17);
        magY = -0.32 * k;
        magZ = -0.02 * k;
        magRX = 0.4 * k;
      }
      // Mag seats: a little slap.
      if (this.lastReload < 0.62 && p >= 0.62) {
        this.kPosY.velocity += 0.5;
        this.kRotX.velocity -= 3;
        this.kRotZ.velocity -= 2;
      }
    }
    this.lastReload = p;
    this.magPivot.position.set(0, -0.05 + magY, 0.065 + magZ);
    this.magPivot.rotation.x = magRX;

    // Sprint pose and lowered (death / pre-start)
    const sb = this.sprintBlend;
    const lb = smoothstep(this.lowerBlend);

    const root = this.root;
    root.position.set(
      BASE_POS.x + this.swayPosX + bobX + kpx - 0.035 * sb,
      BASE_POS.y + this.swayPosY + bobY + breathY + kpy + rPosY - 0.03 * sb - 0.4 * lb + 0.01 * this.airBlend,
      BASE_POS.z + kpz + rPosZ - 0.03 * sb,
    );
    root.rotation.set(
      BASE_ROT.x + this.swayRotX + bobRX + breathRX + krx + rRotX + 0.2 * sb + 0.7 * lb - 0.04 * this.airBlend,
      BASE_ROT.y + this.swayRotY + kry + rRotY - 0.45 * sb,
      BASE_ROT.z + bobRZ + krz + rRotZ + this.strafeTilt + 0.3 * sb,
    );

    // Flashes
    this.flashT -= dt;
    this.launcherFlashT -= dt;
    this.rifleFlash.setEnabled(this.flashT > 0);
    this.launcherFlash.setEnabled(this.launcherFlashT > 0);

    // Accent strip: cyan, shifts red when low, pulses on shots, "charges" during reload.
    const low = clamp((0.3 - s.ammoFraction) / 0.3, 0, 1);
    let intensity = 0.75 + this.accentPulse * 1.4;
    if (p >= 0) {
      intensity = 0.25 + 0.9 * p + 0.25 * Math.sin(t * 30) * (1 - p);
    } else if (low > 0) {
      intensity *= 0.8 + 0.35 * Math.sin(t * 10);
    }
    const ac = this.accentMat.emissiveColor;
    const lowMix = p >= 0 ? 0 : low;
    ac.r = (ACCENT_BASE.r + (ACCENT_LOW.r - ACCENT_BASE.r) * lowMix) * intensity;
    ac.g = (ACCENT_BASE.g + (ACCENT_LOW.g - ACCENT_BASE.g) * lowMix) * intensity;
    ac.b = (ACCENT_BASE.b + (ACCENT_LOW.b - ACCENT_BASE.b) * lowMix) * intensity;

    // Launcher pips
    for (let i = 0; i < this.pips.length; i++) {
      const pip = this.pips[i]!;
      const want = i < s.charges ? this.pipOn : i === s.charges && s.charges < s.maxCharges ? this.pipCharging : this.pipOff;
      if (pip.material !== want) pip.material = want;
    }
    const pc = this.pipCharging.emissiveColor;
    const ck = 0.08 + 0.45 * s.rechargeProgress;
    pc.set(PIP_ON.r * ck, PIP_ON.g * ck, PIP_ON.b * ck);
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    this.root.dispose();
  }
}
