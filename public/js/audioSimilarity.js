/**
 * audioSimilarity.js
 *
 * Compare deux fichiers/blobs audio et renvoie un pourcentage de ressemblance.
 * Fonctionne dans le navigateur (utilise l'API Web Audio).
 *
 * Usage:
 *   import { compareAudio } from './audioSimilarity.js';
 *   const percent = await compareAudio(file1, file2);
 *   console.log(percent); // ex: 82.4
 */

// ---- Paramètres de l'algorithme ----
const FFT_SIZE = 2048;       // taille de fenêtre pour l'analyse spectrale
const HOP_SIZE = 1024;       // avancement entre deux fenêtres (50% overlap)
const TARGET_SAMPLE_RATE = 22050; // on ré-échantillonne tout à la même fréquence

/**
 * Compare deux sources audio (File, Blob, ArrayBuffer ou URL) et renvoie
 * un score de similarité en pourcentage (0 à 100).
 */
export async function compareAudio(sourceA, sourceB) {
  const [bufferA, bufferB] = await Promise.all([
    loadAsAudioBuffer(sourceA),
    loadAsAudioBuffer(sourceB),
  ]);

  const fingerprintA = computeFingerprint(bufferA);
  const fingerprintB = computeFingerprint(bufferB);

  const similarity = cosineSimilarity(fingerprintA, fingerprintB);

  return Math.round(clamp01(similarity) * 1000) / 10;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ---- Chargement et décodage ----

async function loadAsAudioBuffer(source) {
  const arrayBuffer = await toArrayBuffer(source);
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    return resample(decoded, TARGET_SAMPLE_RATE);
  } finally {
    audioCtx.close();
  }
}

async function toArrayBuffer(source) {
  if (source instanceof ArrayBuffer) return source;
  if (source instanceof Blob) return source.arrayBuffer();
  if (typeof source === 'string') {
    const res = await fetch(source);
    return res.arrayBuffer();
  }
  throw new Error('Source audio non supportée: doit être un File, Blob, ArrayBuffer ou une URL');
}

// Ré-échantillonnage simple via OfflineAudioContext (aussi convertit en mono)
async function resample(audioBuffer, targetRate) {
  if (audioBuffer.sampleRate === targetRate && audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }
  const duration = audioBuffer.duration;
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(duration * targetRate), targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

// ---- Extraction d'empreinte spectrale ----

function computeFingerprint(samples) {
  const numFrames = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1);
  const spectrumSum = new Float32Array(FFT_SIZE / 2);

  const window = hannWindow(FFT_SIZE);

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * HOP_SIZE;
    const frameData = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = samples[start + i] || 0;
      frameData[i] = sample * window[i];
    }
    const magnitudes = fftMagnitude(frameData);
    for (let i = 0; i < magnitudes.length; i++) {
      spectrumSum[i] += magnitudes[i];
    }
  }

  // Moyenne du spectre sur toutes les fenêtres
  for (let i = 0; i < spectrumSum.length; i++) {
    spectrumSum[i] /= numFrames;
  }

  return normalizeVector(spectrumSum);
}

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

function normalizeVector(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // a et b sont déjà normalisés, donc dot == cosine
}

// ---- FFT (implémentation itérative radix-2, sans dépendance) ----

function fftMagnitude(frame) {
  const n = frame.length;
  const real = Float32Array.from(frame);
  const imag = new Float32Array(n);

  fftInPlace(real, imag);

  const mags = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    mags[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return mags;
}

function fftInPlace(real, imag) {
  const n = real.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT_SIZE doit être une puissance de 2');
  }

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1;
      let curWi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = real[i + j];
        const ui = imag[i + j];
        const vr = real[i + j + len / 2] * curWr - imag[i + j + len / 2] * curWi;
        const vi = real[i + j + len / 2] * curWi + imag[i + j + len / 2] * curWr;

        real[i + j] = ur + vr;
        imag[i + j] = ui + vi;
        real[i + j + len / 2] = ur - vr;
        imag[i + j + len / 2] = ui - vi;

        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr;
        curWi = nextWi;
      }
    }
  }
}
