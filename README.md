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

## Comparaison audio

Le score est calculé dans le navigateur (`public/js/audioSimilarity.js`), sans
dépendance, en combinant quatre critères par moyenne géométrique :

| Critère | Poids | Méthode |
|---|---|---|
| Timbre / contenu prononcé | 38 % | MFCC (12 coefficients + deltas) alignés par DTW — la technique classique de reconnaissance de mots isolés |
| Intonation | 24 % | Contour de hauteur F0 (autocorrélation) en demi-tons relatifs, comparé par DTW |
| Rythme | 13 % | Enveloppe d'énergie RMS, corrélation de Pearson |
| Durée | 25 % | Rapport des durées après suppression des silences |

L'alignement DTW rend la comparaison insensible à la vitesse d'élocution, et la
normalisation cepstrale la rend robuste à l'écart entre un mp3 et un micro de
téléphone. L'intonation étant relative à la médiane, une voix grave et une voix
aiguë qui font la même mélodie obtiennent le même score.

Mesuré sur les 38 sons du jeu (703 paires) : un son comparé à lui-même donne
100 %, une version bruitée et 2,5x moins forte reste à 92 % de médiane, et deux
sons sans aucun rapport tombent à 17,6 % de médiane — aucun n'atteint le grade A.

## Structure

```
server.js              Serveur Express + WebSocket (logique de jeu)
gen-cert.sh             Génère cert.pem / key.pem
data/                    Fichiers audio du jeu
public/
  index.html, style.css, client.js
  js/audioSimilarity.js  Comparaison audio côté navigateur
```
