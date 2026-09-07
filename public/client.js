import { compareAudio } from './js/audioSimilarity.js';

const $ = (id) => document.getElementById(id);
const show = (el, visible) => {
  el.hidden = !visible;
};

// ---- Ecrans / éléments ----
const joinScreen = $('joinScreen');
const gameScreen = $('gameScreen');
const nameInput = $('nameInput');
const joinBtn = $('joinBtn');
const joinStatus = $('joinStatus');

const roundPill = $('roundPill');
const waitingCard = $('waitingCard');
const waitingMsg = $('waitingMsg');
const turnCard = $('turnCard');
const summaryCard = $('summaryCard');
const gameOverCard = $('gameOverCard');

const soundNameEl = $('soundName');
const recordBtn = $('recordBtn');
const recLabel = recordBtn.querySelector('.rec-label');
const submitBtn = $('submitBtn');
const recStatus = $('recStatus');
const meter = $('meter');
const opponentStatus = $('opponentStatus');

const summaryRound = $('summaryRound');
const summarySound = $('summarySound');
const nextRoundBtn = $('nextRoundBtn');
const readyStatus = $('readyStatus');

const chatLog = $('chatLog');
const chatForm = $('chatForm');
const chatInput = $('chatInput');
const soundToggle = $('soundToggle');

// ---- Etat ----
let ws = null;
let mySlot = null;
let myName = '';
let playerNames = { 1: 'Joueur 1', 2: 'Joueur 2' };
let currentFilename = null;
let recordedBlob = null;
let mediaRecorder = null;
let recordedChunks = [];
let micStream = null;
let iSubmittedThisRound = false;
let soundsEnabled = true;

// ==========================================================
// Sons de feedback (synthétisés, aucun fichier à charger)
// ==========================================================

let fxCtx = null;

function fx() {
  if (!fxCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    fxCtx = new Ctx();
  }
  if (fxCtx.state === 'suspended') fxCtx.resume();
  return fxCtx;
}

function note(freq, at, duration, { type = 'triangle', gain = 0.16, glideTo = null } = {}) {
  const ctx = fx();
  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + duration);

  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  osc.connect(env).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.03);
}

// Plus le grade est haut, plus la fanfare est longue et montante.
const GRADE_JINGLES = {
  S: { notes: [523.25, 659.25, 783.99, 1046.5, 1318.51], gap: 0.085, dur: 0.55, gain: 0.2 },
  A: { notes: [523.25, 659.25, 987.77], gap: 0.09, dur: 0.42 },
  B: { notes: [493.88, 622.25, 739.99], gap: 0.1, dur: 0.34 },
  C: { notes: [440, 554.37], gap: 0.11, dur: 0.3 },
  D: { notes: [392, 466.16], gap: 0.12, dur: 0.26 },
  E: { notes: [349.23], gap: 0, dur: 0.24, gain: 0.13 },
};

function playGradeSound(grade) {
  if (!soundsEnabled) return;
  const ctx = fx();
  const now = ctx.currentTime + 0.02;

  if (grade === 'F') {
    // descente "raté"
    note(311.13, now, 0.22, { type: 'sawtooth', gain: 0.09 });
    note(261.63, now + 0.16, 0.26, { type: 'sawtooth', gain: 0.09 });
    note(196, now + 0.32, 0.5, { type: 'sawtooth', gain: 0.1, glideTo: 130.81 });
    return;
  }

  const jingle = GRADE_JINGLES[grade] || GRADE_JINGLES.E;
  jingle.notes.forEach((freq, i) => {
    note(freq, now + i * jingle.gap, jingle.dur, { gain: jingle.gain ?? 0.16 });
  });

  // petit scintillement en prime pour un S
  if (grade === 'S') {
    jingle.notes.forEach((freq, i) => {
      note(freq * 2, now + 0.3 + i * 0.05, 0.3, { type: 'sine', gain: 0.06 });
    });
  }
}

function playTick(up = true) {
  if (!soundsEnabled) return;
  const ctx = fx();
  note(up ? 660 : 440, ctx.currentTime + 0.01, 0.09, { type: 'sine', gain: 0.1 });
}

soundToggle.addEventListener('click', () => {
  soundsEnabled = !soundsEnabled;
  soundToggle.textContent = soundsEnabled ? '🔊' : '🔇';
  soundToggle.title = soundsEnabled ? 'Couper les sons' : 'Activer les sons';
});

// ==========================================================
// Lecteur audio personnalisé
// ==========================================================

function createPlayer(rootId) {
  const root = $(rootId);
  const audio = root.querySelector('audio');
  const playBtn = root.querySelector('.player-play');
  const bar = root.querySelector('.player-bar');
  const fill = root.querySelector('.player-fill');
  const timeEl = root.querySelector('.player-time');
  const durationEl = root.querySelector('.player-duration');

  const fmt = (s) =>
    Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';

  const render = () => {
    const ratio = audio.duration ? audio.currentTime / audio.duration : 0;
    fill.style.width = `${ratio * 100}%`;
    if (timeEl) timeEl.textContent = fmt(audio.currentTime);
  };

  playBtn.addEventListener('click', () => {
    // une seule lecture à la fois sur toute la page
    document.querySelectorAll('audio').forEach((a) => {
      if (a !== audio) a.pause();
    });
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });

  bar.addEventListener('click', (event) => {
    if (!audio.duration) return;
    const rect = bar.getBoundingClientRect();
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * audio.duration;
    render();
  });

  audio.addEventListener('play', () => root.classList.add('playing'));
  audio.addEventListener('pause', () => root.classList.remove('playing'));
  audio.addEventListener('ended', () => {
    root.classList.remove('playing');
    fill.style.width = '0%';
    if (timeEl) timeEl.textContent = '0:00';
  });
  audio.addEventListener('timeupdate', render);
  audio.addEventListener('loadedmetadata', () => {
    if (durationEl) durationEl.textContent = fmt(audio.duration);
    render();
  });

  return {
    setSrc(src) {
      audio.pause();
      audio.src = src;
      fill.style.width = '0%';
      if (timeEl) timeEl.textContent = '0:00';
      if (durationEl) durationEl.textContent = '0:00';
    },
  };
}

const originalPlayer = createPlayer('originalPlayer');
const myPlayer = createPlayer('myPlayer');
const attemptPlayers = { 1: createPlayer('attempt1Player'), 2: createPlayer('attempt2Player') };

// ==========================================================
// VU-mètre pendant l'enregistrement
// ==========================================================

const METER_BARS = 28;
for (let i = 0; i < METER_BARS; i++) meter.appendChild(document.createElement('span'));
const meterBars = [...meter.children];

let meterRaf = null;
let meterSource = null;

function startMeter(stream) {
  const ctx = fx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.75;

  meterSource = ctx.createMediaStreamSource(stream);
  meterSource.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  meter.classList.add('active');

  const draw = () => {
    analyser.getByteFrequencyData(data);
    for (let i = 0; i < METER_BARS; i++) {
      const value = data[Math.floor((i / METER_BARS) * data.length)] / 255;
      meterBars[i].style.height = `${3 + value * 43}px`;
    }
    meterRaf = requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = null;
  if (meterSource) meterSource.disconnect();
  meterSource = null;
  meter.classList.remove('active');
  meterBars.forEach((b) => (b.style.height = '3px'));
}

// ==========================================================
// Connexion
// ==========================================================

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Joueur';
  myName = name;
  joinBtn.disabled = true;
  joinStatus.textContent = 'Connexion…';

  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', name })));
  ws.addEventListener('message', (event) => handleMessage(JSON.parse(event.data)));
  ws.addEventListener('close', () => {
    joinStatus.textContent = 'Connexion perdue.';
    addSystemLine('Connexion perdue avec le serveur.');
  });
  ws.addEventListener('error', () => {
    joinStatus.textContent = 'Erreur de connexion au serveur.';
    joinBtn.disabled = false;
  });
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

function handleMessage(msg) {
  switch (msg.type) {
    case 'room-full':
      joinStatus.textContent = 'Partie déjà pleine (2 joueurs max).';
      joinBtn.disabled = false;
      break;

    case 'joined':
      mySlot = msg.slot;
      playerNames[mySlot] = msg.name;
      if (msg.opponent) playerNames[other(mySlot)] = msg.opponent;
      show(joinScreen, false);
      show(gameScreen, true);
      renderPlayers();
      updateScores(msg.scores);
      break;

    case 'opponent-joined':
      playerNames[other(mySlot)] = msg.name;
      renderPlayers();
      break;

    case 'opponent-left':
      playerNames[other(mySlot)] = 'déconnecté';
      renderPlayers();
      waitingMsg.textContent = "L'adversaire est parti. En attente d'un nouveau joueur…";
      showStage(waitingCard);
      roundPill.textContent = '—';
      break;

    case 'waiting-for-players':
      showStage(waitingCard);
      break;

    case 'info':
      addSystemLine(msg.message);
      break;

    case 'error':
      addSystemLine(`⚠️ ${msg.message}`);
      break;

    case 'round-start':
      onRoundStart(msg);
      break;

    case 'attempt-submitted':
      if (msg.slot !== mySlot) {
        opponentStatus.textContent = `${msg.name} a envoyé sa tentative`;
      }
      break;

    case 'round-summary':
      onRoundSummary(msg);
      break;

    case 'ready-status':
      onReadyStatus(msg);
      break;

    case 'game-over':
      onGameOver(msg);
      break;

    case 'chat':
      addChatMessage(msg.from, msg.slot, msg.text);
      break;
  }
}

const other = (slot) => (slot === 1 ? 2 : 1);

function showStage(card) {
  for (const c of [waitingCard, turnCard, summaryCard, gameOverCard]) show(c, c === card);
}

function renderPlayers() {
  for (const slot of [1, 2]) {
    const isMe = slot === mySlot;
    $(`name${slot}`).textContent = playerNames[slot] + (isMe ? ' (toi)' : '');
  }
}

function updateScores(scores) {
  for (const slot of [1, 2]) {
    const el = $(`score${slot}`);
    const value = scores?.[slot] ?? 0;
    if (el.textContent !== String(value)) {
      el.textContent = value;
      el.classList.remove('bump');
      void el.offsetWidth; // relance l'animation
      el.classList.add('bump');
    }
  }
}

// ==========================================================
// Déroulé d'une manche
// ==========================================================

function onRoundStart(msg) {
  showStage(turnCard);

  currentFilename = msg.filename;
  recordedBlob = null;
  iSubmittedThisRound = false;

  roundPill.textContent = `Manche ${msg.round} / ${msg.totalRounds}`;
  soundNameEl.textContent = msg.filename.replace(/\.[^.]+$/, '');
  originalPlayer.setSrc(`/data/${encodeURIComponent(msg.filename)}`);

  show($('myPlayer'), false);
  submitBtn.disabled = true;
  recordBtn.disabled = false;
  recordBtn.classList.remove('recording');
  recLabel.textContent = 'Enregistrer';
  recStatus.textContent = '';
  opponentStatus.textContent = '';
}

function onRoundSummary(msg) {
  showStage(summaryCard);
  summaryRound.textContent = msg.round;
  summarySound.textContent = msg.filename.replace(/\.[^.]+$/, '');

  for (const slot of [1, 2]) {
    const result = msg.results[slot];
    const isMe = slot === mySlot;
    $(`attempt${slot}Name`).textContent = playerNames[slot] + (isMe ? ' (toi)' : '');

    const gradeEl = $(`attempt${slot}Grade`);
    const percentEl = $(`attempt${slot}Percent`);
    const pointsEl = $(`attempt${slot}Points`);
    const playerEl = $(`attempt${slot}Player`);
    const noAudioEl = $(`attempt${slot}NoAudio`);

    if (!result) {
      gradeEl.textContent = '–';
      gradeEl.dataset.grade = 'F';
      percentEl.textContent = '–';
      pointsEl.textContent = '';
      show(playerEl, false);
      show(noAudioEl, true);
      continue;
    }

    gradeEl.textContent = result.grade;
    gradeEl.dataset.grade = result.grade;
    gradeEl.classList.remove('grade-badge');
    void gradeEl.offsetWidth;
    gradeEl.classList.add('grade-badge');

    percentEl.textContent = result.percent;
    pointsEl.textContent = `+${result.points} pt${result.points > 1 ? 's' : ''}`;

    if (result.audioData && result.mimeType) {
      attemptPlayers[slot].setSrc(`data:${result.mimeType};base64,${result.audioData}`);
      show(playerEl, true);
      show(noAudioEl, false);
    } else {
      show(playerEl, false);
      show(noAudioEl, true);
    }
  }

  updateScores(msg.scores);
  nextRoundBtn.disabled = false;
  nextRoundBtn.textContent = 'Manche suivante';
  readyStatus.textContent = '';

  const mine = msg.results[mySlot];
  if (mine) playGradeSound(mine.grade);
}

function onReadyStatus(msg) {
  const meReady = msg.ready.includes(mySlot);
  const oppReady = msg.ready.includes(other(mySlot));
  if (meReady) {
    nextRoundBtn.disabled = true;
    nextRoundBtn.textContent = 'En attente de l’adversaire…';
  }
  readyStatus.textContent = `Toi ${meReady ? '✅' : '⏳'}  ·  ${playerNames[other(mySlot)]} ${oppReady ? '✅' : '⏳'}`;
}

function onGameOver(msg) {
  showStage(gameOverCard);
  roundPill.textContent = 'Terminé';
  updateScores(msg.scores);

  for (const slot of [1, 2]) {
    $(`final${slot}Name`).textContent = playerNames[slot] + (slot === mySlot ? ' (toi)' : '');
    $(`final${slot}Score`).textContent = msg.scores[slot] ?? 0;
  }

  const mine = msg.scores[mySlot] ?? 0;
  const theirs = msg.scores[other(mySlot)] ?? 0;
  const title = $('gameOverTitle');
  const icon = $('gameOverIcon');

  if (mine > theirs) {
    icon.textContent = '🏆';
    title.textContent = 'Victoire !';
    playGradeSound('S');
  } else if (mine < theirs) {
    icon.textContent = '💀';
    title.textContent = 'Défaite';
    playGradeSound('F');
  } else {
    icon.textContent = '🤝';
    title.textContent = 'Égalité';
    playGradeSound('C');
  }

  $('gameOverSub').textContent = `${msg.roundsPlayed} manches jouées — tous les sons sont passés.`;
}

nextRoundBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'ready-next-round' }));
  nextRoundBtn.disabled = true;
  nextRoundBtn.textContent = 'En attente de l’adversaire…';
});

// ==========================================================
// Enregistrement micro
// ==========================================================

recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  try {
    recStatus.textContent = 'Accès au micro…';
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(micStream);

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    });

    mediaRecorder.addEventListener('stop', () => {
      stopMeter();
      micStream.getTracks().forEach((t) => t.stop());
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });

      myPlayer.setSrc(URL.createObjectURL(recordedBlob));
      show($('myPlayer'), true);
      recordBtn.classList.remove('recording');
      recLabel.textContent = 'Réessayer';
      recStatus.textContent = 'Écoute-toi, puis envoie ta tentative.';
      submitBtn.disabled = false;
      playTick(false);
    });

    mediaRecorder.start();
    startMeter(micStream);
    playTick(true);
    recordBtn.classList.add('recording');
    recLabel.textContent = 'Stop';
    recStatus.textContent = 'Enregistrement en cours…';
  } catch (err) {
    recStatus.textContent = `Micro indisponible : ${err.message}`;
  }
});

submitBtn.addEventListener('click', async () => {
  if (!recordedBlob || !currentFilename || iSubmittedThisRound) return;
  iSubmittedThisRound = true;
  submitBtn.disabled = true;
  recordBtn.disabled = true;
  recStatus.textContent = 'Analyse en cours…';

  try {
    const percent = await compareAudio(recordedBlob, `/data/${encodeURIComponent(currentFilename)}`);
    const audioData = await blobToBase64(recordedBlob);
    ws.send(
      JSON.stringify({
        type: 'submit-result',
        percent,
        audioData,
        mimeType: recordedBlob.type || 'audio/webm',
      })
    );
    recStatus.textContent = 'Tentative envoyée ✓';
  } catch (err) {
    recStatus.textContent = `Erreur d'analyse : ${err.message}`;
    iSubmittedThisRound = false;
    submitBtn.disabled = false;
    recordBtn.disabled = false;
  }
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ==========================================================
// Tchat
// ==========================================================

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  chatInput.value = '';
});

function appendChat(el) {
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addChatMessage(from, slot, text) {
  const div = document.createElement('div');
  div.className = `msg p${slot}`;

  const name = document.createElement('span');
  name.className = 'from';
  name.textContent = slot === mySlot ? `${from} (toi)` : from;

  const body = document.createElement('span');
  body.textContent = text;

  div.append(name, body);
  appendChat(div);
}

function addSystemLine(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  appendChat(div);
}
