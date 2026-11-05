#!/usr/bin/env bash
# Adds a second desktop launcher "SAP GUI (MCP bridge)" that starts SAP GUI for Java with the bridge
# agent. The existing launcher is not touched. Remove with: rm ~/.local/share/applications/sapgui-mcp-bridge.desktop
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
GUI="${SAPGUI_HOME:-$HOME/SAPClients/SAPGUI8.10rev14}"
"$REPO/agent/build.sh"
icon=""
orig="$HOME/.local/share/applications/$(basename "$GUI").desktop"
[ -f "$orig" ] && icon="$(grep -m1 '^Icon=' "$orig" | cut -d= -f2- || true)"
dest="$HOME/.local/share/applications/sapgui-mcp-bridge.desktop"
cat > "$dest" <<DESK
[Desktop Entry]
Type=Application
Name=SAP GUI (MCP bridge)
Comment=SAP GUI for Java with the sapgui-java-mcp bridge started automatically
Exec=env PLATIN_JAVA=$REPO/scripts/sapgui-java-with-bridge "$GUI/bin/guilogon"
${icon:+Icon=$icon}
Terminal=false
Categories=X-SAPClients;Office;
StartupWMClass=com-sap-platin-Gui
DESK
echo "installed $dest"
