import { compareAudio } from './js/audioSimilarity.js';

const $ = (id) => document.getElementById(id);

const joinScreen = $('joinScreen');
const gameScreen = $('gameScreen');
const nameInput = $('nameInput');
const joinBtn = $('joinBtn');
const joinStatus = $('joinStatus');

const meEl = $('me');
const opponentEl = $('opponent');
const score1El = $('score1');
const score2El = $('score2');

const waitingMsg = $('waitingMsg');
const turnContent = $('turnContent');
const roundNumberEl = $('roundNumber');
const turnNumberEl = $('turnNumber');
const totalTurnsEl = $('totalTurns');
const soundNameEl = $('soundName');
const performerLabel = $('performerLabel');
const originalAudio = $('originalAudio');

const performerControls = $('performerControls');
const spectatorMsg = $('spectatorMsg');
const recordBtn = $('recordBtn');
const stopBtn = $('stopBtn');
const submitBtn = $('submitBtn');
const recStatus = $('recStatus');
const myRecording = $('myRecording');
const timeLeftEl = $('timeLeft');

const summaryContent = $('summaryContent');
const summaryRoundNumber = $('summaryRoundNumber');
const summarySoundName = $('summarySoundName');
const nextRoundBtn = $('nextRoundBtn');
const readyStatus = $('readyStatus');

const chatLog = $('chatLog');
const chatInput = $('chatInput');
const chatSendBtn = $('chatSendBtn');

let ws = null;
let mySlot = null;
let myName = '';
let currentFilename = null;
let recordedBlob = null;
let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let countdownTimer = null;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function addChatLine(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Joueur';
  myName = name;
  joinBtn.disabled = true;
  joinStatus.textContent = 'Connexion...';

  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', name }));
  });

  ws.addEventListener('close', () => {
    joinStatus.textContent = 'Connexion perdue.';
  });

  ws.addEventListener('error', () => {
    joinStatus.textContent = 'Erreur de connexion au serveur.';
    joinBtn.disabled = false;
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  });
});

function handleMessage(msg) {
  switch (msg.type) {
    case 'room-full':
      joinStatus.textContent = 'Partie déjà pleine (2 joueurs max).';
      joinBtn.disabled = false;
      break;

    case 'joined':
      mySlot = msg.slot;
      joinScreen.style.display = 'none';
      gameScreen.style.display = 'block';
      meEl.textContent = `${msg.name} (moi)`;
      opponentEl.textContent = msg.opponent || 'en attente...';
      updateScores(msg.scores);
      break;

    case 'opponent-joined':
      opponentEl.textContent = msg.name;
      break;

    case 'opponent-left':
      opponentEl.textContent = 'déconnecté';
      waitingMsg.style.display = 'block';
      waitingMsg.textContent = "L'adversaire s'est déconnecté. En attente d'un nouveau joueur...";
      turnContent.style.display = 'none';
      summaryContent.style.display = 'none';
      break;

    case 'waiting-for-players':
      waitingMsg.style.display = 'block';
      turnContent.style.display = 'none';
      summaryContent.style.display = 'none';
      break;

    case 'info':
      addChatLine(`<span class="system">${escapeHtml(msg.message)}</span>`);
      break;

    case 'error':
      addChatLine(`<span class="system">⚠️ ${escapeHtml(msg.message)}</span>`);
      break;

    case 'turn-start':
      onTurnStart(msg);
      break;

    case 'turn-result':
      updateScores(msg.scores);
      break;

    case 'round-summary':
      onRoundSummary(msg);
      break;

    case 'ready-status':
      onReadyStatus(msg);
      break;

    case 'chat':
      addChatLine(
        `<span class="from">${escapeHtml(msg.from)}${msg.slot === mySlot ? ' (moi)' : ''}:</span> ${escapeHtml(msg.text)}`
      );
      break;
  }
}

function updateScores(scores) {
  score1El.textContent = scores[1] ?? 0;
  score2El.textContent = scores[2] ?? 0;
}

function onTurnStart(msg) {
  waitingMsg.style.display = 'none';
  summaryContent.style.display = 'none';
  turnContent.style.display = 'block';

  currentFilename = msg.filename;
  recordedBlob = null;
  myRecording.style.display = 'none';
  submitBtn.disabled = true;
  recStatus.textContent = '';

  roundNumberEl.textContent = msg.round;
  turnNumberEl.textContent = msg.turnNumber;
  totalTurnsEl.textContent = msg.totalTurns;
  soundNameEl.textContent = msg.filename;
  originalAudio.src = `/data/${encodeURIComponent(msg.filename)}`;

  const isPerformer = msg.activeSlot === mySlot;
  performerLabel.textContent = isPerformer
    ? "🎤 C'est à toi de reproduire ce son !"
    : `🎧 ${msg.activeName} doit reproduire ce son.`;

  performerControls.style.display = isPerformer ? 'block' : 'none';
  spectatorMsg.style.display = isPerformer ? 'none' : 'block';

  recordBtn.disabled = false;
  stopBtn.disabled = true;
  recordBtn.classList.remove('recording');

  clearInterval(countdownTimer);
  if (isPerformer) {
    let remaining = Math.floor(msg.timeLimitMs / 1000);
    timeLeftEl.textContent = `Temps restant : ${remaining}s`;
    countdownTimer = setInterval(() => {
      remaining -= 1;
      timeLeftEl.textContent = remaining > 0 ? `Temps restant : ${remaining}s` : 'Temps écoulé !';
      if (remaining <= 0) clearInterval(countdownTimer);
    }, 1000);
  } else {
    timeLeftEl.textContent = '';
  }
}

function onRoundSummary(msg) {
  clearInterval(countdownTimer);
  turnContent.style.display = 'none';
  summaryContent.style.display = 'block';

  summaryRoundNumber.textContent = msg.round;
  summarySoundName.textContent = msg.filename;

  for (const slot of [1, 2]) {
    const result = msg.results[slot];
    const nameEl = $(`attempt${slot}Name`);
    const percentEl = $(`attempt${slot}Percent`);
    const gradeEl = $(`attempt${slot}Grade`);
    const audioEl = $(`attempt${slot}Audio`);
    const noAudioEl = $(`attempt${slot}NoAudio`);

    const playerName = slot === mySlot ? `${myName} (moi)` : opponentEl.textContent;
    nameEl.textContent = playerName;

    if (!result) {
      percentEl.textContent = '--%';
      gradeEl.textContent = '-';
      audioEl.style.display = 'none';
      noAudioEl.style.display = 'block';
      continue;
    }

    percentEl.textContent = `${result.percent}%`;
    gradeEl.textContent = `Grade ${result.grade} (+${result.points} pt${result.points > 1 ? 's' : ''})`;

    if (result.audioData && result.mimeType) {
      audioEl.src = `data:${result.mimeType};base64,${result.audioData}`;
      audioEl.style.display = 'block';
      noAudioEl.style.display = 'none';
    } else {
      audioEl.style.display = 'none';
      noAudioEl.style.display = 'block';
    }
  }

  updateScores(msg.scores);
  nextRoundBtn.disabled = false;
  nextRoundBtn.textContent = "✅ J'ai écouté les deux tentatives — Manche suivante";
  readyStatus.textContent = '';
}

function onReadyStatus(msg) {
  const meReady = msg.ready.includes(mySlot);
  const opponentReady = msg.ready.includes(mySlot === 1 ? 2 : 1);
  if (meReady) {
    nextRoundBtn.disabled = true;
    nextRoundBtn.textContent = 'En attente de la validation...';
  }
  readyStatus.textContent = `Toi : ${meReady ? '✅ prêt' : '⏳ en attente'} — Adversaire : ${opponentReady ? '✅ prêt' : '⏳ en attente'}`;
}

nextRoundBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'ready-next-round' }));
  nextRoundBtn.disabled = true;
  nextRoundBtn.textContent = 'En attente de la validation...';
});

recordBtn.addEventListener('click', async () => {
  try {
    recStatus.textContent = "Demande d'accès au micro...";
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    });

    mediaRecorder.addEventListener('stop', () => {
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      myRecording.src = URL.createObjectURL(recordedBlob);
      myRecording.style.display = 'block';
      recStatus.textContent = 'Enregistrement terminé. Tu peux réessayer ou envoyer.';
      submitBtn.disabled = false;
      stream.getTracks().forEach((t) => t.stop());
    });

    mediaRecorder.start();
    recordBtn.disabled = true;
    recordBtn.classList.add('recording');
    stopBtn.disabled = false;
    recStatus.textContent = 'Enregistrement en cours...';
  } catch (err) {
    recStatus.textContent = `Erreur micro : ${err.message}`;
  }
});

stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recordBtn.disabled = false;
  recordBtn.classList.remove('recording');
  stopBtn.disabled = true;
});

submitBtn.addEventListener('click', async () => {
  if (!recordedBlob || !currentFilename) return;
  submitBtn.disabled = true;
  recordBtn.disabled = true;
  stopBtn.disabled = true;
  recStatus.textContent = 'Analyse en cours...';

  try {
    const percent = await compareAudio(recordedBlob, `/data/${encodeURIComponent(currentFilename)}`);
    const audioData = await blobToBase64(recordedBlob);
    ws.send(JSON.stringify({
      type: 'submit-result',
      percent,
      audioData,
      mimeType: recordedBlob.type || 'audio/webm',
    }));
    recStatus.textContent = 'Tentative envoyée.';
  } catch (err) {
    recStatus.textContent = `Erreur d'analyse : ${err.message}`;
    submitBtn.disabled = false;
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

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  chatInput.value = '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
