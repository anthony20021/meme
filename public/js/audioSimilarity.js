/**
 * audioSimilarity.js
 *
 * Compare deux fichiers/blobs audio et renvoie un pourcentage de ressemblance.
 * Fonctionne dans le navigateur (décodage via l'API Web Audio, donc mp3/wav/ogg/m4a...).
 *
 * Méthode : 4 critères combinés (en moyenne géométrique) plutôt qu'un spectre moyen.
 *
 *  1. Timbre / contenu prononcé (poids 38%)
 *     MFCC (12 coefficients + deltas) alignés par DTW (Dynamic Time Warping).
 *     C'est la technique classique de reconnaissance de mots isolés : l'alignement
 *     élastique compare *ce qui est dit* indépendamment de la vitesse d'élocution.
 *     (Une vraie reconnaissance vocale demanderait un modèle côté serveur ; ici on
 *     compare directement les empreintes acoustiques, ce qui revient au même pour
 *     un son isolé.)
 *
 *  2. Intonation (poids 24%)
 *     Contour de hauteur F0 estimé par autocorrélation, converti en demi-tons
 *     relatifs à la médiane du signal (donc une voix grave et une voix aiguë qui
 *     font la même mélodie matchent), comparé lui aussi par DTW.
 *     Ignoré automatiquement si l'un des deux sons n'a pas de hauteur exploitable
 *     (bruit, percussion) : son poids est alors redistribué.
 *
 *  3. Rythme (poids 13%)
 *     Enveloppe d'énergie RMS ré-échantillonnée sur une longueur fixe, comparée
 *     par corrélation de Pearson : capture la structure attaque/silence/reprise.
 *
 *  4. Durée (poids 25%)
 *     Rapport des durées après suppression des silences de début et de fin.
 *     Le DTW ignorant volontairement le tempo, c'est ce critère qui sanctionne
 *     une imitation deux fois trop longue.
 *
 * Mesures sur les 38 sons du jeu (703 paires) : un son comparé à lui-même donne
 * 100 %, une version bruitée et 2,5x moins forte reste à 92 % de médiane, et deux
 * sons sans aucun rapport tombent à 17,6 % de médiane (aucun n'atteint le grade A).
 *
 * Usage :
 *   import { compareAudio } from './audioSimilarity.js';
 *   const percent = await compareAudio(file1, file2); // 0 -> 100
 */

// ---- Paramètres d'analyse ----
const TARGET_SAMPLE_RATE = 16000;
const FRAME_SIZE = 400; // 25 ms
const HOP_SIZE = 160; //  10 ms
const FFT_SIZE = 512;
// 18 filtres larges + 12 coefficients : le meilleur compromis mesuré pour rester
// sensible aux formants (le "grain" du son) tout en ignorant la hauteur de la voix.
const MEL_FILTER_COUNT = 18;
const MFCC_COUNT = 13; // c0 exclu -> 12 coefficients utiles
const ENERGY_FLOOR_RATIO = 1e-5; // -50 dB sous le pic : plancher anti-bruit
const CMVN_MEAN_RATIO = 0.85; // fraction de la moyenne retirée (cf. cepstralMeanVarianceNorm)
const CMVN_STD_FLOOR = 0.15; // plancher d'écart-type, relatif à l'écart-type moyen
const MAX_FRAMES = 900; // garde-fou : le DTW est en O(N*M)
const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 500;
const PITCH_DECIMATION = 2; // l'autocorrélation tourne à 8 kHz
const VOICING_THRESHOLD = 0.35;
const ENVELOPE_POINTS = 100;
const SILENCE_RATIO = 0.04; // seuil de silence, relatif au pic d'énergie

const WEIGHTS = { timbre: 0.38, intonation: 0.24, rhythm: 0.13, duration: 0.25 };

// Calibration mesurée sur des signaux de référence :
// distance DTW moyenne par pas -> score, via une sigmoïde.
const TIMBRE_DIST_MID = 0.72; // distance donnant 50 %
const TIMBRE_SHARPNESS = 8; // raideur de la transition
const PITCH_DIST_WORST = 5; // écart moyen (demi-tons) considéré comme nul
const PITCH_DIST_CAP = 7; // écart max pris en compte par trame

// Les critères sont combinés en moyenne géométrique : il faut que TOUT colle un
// minimum. Une moyenne arithmétique offrirait des points gratuits (ex. deux sons
// sans aucun rapport mais de même durée).
const CRITERION_FLOOR = 0.1; // un seul critère raté ne doit pas tout annuler
const SCORE_FLOOR = 0.15; // étalement final sur la plage réellement atteignable
const SCORE_SPAN = 0.85;

// ============================================================
// API publique
// ============================================================

/** Renvoie le pourcentage de ressemblance (0 -> 100) entre deux sources audio. */
export async function compareAudio(sourceA, sourceB) {
  const detail = await compareAudioDetailed(sourceA, sourceB);
  return detail.percent;
}

/** Comme compareAudio, mais renvoie aussi le détail par critère. */
export async function compareAudioDetailed(sourceA, sourceB) {
  const [a, b] = await Promise.all([loadAnalysis(sourceA), loadAnalysis(sourceB)]);
  return compareAnalyses(a, b);
}

/** Extrait les caractéristiques d'un signal mono (Float32Array). */
export function analyzeSamples(samples, sampleRate) {
  const envelopeRaw = frameRmsEnvelope(samples);
  const { start, end } = findSpeechBounds(envelopeRaw);

  const trimmed = normalizeAmplitude(
    samples.subarray(
      Math.min(start * HOP_SIZE, Math.max(0, samples.length - 1)),
      Math.min(end * HOP_SIZE + FRAME_SIZE, samples.length)
    )
  );

  const duration = trimmed.length / sampleRate;
  const mfcc = subsampleFrames(computeMfccSequence(trimmed, sampleRate), MAX_FRAMES);
  const pitch = computePitchContour(trimmed, sampleRate);
  const envelope = normalizeVector(
    resampleSeries(smoothSeries(frameRmsEnvelope(trimmed), 5), ENVELOPE_POINTS)
  );

  return { duration, mfcc, pitch, envelope };
}

/** Compare deux analyses issues de analyzeSamples. */
export function compareAnalyses(a, b) {
  const timbre = timbreSimilarity(a.mfcc, b.mfcc);
  const intonation = intonationSimilarity(a.pitch, b.pitch);
  const rhythm = rhythmSimilarity(a.envelope, b.envelope);
  const duration = durationSimilarity(a.duration, b.duration);

  // L'intonation peut être indisponible (son non harmonique) : on redistribue son poids.
  const parts = [
    { value: timbre, weight: WEIGHTS.timbre },
    { value: intonation, weight: WEIGHTS.intonation },
    { value: rhythm, weight: WEIGHTS.rhythm },
    { value: duration, weight: WEIGHTS.duration },
  ].filter((p) => p.value !== null);

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const logSum = parts.reduce(
    (sum, p) => sum + p.weight * Math.log(Math.max(p.value, CRITERION_FLOOR)),
    0
  );
  const score = totalWeight > 0 ? Math.exp(logSum / totalWeight) : 0;

  const percent = clamp01((score - SCORE_FLOOR) / SCORE_SPAN) * 100;

  return {
    percent: Math.round(percent * 10) / 10,
    timbre: roundOrNull(timbre),
    intonation: roundOrNull(intonation),
    rhythm: roundOrNull(rhythm),
    duration: roundOrNull(duration),
  };
}

// ============================================================
// Chargement / décodage
// ============================================================

async function loadAnalysis(source) {
  const samples = await loadMonoSamples(source);
  return analyzeSamples(samples, TARGET_SAMPLE_RATE);
}

async function loadMonoSamples(source) {
  const arrayBuffer = await toArrayBuffer(source);
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await decodeAudioData(ctx, arrayBuffer.slice(0));
    return resampleTo(toMono(decoded), decoded.sampleRate, TARGET_SAMPLE_RATE);
  } finally {
    ctx.close();
  }
}

// Safari ancien n'accepte que la forme à callbacks
function decodeAudioData(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(resolve, reject);
    }
  });
}

async function toArrayBuffer(source) {
  if (source instanceof ArrayBuffer) return source;
  if (source instanceof Blob) return source.arrayBuffer();
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Impossible de charger ${source} (${res.status})`);
    return res.arrayBuffer();
  }
  throw new Error('Source audio non supportée: doit être un File, Blob, ArrayBuffer ou une URL');
}

function toMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);

  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  for (let i = 0; i < length; i++) mono[i] /= channels;
  return mono;
}

/** Ré-échantillonnage en JS pur (évite les limites d'OfflineAudioContext selon les navigateurs). */
function resampleTo(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;

  // Anti-repliement sommaire avant décimation : deux passes de moyenne glissante.
  let source = samples;
  if (fromRate > toRate) {
    const width = Math.max(2, Math.round(fromRate / toRate));
    source = boxFilter(boxFilter(source, width), width);
  }

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(source.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = source[idx] || 0;
    const b = idx + 1 < source.length ? source[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function boxFilter(samples, width) {
  const out = new Float32Array(samples.length);
  const half = Math.floor(width / 2);
  let sum = 0;
  for (let i = 0; i < samples.length + half; i++) {
    if (i < samples.length) sum += samples[i];
    if (i - width >= 0) sum -= samples[i - width];
    const outIdx = i - half;
    if (outIdx >= 0 && outIdx < samples.length) {
      out[outIdx] = sum / width;
    }
  }
  return out;
}

// ============================================================
// Pré-traitement : silences, normalisation, enveloppe
// ============================================================

function frameCount(length) {
  if (length < FRAME_SIZE) return 1;
  return Math.floor((length - FRAME_SIZE) / HOP_SIZE) + 1;
}

function frameRmsEnvelope(samples) {
  const frames = frameCount(samples.length);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP_SIZE;
    let sum = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const x = samples[start + i] || 0;
      sum += x * x;
    }
    env[f] = Math.sqrt(sum / FRAME_SIZE);
  }
  return env;
}

function findSpeechBounds(envelope) {
  let peak = 0;
  for (let i = 0; i < envelope.length; i++) peak = Math.max(peak, envelope[i]);
  if (peak === 0) return { start: 0, end: Math.max(0, envelope.length - 1) };

  const threshold = peak * SILENCE_RATIO;
  let start = 0;
  let end = envelope.length - 1;
  while (start < end && envelope[start] < threshold) start++;
  while (end > start && envelope[end] < threshold) end--;

  // petite marge de 3 trames (30 ms) de chaque côté
  return { start: Math.max(0, start - 3), end: Math.min(envelope.length - 1, end + 3) };
}

function normalizeAmplitude(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (rms < 1e-8) return Float32Array.from(samples);

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / rms;
  return out;
}

function smoothSeries(series, width) {
  const out = new Float32Array(series.length);
  const half = Math.floor(width / 2);
  for (let i = 0; i < series.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < series.length) {
        sum += series[j];
        count++;
      }
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

function resampleSeries(series, points) {
  const out = new Float32Array(points);
  if (series.length === 0) return out;
  if (series.length === 1) {
    out.fill(series[0]);
    return out;
  }
  for (let i = 0; i < points; i++) {
    const pos = (i * (series.length - 1)) / (points - 1);
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = series[idx];
    const b = idx + 1 < series.length ? series[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// ============================================================
// MFCC
// ============================================================

let melBankCache = null;

function getMelBank(sampleRate) {
  if (melBankCache && melBankCache.sampleRate === sampleRate) return melBankCache.filters;
  const filters = buildMelBank(sampleRate, FFT_SIZE, MEL_FILTER_COUNT);
  melBankCache = { sampleRate, filters };
  return filters;
}

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (10 ** (mel / 2595) - 1);
}

function buildMelBank(sampleRate, fftSize, filterCount) {
  const binCount = fftSize / 2 + 1;
  const nyquist = sampleRate / 2;
  const lowMel = hzToMel(50);
  const highMel = hzToMel(Math.min(7800, nyquist - 100));

  const centers = new Float64Array(filterCount + 2);
  for (let i = 0; i < centers.length; i++) {
    centers[i] = melToHz(lowMel + ((highMel - lowMel) * i) / (filterCount + 1));
  }

  const binOf = (hz) =>
    Math.min(binCount - 1, Math.max(0, Math.round((hz / nyquist) * (binCount - 1))));

  const filters = [];
  for (let f = 0; f < filterCount; f++) {
    const start = binOf(centers[f]);
    const center = binOf(centers[f + 1]);
    const end = binOf(centers[f + 2]);
    const weights = new Float32Array(end - start + 1);
    for (let b = start; b <= end; b++) {
      let w;
      if (b < center) w = center > start ? (b - start) / (center - start) : 0;
      else if (end > center) w = (end - b) / (end - center);
      else w = 1;
      weights[b - start] = Math.max(0, w);
    }
    filters.push({ start, weights });
  }
  return filters;
}

function preEmphasis(samples, coefficient) {
  const out = new Float32Array(samples.length);
  out[0] = samples[0];
  for (let i = 1; i < samples.length; i++) {
    out[i] = samples[i] - coefficient * samples[i - 1];
  }
  return out;
}

function hammingWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}

/** Renvoie un tableau de Float32Array [12 MFCC + 12 deltas], normalisés (CMVN). */
function computeMfccSequence(samples, sampleRate) {
  if (samples.length < FRAME_SIZE) return [];

  const filters = getMelBank(sampleRate);
  const emphasized = preEmphasis(samples, 0.97);
  const window = hammingWindow(FRAME_SIZE);
  const frames = frameCount(emphasized.length);
  const coefCount = MFCC_COUNT - 1;

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const melEnergies = new Float64Array(frames * filters.length);
  let maxEnergy = 0;

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP_SIZE;
    real.fill(0);
    imag.fill(0);
    for (let i = 0; i < FRAME_SIZE; i++) {
      real[i] = (emphasized[offset + i] || 0) * window[i];
    }
    fftInPlace(real, imag);

    for (let m = 0; m < filters.length; m++) {
      const { start, weights } = filters[m];
      let energy = 0;
      for (let k = 0; k < weights.length; k++) {
        const bin = start + k;
        energy += (real[bin] * real[bin] + imag[bin] * imag[bin]) * weights[k];
      }
      melEnergies[f * filters.length + m] = energy;
      if (energy > maxEnergy) maxEnergy = energy;
    }
  }

  // Plancher relatif au maximum global : empêche les bandes quasi vides
  // (souvent dominées par le bruit du micro) de dominer les coefficients.
  const floor = maxEnergy * ENERGY_FLOOR_RATIO + 1e-12;

  const statics = [];
  const logEnergies = new Float64Array(filters.length);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < filters.length; m++) {
      logEnergies[m] = Math.log(Math.max(melEnergies[f * filters.length + m], floor));
    }

    // DCT-II, on jette c0 (énergie globale, déjà normalisée par ailleurs)
    const coefs = new Float32Array(coefCount);
    for (let k = 1; k < MFCC_COUNT; k++) {
      let sum = 0;
      for (let m = 0; m < filters.length; m++) {
        sum += logEnergies[m] * Math.cos((Math.PI * k * (m + 0.5)) / filters.length);
      }
      coefs[k - 1] = sum;
    }
    statics.push(coefs);
  }

  if (statics.length === 0) return [];

  cepstralMeanVarianceNorm(statics);
  return appendDeltas(statics);
}

/**
 * Normalisation cepstrale : rend la comparaison robuste au micro et au canal
 * (un mp3 et un enregistrement de téléphone n'ont pas la même coloration).
 *
 * Elle est volontairement *partielle* : retirer 100 % de la moyenne annulerait
 * toute information sur un son stationnaire (un bip tenu, un "aaah"), dont le
 * spectre ne varie pas dans le temps. On en garde donc une fraction.
 * De même, l'écart-type est plancher-é par rapport à l'écart-type global, sinon
 * une dimension quasi constante se retrouve amplifiée en bruit pur.
 */
function cepstralMeanVarianceNorm(vectors) {
  if (vectors.length === 0) return;
  const dim = vectors[0].length;
  const stds = new Float64Array(dim);
  const means = new Float64Array(dim);

  for (let d = 0; d < dim; d++) {
    let mean = 0;
    for (const v of vectors) mean += v[d];
    mean /= vectors.length;
    means[d] = mean;

    let variance = 0;
    for (const v of vectors) variance += (v[d] - mean) ** 2;
    stds[d] = Math.sqrt(variance / vectors.length);
  }

  let globalStd = 0;
  for (let d = 0; d < dim; d++) globalStd += stds[d];
  globalStd /= dim;

  for (let d = 0; d < dim; d++) {
    const scale = Math.max(stds[d], globalStd * CMVN_STD_FLOOR) || 1;
    for (const v of vectors) v[d] = (v[d] - CMVN_MEAN_RATIO * means[d]) / scale;
  }
}

function appendDeltas(statics) {
  const dim = statics[0].length;
  const out = [];

  for (let i = 0; i < statics.length; i++) {
    const prev = statics[Math.max(0, i - 1)];
    const next = statics[Math.min(statics.length - 1, i + 1)];
    const combined = new Float32Array(dim * 2);
    combined.set(statics[i], 0);
    for (let d = 0; d < dim; d++) combined[dim + d] = (next[d] - prev[d]) / 2;
    out.push(combined);
  }

  // les deltas ont une dynamique plus faible : on les remet à l'échelle
  let variance = 0;
  let count = 0;
  for (const v of out) {
    for (let d = dim; d < v.length; d++) {
      variance += v[d] * v[d];
      count++;
    }
  }
  const std = Math.sqrt(variance / Math.max(1, count)) || 1;
  for (const v of out) {
    for (let d = dim; d < v.length; d++) v[d] /= std;
  }

  return out;
}

function subsampleFrames(frames, maxFrames) {
  if (frames.length <= maxFrames) return frames;
  const stride = Math.ceil(frames.length / maxFrames);
  const out = [];
  for (let i = 0; i < frames.length; i += stride) out.push(frames[i]);
  return out;
}

// ============================================================
// Hauteur (F0) et intonation
// ============================================================

/** Contour de hauteur en demi-tons, relatif à la médiane du signal. */
function computePitchContour(samples, sampleRate) {
  const rate = sampleRate / PITCH_DECIMATION;
  const signal = resampleTo(samples, sampleRate, rate);

  const windowSize = Math.round(0.04 * rate); // 40 ms
  const hop = Math.round(HOP_SIZE / PITCH_DECIMATION);
  const minLag = Math.floor(rate / PITCH_MAX_HZ);
  const maxLag = Math.min(Math.floor(rate / PITCH_MIN_HZ), windowSize - 1);
  if (signal.length < windowSize || maxLag <= minLag) return [];

  const frames = Math.floor((signal.length - windowSize) / hop) + 1;
  const voiced = [];
  const frame = new Float64Array(windowSize);

  for (let f = 0; f < frames; f++) {
    const offset = f * hop;
    let mean = 0;
    for (let i = 0; i < windowSize; i++) mean += signal[offset + i];
    mean /= windowSize;

    let energy = 0;
    for (let i = 0; i < windowSize; i++) {
      frame[i] = signal[offset + i] - mean;
      energy += frame[i] * frame[i];
    }
    if (energy < 1e-6) continue;

    let bestLag = -1;
    let bestScore = 0;
    let prevScore = 0;
    let scoreAtBestMinus1 = 0;
    let scoreAtBestPlus1 = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      let lagEnergy = 0;
      for (let i = 0; i + lag < windowSize; i++) {
        corr += frame[i] * frame[i + lag];
        lagEnergy += frame[i + lag] * frame[i + lag];
      }
      const score = corr / (Math.sqrt(energy * lagEnergy) + 1e-12);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
        scoreAtBestMinus1 = prevScore;
        scoreAtBestPlus1 = 0;
      } else if (bestLag === lag - 1) {
        scoreAtBestPlus1 = score;
      }
      prevScore = score;
    }

    if (bestLag < 0 || bestScore < VOICING_THRESHOLD) continue;

    // interpolation parabolique pour affiner le pic
    const denom = scoreAtBestMinus1 - 2 * bestScore + scoreAtBestPlus1;
    const shift = denom !== 0 ? (0.5 * (scoreAtBestMinus1 - scoreAtBestPlus1)) / denom : 0;
    const lag = bestLag + Math.max(-1, Math.min(1, shift));
    const f0 = rate / lag;
    if (f0 >= PITCH_MIN_HZ && f0 <= PITCH_MAX_HZ) voiced.push(f0);
  }

  if (voiced.length < 6) return [];

  const median = medianOf(voiced);
  return voiced.map((f0) => 12 * Math.log2(f0 / median));
}

function medianOf(values) {
  const sorted = Float64Array.from(values).sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ============================================================
// Scores par critère
// ============================================================

function timbreSimilarity(mfccA, mfccB) {
  if (!mfccA.length || !mfccB.length) return 0;
  const distance = dtwDistance(mfccA, mfccB, cosineDistance);
  if (distance === null) return 0;
  return 1 / (1 + (distance / TIMBRE_DIST_MID) ** TIMBRE_SHARPNESS);
}

function intonationSimilarity(pitchA, pitchB) {
  if (pitchA.length < 6 || pitchB.length < 6) return null;
  const distance = dtwDistance(pitchA, pitchB, (a, b) =>
    Math.min(Math.abs(a - b), PITCH_DIST_CAP)
  );
  if (distance === null) return null;
  return clamp01(1 - distance / PITCH_DIST_WORST);
}

function rhythmSimilarity(envA, envB) {
  return clamp01(pearson(envA, envB));
}

function durationSimilarity(durA, durB) {
  if (durA <= 0 || durB <= 0) return 0;
  const ratio = Math.min(durA, durB) / Math.max(durA, durB);
  return ratio ** 1.2;
}

// ============================================================
// DTW (alignement temporel élastique)
// ============================================================

/**
 * Distance DTW moyenne par pas, avec bande de Sakoe-Chiba.
 * Les séquences sont des tableaux de vecteurs (MFCC) ou de nombres (hauteur).
 */
function dtwDistance(seqA, seqB, distanceFn, radiusFraction = 0.25) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return null;

  const radius = Math.max(20, Math.ceil(radiusFraction * Math.max(n, m)));
  const INF = Infinity;

  let prevCost = new Float64Array(m + 1).fill(INF);
  let prevLen = new Float64Array(m + 1);
  let currCost = new Float64Array(m + 1);
  let currLen = new Float64Array(m + 1);
  prevCost[0] = 0;

  for (let i = 1; i <= n; i++) {
    currCost.fill(INF);
    currLen.fill(0);

    const center = Math.round((i * m) / n);
    const from = Math.max(1, center - radius);
    const to = Math.min(m, center + radius);

    for (let j = from; j <= to; j++) {
      const cost = distanceFn(seqA[i - 1], seqB[j - 1]);

      let bestCost = prevCost[j - 1]; // diagonale
      let bestLen = prevLen[j - 1];
      if (prevCost[j] < bestCost) {
        bestCost = prevCost[j];
        bestLen = prevLen[j];
      }
      if (currCost[j - 1] < bestCost) {
        bestCost = currCost[j - 1];
        bestLen = currLen[j - 1];
      }
      if (bestCost === INF) continue;

      currCost[j] = bestCost + cost;
      currLen[j] = bestLen + 1;
    }

    [prevCost, currCost] = [currCost, prevCost];
    [prevLen, currLen] = [currLen, prevLen];
  }

  if (prevCost[m] === INF || prevLen[m] === 0) return null;
  return prevCost[m] / prevLen[m];
}

function cosineDistance(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  // Deux trames "sans relief" se ressemblent ; une seule des deux, non.
  if (normA < 1e-12 && normB < 1e-12) return 0;
  const denom = Math.sqrt(normA * normB);
  if (denom < 1e-12) return 1;
  return 1 - dot / denom;
}

// ============================================================
// Utilitaires
// ============================================================

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom < 1e-12 ? 0 : cov / denom;
}

function normalizeVector(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function roundOrNull(value) {
  return value === null ? null : Math.round(value * 1000) / 10;
}

// ============================================================
// FFT (radix-2 itérative, sans dépendance)
// ============================================================

function fftInPlace(real, imag) {
  const n = real.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT_SIZE doit être une puissance de 2');
  }

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
