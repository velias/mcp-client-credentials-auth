# Contributing to mcp-client-credentials-auth

Thank you for considering contributing! This document explains the process and guidelines for contributing to this project.

For detailed architecture notes, performance conventions, and implementation patterns, see [AGENTS.md](AGENTS.md) — it is maintained as the single source of truth for how the codebase is structured and why.

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

GitHub Release notes are **auto-generated from merged PRs**. To keep them useful:

- **Write a clear PR title** — it appears verbatim in the release notes (along with the PR author). The PR body/description is _not_ included.
- **Apply a label** to categorize the PR in release notes. Use one of:
  - `breaking` — breaking changes
  - `enhancement` or `feature` — new functionality
  - `bug` or `fix` — bug fixes
  - `documentation` — docs-only changes
  - Unlabeled PRs land in "Other Changes"
- Labels can be added or changed **at any time** before the release is created — they don't need to be set at merge time.
- All meaningful changes should go through PRs. Direct commits to `main` appear as raw commit hashes in release notes.

## Development Setup

**Prerequisites:** Node.js >= 18.x, npm

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

See the **Code style**, **Testing conventions**, and **Performance conventions** sections in [AGENTS.md](AGENTS.md) for the full guidelines.

## Releases

See [RELEASING.md](RELEASING.md) for the release process, npm token setup, and how release notes are generated.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
