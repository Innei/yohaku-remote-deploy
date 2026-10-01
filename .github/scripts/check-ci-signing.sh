#!/bin/bash
set -euo pipefail
: "${DIST_CERT_P12:?}"
: "${DIST_CERT_PASSWORD:?}"
python3 /Users/ci/ci-self/bin/signing-lock.py acquire
keychain="$RUNNER_TEMP/check-signing.keychain-db"
password="$(uuidgen)"
security list-keychains -d user > "$RUNNER_TEMP/check-original-keychains.txt"
cleanup() {
  python3 <<'PYCLEAN'
import os, pathlib, shlex, subprocess
path = pathlib.Path(os.environ['RUNNER_TEMP']) / 'check-original-keychains.txt'
if path.exists():
    subprocess.run(['security','list-keychains','-d','user','-s',*shlex.split(path.read_text())], check=True)
PYCLEAN
  security delete-keychain "$keychain" || true
  rm -f "$RUNNER_TEMP/check-dist.p12" "$RUNNER_TEMP/check-probe" "$RUNNER_TEMP/check-probe.c" "$RUNNER_TEMP/check-original-keychains.txt"
  python3 /Users/ci/ci-self/bin/signing-lock.py release
}
trap cleanup EXIT
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
printf '%s' "$DIST_CERT_P12" | base64 --decode > "$RUNNER_TEMP/check-dist.p12"
security import "$RUNNER_TEMP/check-dist.p12" -k "$keychain" -P "$DIST_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
/bin/bash "$(dirname "$0")/import-apple-intermediates.sh" "$keychain"
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
identities="$(security find-identity -v -p codesigning "$keychain")"
identity="$(awk '/Apple Distribution:/{print $2; exit}' <<< "$identities")"
if [ -z "$identity" ]; then
  printf '%s\n' "$identities"
  echo '::error::No valid Apple Distribution identity after importing the certificate chain.'
  exit 1
fi
printf '%s\n' 'int main(void) { return 0; }' > "$RUNNER_TEMP/check-probe.c"
xcrun clang "$RUNNER_TEMP/check-probe.c" -o "$RUNNER_TEMP/check-probe"
codesign --force --timestamp=none --sign "$identity" --keychain "$keychain" "$RUNNER_TEMP/check-probe"
codesign --verify --strict "$RUNNER_TEMP/check-probe"
echo 'CI distribution certificate import and codesign verified without publishing.'
