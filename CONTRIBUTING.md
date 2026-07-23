# Contributing to mcp-client-credentials-auth

Thank you for considering contributing! This document explains the process and guidelines for contributing to this project.

For architecture, code style, logging, and testing conventions, see [AGENTS.md](AGENTS.md).

## How to Contribute

### Reporting Bugs

- Open a [GitHub issue](https://github.com/velias/mcp-client-credentials-auth/issues) with a clear description.
- Include steps to reproduce, expected behavior, and actual behavior.
- Include the Node.js version and OS if relevant.
- Include MCP Client and its version where the bug appears if relevant.

### Suggesting Features

- **Features should be discussed before implementation.** Open a [GitHub issue](https://github.com/velias/mcp-client-credentials-auth/issues) describing the use case, proposed behavior, and any alternatives you considered.
- Wait for feedback and approval before starting work — this saves everyone's time and avoids rejected PRs.

### Submitting Pull Requests

1. **Every PR must reference a GitHub issue.** If one doesn't exist, create it first.
2. Fork the repository and create a branch from `main`.
3. Make your changes (see [AGENTS.md](AGENTS.md) for code style and architecture conventions).
4. Ensure all checks pass locally:
   ```bash
   npm run lint
   npm run build
   npm test
   ```
5. Open a PR against `main` and reference the issue (e.g. `Fixes #42` or `Relates to #42`).

### PR titles and labels (for release notes)

Release notes are auto-generated from merged PRs (see [RELEASING.md](RELEASING.md) for details). As a contributor:

- **Write a clear PR title** — it appears verbatim in the release notes.
- **Apply a label**: `breaking`, `enhancement`/`feature`, `bug`/`fix`, or `documentation`. Unlabeled PRs land in "Other Changes".

## Development Setup

**Prerequisites:** Node.js >= 20, npm

```bash
git clone https://github.com/velias/mcp-client-credentials-auth.git
cd mcp-client-credentials-auth
npm install
```

### Testing with a local MCP client

To test your local development version with an actual MCP client (e.g. Claude Desktop, Cursor), point the client config at your local source or build instead of the npm package.

**Using `tsx` (no build step needed, fastest for development):**

```jsonc
{
  "mcpServers": {
    "my-dev-proxy": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-client-credentials-auth/src/index.ts"],
      "env": {
        "MCP_CC_PROXY_REMOTE_MCP_URL": "https://mcp.example.com/mcp",
        "MCP_CC_PROXY_CLIENT_ID": "my-client",
        "MCP_CC_PROXY_CLIENT_SECRET": "my-secret"
      }
    }
  }
}
```

**Using the compiled build:**

```bash
npm run build           # Compile TypeScript to dist/
```

```jsonc
{
  "mcpServers": {
    "my-dev-proxy": {
      "command": "node",
      "args": ["/path/to/mcp-client-credentials-auth/dist/index.js"],
      "env": {
        "MCP_CC_PROXY_REMOTE_MCP_URL": "https://mcp.example.com/mcp",
        "MCP_CC_PROXY_CLIENT_ID": "my-client",
        "MCP_CC_PROXY_CLIENT_SECRET": "my-secret"
      }
    }
  }
}
```

You can also use a `.env` file instead of the `env` block by passing `--env-file` to Node.js (requires Node 20+):

```bash
cp .env.example .env    # Edit with your remote MCP server + OAuth details
```

```jsonc
{
  "mcpServers": {
    "my-dev-proxy": {
      "command": "node",
      "args": ["--env-file", "/path/to/mcp-client-credentials-auth/.env", "/path/to/mcp-client-credentials-auth/dist/index.js"]
    }
  }
}
```

### Building the container image (optional)

On-premises HTTP mode ships a GHCR image on release tags. For a local image build (Podman is used in examples; `docker` works the same):

```bash
podman build -t mcp-client-credentials-auth:local .
```

Image defaults set `MCP_CC_PROXY_TRANSPORT=http` and `MCP_CC_PROXY_LISTEN_HOST=0.0.0.0`. See README [On-premises HTTP deployment](README.md#on-premises-http-deployment-alternative). Stdio remains the primary local development path.

### Running Tests

```bash
npm test                # Vitest (no network, no server)
npm test -- --coverage  # Run with coverage report
```

Tests use in-memory MCP transports and mocked SDK functions — no server started, no network calls.

The `--coverage` flag prints a summary table to the terminal and generates a detailed HTML report in `coverage/lcov-report/index.html` that you can open in a browser. Coverage is also reported automatically on pull requests by CI.

### Linting

```bash
npm run lint            # ESLint check
npm run lint:fix        # Auto-fix
```

ESLint uses [typescript-eslint](https://typescript-eslint.io/) with type-aware rules (`recommendedTypeChecked`). Config: `eslint.config.mjs`.

## Code Style, Testing & Architecture

See [AGENTS.md](AGENTS.md).

## Releases

See [RELEASING.md](RELEASING.md) for the release process, npm token setup, and how release notes are generated.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
