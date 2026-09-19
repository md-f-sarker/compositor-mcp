# Development

## Install dependencies

```bash
npm install
```

## Quality checks

```bash
npm run typecheck
npm test
npm run parity
npm run check
```

## Mock mode

Mock mode lets an MCP inspector or client exercise the server without macOS or Compositor:

```bash
COMPOSITOR_MCP_MOCK=1 npm run dev
```

The mock is deliberately small. It verifies the MCP surface, request validation and representative atomic editing flows; it is not a rendering emulator.

## Testing the native patch

```bash
./scripts/install-into-compositor.sh /path/to/Compositor
open /path/to/Compositor/Compositor.xcodeproj
```

Build and run the Compositor scheme. After launch, inspect:

```bash
cat "$HOME/Library/Application Support/Compositor/MCP/bridge.json"
```

Do not paste or commit its token.

## Operation naming

Use names in the form `domain.verbNoun`, for example `layer.setOpacity`. Names are protocol surface and should not be renamed casually. Prefer:

- absolute values over UI deltas where possible;
- explicit units in descriptions and schemas;
- IDs plus the well-defined aliases `active` and `current`;
- bounded arrays and numbers;
- deterministic results that return changed object IDs/state.

## Upstream compatibility

The installer copies files into a file-system-synchronised Xcode group and makes a small app-delegate change. When upstream changes:

1. run the installer against the new checkout;
2. build with the required Xcode/macOS version;
3. run representative MCP requests;
4. update the audited upstream commit in README and NOTICE;
5. update method mappings rather than bypassing new upstream abstractions.
