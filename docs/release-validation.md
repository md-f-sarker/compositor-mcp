# Release validation

Validation completed for the 0.1.0 private alpha on 19 September 2026.

## Completed in the development environment

- TypeScript protocol and server projects type-check with strict compiler settings.
- Both TypeScript projects build to ESM output.
- Fourteen protocol/server tests pass.
- Every catalogue example validates against its advertised JSON schema.
- The TypeScript capability catalogue and Swift router agree on all 42 implemented operation names, destructive classifications, read-only classifications and non-transactional classifications.
- All five Swift integration files pass Swift parser validation.
- Shell scripts pass `bash -n`.
- JSON examples and configuration files parse successfully.
- Installer smoke test passes, including repeat installation and clean uninstall against a representative upstream app delegate.
- Repository scan found no embedded credentials, bridge tokens, private keys or development-machine absolute paths.

## Required before calling the native integration production-ready

This environment cannot launch AppKit or build the patched application with Xcode. A maintainer must still:

1. build the audited Compositor upstream revision with Xcode 26 on macOS 26;
2. launch the patched app and confirm the discovery file is created with mode `0600`;
3. connect an MCP inspector to the built TypeScript server;
4. run representative read, write, filesystem, destructive, dry-run and rollback operations against a real document;
5. confirm rendering and file authorisation behaviour using real image assets;
6. run Compositor's existing unit and UI test suites after installing the bridge.

The current release is therefore a working, tested integration foundation rather than a claim of complete one-to-one editor parity or a signed production build.
