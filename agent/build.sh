#!/usr/bin/env bash
# Build agent/bridge-agent.jar with the JDK that ships with SAP GUI (SapMachine).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
jdk="${SAPGUI_JDK:-$HOME/SAPClients/SAPGUI8.10rev14/jre}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
"$jdk/bin/javac" --release 17 -d "$out" "$here/BridgeAgent.java"
cat > "$out/MANIFEST.MF" <<MF
Premain-Class: BridgeAgent
Agent-Class: BridgeAgent
Main-Class: BridgeAgent
MF
"$jdk/bin/jar" --create --file "$here/bridge-agent.jar" --manifest "$out/MANIFEST.MF" -C "$out" BridgeAgent.class
echo "built $here/bridge-agent.jar"
