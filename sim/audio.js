/**
 * Web Audio rendering of the encoder's output.
 *
 * This file contains no encoding decisions — it only realises what
 * sonification/encoder.js produced. That separation is the point: the encoder
 * gets ported to Swift and C++, this does not.
 */

import { SECTORS } from '../sonification/encoder.js';

const RAMP = 0.05; // short enough to stay inside the latency budget, long enough not to click

export class SoundscapeEngine {
  constructor() {
    this.ctx = null;
    this.voices = [];
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();

    if (!this.master) {
      // A hard output ceiling, per requirement N5. A device that vibrates a
      // skull for hours gets a limiter that the user cannot defeat.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.08;

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      for (let k = 0; k < SECTORS; k++) this.voices.push(this._makeVoice());
    }
    this.running = true;
  }

  _makeVoice() {
    const ctx = this.ctx;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 220;

    // Tremolo: an LFO swinging a gain node. Rate carries proximity — this is
    // the "faster beating as you get closer" idea, made continuous.
    const trem = ctx.createGain();
    trem.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.3;
    lfo.connect(lfoDepth);
    lfoDepth.connect(trem.gain);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 20000;
    lp.Q.value = 0.7;

    const pan = ctx.createStereoPanner();
    pan.pan.value = 0;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    osc.connect(trem);
    trem.connect(lp);
    lp.connect(pan);
    pan.connect(gain);
    gain.connect(this.master);

    osc.start();
    lfo.start();

    return { osc, lfo, lfoDepth, trem, lp, pan, gain };
  }

  /** @param {Array} active output of encodeAudio() — omitted sectors are silent */
  update(active) {
    if (!this.running || !this.ctx) return;
    const t = this.ctx.currentTime;
    const byIndex = new Map(active.map((v) => [v.sector, v]));

    for (let k = 0; k < SECTORS; k++) {
      const voice = this.voices[k];
      const v = byIndex.get(k);
      if (!v) {
        voice.gain.gain.setTargetAtTime(0, t, RAMP);
        continue;
      }
      voice.gain.gain.setTargetAtTime(v.gain * 0.8, t, RAMP);
      voice.pan.pan.setTargetAtTime(v.pan, t, RAMP);
      voice.osc.frequency.setTargetAtTime(v.carrierHz, t, RAMP);
      voice.lfo.frequency.setTargetAtTime(v.tremoloHz, t, RAMP);
      voice.lfoDepth.gain.setTargetAtTime(v.tremoloDepth * 0.5, t, RAMP);
      voice.trem.gain.setTargetAtTime(1 - v.tremoloDepth * 0.5, t, RAMP);
      voice.lp.frequency.setTargetAtTime(v.lowpassHz, t, RAMP);
    }
  }

  stop() {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.gain.gain.setTargetAtTime(0, t, RAMP);
    this.running = false;
  }

  setMasterGain(g) {
    if (this.master) this.master.gain.setTargetAtTime(g, this.ctx.currentTime, RAMP);
  }
}
