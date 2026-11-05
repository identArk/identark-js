# Contributing to the IdentArk TypeScript SDK

Thank you for helping make agent infrastructure safer. This repository welcomes bug fixes, documentation, examples, tests, provider improvements, and framework adapters that preserve the `AgentGateway` boundary.

## Find something to work on

- [`good first issue`](https://github.com/identArk/identark-js/labels/good%20first%20issue): scoped docs and example tasks. Many point at a working file in the [Python SDK](https://github.com/identArk/identark) that you can port.
- [`help wanted`](https://github.com/identArk/identark-js/labels/help%20wanted): larger tasks such as framework adapters.

**Claim an issue before you start.** Comment on it to say you are taking it. A maintainer will assign it to you, so two people don't build the same thing. A maintainer replies to new issues and pull requests within 48 hours. If an assigned issue has had no activity for two weeks, it may be reopened for others.

Not sure where to start? Comment on any open issue and ask.

## Before you start

- Use GitHub Issues for bugs and narrowly scoped feature requests.
- Use the integration proposal form before building a new framework adapter.
- Open an issue to discuss the design before changing `AgentGateway`, authentication behavior, error semantics, package exports, or security invariants.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Never include credentials, tokens, customer data, or exploitable details in a public issue.

The hosted IdentArk control plane is outside this repository. Contributions must not depend on private service code or reproduce its authorization, policy, audit, or credential-handling internals in the SDK.

## Development setup

Requirements:

- Node.js 18, 20, or 22
- npm

```bash
git clone https://github.com/identArk/identark-js.git
cd identark-js
npm ci
npm run lint
npm run typecheck
npx vitest run
```

`npm ci` installs development and optional peer packages used by the test suite. The published SDK still has zero required runtime dependencies.

Useful commands:

```bash
npm run lint           # ESLint, zero warnings allowed
npm run typecheck      # tsc --noEmit
npm test               # vitest in watch mode
npx vitest run         # run the suite once
npm run test:coverage  # coverage report
npm run build          # compile to dist/
```

CI runs lint, typecheck, and tests on Node.js 18, 20, and 22. All three must pass before a pull request can merge.

## Design constraints

All contributions must preserve these boundaries:

1. **`AgentGateway` is stable.** Do not change its required surface without an agreed proposal, a compatibility plan, and matching Python SDK work.
2. **Zero required runtime dependencies.** Use platform APIs or optional peer dependencies. A new optional peer must sit behind its own package subpath.
3. **No secret exposure.** Never log, serialize, return, or embed API keys, session tokens, credentials, authorization headers, or secret-shaped error payloads.
4. **Local and governed execution are distinct.** `DirectGateway` receives provider credentials in its host process. Only claim credential isolation when the deployment path actually provides it.
5. **Fail closed.** Do not add client behavior that bypasses authorization, approval, risk decisions, audit recording, or server-side cost enforcement.
6. **Keep integrations isolated.** Framework imports belong behind explicit subpath exports, so installing the core package never requires the framework.
7. **Do not copy control-plane code.** Public contracts may be documented. Private implementation details, operational topology, and internal security controls do not belong here.

## Tests

Add tests for every behavior change. Networked tests must use mocks by default and must never require contributor credentials. `MockGateway` (in `src/testing/`) is available for tests and examples.

For security-sensitive changes, include negative tests for malformed values and confirm that thrown or reported errors cannot expose credentials.

## Porting from the Python SDK

The two SDKs are kept at parity. When an issue asks you to port a Python example or integration:

- Link the Python file you are porting from in your pull request.
- Keep the same behavior and names, adapted to TypeScript conventions (camelCase, `async`/`await`).
- Examples go in `examples/` and must run without real credentials, or read them from environment variables and say so at the top of the file.

## Pull requests

- Keep the change focused, and update the README when public behavior changes.
- Link the issue the pull request closes.
- Use [Conventional Commit](https://www.conventionalcommits.org/) prefixes, for example `docs:`, `feat:`, `fix:`, `test:`.
- Make sure lint, typecheck, and tests pass locally.
- Expect additional security review for gateways, transport, authentication, file paths, errors, release automation, and framework integrations.

Maintainers may ask for a smaller change, more threat analysis, or matching work in the Python SDK before merging.

## Developer Certificate of Origin

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/). Signing off certifies that you wrote the change, or otherwise have the right to submit it under this repository's MIT license.

Add the sign-off with `-s`:

```bash
git commit -s -m "docs: document the validation helpers"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line that must match your commit author. To sign off commits you already made, run `git rebase --signoff main` and force-push your branch.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under the [MIT License](LICENSE).
