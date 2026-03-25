/**
 * Simple Web Audio API based sound synthesizer for chiptune-style game sounds.
 * No external assets required.
 */
class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  constructor() {
    // Context is initialized on first user interaction
  }

  private init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.gain.value = 0.12; // Lowered master volume for better balance
    
    this.noiseBuffer = this.createNoiseBuffer();

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  private createNoiseBuffer() {
    if (!this.ctx) return null;
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private playNoise(duration: number, volume: number, type: 'lowpass' | 'highpass' | 'bandpass' = 'lowpass', freq: number = 1000) {
    this.init();
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;

    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(50, this.ctx.currentTime + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration); // Sharper fade out

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    source.start();
    source.stop(this.ctx.currentTime + duration);
  }

  private playTone(freq: number, type: OscillatorType, duration: number, volume: number, fade: boolean = true, sweepFreq?: number) {
    this.init();
    if (!this.ctx || !this.masterGain) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    if (sweepFreq) {
      osc.frequency.exponentialRampToValueAtTime(sweepFreq, this.ctx.currentTime + duration);
    }

    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    if (fade) {
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration); // Sharper fade out
    }

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  playHit() {
    // Standard impact sound: Noise + Low kick
    this.playNoise(0.1, 0.15, 'lowpass', 1200);
    this.playTone(100, 'sine', 0.1, 0.2, true, 40);
  }

  playAllyHit() {
    // Subtle impact for allies: Triangle wave + noise
    this.playNoise(0.08, 0.1, 'highpass', 3500);
    this.playTone(350, 'triangle', 0.08, 0.12, true, 180);
  }

  playPlayerHit() {
    // Punchy impact for player: Heavy bass + noise
    this.playNoise(0.12, 0.25, 'bandpass', 1000);
    this.playTone(140, 'sawtooth', 0.12, 0.3, true, 50);
  }

  playSwing() {
    // "Whoosh" sound for player attack: White noise sweep
    this.playNoise(0.12, 0.12, 'bandpass', 1800);
    this.playTone(700, 'sine', 0.12, 0.08, true, 150);
  }

  playCapture() {
    // "Bling" sound: Triangle sweep + high noise
    this.playTone(400, 'triangle', 0.2, 0.15, true, 1000);
    this.playNoise(0.15, 0.08, 'highpass', 5000);
  }

  playSkill() {
    // Powerful dash: Sawtooth sweep + white noise
    this.playTone(80, 'sawtooth', 0.4, 0.2, true, 500);
    this.playNoise(0.4, 0.15, 'bandpass', 1500);
  }

  playBossSkill() {
    // Growling roar: Deep sawtooth + heavy low noise
    this.playTone(180, 'sawtooth', 0.5, 0.3, true, 40);
    this.playNoise(0.5, 0.25, 'lowpass', 400);
  }

  playWin() {
    this.init();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => {
      this.playTone(f, 'triangle', 0.5, 0.15, true);
    });
  }

  playLoss() {
    this.playTone(150, 'sawtooth', 1.0, 0.4, true, 30);
    this.playNoise(1.0, 0.2, 'lowpass', 300);
  }

  private bgmInterval: any = null;
  startBGM() {
    this.init();
    if (!this.ctx || !this.masterGain || this.bgmInterval) return;
    
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    
    let step = 0;
    const bassNotes = [110, 110, 130, 110, 146, 110, 130, 123]; 
    const melodyNotes = [220, 0, 261, 293, 0, 329, 261, 0]; 
    
    this.bgmInterval = setInterval(() => {
      if (!this.ctx || !this.masterGain) return;
      const now = this.ctx.currentTime;
      
      // Kick drum (every 2 steps)
      if (step % 2 === 0) {
        this.playTone(60, 'sine', 0.15, 0.3, true, 30);
      }

      // Snare/Hi-hat noise (every 2 steps, offset)
      if (step % 2 === 1) {
        this.playNoise(0.05, 0.1, 'highpass', 8000);
      }
      
      // Bass synth
      const bassOsc = this.ctx.createOscillator();
      const bassGain = this.ctx.createGain();
      bassOsc.type = 'triangle';
      bassOsc.frequency.setValueAtTime(bassNotes[step % bassNotes.length], now);
      bassGain.gain.setValueAtTime(0.12, now);
      bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      bassOsc.connect(bassGain);
      bassGain.connect(this.masterGain);
      bassOsc.start();
      bassOsc.stop(now + 0.18);

      // Melody synth
      const mNote = melodyNotes[step % melodyNotes.length];
      if (mNote > 0) {
        const melOsc = this.ctx.createOscillator();
        const melGain = this.ctx.createGain();
        melOsc.type = 'square';
        melOsc.frequency.setValueAtTime(mNote, now);
        melGain.gain.setValueAtTime(0.04, now);
        melGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        melOsc.connect(melGain);
        melGain.connect(this.masterGain);
        melOsc.start();
        melOsc.stop(now + 0.15);
      }
      
      step++;
    }, 200);
  }

  stopBGM() {
    if (this.bgmInterval) {
      clearInterval(this.bgmInterval);
      this.bgmInterval = null;
    }
  }
}

export const soundManager = new SoundManager();
