// audio.js -- the shared Web Audio context for the game (copied from the film's audio.js, trimmed to what sound.js needs:
// the context, the master gain and the two noise buffers). All sound is synthesised, no audio files. Starts only after a
// user gesture (call start() from the PLAY click).

export class Sfx {
  constructor() { this.ctx = null; this.master = null; this.noise = null; this.brown = null; }

  /** Creates (or resumes) the context. Safe to call on every click. */
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    this.noise = this.makeNoise(2.5);
    this.brown = this.makeBrown(4);
  }

  /** white noise buffer */
  makeNoise(sec) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * sec, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /** brown (red) noise buffer: deep rumble */
  makeBrown(sec) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * sec, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return b;
  }

  /** suspend / resume (pause menu) */
  pause(on) {
    if (!this.ctx) return;
    if (on) this.ctx.suspend(); else this.ctx.resume();
  }
}
