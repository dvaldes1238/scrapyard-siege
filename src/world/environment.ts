import {
  CascadedShadowGenerator,
  Color3,
  Color4,
  ColorCurves,
  DefaultRenderingPipeline,
  DirectionalLight,
  GlowLayer,
  HemisphericLight,
  ImageProcessingConfiguration,
  Mesh,
  MeshBuilder,
  ReflectionProbe,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  SSAO2RenderingPipeline,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { SkyMaterial } from "@babylonjs/materials";
import type { GameContext } from "../core/context";
import { markNoHit } from "../core/damage";
import { FILL, FOG, GLOW, POST, PROBE, SHADOWS, SKY, SSAO, SUN } from "./config";
import { horizonColor, skyColor, type Vec3 } from "./skyColor";

export interface Environment {
  sun: DirectionalLight;
  /** CascadedShadowGenerator on WebGL2 (always, in practice). */
  shadows: ShadowGenerator;
  glow: GlowLayer;
  pipeline: DefaultRenderingPipeline;
  skybox: Mesh;
  toSun: Vector3;
  fogColor: Color3;
}

export function createEnvironment(ctx: GameContext): Environment {
  const { scene, camera } = ctx;
  const params = new URLSearchParams(location.search);

  // --- Sun direction -------------------------------------------------------------------------
  const el = (SUN.elevationDeg * Math.PI) / 180;
  const az = new Vector3(SUN.azimuth[0], 0, SUN.azimuth[1]).normalize();
  const toSun = new Vector3(az.x * Math.cos(el), Math.sin(el), az.z * Math.cos(el)).normalize();
  const toSunArr: Vec3 = [toSun.x, toSun.y, toSun.z];

  // --- Lights --------------------------------------------------------------------------------
  const sun = new DirectionalLight("sun", toSun.scale(-1), scene);
  sun.position = toSun.scale(160);
  sun.intensity = SUN.intensity;
  sun.diffuse = SUN.color.clone();
  sun.specular = SUN.color.clone();

  // Hemispheric fill: sky tint from the zenith-ish sky colour, warm bounce from the ground.
  const zen = skyColor([0.2, 0.75, -0.3], toSunArr, SKY);
  const hemi = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
  const hb = FILL.hemiSkyBase;
  hemi.intensity = FILL.hemiIntensity;
  hemi.diffuse = new Color3(hb[0] + zen[0] * 0.5, hb[1] + zen[1] * 0.5, hb[2] + zen[2] * 0.5);
  hemi.groundColor = FILL.hemiGround.clone();
  hemi.specular = Color3.Black();

  // --- Shadows -------------------------------------------------------------------------------
  // Cascaded shadows need WebGL2; fall back to a single PCF map otherwise.
  let shadows: ShadowGenerator;
  if (CascadedShadowGenerator.IsSupported) {
    const csm = new CascadedShadowGenerator(SHADOWS.mapSize, sun);
    csm.numCascades = SHADOWS.cascades;
    csm.lambda = SHADOWS.lambda;
    csm.stabilizeCascades = true;
    csm.shadowMaxZ = SHADOWS.maxZ;
    csm.depthClamp = true;
    csm.cascadeBlendPercentage = SHADOWS.cascadeBlend;
    csm.autoCalcDepthBounds = false;
    shadows = csm;
  } else {
    shadows = new ShadowGenerator(SHADOWS.mapSize, sun);
    sun.autoUpdateExtends = true;
  }
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = SHADOWS.bias;
  shadows.normalBias = SHADOWS.normalBias;
  shadows.darkness = SHADOWS.darkness;

  // --- Sky -----------------------------------------------------------------------------------
  const skybox = MeshBuilder.CreateBox("sky", { size: SKY.boxSize, sideOrientation: Mesh.BACKSIDE }, scene);
  const sky = new SkyMaterial("skyMat", scene);
  sky.backFaceCulling = false;
  sky.useSunPosition = true;
  sky.sunPosition = toSun.scale(SUN.skyDistance);
  sky.luminance = SKY.luminance;
  sky.turbidity = SKY.turbidity;
  sky.rayleigh = SKY.rayleigh;
  sky.mieCoefficient = SKY.mieCoefficient;
  sky.mieDirectionalG = SKY.mieDirectionalG;
  sky.dithering = true;
  skybox.material = sky;
  skybox.infiniteDistance = true;
  skybox.applyFog = false;
  skybox.receiveShadows = false;
  markNoHit(skybox);

  // --- Fog matched to the horizon haze (computed from the same sky model) --------------------
  const h = horizonColor(toSunArr, SKY, FOG.horizonElevationDeg);
  const ft = FOG.tint;
  const fogColor = new Color3(Math.min(1, h[0] * ft[0]), Math.min(1, h[1] * ft[1]), Math.min(1, h[2] * ft[2]));
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = FOG.density;
  scene.fogColor = fogColor;
  scene.clearColor = new Color4(fogColor.r, fogColor.g, fogColor.b, 1);

  // --- Image-based lighting from a one-off capture of the sky ---------------------------------
  // The probe renders every frame until the sky shader is compiled and has been captured for a
  // few frames, then is frozen and assigned as the environment (no downloaded .env files).
  const probe = new ReflectionProbe("skyProbe", PROBE.size, scene, true, true, true);
  // A dim, probe-only ground disc so the lower hemisphere of the IBL is ground bounce rather
  // than bright horizon haze. Its layer mask hides it from the camera; the probe renders its
  // explicit renderList regardless of layer masks.
  const probeGround = MeshBuilder.CreateDisc("probeGround", { radius: 220, tessellation: 24, sideOrientation: Mesh.DOUBLESIDE }, scene);
  probeGround.rotation.x = Math.PI / 2;
  probeGround.position.y = -1.5;
  probeGround.layerMask = 0x10000000;
  const pgMat = new StandardMaterial("probeGroundMat", scene);
  pgMat.disableLighting = true;
  pgMat.emissiveColor = PROBE.groundColor.clone();
  pgMat.diffuseColor = Color3.Black();
  pgMat.specularColor = Color3.Black();
  probeGround.material = pgMat;
  markNoHit(probeGround);
  probe.renderList!.push(skybox, probeGround);
  probe.refreshRate = 1;
  scene.environmentIntensity = FILL.envIntensity;
  let readyFrames = 0;
  let waited = 0;
  const probeObs = scene.onBeforeRenderObservable.add(() => {
    probe.position.copyFrom(camera.globalPosition);
    // Safety net: never wait forever for shader compilation.
    if ((skybox.isReady(true) && probeGround.isReady(true)) || ++waited > PROBE.timeoutFrames) readyFrames++;
    if (readyFrames === PROBE.readyFrames) {
      scene.environmentTexture = probe.cubeTexture;
      probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    }
    if (readyFrames > PROBE.readyFrames + 4) {
      probeGround.setEnabled(false);
      scene.onBeforeRenderObservable.remove(probeObs);
    }
  });

  // --- Glow ----------------------------------------------------------------------------------
  const glow = new GlowLayer("glow", scene, { mainTextureRatio: GLOW.textureRatio, blurKernelSize: GLOW.blurKernel });
  glow.intensity = GLOW.intensity;
  glow.addExcludedMesh(skybox);
  glow.addExcludedMesh(probeGround);

  // --- Post ----------------------------------------------------------------------------------
  const pipeline = new DefaultRenderingPipeline("post", true, scene, [camera]);
  pipeline.samples = POST.msaaSamples;
  pipeline.fxaaEnabled = POST.fxaa;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = POST.bloomThreshold;
  pipeline.bloomWeight = POST.bloomWeight;
  pipeline.bloomKernel = POST.bloomKernel;
  pipeline.bloomScale = POST.bloomScale;
  pipeline.imageProcessingEnabled = true;
  pipeline.grainEnabled = POST.grainIntensity > 0;
  pipeline.grain.intensity = POST.grainIntensity;
  pipeline.grain.animated = true;
  pipeline.chromaticAberrationEnabled = POST.chromaticAberration > 0;
  pipeline.chromaticAberration.aberrationAmount = POST.chromaticAberration;
  pipeline.chromaticAberration.radialIntensity = POST.chromaticRadial;

  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = POST.exposure;
  ip.contrast = POST.contrast;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = POST.vignetteWeight;
  ip.vignetteStretch = POST.vignetteStretch;
  ip.vignetteColor = new Color4(POST.vignetteColor[0], POST.vignetteColor[1], POST.vignetteColor[2], 0);
  ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
  ip.ditheringEnabled = true;
  // Gentle golden-hour split tone: warm highlights, cool shadows.
  const curves = new ColorCurves();
  curves.globalHue = POST.curves.globalHue;
  curves.globalDensity = POST.curves.globalDensity;
  curves.highlightsHue = POST.curves.highlightsHue;
  curves.highlightsDensity = POST.curves.highlightsDensity;
  curves.shadowsHue = POST.curves.shadowsHue;
  curves.shadowsDensity = POST.curves.shadowsDensity;
  ip.colorCurves = curves;
  ip.colorCurvesEnabled = true;

  // --- Optional SSAO (?ssao=1) ---------------------------------------------------------------
  if (params.get("ssao") === "1" && SSAO2RenderingPipeline.IsSupported) {
    const ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: SSAO.ratio, blurRatio: SSAO.ratio }, [camera]);
    ssao.radius = SSAO.radius;
    ssao.totalStrength = SSAO.strength;
    ssao.samples = SSAO.samples;
    ssao.maxZ = SSAO.maxZ;
    ssao.expensiveBlur = true;
  }

  return { sun, shadows, glow, pipeline, skybox, toSun, fogColor };
}
