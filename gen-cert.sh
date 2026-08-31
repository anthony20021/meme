#!/usr/bin/env bash
# Génère un certificat TLS auto-signé pour servir le jeu en HTTPS sur le réseau local
# (nécessaire pour que le micro fonctionne sur un téléphone via getUserMedia).
set -e
cd "$(dirname "$0")"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-localhost}"

openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=${IP}"

echo "Certificat généré pour CN=${IP} (cert.pem / key.pem)"
