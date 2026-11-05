## Summary

<!-- What changes, and why is this the smallest safe change? -->

## Related issue

Closes #

## Validation

- [ ] `npm run lint`, `npm run typecheck` and `npx vitest run` pass locally.
- [ ] Tests cover new and changed behavior without live credentials.
- [ ] The README is updated where public behavior changed.
- [ ] Package contents were reviewed when exports, build, or packaging changed.
- [ ] Every commit is signed off (`git commit -s`), as described in CONTRIBUTING.md.

## Security and compatibility

- [ ] This change does not log, return, serialize, or embed secrets or tokens.
- [ ] This change does not weaken authorization, approval, audit, path, or cost boundaries.
- [ ] `AgentGateway` signatures and documented behavior remain backward compatible.
- [ ] Any Python SDK parity impact is linked and explicitly tracked.
- [ ] New framework/provider dependencies are optional peers behind an explicit subpath.
- [ ] I used synthetic data and removed credentials, private endpoints, and customer information.

## Reviewer notes

<!-- Call out threat-model assumptions, migration concerns, or follow-up work. -->
