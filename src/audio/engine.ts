import { Vector3, type Camera } from "@babylonjs/core";
import type { SoundId } from "../core/context";
import { RECIPES } from "./sounds";
import { Voice, type NoiseKind, type VoiceKit } from "./voice";

export interface PlayOptions {
  position?: Vector3;
  volume?: number;
  pitch?: number;
}

interface ActiveVoice {
  voice: Voice;
  priority: number;
  start: number;
  end: number;
  /** Nodes owned by the engine for this voice (disconnected on release). */
  nodes: AudioNode[];
  timer: number;
}

const MAX_VOICES = 24;
const MASTER_LEVEL = 0.9;
const REVERB_RETURN = 0.5;

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * WebAudio synth engine: lazy AudioContext, master gain -> compressor -> out,
 * a generated-impulse convolver reverb on a send bus, positional panning and
 * a voice cap with priority-based stealing.
 */
export class AudioEngine {
  private ac: AudioContext | null = null;
  private kit: VoiceKit | null = null;
  private bus: GainNode | null = null;
  private reverbIn: GainNode | null = null;
  private canPan = false;
  private voices: ActiveVoice[] = [];

  private readonly camPos = new Vector3();
  private readonly camRight = new Vector3();
  private readonly camFwd = new Vector3();
  private readonly dir = new Vector3();

  constructor(
    private readonly camera: Camera,
    private readonly muted: boolean,
  ) {}

  /** Create (first call) and resume the AudioContext. Call from a user gesture. */
  unlock(): void {
    if (!this.ac) this.init();
    const ac = this.ac;
    if (!ac) return;
    if (ac.state !== "running") ac.resume().catch(() => {});
    // iOS/Safari: starting any source inside the gesture fully unlocks output.
    try {
      const s = ac.createBufferSource();
      s.buffer = ac.createBuffer(1, 1, ac.sampleRate);
      s.connect(ac.destination);
      s.start();
    } catch {
      /* ignore */
    }
  }

  /** Resume a context the browser suspended (tab switch, interruption). Safe to call often. */
  resumeIfSuspended(): void {
    const ac = this.ac;
    if (ac && ac.state !== "running" && ac.state !== "closed") ac.resume().catch(() => {});
  }

  private init(): void {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    let ac: AudioContext;
    try {
      ac = new Ctor({ latencyHint: "interactive" });
    } catch {
      return;
    }
    this.ac = ac;

    // master gain -> compressor -> speakers
    const master = ac.createGain();
    master.gain.value = this.muted ? 0 : MASTER_LEVEL;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    master.connect(comp);
    comp.connect(ac.destination);

    // Dry bus for all voices.
    const bus = ac.createGain();
    bus.connect(master);
    this.bus = bus;

    // Reverb send: short outdoor slap + diffuse tail, band-limited, low return.
    const reverbIn = ac.createGain();
    const conv = ac.createConvolver();
    conv.buffer = makeImpulse(ac);
    const hp = ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 170;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5200;
    const ret = ac.createGain();
    ret.gain.value = REVERB_RETURN;
    reverbIn.connect(conv);
    conv.connect(hp);
    hp.connect(lp);
    lp.connect(ret);
    ret.connect(master);
    this.reverbIn = reverbIn;

    this.canPan = typeof ac.createStereoPanner === "function";
    this.kit = {
      ac,
      noise: {
        white: makeNoise(ac, "white"),
        pink: makeNoise(ac, "pink"),
        brown: makeNoise(ac, "brown"),
      },
      crushCurve: makeCrushCurve(6),
    };
  }

  play(id: SoundId, opts: PlayOptions = {}): void {
    const ac = this.ac;
    const kit = this.kit;
    if (!ac || !kit || !this.bus || !this.reverbIn) return;
    // Never queue sounds into a suspended context: they would all burst out on resume.
    if (ac.state !== "running") return;
    const recipe = RECIPES[id];
    if (!recipe) return;

    let level = recipe.gain * (opts.volume ?? 1);
    let pan = 0;
    let cutoff = 0;
    if (opts.position) {
      const s = this.spatialize(opts.position, recipe.refDistance ?? 4, recipe.rolloff ?? 0.6);
      level *= s.gain;
      pan = s.pan;
      cutoff = s.cutoff;
    }
    if (!(level > 0.004)) return;

    const now = ac.currentTime;
    if (!this.reserve(now, recipe.priority)) return;

    const jitter = recipe.jitter ?? 0;
    const pitch = Math.max(0.25, (opts.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * jitter));
    const voice = new Voice(kit, now + 0.004, pitch);
    try {
      recipe.build(voice);
    } catch (err) {
      console.warn(`[audio] failed to build "${id}"`, err);
      for (const s of voice.sources) safeStop(s, now);
      return;
    }

    voice.input.gain.value = level;
    const nodes: AudioNode[] = [voice.input];
    let out: AudioNode = voice.input;
    if (cutoff > 0 && cutoff < 16000) {
      const f = ac.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      f.Q.value = 0.5;
      out.connect(f);
      out = f;
      nodes.push(f);
    }
    if (pan !== 0 && this.canPan) {
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      out.connect(p);
      out = p;
      nodes.push(p);
    }
    out.connect(this.bus);
    if (recipe.reverb > 0) {
      const send = ac.createGain();
      send.gain.value = recipe.reverb;
      out.connect(send);
      send.connect(this.reverbIn);
      nodes.push(send);
    }

    const active: ActiveVoice = { voice, priority: recipe.priority, start: now, end: voice.end, nodes, timer: 0 };
    active.timer = window.setTimeout(() => this.release(active), (voice.end - now) * 1000 + 150);
    this.voices.push(active);
  }

  /** Make room for a new voice. Returns false if the new sound should be dropped. */
  private reserve(now: number, priority: number): boolean {
    let live = 0;
    let victim: ActiveVoice | null = null;
    for (const v of this.voices) {
      if (v.end <= now) continue;
      live++;
      if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.start < victim.start)) victim = v;
    }
    if (live < MAX_VOICES) return true;
    if (!victim || victim.priority > priority) return false;
    // Steal: quick fade so it doesn't click, then free it.
    const g = victim.voice.input.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.03);
    for (const s of victim.voice.sources) safeStop(s, now + 0.04);
    victim.end = now;
    window.clearTimeout(victim.timer);
    const stolen = victim;
    stolen.timer = window.setTimeout(() => this.release(stolen), 90);
    return true;
  }

  private release(v: ActiveVoice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Distance attenuation, stereo pan from the camera's right vector, air/behind lowpass. */
  private spatialize(pos: Vector3, ref: number, rolloff: number): { gain: number; pan: number; cutoff: number } {
    const m = this.camera.getWorldMatrix();
    m.getTranslationToRef(this.camPos);
    Vector3.TransformNormalToRef(AXIS_X, m, this.camRight);
    Vector3.TransformNormalToRef(AXIS_Z, m, this.camFwd);
    this.camRight.normalize();
    this.camFwd.normalize();
    pos.subtractToRef(this.camPos, this.dir);
    const d = this.dir.length();
    const gain = ref / (ref + rolloff * Math.max(0, d - ref));
    let pan = 0;
    let front = 1;
    if (d > 0.05) {
      this.dir.scaleInPlace(1 / d);
      pan = clamp(Vector3.Dot(this.dir, this.camRight), -1, 1) * 0.8;
      front = Vector3.Dot(this.dir, this.camFwd);
    }
    // Very close sources wrap around the listener instead of hard-panning.
    pan *= Math.min(1, d / 2);
    let cutoff = 20000 / (1 + d / 35);
    if (front < 0) cutoff *= 1 + front * 0.5;
    return { gain, pan, cutoff: Math.max(500, cutoff) };
  }
}

function safeStop(s: AudioScheduledSourceNode, when: number): void {
  try {
    s.stop(when);
  } catch {
    /* already stopped */
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 2 s of mono noise, generated once and reused by every voice. */
function makeNoise(ac: AudioContext, kind: NoiseKind): AudioBuffer {
  const len = Math.floor(ac.sampleRate * 2);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === "white") {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else if (kind === "pink") {
    // Paul Kellet's economy pink filter.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

/** tanh soft-clip curve. */
function makeCrushCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

/**
 * Stereo impulse for an open-air yard: a few discrete slap-back echoes off
 * containers/walls plus a short diffuse tail that darkens as it decays.
 */
function makeImpulse(ac: AudioContext): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.floor(sr * 1.4);
  const buf = ac.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = t < 0.015 ? 0 : Math.exp(-(t - 0.015) * 5.5);
      const smooth = Math.min(0.94, 0.3 + t * 0.9);
      lp += (1 - smooth) * (Math.random() * 2 - 1 - lp);
      d[i] = lp * env * 0.5;
    }
    const slaps: [number, number][] = [
      [0.068 + ch * 0.011, 0.6],
      [0.131 - ch * 0.009, 0.42],
      [0.226 + ch * 0.017, 0.28],
      [0.355 - ch * 0.012, 0.16],
    ];
    const slapLen = Math.floor(sr * 0.006);
    for (const [time, amp] of slaps) {
      const i0 = Math.floor(time * sr);
      for (let k = 0; k < slapLen && i0 + k < len; k++) {
        d[i0 + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / (sr * 0.0015));
      }
    }
  }
  return buf;
}
