#!/bin/bash
# Public Apple WWDR intermediates belong to this job's temporary keychain.
set -euo pipefail
keychain="${1:?Temporary signing keychain is required}"
cert_file="$(mktemp "$RUNNER_TEMP/apple-wwdr.XXXXXX")"
trap 'rm -f "$cert_file"' EXIT
for entry in \
  G3:dcf21878c77f4198e4b4614f03d696d89c66c66008d4244e1b99161aac91601f \
  G6:bdd4ed6e74691f0c2bfd01be0296197af1379e0418e2d300efa9c3bef642ca30; do
  generation="${entry%%:*}"
  digest="${entry#*:}"
  curl --fail --silent --show-error --location --retry 3 \
    "https://www.apple.com/certificateauthority/AppleWWDRCA${generation}.cer" --output "$cert_file"
  printf '%s  %s\n' "$digest" "$cert_file" | shasum -a 256 --check --status
  security import "$cert_file" -k "$keychain" >/dev/null
 done
