import { Vector3 } from "@babylonjs/core";
import type { GameContext } from "../core/context";
import { clamp, el, Flag, fmt, q, Txt } from "./dom";

export interface Hud {
  /** Per-frame cosmetic update (crosshair recovery, damage indicators). */
  frame(dt: number): void;
  /** Short message near the bottom of the screen. */
  toast(message: string, ms?: number): void;
}

const DEG = Math.PI / 180;
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);
const SMOOTH = "cubic-bezier(.2,.8,.2,1)";

/** Mirrors the rifle spread model in DESIGN.md so the crosshair shows the real cone. */
const SPREAD_BASE = 0.4;
const SPREAD_PER_SHOT = 0.3;
const SPREAD_MAX = 2.5;
const SPREAD_RECOVERY = 8;
const RELOAD_SECONDS = 1.6;

const DMG_SVG =
  '<svg viewBox="-100 -100 200 200" aria-hidden="true">' +
  '<path d="M -31.5 -77.9 A 84 84 0 0 1 31.5 -77.9"/>' +
  '<path class="ss-chev" d="M -9 -88 L 0 -97 L 9 -88"/>' +
  "</svg>";

interface DamageIndicator {
  el: HTMLElement;
  from: Vector3;
  age: number;
  strength: number;
  active: boolean;
  lastDeg: number;
  lastOpacity: number;
}
const DMG_LIFE = 1.5;

interface Pip {
  el: HTMLElement;
  fill: HTMLElement;
  full: Flag;
  last: number;
}

export function createHud(ctx: GameContext, root: HTMLElement): Hud {
  const ev = ctx.events;
  const hud = el("div", "ss-hud", root);
  hud.innerHTML = `
    <div class="ss-full ss-lowhp"></div>
    <div class="ss-full ss-dmgflash"></div>
    <div class="ss-full ss-dmgdirs"></div>
    <div class="ss-cross"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="d"></i></div>
    <div class="ss-hit"><i></i><i></i><i></i><i></i></div>
    <div class="ss-full ss-popups"></div>
    <div class="ss-top">
      <div class="ss-top-block"><span class="ss-label">Wave</span><span class="ss-top-val ss-wave">–</span></div>
      <div class="ss-top-sep"></div>
      <div class="ss-top-block is-score"><span class="ss-label">Score</span><span class="ss-top-val ss-score">0</span></div>
    </div>
    <div class="ss-banner"><div class="ss-banner-title"></div><div class="ss-hazard"></div><div class="ss-banner-sub"></div></div>
    <div class="ss-health">
      <span class="ss-label">Health</span>
      <div class="ss-health-row">
        <span class="ss-health-num">100</span>
        <div class="ss-bar"><div class="ss-bar-trail"></div><div class="ss-bar-fill"></div><div class="ss-bar-ticks"></div></div>
      </div>
    </div>
    <div class="ss-weapon">
      <div class="ss-launcher"><span class="ss-label">Kinetic</span><span class="ss-key is-sm">RMB</span><div class="ss-pips"></div></div>
      <span class="ss-label">Pulse rifle</span>
      <div class="ss-ammo"><span class="ss-ammo-cur">30</span><span class="ss-ammo-sep">/</span><span class="ss-ammo-max">30</span></div>
      <div class="ss-reload"><div class="ss-reload-fill"></div></div>
      <div class="ss-label ss-ammo-status"></div>
    </div>
    <div class="ss-toast"></div>
  `;

  // Viewport size, cached (no layout reads per frame).
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  window.addEventListener("resize", () => {
    vw = window.innerWidth;
    vh = window.innerHeight;
  });

  // Camera basis, refreshed on demand.
  const camPos = new Vector3();
  const camRight = new Vector3();
  const camFwd = new Vector3();
  const tmp = new Vector3();
  const readCamera = (): void => {
    const m = ctx.camera.getWorldMatrix();
    m.getTranslationToRef(camPos);
    Vector3.TransformNormalToRef(AXIS_X, m, camRight);
    Vector3.TransformNormalToRef(AXIS_Z, m, camFwd);
  };

  // ------------------------------------------------------------ crosshair
  const cross = q(hud, ".ss-cross");
  let spread = SPREAD_BASE;
  let kick = 0;
  let move = 0;
  let lastGap = -1;

  ev.on("weapon:fire", ({ weapon }) => {
    if (weapon === "rifle") spread = Math.min(SPREAD_MAX, spread + SPREAD_PER_SHOT);
    else kick = Math.min(kick + 2.4, 5);
  });

  function updateCrosshair(dt: number): void {
    spread = Math.max(SPREAD_BASE, spread - SPREAD_RECOVERY * dt);
    kick *= Math.exp(-dt * 9);
    const vel = ctx.player?.getVelocity?.();
    let target = 0;
    if (vel) {
      target = clamp((Math.hypot(vel.x, vel.z) - 2) / 4, 0, 1);
      if (Math.abs(vel.y) > 1.2) target = 1;
    }
    move += (target - move) * Math.min(1, dt * 10);
    const deg = spread + move + kick;
    const tanHalf = Math.tan((ctx.camera.fov || 1.2) / 2);
    const gap = Math.round(3 + (Math.tan(deg * DEG) / tanHalf) * (vh / 2));
    if (gap !== lastGap) {
      lastGap = gap;
      cross.style.setProperty("--gap", `${gap}px`);
    }
  }

  // ------------------------------------------------------------ hitmarker
  const hit = q(hud, ".ss-hit");
  const hitKill = new Flag(hit, "is-kill");
  let hitAnim: Animation | null = null;
  let killMarkerUntil = 0;

  ev.on("hit", ({ kind, killed }) => {
    if (kind !== "enemy" && kind !== "barrel") return;
    const now = performance.now();
    if (!killed && now < killMarkerUntil) return; // let the kill marker finish its pop
    hitKill.set(killed);
    hitAnim?.cancel();
    if (killed) {
      killMarkerUntil = now + 180;
      hitAnim = hit.animate(
        [
          { opacity: 1, transform: "scale(1.8)", easing: SMOOTH },
          { opacity: 1, transform: "scale(1)", offset: 0.25 },
          { opacity: 0, transform: "scale(1.1)" },
        ],
        { duration: 440 },
      );
    } else {
      hitAnim = hit.animate(
        [
          { opacity: 1, transform: "scale(1.3)", easing: SMOOTH },
          { opacity: 1, transform: "scale(1)", offset: 0.3 },
          { opacity: 0, transform: "scale(1)" },
        ],
        { duration: 230 },
      );
    }
  });

  // ------------------------------------------------------------ health
  const healthEl = q(hud, ".ss-health");
  const healthNum = new Txt(q(hud, ".ss-health-num"));
  const barFill = q(hud, ".ss-bar-fill");
  const barTrail = q(hud, ".ss-bar-trail");
  const warn = new Flag(healthEl, "is-warn");
  const crit = new Flag(healthEl, "is-crit");
  const lowhp = q(hud, ".ss-lowhp");
  const lowOn = new Flag(lowhp, "is-on");
  let barKey = -1;
  let lowKey = -1;
  let trailInstant = false;

  function setHealth(health: number, maxHealth: number, damaged: boolean): void {
    const h = Math.max(0, health);
    const frac = clamp(h / (maxHealth || 100), 0, 1);
    healthNum.set(String(Math.ceil(h)));
    const key = Math.round(frac * 400);
    // Damage: the trail lags behind the fill (CSS delay). Heal: trail snaps, hidden under the fill.
    if (damaged === trailInstant) {
      trailInstant = !damaged;
      barTrail.style.transition = damaged ? "" : "none";
    }
    if (key !== barKey) {
      barKey = key;
      const s = `scaleX(${key / 400})`;
      barFill.style.transform = s;
      barTrail.style.transform = s;
    }
    warn.set(h > 30 && h <= 60);
    crit.set(h <= 30);
    const low = h > 0 && h < 30;
    lowOn.set(low);
    if (low) {
      const k = Math.round((0.55 + 0.45 * (1 - h / 30)) * 20);
      if (k !== lowKey) {
        lowKey = k;
        lowhp.style.setProperty("--ss-low", String(k / 20));
      }
    }
  }
  setHealth(ctx.player?.health ?? 100, ctx.player?.maxHealth ?? 100, false);

  // ------------------------------------------------------------ damage feedback
  const flashEl = q(hud, ".ss-dmgflash");
  let flashAnim: Animation | null = null;
  const dirs = q(hud, ".ss-dmgdirs");
  const indicators: DamageIndicator[] = [];
  for (let i = 0; i < 4; i++) {
    const e = el("div", "ss-dmgind", dirs);
    e.innerHTML = DMG_SVG;
    indicators.push({ el: e, from: new Vector3(), age: 0, strength: 1, active: false, lastDeg: NaN, lastOpacity: 0 });
  }

  function indicate(from: Vector3, amount: number): void {
    let ind = indicators.find((d) => d.active && Vector3.DistanceSquared(d.from, from) < 4);
    if (!ind) ind = indicators.find((d) => !d.active);
    if (!ind) ind = indicators.reduce((a, b) => (a.age > b.age ? a : b));
    ind.from.copyFrom(from);
    ind.age = 0;
    ind.active = true;
    ind.strength = clamp(0.6 + amount / 25, 0.6, 1);
    readCamera();
    updateIndicator(ind);
  }

  function updateIndicator(ind: DamageIndicator): void {
    // Angle of the source around the player, relative to camera yaw (0 = straight ahead, + = right).
    ind.from.subtractToRef(camPos, tmp);
    const dx = tmp.x;
    const dz = tmp.z;
    if (dx * dx + dz * dz > 0.16) {
      let rx = camRight.x;
      let rz = camRight.z;
      let fx = camFwd.x;
      let fz = camFwd.z;
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl;
      rz /= rl;
      const fl = Math.hypot(fx, fz);
      if (fl < 0.1) {
        // Looking straight up/down: derive horizontal forward from right (left-handed, Y up).
        fx = -rz;
        fz = rx;
      } else {
        fx /= fl;
        fz /= fl;
      }
      const deg = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) / DEG;
      const diff = Math.abs((((deg - ind.lastDeg) % 360) + 540) % 360 - 180);
      if (!(diff < 0.5)) {
        ind.lastDeg = deg;
        ind.el.style.transform = `translate(-50%, -50%) rotate(${deg.toFixed(1)}deg)`;
      }
    }
    const a = ind.age;
    const fade = a < 0.06 ? a / 0.06 : a > DMG_LIFE - 0.6 ? (DMG_LIFE - a) / 0.6 : 1;
    const op = clamp(fade, 0, 1) * ind.strength;
    if (Math.abs(op - ind.lastOpacity) > 0.02 || (op === 0 && ind.lastOpacity !== 0)) {
      ind.lastOpacity = op;
      ind.el.style.opacity = op.toFixed(2);
    }
  }

  function updateIndicators(dt: number): void {
    let cameraRead = false;
    for (const ind of indicators) {
      if (!ind.active) continue;
      ind.age += dt;
      if (ind.age >= DMG_LIFE) {
        ind.active = false;
        ind.lastOpacity = 0;
        ind.el.style.opacity = "0";
        continue;
      }
      if (!cameraRead) {
        readCamera();
        cameraRead = true;
      }
      updateIndicator(ind);
    }
  }

  ev.on("player:damaged", ({ amount, health, maxHealth, from }) => {
    setHealth(health, maxHealth, true);
    const peak = clamp(0.35 + amount / 30, 0.35, 0.95);
    flashAnim?.cancel();
    flashAnim = flashEl.animate([{ opacity: peak }, { opacity: 0 }], { duration: 520, easing: "ease-out" });
    if (from) indicate(from, amount);
  });
  ev.on("player:healed", ({ health, maxHealth }) => setHealth(health, maxHealth, false));

  // ------------------------------------------------------------ ammo + reload
  const ammoBox = q(hud, ".ss-ammo");
  const ammoCurEl = q(hud, ".ss-ammo-cur");
  const ammoCur = new Txt(ammoCurEl);
  const ammoMax = new Txt(q(hud, ".ss-ammo-max"));
  const ammoLow = new Flag(ammoBox, "is-low");
  const ammoEmpty = new Flag(ammoBox, "is-empty");
  const reloadBar = q(hud, ".ss-reload");
  const reloadOn = new Flag(reloadBar, "is-active");
  const reloadFill = q(hud, ".ss-reload-fill");
  const statusEl = q(hud, ".ss-ammo-status");
  const status = new Txt(statusEl);
  const statusAlert = new Flag(statusEl, "is-alert");
  let reloadAnim: Animation | null = null;
  let ammo = 30;
  let mag = 30;
  let reloading = false;

  function renderAmmo(): void {
    ammoCur.set(String(ammo));
    ammoMax.set(String(mag));
    const low = ammo > 0 && ammo <= Math.ceil(mag * 0.25);
    ammoEmpty.set(ammo === 0);
    ammoLow.set(low);
    if (reloading) {
      status.set("Reloading");
      statusAlert.set(false);
    } else if (ammo === 0) {
      status.set("Press R to reload");
      statusAlert.set(true);
    } else if (low) {
      status.set("Low ammo");
      statusAlert.set(false);
    } else {
      status.set("");
      statusAlert.set(false);
    }
  }

  function startReload(): void {
    if (reloading) return;
    reloading = true;
    reloadOn.set(true);
    reloadAnim?.cancel();
    reloadAnim = reloadFill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: RELOAD_SECONDS * 1000,
      easing: "linear",
      fill: "forwards",
    });
    renderAmmo();
  }

  function endReload(): void {
    if (!reloading) return;
    reloading = false;
    reloadOn.set(false); // the bar fades out while still showing full
  }

  ev.on("weapon:reload", ({ weapon }) => {
    if (weapon === "rifle") startReload();
  });
  ev.on("ammo:changed", (p) => {
    ammo = p.ammo;
    mag = p.magSize;
    if (p.reloading) startReload();
    else endReload();
    renderAmmo();
  });

  let emptyAnimAt = 0;
  ev.on("weapon:empty", ({ weapon }) => {
    const now = performance.now();
    if (now - emptyAnimAt < 200) return;
    emptyAnimAt = now;
    if (weapon === "rifle") {
      ammoCurEl.animate(
        [{ transform: "translateX(-4px)", color: "#ff4a3d" }, { transform: "translateX(4px)", offset: 0.35 }, { transform: "none" }],
        { duration: 240, easing: "ease-out" },
      );
    } else {
      pipsEl.animate([{ transform: "translateX(-4px)" }, { transform: "translateX(4px)", offset: 0.35 }, { transform: "none" }], {
        duration: 240,
        easing: "ease-out",
      });
    }
  });

  // ------------------------------------------------------------ launcher charges
  const pipsEl = q(hud, ".ss-pips");
  let pips: Pip[] = [];
  let prevCharges = -1;

  function buildPips(n: number): void {
    pipsEl.textContent = "";
    pips = [];
    for (let i = 0; i < n; i++) {
      const p = el("div", "ss-pip", pipsEl);
      const fill = el("div", "ss-pip-fill", p);
      pips.push({ el: p, fill, full: new Flag(p, "is-full"), last: -1 });
    }
  }

  function setLauncher(charges: number, maxCharges: number, progress: number): void {
    if (maxCharges !== pips.length) buildPips(Math.max(0, Math.min(8, maxCharges)));
    pips.forEach((pip, i) => {
      const v = i < charges ? 1 : i === charges ? clamp(progress, 0, 1) : 0;
      const key = Math.round(v * 100);
      if (key !== pip.last) {
        pip.last = key;
        pip.fill.style.transform = `scaleX(${key / 100})`;
      }
      pip.full.set(i < charges);
    });
    if (prevCharges >= 0 && charges > prevCharges) {
      pips[charges - 1]?.el.animate(
        [{ transform: "skewX(-20deg) scaleY(1.7)", filter: "brightness(1.8)" }, { transform: "skewX(-20deg)", filter: "none" }],
        { duration: 320, easing: "ease-out" },
      );
    }
    prevCharges = charges;
  }
  setLauncher(3, 3, 0);
  ev.on("launcher:changed", ({ charges, maxCharges, rechargeProgress }) => setLauncher(charges, maxCharges, rechargeProgress));

  // ------------------------------------------------------------ wave + score
  const waveEl = q(hud, ".ss-wave");
  const scoreEl = q(hud, ".ss-score");
  const waveTxt = new Txt(waveEl);
  const scoreTxt = new Txt(scoreEl);
  const bumps = new Map<HTMLElement, Animation>();
  const bump = (e: HTMLElement): void => {
    bumps.get(e)?.cancel();
    bumps.set(
      e,
      e.animate([{ transform: "scale(1.22)", color: "#ffb547" }, { transform: "scale(1)" }], { duration: 340, easing: SMOOTH }),
    );
  };
  if (ctx.state.wave > 0) waveTxt.set(String(ctx.state.wave));
  scoreTxt.set(fmt(ctx.state.score));

  ev.on("score:changed", ({ score }) => {
    if (scoreTxt.set(fmt(score))) bump(scoreEl);
  });

  // ------------------------------------------------------------ banners
  const bannerEl = q(hud, ".ss-banner");
  const bannerTitle = q(hud, ".ss-banner-title");
  const bannerSub = q(hud, ".ss-banner-sub");
  const bannerRule = q(hud, ".ss-banner .ss-hazard");
  const bannerClear = new Flag(bannerEl, "is-clear");
  let bannerAnim: Animation | null = null;
  let ruleAnim: Animation | null = null;

  function banner(title: string, sub: string, clear: boolean): void {
    bannerTitle.textContent = title;
    bannerSub.textContent = sub;
    bannerClear.set(clear);
    bannerAnim?.cancel();
    ruleAnim?.cancel();
    const T = "translate(-50%, -50%)";
    bannerAnim = bannerEl.animate(
      [
        { opacity: 0, transform: `${T} scale(1.35)`, easing: SMOOTH },
        { opacity: 1, transform: `${T} scale(1)`, offset: 0.1 },
        { opacity: 1, transform: `${T} scale(1)`, offset: 0.84, easing: "ease-in" },
        { opacity: 0, transform: `${T} translateY(-16px) scale(0.98)` },
      ],
      { duration: 2900 },
    );
    ruleAnim = bannerRule.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: 650,
      delay: 140,
      easing: SMOOTH,
      fill: "backwards",
    });
  }

  ev.on("wave:start", ({ wave, enemies }) => {
    if (waveTxt.set(String(wave))) bump(waveEl);
    banner(`WAVE ${wave}`, enemies > 0 ? `${enemies} hostiles inbound` : "Hostiles inbound", false);
  });
  ev.on("wave:cleared", ({ bonus }) => {
    banner("WAVE CLEARED", `+${fmt(bonus)}`, true);
  });

  // ------------------------------------------------------------ score popups
  const popLayer = q(hud, ".ss-popups");
  const popups: { el: HTMLElement; anim: Animation | null }[] = [];
  for (let i = 0; i < 10; i++) popups.push({ el: el("div", "ss-popup", popLayer), anim: null });
  let popIndex = 0;
  let stackT = 0;
  let stack = 0;

  ev.on("enemy:killed", ({ position, points }) => {
    const pop = popups[popIndex++ % popups.length];
    pop.anim?.cancel();
    pop.el.textContent = `+${fmt(points)}`;
    pop.el.className = points >= 400 ? "ss-popup is-big" : "ss-popup";

    // Float the number up from where the drone died; fall back next to the crosshair.
    let x = 0;
    let y = 0;
    let onScreen = false;
    readCamera();
    position.subtractToRef(camPos, tmp);
    if (Vector3.Dot(tmp, camFwd) > 0.5) {
      Vector3.TransformCoordinatesToRef(position, ctx.camera.getTransformationMatrix(), tmp);
      x = (tmp.x + 1) * 0.5 * vw;
      y = (1 - tmp.y) * 0.5 * vh - 24;
      onScreen = x > 0 && x < vw && y > 0 && y < vh;
    }
    if (!onScreen) {
      const now = performance.now();
      stack = now - stackT < 700 ? (stack + 1) % 4 : 0;
      stackT = now;
      x = vw / 2 + 70;
      y = vh / 2 - 36 - stack * 30;
    }
    x = clamp(x, 40, vw - 40);
    y = clamp(y, 70, vh - 70);
    const at = (dy: number, s: number) => `translate(${x.toFixed(0)}px, ${(y + dy).toFixed(0)}px) translate(-50%, -50%) scale(${s})`;
    pop.anim = pop.el.animate(
      [
        { opacity: 0, transform: at(0, 0.6), easing: SMOOTH },
        { opacity: 1, transform: at(-8, 1.15), offset: 0.14 },
        { opacity: 1, transform: at(-34, 1), offset: 0.62, easing: "ease-in" },
        { opacity: 0, transform: at(-58, 0.95) },
      ],
      { duration: 1150 },
    );
  });

  // ------------------------------------------------------------ toast
  const toastEl = q(hud, ".ss-toast");
  let toastAnim: Animation | null = null;

  return {
    frame(dt: number): void {
      updateIndicators(dt);
      if (ctx.state.phase === "playing") updateCrosshair(dt);
    },
    toast(message: string, ms = 4200): void {
      toastEl.textContent = message;
      toastAnim?.cancel();
      const T = "translateX(-50%)";
      toastAnim = toastEl.animate(
        [
          { opacity: 0, transform: `${T} translateY(8px)` },
          { opacity: 1, transform: T, offset: 0.07 },
          { opacity: 1, transform: T, offset: 0.9 },
          { opacity: 0, transform: T },
        ],
        { duration: ms },
      );
    },
  };
}
