# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ Active support |

## Reporting a Vulnerability

If you discover a security vulnerability in the IdentArk TypeScript SDK, please report it responsibly:

1. **Do not open a public issue** — vulnerabilities should not be disclosed publicly until a fix is available.
2. Email security reports to: `security@identark.io`
3. Include:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

We aim to respond to security reports within **48 hours** and release patches within **7 days** for critical issues.

## Security Features

The SDK implements the following security controls:

- **Zero runtime dependencies** — minimal supply chain attack surface
- **No secret logging** — API keys and tokens are never logged to console
- **Cost caps** — Built-in spending limits prevent runaway costs
- **Path validation** — File operations are restricted to the workspace directory
- **Strict TypeScript** — Type safety prevents many classes of bugs

## Known Limitations

- Integration tests against a live control plane are planned but not yet available.
- LlamaIndex, CrewAI, LangGraph, and Gemini framework integrations are planned — LangChain.js is available now.

## Security-Related Configuration

```typescript
// Always use environment variables for API keys
const gateway = new DirectGateway(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  "gpt-4o"
);

// Set cost caps in production
const gateway = new DirectGateway(client, "gpt-4o", undefined, 0.50);
```

## Disclosure Policy

We follow a **coordinated disclosure** model:
1. Reporter submits vulnerability privately
2. We acknowledge receipt within 48 hours
3. We investigate and develop a fix
4. We release the fix and publicly disclose the vulnerability with credit to the reporter
5. We request a CVE for critical vulnerabilities

## Security Contacts

- Primary: `security@identark.io`
- GPG Key: Available on request
