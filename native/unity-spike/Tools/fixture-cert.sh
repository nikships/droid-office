#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$project/Evidence"
if [[ ! -f "$project/Evidence/fixture-key.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
    -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    -keyout "$project/Evidence/fixture-key.pem" -out "$project/Evidence/fixture-cert.pem"
fi
openssl x509 -in "$project/Evidence/fixture-cert.pem" -outform der \
  -out "$project/Evidence/fixture-cert.der"
openssl x509 -in "$project/Evidence/fixture-cert.pem" -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -r \
  | cut -d ' ' -f 1 > "$project/Evidence/fixture-pin.txt"
echo 'Synthetic localhost fixture certificate ready, never an office credential.'
