#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="$HOME/Library/Application Support/Compositor/MCP"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 /allowed/root [/another/root ...]" >&2
  echo "Example: $0 \"$HOME/Pictures\" \"$HOME/Downloads\"" >&2
  exit 64
fi

python3 - "$CONFIG_FILE" "$@" <<'PY'
import json
from pathlib import Path
import sys

output = Path(sys.argv[1])
roots = []
for raw in sys.argv[2:]:
    path = Path(raw).expanduser().resolve()
    if not path.is_dir():
        raise SystemExit(f"Allowed root is not a directory: {path}")
    roots.append(str(path))
output.write_text(json.dumps({"enabled": True, "allowedRoots": roots, "auditLogging": True}, indent=2) + "\n")
PY
chmod 600 "$CONFIG_FILE"
echo "Wrote $CONFIG_FILE"
echo "Restart Compositor to reload the bridge configuration."
