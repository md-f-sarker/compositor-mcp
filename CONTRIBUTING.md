# Contributing

Keep changes small, typed and testable. Before opening a pull request:

```bash
npm install
npm run check
```

For a capability change, update the capability registry, Swift router, tests and parity documentation together. Do not mark an operation implemented when it is only a UI automation sketch or an untested direct model mutation.

Use conventional, descriptive commit messages. Include the upstream Compositor commit used for native testing in the pull request description.

Never commit bridge discovery files, audit logs, local project files, signing identities, notarisation credentials or user images.
