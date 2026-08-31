const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.webm']);

const ROUND_TIMEOUT_MS = 20000; // temps laissé au joueur actif pour reproduire le son

// ---- Barème points / grade ----
function scoreForPercent(percent) {
  if (percent < 20) return { points: 0, grade: 'D' };
  if (percent < 40) return { points: 1, grade: 'C' };
  if (percent < 60) return { points: 2, grade: 'B' };
  if (percent < 80) return { points: 3, grade: 'A' };
  return { points: 4, grade: 'S' };
}

function listSoundFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
}

function pickRandomSound() {
  const files = listSoundFiles();
  if (files.length === 0) return null;
  return files[Math.floor(Math.random() * files.length)];
}

// ---- App HTTP ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(DATA_DIR, {
  // Content-Type correct est déduit automatiquement de l'extension (mp3, wav, ogg, ...)
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

let httpServer;
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');

if (!process.env.FORCE_HTTP && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const https = require('https');
  httpServer = https.createServer(
    { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
    app
  );
  console.log('HTTPS activé (cert.pem / key.pem trouvés)');
} else {
  const http = require('http');
  httpServer = http.createServer(app);
  console.log('HTTPS non configuré (lancez "npm run gen-cert" pour le micro sur téléphone via LAN). Démarrage en HTTP.');
}

const PORT = process.env.PORT || 8443;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

// ---- État de la partie (une seule salle, 2 joueurs) ----
// Chaque manche : les DEUX joueurs, chacun leur tour, reproduisent le MEME son.
// Une fois les deux tentatives faites, les deux enregistrements + résultats sont
// révélés aux deux joueurs, qui doivent chacun cliquer "Manche suivante" pour continuer.
const wss = new WebSocketServer({ server: httpServer, maxPayload: 20 * 1024 * 1024 });

const room = {
  players: {}, // slot(1|2) -> { ws, name }
  round: null, // { number, filename, turnOrder:[slotA,slotB], turnIndex, attempts:{}, timeout, awaitingReady, readySlots:Set }
  roundNumber: 0,
  scores: { 1: 0, 2: 0 },
};

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const slot of [1, 2]) {
    const p = room.players[slot];
    if (p) send(p.ws, msg);
  }
}

function otherSlot(slot) {
  return slot === 1 ? 2 : 1;
}

function freeSlot() {
  if (!room.players[1]) return 1;
  if (!room.players[2]) return 2;
  return null;
}

function bothConnected() {
  return !!room.players[1] && !!room.players[2];
}

function resetGame() {
  if (room.round && room.round.timeout) clearTimeout(room.round.timeout);
  room.round = null;
  room.roundNumber = 0;
  room.scores = { 1: 0, 2: 0 };
}

function startRound(startingSlot) {
  const filename = pickRandomSound();
  if (!filename) {
    broadcast({ type: 'error', message: "Aucun son trouvé dans le dossier data/." });
    return;
  }

  room.roundNumber += 1;
  room.round = {
    number: room.roundNumber,
    filename,
    turnOrder: [startingSlot, otherSlot(startingSlot)],
    turnIndex: 0,
    attempts: {},
    timeout: null,
    awaitingReady: false,
    readySlots: new Set(),
  };

  startTurn();
}

function startTurn() {
  const r = room.round;
  const activeSlot = r.turnOrder[r.turnIndex];

  r.timeout = setTimeout(() => {
    handleAttempt(activeSlot, 0, null, null);
  }, ROUND_TIMEOUT_MS);

  broadcast({
    type: 'turn-start',
    round: r.number,
    filename: r.filename,
    activeSlot,
    activeName: room.players[activeSlot]?.name,
    turnNumber: r.turnIndex + 1,
    totalTurns: r.turnOrder.length,
    timeLimitMs: ROUND_TIMEOUT_MS,
  });
}

function handleAttempt(slot, percent, audioData, mimeType) {
  const r = room.round;
  if (!r) return;
  clearTimeout(r.timeout);

  const clamped = Math.max(0, Math.min(100, percent));
  const { points, grade } = scoreForPercent(clamped);
  room.scores[slot] += points;

  const attempt = {
    percent: Math.round(clamped * 10) / 10,
    points,
    grade,
    audioData: audioData || null,
    mimeType: mimeType || null,
  };
  r.attempts[slot] = attempt;

  broadcast({
    type: 'turn-result',
    round: r.number,
    slot,
    name: room.players[slot]?.name,
    ...attempt,
    scores: room.scores,
  });

  r.turnIndex += 1;

  if (r.turnIndex < r.turnOrder.length) {
    startTurn();
  } else {
    r.awaitingReady = true;
    broadcast({
      type: 'round-summary',
      round: r.number,
      filename: r.filename,
      results: r.attempts,
      scores: room.scores,
    });
  }
}

function handleReadyNextRound(slot) {
  const r = room.round;
  if (!r || !r.awaitingReady) return;
  r.readySlots.add(slot);

  broadcast({
    type: 'ready-status',
    ready: Array.from(r.readySlots),
  });

  if (r.readySlots.size >= 2) {
    const nextStart = otherSlot(r.turnOrder[0]);
    room.round = null;
    if (bothConnected()) startRound(nextStart);
  }
}

wss.on('connection', (ws) => {
  let mySlot = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const slot = freeSlot();
      if (!slot) {
        send(ws, { type: 'room-full' });
        ws.close();
        return;
      }
      mySlot = slot;
      const name = (msg.name || `Joueur ${slot}`).toString().slice(0, 24);
      room.players[slot] = { ws, name };

      send(ws, {
        type: 'joined',
        slot,
        name,
        opponent: room.players[otherSlot(slot)]?.name || null,
        scores: room.scores,
      });

      const opponent = room.players[otherSlot(slot)];
      if (opponent) send(opponent.ws, { type: 'opponent-joined', name });

      if (bothConnected() && !room.round) {
        broadcast({ type: 'info', message: 'Les deux joueurs sont connectés, la partie commence !' });
        startRound(1);
      } else if (!bothConnected()) {
        send(ws, { type: 'waiting-for-players' });
      }
      return;
    }

    if (!mySlot) return; // il faut avoir rejoint avant toute autre action

    if (msg.type === 'chat') {
      const text = (msg.text || '').toString().slice(0, 500);
      if (!text.trim()) return;
      broadcast({ type: 'chat', from: room.players[mySlot].name, slot: mySlot, text });
      return;
    }

    if (msg.type === 'submit-result') {
      if (!room.round || room.round.awaitingReady) return;
      const activeSlot = room.round.turnOrder[room.round.turnIndex];
      if (activeSlot !== mySlot) return;
      const percent = Number(msg.percent);
      if (Number.isNaN(percent)) return;
      handleAttempt(mySlot, percent, msg.audioData || null, msg.mimeType || null);
      return;
    }

    if (msg.type === 'ready-next-round') {
      handleReadyNextRound(mySlot);
      return;
    }
  });

  ws.on('close', () => {
    if (!mySlot) return;
    delete room.players[mySlot];
    broadcast({ type: 'opponent-left' });
    resetGame();
  });
});
