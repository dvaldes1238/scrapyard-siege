import type { SoundId } from "../core/context";
import type { Voice } from "./voice";

/** How a sound is synthesized and mixed. */
export interface Recipe {
  /** Base level (before the per-call volume and distance attenuation). */
  gain: number;
  /** Voice-stealing priority: higher survives when the voice cap is hit. */
  priority: number;
  /** Reverb send level (0 = dry). */
  reverb: number;
  /** Random pitch variation, ± fraction (keeps repeated sounds from fatiguing). */
  jitter?: number;
  /** Positional: full volume within this distance (m). */
  refDistance?: number;
  /** Positional: how quickly volume falls off past refDistance. */
  rolloff?: number;
  build(v: Voice): void;
}

// ---------------------------------------------------------------- shared layers

/** Short metallic click: bright noise snap + a few inharmonic partials. `f` scales its pitch. */
function metalClick(v: Voice, t: number, f: number, amp: number): void {
  v.route(v.noise("white", t, t + 0.04), v.filter("highpass", 2200 * f), v.perc(0.7 * amp, t, 0.0005, 0.03));
  const partials: [number, number, number][] = [
    [2350, 0.16, 0.08],
    [3720, 0.12, 0.06],
    [5810, 0.07, 0.045],
  ];
  for (const [hz, a, d] of partials) {
    v.route(v.osc("sine", hz * f, t, t + d + 0.01), v.perc(a * amp, t, 0.0005, d));
  }
  v.route(v.osc("triangle", 420 * f, t, t + 0.05), v.perc(0.3 * amp, t, 0.0005, 0.04));
}

/** Gravel crunch: a cluster of tiny band-passed noise grains. */
function gravel(v: Voice, t: number, amp: number, count: number): void {
  const g = v.gain(0);
  v.grains(g, t, t + 0.075, count, 1.4 * amp, 0.004, 1);
  v.route(v.noise("white", t, t + 0.11), v.filter("bandpass", 1300 + Math.random() * 1500, 0.8), g);
}

/** Bell-ish ding: sine fundamental with a couple of quiet overtones. */
function ding(v: Voice, f: number, t: number, a: number, d: number): void {
  v.route(v.osc("sine", f, t, t + d + 0.02), v.perc(a, t, 0.002, d));
  v.route(v.osc("sine", f * 2.01, t, t + d * 0.5 + 0.02), v.perc(a * 0.22, t, 0.002, d * 0.5));
  v.route(v.osc("triangle", f * 3, t, t + d * 0.3 + 0.02), v.perc(a * 0.06, t, 0.002, d * 0.3));
}

// ---------------------------------------------------------------- recipes

export const RECIPES: Record<SoundId, Recipe> = {
  rifle: {
    gain: 0.42,
    priority: 5,
    reverb: 0.18,
    jitter: 0.045,
    build(v) {
      const t = v.t;
      // Crack: bright, very short band-passed noise.
      v.route(v.noise("white", t, t + 0.07), v.filter("highpass", 1500), v.filter("bandpass", 3400, 0.8), v.perc(1.6, t, 0.0008, 0.05));
      // Body.
      v.route(v.noise("white", t, t + 0.12), v.filter("lowpass", 1300, 0.9), v.perc(1.4, t, 0.001, 0.09));
      // Low thump: fast pitch drop.
      const th = v.osc("sine", 165, t, t + 0.13);
      v.sweep(th.frequency, 165, 48, t, t + 0.075);
      v.route(th, v.perc(0.7, t, 0.001, 0.11));
      // Pulse "zap": the energy-weapon signature.
      const z = v.osc("square", 1250, t, t + 0.07);
      v.sweep(z.frequency, 1250, 280, t, t + 0.055);
      v.route(z, v.filter("lowpass", 2600), v.perc(0.1, t, 0.0005, 0.05));
      // Short air tail.
      v.route(v.noise("pink", t + 0.01, t + 0.22), v.filter("bandpass", 650, 1.1), v.perc(0.18, t + 0.01, 0.01, 0.18));
    },
  },

  launcher: {
    gain: 0.6,
    priority: 6,
    reverb: 0.22,
    jitter: 0.03,
    build(v) {
      const t = v.t;
      // Deep "thoomp".
      const o = v.osc("sine", 120, t, t + 0.45);
      v.sweep(o.frequency, 120, 36, t, t + 0.26);
      v.route(o, v.perc(1.1, t, 0.004, 0.36));
      const tri = v.osc("triangle", 240, t, t + 0.2);
      v.sweep(tri.frequency, 240, 80, t, t + 0.14);
      v.route(tri, v.filter("lowpass", 700), v.perc(0.35, t, 0.002, 0.16));
      // Air puff + tube resonance.
      v.route(v.noise("brown", t, t + 0.25), v.filter("lowpass", 900), v.perc(0.9, t, 0.003, 0.2));
      v.route(v.noise("white", t, t + 0.12), v.filter("bandpass", 320, 4), v.perc(3.0, t, 0.002, 0.1));
      // Mechanism clack, then a re-chamber tick.
      v.route(v.noise("white", t, t + 0.04), v.filter("bandpass", 2200, 1.2), v.perc(0.35, t, 0.0005, 0.025));
      v.route(v.noise("white", t + 0.13, t + 0.16), v.filter("highpass", 3000), v.perc(0.18, t + 0.13, 0.0005, 0.02));
    },
  },

  explosion: {
    gain: 0.85,
    priority: 7,
    reverb: 0.4,
    jitter: 0.08,
    refDistance: 10,
    rolloff: 0.45,
    build(v) {
      const t = v.t;
      // Initial crack.
      v.route(v.noise("white", t, t + 0.1), v.filter("highpass", 700), v.perc(0.8, t, 0.001, 0.08));
      // Boom: brown noise through a closing lowpass.
      const lp = v.filter("lowpass", 3000, 0.8);
      v.sweep(lp.frequency, 3000, 180, t, t + 1.0);
      v.route(v.noise("brown", t, t + 1.9), lp, v.perc(2.4, t, 0.004, 1.8));
      // Mid body.
      v.route(v.noise("pink", t, t + 1.0), v.filter("lowpass", 1100), v.perc(0.9, t, 0.006, 0.9));
      // Sub drop.
      const sub = v.osc("sine", 82, t, t + 1.3);
      v.sweep(sub.frequency, 82, 27, t, t + 0.9);
      v.route(sub, v.perc(1.25, t, 0.005, 1.2));
      // Crackle tail: sparse noise grains, denser early.
      const cr = v.gain(0);
      v.grains(cr, t + 0.06, t + 1.6, 34, 1.0, 0.007, 1.8);
      v.route(v.noise("white", t + 0.05, t + 1.7), v.filter("bandpass", 2300, 0.7), cr);
      // Long low rumble.
      v.route(v.noise("brown", t + 0.05, t + 2.4), v.filter("lowpass", 170), v.perc(0.6, t + 0.05, 0.15, 2.2));
    },
  },

  reload: {
    gain: 0.55,
    priority: 6,
    reverb: 0.06,
    build(v) {
      const t = v.t;
      // Click 1: mag release.
      metalClick(v, t + 0.17, 1.0, 0.8);
      // Mag sliding out.
      v.route(v.noise("white", t + 0.26, t + 0.6), v.filter("bandpass", 1500, 2.5), v.ahr(0.5, t + 0.26, 0.05, 0.12, 0.15));
      // Click 2: mag seated (heavier, lower).
      metalClick(v, t + 1.12, 0.78, 1.0);
      const k = v.osc("sine", 190, t + 1.12, t + 1.24);
      v.sweep(k.frequency, 190, 90, t + 1.12, t + 1.2);
      v.route(k, v.perc(0.6, t + 1.12, 0.001, 0.09));
      // Energy cell charge-up whine, ending right as the reload completes (1.6 s).
      const w = v.osc("sine", 520, t + 1.2, t + 1.56);
      v.sweep(w.frequency, 520, 1650, t + 1.2, t + 1.5);
      v.route(w, v.ahr(0.07, t + 1.2, 0.08, 0.18, 0.08));
      v.route(v.noise("white", t + 1.52, t + 1.56), v.filter("highpass", 4000), v.perc(0.2, t + 1.52, 0.0005, 0.02));
    },
  },

  empty: {
    gain: 0.5,
    priority: 4,
    reverb: 0,
    jitter: 0.04,
    build(v) {
      const t = v.t;
      v.route(v.noise("white", t, t + 0.025), v.filter("highpass", 2800), v.perc(0.55, t, 0.0003, 0.016));
      v.route(v.osc("square", 1750, t, t + 0.03), v.filter("bandpass", 1800, 3), v.perc(0.25, t, 0.0003, 0.022));
      v.route(v.osc("triangle", 380, t, t + 0.04), v.perc(0.2, t, 0.0005, 0.03));
    },
  },

  switch: {
    gain: 0.4,
    priority: 3,
    reverb: 0.03,
    build(v) {
      metalClick(v, v.t, 1.2, 0.6);
      metalClick(v, v.t + 0.075, 0.95, 0.5);
    },
  },

  hitmarker: {
    gain: 0.38,
    priority: 6,
    reverb: 0.02,
    jitter: 0.03,
    build(v) {
      const t = v.t;
      v.route(v.osc("triangle", 2350, t, t + 0.06), v.perc(0.5, t, 0.0005, 0.045));
      v.route(v.osc("sine", 3900, t, t + 0.04), v.perc(0.2, t, 0.0005, 0.03));
      v.route(v.noise("white", t, t + 0.015), v.filter("highpass", 5000), v.perc(0.25, t, 0.0003, 0.01));
    },
  },

  kill: {
    gain: 0.5,
    priority: 8,
    reverb: 0.12,
    build(v) {
      const t = v.t;
      // Crunch: saturated band of noise + a short low square.
      v.route(v.noise("white", t, t + 0.08), v.filter("bandpass", 1300, 0.8), v.shaper(), v.filter("lowpass", 3800), v.perc(0.5, t, 0.001, 0.07));
      v.route(v.osc("square", 92, t, t + 0.08), v.filter("lowpass", 700), v.perc(0.35, t, 0.001, 0.06));
      // Two-tone ding (E6 -> B6).
      ding(v, 1318.5, t + 0.012, 0.42, 0.26);
      ding(v, 1975.5, t + 0.085, 0.46, 0.5);
    },
  },

  enemyShot: {
    gain: 0.45,
    priority: 4,
    reverb: 0.15,
    jitter: 0.06,
    refDistance: 5,
    rolloff: 0.55,
    build(v) {
      const t = v.t;
      // Zappy down-sweep with a fast vibrato wobble.
      const s = v.osc("sawtooth", 1500, t, t + 0.24);
      v.sweep(s.frequency, 1500, 170, t, t + 0.2);
      const lfo = v.osc("sine", 42, t, t + 0.24);
      const depth = v.gain(0);
      v.sweep(depth.gain, 300, 30, t, t + 0.2);
      lfo.connect(depth);
      depth.connect(s.frequency);
      v.route(s, v.filter("lowpass", 3800, 1.5), v.perc(0.42, t, 0.002, 0.2));
      const q = v.osc("square", 740, t, t + 0.22);
      v.sweep(q.frequency, 740, 95, t, t + 0.2);
      v.route(q, v.filter("lowpass", 2200), v.perc(0.2, t, 0.002, 0.19));
      v.route(v.noise("white", t, t + 0.04), v.filter("highpass", 3200), v.perc(0.2, t, 0.0005, 0.03));
    },
  },

  enemyHum: {
    gain: 0.35,
    priority: 1,
    reverb: 0.05,
    refDistance: 3,
    rolloff: 0.8,
    build(v) {
      const t = v.t;
      const lp = v.filter("lowpass", 420, 2);
      v.osc("sawtooth", 64, t, t + 0.9).connect(lp);
      v.osc("sawtooth", 65.7, t, t + 0.9).connect(lp);
      v.route(lp, v.ahr(0.3, t, 0.15, 0.4, 0.3));
    },
  },

  playerHurt: {
    gain: 0.6,
    priority: 7,
    reverb: 0.04,
    jitter: 0.08,
    build(v) {
      const t = v.t;
      // Body thud.
      const th = v.osc("sine", 125, t, t + 0.25);
      v.sweep(th.frequency, 125, 48, t, t + 0.14);
      v.route(th, v.perc(1.0, t, 0.002, 0.2));
      v.route(v.noise("brown", t, t + 0.2), v.filter("lowpass", 600), v.perc(0.6, t, 0.002, 0.15));
      // Grunt: buzzy source through two vowel formants ("uh").
      const src = v.osc("sawtooth", 142, t + 0.01, t + 0.3);
      v.sweep(src.frequency, 142, 96, t + 0.01, t + 0.26);
      const env = v.ahr(0.9, t + 0.01, 0.025, 0.06, 0.16);
      const f1 = v.filter("bandpass", 520, 5);
      const f2 = v.filter("bandpass", 1150, 7);
      src.connect(f1);
      src.connect(f2);
      f1.connect(env);
      v.route(f2, env);
      // Breath.
      v.route(v.noise("pink", t + 0.01, t + 0.25), v.filter("bandpass", 700, 3), v.ahr(0.35, t + 0.01, 0.02, 0.05, 0.14));
    },
  },

  jump: {
    gain: 0.45,
    priority: 3,
    reverb: 0.03,
    jitter: 0.08,
    build(v) {
      const t = v.t;
      // Push-off scuff.
      v.route(v.noise("pink", t, t + 0.12), v.filter("bandpass", 1100, 0.9), v.perc(0.8, t, 0.003, 0.08));
      gravel(v, t, 0.6, 5);
      // Cloth / air whoosh.
      const wb = v.filter("bandpass", 380, 1.6);
      v.sweep(wb.frequency, 380, 1300, t, t + 0.2);
      v.route(v.noise("white", t, t + 0.25), wb, v.ahr(0.4, t, 0.05, 0.04, 0.12));
    },
  },

  land: {
    gain: 0.6,
    priority: 4,
    reverb: 0.05,
    jitter: 0.06,
    build(v) {
      const t = v.t;
      const th = v.osc("sine", 100, t, t + 0.25);
      v.sweep(th.frequency, 100, 42, t, t + 0.12);
      v.route(th, v.perc(1.0, t, 0.001, 0.2));
      v.route(v.noise("brown", t, t + 0.2), v.filter("lowpass", 900), v.perc(0.7, t, 0.002, 0.14));
      v.route(v.noise("white", t, t + 0.18), v.filter("lowpass", 2600), v.perc(0.35, t, 0.002, 0.12));
      gravel(v, t, 1, 10);
    },
  },

  footstep: {
    gain: 0.32,
    priority: 2,
    reverb: 0.02,
    jitter: 0.12,
    build(v) {
      const t = v.t;
      gravel(v, t, 1, 6);
      const th = v.osc("sine", 85, t, t + 0.09);
      v.sweep(th.frequency, 85, 55, t, t + 0.07);
      v.route(th, v.perc(0.35, t, 0.002, 0.06));
      v.route(v.noise("pink", t, t + 0.1), v.filter("lowpass", 700), v.perc(0.35, t, 0.003, 0.07));
    },
  },

  waveStart: {
    gain: 0.42,
    priority: 9,
    reverb: 0.3,
    build(v) {
      const t = v.t;
      // Two-tone alarm, each pair a whole tone higher than the last.
      for (let i = 0; i < 6; i++) {
        const semis = Math.floor(i / 2) * 2;
        const f = (i % 2 ? 740 : 554.37) * Math.pow(2, semis / 12);
        const s = t + i * 0.165;
        const o = v.osc("sawtooth", f * 0.97, s, s + 0.17);
        v.sweep(o.frequency, f * 0.97, f, s, s + 0.05);
        const lp = v.filter("lowpass", 2400, 2);
        o.connect(lp);
        v.chain(v.osc("square", f / 2, s, s + 0.17), v.gain(0.4), lp);
        v.route(lp, v.ahr(0.3, s, 0.012, 0.11, 0.035));
      }
    },
  },

  waveClear: {
    gain: 0.5,
    priority: 9,
    reverb: 0.35,
    build(v) {
      const t = v.t;
      // Major arpeggio C5 E5 G5 C6 E6.
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      notes.forEach((f, i) => {
        const s = t + i * 0.085;
        const d = i === notes.length - 1 ? 1.3 : 0.55;
        v.route(v.osc("triangle", f, s, s + d + 0.05), v.perc(0.38, s, 0.004, d));
        v.route(v.osc("sine", f * 2, s, s + d * 0.6 + 0.05), v.perc(0.1, s, 0.004, d * 0.6));
      });
      // Soft pad: C major triad.
      for (const f of [261.63, 329.63, 392.0]) {
        v.route(v.osc("sawtooth", f, t, t + 1.6), v.filter("lowpass", 1400, 0.7), v.ahr(0.06, t, 0.08, 0.6, 0.8));
      }
    },
  },

  gameOver: {
    gain: 0.5,
    priority: 10,
    reverb: 0.4,
    build(v) {
      const t = v.t;
      // Low impact.
      const b = v.osc("sine", 70, t, t + 1.2);
      v.sweep(b.frequency, 70, 30, t, t + 1.0);
      v.route(b, v.perc(0.8, t, 0.01, 1.0));
      // Descending minor line: G4 Eb4 C4 G3, the last note sagging flat.
      const seq: [number, number, number][] = [
        [392.0, 0, 0.4],
        [311.13, 0.36, 0.4],
        [261.63, 0.72, 0.45],
        [196.0, 1.1, 1.6],
      ];
      seq.forEach(([f, at, d], i) => {
        const s = t + at;
        const o = v.osc("sawtooth", f, s, s + d + 0.1);
        const o2 = v.osc("triangle", f * 0.5, s, s + d + 0.1);
        if (i === seq.length - 1) {
          v.sweep(o.frequency, f, f * 0.94, s + 0.3, s + d);
          v.sweep(o2.frequency, f * 0.5, f * 0.47, s + 0.3, s + d);
        }
        const lp = v.filter("lowpass", 1800, 1);
        v.sweep(lp.frequency, 1800, 400, s, s + d);
        o.connect(lp);
        o2.connect(lp);
        v.route(lp, v.ahr(0.3, s, 0.02, d * 0.45, d * 0.55));
      });
    },
  },
};
