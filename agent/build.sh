#!/usr/bin/env bash
# Build agent/bridge-agent.jar. JDK: $SAPGUI_JDK, else the one shipped with SAP GUI (SapMachine),
# else $JAVA_HOME, else javac on PATH. Needs JDK 17+.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
jdk="${SAPGUI_JDK:-}"
if [[ -z $jdk ]]; then
  if gui=$("$here/../scripts/sapgui-home" 2>/dev/null) && [[ -x $gui/jre/bin/javac ]]; then jdk=$gui/jre
  elif [[ -n ${JAVA_HOME:-} && -x $JAVA_HOME/bin/javac ]]; then jdk=$JAVA_HOME
  elif command -v javac >/dev/null; then jdk=$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")
  else echo "no JDK found – set SAPGUI_JDK or JAVA_HOME" >&2; exit 1; fi
fi
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
