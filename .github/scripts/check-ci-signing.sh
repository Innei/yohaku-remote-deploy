#!/bin/bash
set -euo pipefail
: "${DIST_CERT_P12:?}"
: "${DIST_CERT_PASSWORD:?}"
: "${APP_PROFILE_BASE64:?}"
: "${EXTENSION_PROFILE_BASE64:?}"
: "${APPLE_TEAM_ID:?}"
: "${YOHAKU_BUNDLE_ID:?}"
: "${YOHAKU_EXTENSION_BUNDLE_ID:?}"
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
  rm -f "$RUNNER_TEMP/check-dist.p12" "$RUNNER_TEMP/check-probe" "$RUNNER_TEMP/check-probe.c" "$RUNNER_TEMP/check-original-keychains.txt" "$RUNNER_TEMP/check-leaf.pem"
  rm -f "$RUNNER_TEMP/check-app.mobileprovision" "$RUNNER_TEMP/check-app.plist" "$RUNNER_TEMP/check-extension.mobileprovision" "$RUNNER_TEMP/check-extension.plist"
  python3 /Users/ci/ci-self/bin/signing-lock.py release
}
trap cleanup EXIT
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
python3 <<'PYKEYCHAIN'
import os, pathlib, shlex, subprocess
original = shlex.split((pathlib.Path(os.environ['RUNNER_TEMP']) / 'check-original-keychains.txt').read_text())
keychain = str(pathlib.Path(os.environ['RUNNER_TEMP']) / 'check-signing.keychain-db')
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', keychain, *original], check=True)
PYKEYCHAIN
printf '%s' "$DIST_CERT_P12" | base64 --decode > "$RUNNER_TEMP/check-dist.p12"
security import "$RUNNER_TEMP/check-dist.p12" -k "$keychain" -P "$DIST_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
identities="$(security find-identity -v -p codesigning "$keychain")"
identity="$(awk '/Apple Distribution:/{print $2; exit}' <<< "$identities")"
if [ -z "$identity" ]; then
  printf '%s\n' "$identities"
  echo '::error::No valid Apple Distribution identity. Check the machine Apple WWDR bootstrap.'
  exit 1
fi
security find-certificate -c 'Apple Distribution' -p "$keychain" > "$RUNNER_TEMP/check-leaf.pem"
security verify-cert -c "$RUNNER_TEMP/check-leaf.pem" -L -p codeSign
check_profile() {
  local label="$1" payload="$2" bundle_id="$3"
  local profile="$RUNNER_TEMP/check-$label.mobileprovision"
  local plist="$RUNNER_TEMP/check-$label.plist"
  printf '%s' "$payload" | base64 --decode > "$profile"
  security cms -D -k "$keychain" -i "$profile" > "$plist"
  test "$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$plist")" = "$APPLE_TEAM_ID"
  test "$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$plist")" = "$APPLE_TEAM_ID.$bundle_id"
  /usr/libexec/PlistBuddy -c 'Print :UUID' "$plist" >/dev/null
  echo "CI $label provisioning profile decoded with the temporary keychain."
}
check_profile app "$APP_PROFILE_BASE64" "$YOHAKU_BUNDLE_ID"
check_profile extension "$EXTENSION_PROFILE_BASE64" "$YOHAKU_EXTENSION_BUNDLE_ID"
printf '%s\n' 'int main(void) { return 0; }' > "$RUNNER_TEMP/check-probe.c"
xcrun --sdk iphoneos clang -target arm64-apple-ios17.0 "$RUNNER_TEMP/check-probe.c" -o "$RUNNER_TEMP/check-probe"
codesign --force --timestamp=none --sign "$identity" "$RUNNER_TEMP/check-probe"
codesign --verify --strict "$RUNNER_TEMP/check-probe"
echo 'CI distribution certificate, provisioning profiles and real iOS codesign verified without publishing.'
