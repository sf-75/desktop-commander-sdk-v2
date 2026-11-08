# Desktop Commander SDK v2 — public validation snapshot

This is an **independent, non-official** source snapshot for testing Desktop Commander with MCP SDK v2. It is not the upstream project's release repository, an npm publishing endpoint, or a production deployment.

- Upstream: https://github.com/wonderwhy-er/DesktopCommanderMCP
- Based on upstream MIT-licensed source. Original copyright and license are preserved in [LICENSE](LICENSE).
- Validation here concerns compatibility and regressions; passing tests do not imply production readiness.
- The npm package is explicitly marked `"private": true`, and no release workflow is provided.
- Private development records, local deployment scripts, personal settings, credentials, and the upstream/private Git history are intentionally not included.
- GitHub Actions are deliberately configured for manual invocation only in the initial public snapshot.

## Local validation

Use Node.js 24 and `npm ci`, then `npm run build`. The root tests use `node test/run-all-tests.js`, and OS-specific integrations use `node test/integration/run-all-integration-tests.js`. Individual focused tests can be selected by passing test filenames to those runners.

Do not use this snapshot to replace an existing Desktop Commander installation. See the original upstream project for ordinary installation and release information.
