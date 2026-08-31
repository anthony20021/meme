# SoundGame

Jeu à 2 joueurs en temps réel : un son est joué, un joueur doit le reproduire au micro et obtenir le meilleur % de ressemblance possible.

## Installation

```bash
npm install
npm run gen-cert   # génère un certificat TLS auto-signé (nécessaire pour le micro sur téléphone via LAN)
```

Placez vos fichiers audio (mp3, wav, ogg, m4a, flac, aac) dans le dossier `data/`.

## Lancement

```bash
npm start
```

Puis ouvrez `https://<IP-de-la-machine>:8443` sur les deux appareils (accepter le certificat auto-signé).

## Règles

- Chaque manche, les deux joueurs reproduisent chacun leur tour **le même son**.
- Un barème note le % de ressemblance : <20% → 0pt/D, 20-40% → 1pt/C, 40-60% → 2pts/B, 60-80% → 3pts/A, ≥80% → 4pts/S.
- Une fois les deux tentatives faites, les enregistrements des deux joueurs sont écoutables par les deux. Chaque joueur clique "Manche suivante" quand il est prêt ; la manche suivante démarre quand les deux ont validé.
- Un tchat WebSocket permet de discuter entre les deux joueurs.

## Structure

```
server.js              Serveur Express + WebSocket (logique de jeu)
gen-cert.sh             Génère cert.pem / key.pem
data/                    Fichiers audio du jeu (non versionnés)
public/
  index.html, style.css, client.js
  js/audioSimilarity.js  Comparaison audio (FFT + similarité cosinus) côté navigateur
```
