/**
 * A Voice is one playing instance of a synthesized sound: a little graph of
 * oscillators / noise sources, filters and envelopes summed into `input`.
 * Recipes (sounds.ts) build into a Voice; the engine routes `input` onwards.
 */

export type NoiseKind = "white" | "pink" | "brown";

/** Shared, reusable resources owned by the engine. */
export interface VoiceKit {
  ac: AudioContext;
  noise: Record<NoiseKind, AudioBuffer>;
  /** Soft-clip curve for crunchy layers. */
  crushCurve: Float32Array<ArrayBuffer>;
}

/** -80 dB: target for exponential fades (exponential ramps cannot reach 0). */
const SILENCE = 0.0001;

export class Voice {
  readonly sources: AudioScheduledSourceNode[] = [];
  /** Sum of every layer; the engine sets its gain (= voice level) and routes it. */
  readonly input: GainNode;
  /** Latest time (AudioContext clock) at which anything in this voice still sounds. */
  end: number;

  constructor(
    private readonly kit: VoiceKit,
    /** Start time (AudioContext clock). */
    readonly t: number,
    /** Pitch multiplier applied to oscillators, noise playback rate and filter frequencies. */
    readonly pitch: number,
  ) {
    this.input = kit.ac.createGain();
    this.end = t;
  }

  private until(t: number): void {
    if (t > this.end) this.end = t;
  }

  osc(type: OscillatorType, freq: number, t0: number, t1: number): OscillatorNode {
    const o = this.kit.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq * this.pitch, t0);
    o.start(t0);
    o.stop(t1);
    this.sources.push(o);
    this.until(t1);
    return o;
  }

  /** Looping noise from a shared buffer, starting at a random offset so repeats never sound identical. */
  noise(kind: NoiseKind, t0: number, t1: number, rate = 1): AudioBufferSourceNode {
    const buf = this.kit.noise[kind];
    const s = this.kit.ac.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.setValueAtTime(rate * this.pitch, t0);
    s.start(t0, Math.random() * buf.duration * 0.9);
    s.stop(t1);
    this.sources.push(s);
    this.until(t1);
    return s;
  }

  gain(value = 0): GainNode {
    const g = this.kit.ac.createGain();
    g.gain.value = value;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7071): BiquadFilterNode {
    const f = this.kit.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(freq * this.pitch, 20000);
    f.Q.value = q;
    return f;
  }

  shaper(): WaveShaperNode {
    const w = this.kit.ac.createWaveShaper();
    w.curve = this.kit.crushCurve;
    w.oversample = "2x";
    return w;
  }

  /** Exponential glide of a frequency-like param (pitch applied). */
  sweep(param: AudioParam, from: number, to: number, t0: number, t1: number): void {
    param.setValueAtTime(Math.max(from * this.pitch, 1), t0);
    param.exponentialRampToValueAtTime(Math.max(to * this.pitch, 1), t1);
  }

  /** Percussive envelope gain: 0 -> peak in `attack`, exponential fade over `decay`. */
  perc(peak: number, t0: number, attack: number, decay: number): GainNode {
    const g = this.gain(0);
    const p = g.gain;
    const pk = Math.max(peak, SILENCE * 2);
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(pk, t0 + attack);
    p.exponentialRampToValueAtTime(SILENCE, t0 + attack + decay);
    this.until(t0 + attack + decay);
    return g;
  }

  /** Attack / hold / exponential-release envelope gain. */
  ahr(peak: number, t0: number, attack: number, hold: number, release: number): GainNode {
    const g = this.gain(0);
    const p = g.gain;
    const pk = Math.max(peak, SILENCE * 2);
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(pk, t0 + attack);
    p.setValueAtTime(pk, t0 + attack + hold);
    p.exponentialRampToValueAtTime(SILENCE, t0 + attack + hold + release);
    this.until(t0 + attack + hold + release);
    return g;
  }

  /**
   * Sparse random amplitude spikes on a gain (crackle, gravel crunch).
   * `bias` > 1 packs grains towards the start; amplitude also falls off over the span.
   */
  grains(g: GainNode, t0: number, t1: number, count: number, amp: number, tau: number, bias = 1): void {
    const span = t1 - t0;
    const times: number[] = [];
    for (let i = 0; i < count; i++) times.push(t0 + Math.pow(Math.random(), bias) * span);
    times.sort((a, b) => a - b);
    const p = g.gain;
    p.setValueAtTime(0, t0);
    for (const t of times) {
      const frac = (t - t0) / span;
      const a = amp * (0.35 + 0.65 * Math.random()) * (1 - 0.7 * frac);
      p.setValueAtTime(a, t);
      p.setTargetAtTime(0, t, tau);
    }
    this.until(t1 + tau * 6);
  }

  /** Connect nodes in series; returns the last node. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /** Connect nodes in series and route the last one into the voice. */
  route(...nodes: AudioNode[]): void {
    this.chain(...nodes).connect(this.input);
  }
}
