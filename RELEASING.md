# Releasing

## How release notes are generated

GitHub automatically generates release notes from **merged PRs** between the
previous tag and the new tag. For each PR, the **title** and **author** are
shown (the PR body is not included). PRs are grouped into sections based on
their GitHub **labels** (configured in `.github/release.yml`).

This means:
- All changes should go through PRs with **clear, descriptive titles**.
- Apply labels (`breaking`, `enhancement`, `bug`, `documentation`, etc.) to PRs
  so they are grouped correctly. Labels can be added **at any time before the
  release is created** -- not necessarily at merge time.
- Direct commits to `main` (not via PR) appear as raw commit hashes -- avoid
  these for user-visible changes.

After the release is created, you can **edit the notes in the GitHub UI** to
add context, highlight important changes, or remove noise.

## Prerequisites

- Push access to `main`
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
  (`gh auth login`)
- **Trusted Publishing** configured on npmjs.com (see below)

## Steps

1. Ensure `main` is green (CI passing)
2. Review merged PRs since the last tag -- add/fix labels if needed
3. Run: `npm version patch|minor|major` (bumps version in package.json,
   creates git commit + `vX.Y.Z` tag)
4. Push: `git push origin main --follow-tags`
5. The `release.yml` workflow will automatically:
   - Run lint, test, build
   - Publish to npm via OIDC Trusted Publishing (no token needed)
   - Create a GitHub Release with auto-generated notes
6. (Optional) Edit the GitHub Release notes in the UI to curate

## Version guidance

- `patch` -- bug fixes, docs, internal refactors
- `minor` -- new features, non-breaking behavior changes
- `major` -- breaking changes (config format, removed features, API changes)

## Authentication: Trusted Publishing (OIDC)

The release workflow uses **npm Trusted Publishing** with OpenID Connect (OIDC)
instead of long-lived npm tokens. GitHub Actions generates a short-lived OIDC
credential for each workflow run; npm verifies the workflow identity and allows
the publish. No secrets to store or rotate.

### Setup (one-time, after first publish)

Trusted Publishing can only be configured on a package that already exists on
npm. After the first publish (see "First publish" below), configure it:

1. Go to **npmjs.com > package settings** for
   [mcp-client-credentials-auth](https://www.npmjs.com/package/mcp-client-credentials-auth/access)
2. Under **Publishing access**, click **Add trusted publisher**
3. Configure:
   - **Provider**: GitHub Actions
   - **Organization or user**: `velias`
   - **Repository**: `mcp-client-credentials-auth`
   - **Workflow filename**: `release.yml`
   - **Environment**: leave empty
   - **Allowed actions**: `npm publish`
4. Save

The `release.yml` workflow already has the required `id-token: write` permission
and upgrades npm to a version that supports OIDC. The workflow also passes
`NODE_AUTH_TOKEN` as a fallback; when Trusted Publishing is active, the OIDC
flow takes priority and the token is ignored.

### After Trusted Publishing is active

- Delete the `NPM_TOKEN` repository secret from GitHub (Settings > Secrets and
  variables > Actions) - it is no longer needed. The workflow reference to it
  is harmless when the secret does not exist.
- You can also set your npm account to **"Require two-factor authentication and
  disallow tokens"** for maximum security, since CI no longer uses tokens.

## First publish

The very first publish requires an npm token because Trusted Publishing can only
be configured on an existing package.

### 1. Create a temporary npm token

1. Go to [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens)
2. Click **Generate New Token** > **Granular Access Token**
3. Configure:
   - **Token name**: e.g. `mcp-client-credentials-auth-first-publish`
   - **Expiration**: 1 day (shortest available; this is temporary)
   - **Packages and scopes**: `Read and write`, `All packages` (the package
     does not exist yet, so you cannot scope to it)
   - **Organizations**: `No access`
4. Click **Generate token** and copy the value

### 2. Add as a GitHub secret

1. Go to **GitHub repo > Settings > Secrets and variables > Actions**
   (https://github.com/velias/mcp-client-credentials-auth/settings/secrets/actions)
2. Click **New repository secret**:
   - **Name**: `NPM_TOKEN`
   - **Secret**: paste the token value

### 3. Publish

Follow the normal release steps (tag and push). The workflow will authenticate
using the `NPM_TOKEN` secret (the OIDC path is not available yet because
Trusted Publishing is not configured). Once the first publish succeeds:

1. Configure Trusted Publishing on npmjs.com (see above)
2. Delete the `NPM_TOKEN` secret from GitHub

## Hotfix

Same process from a release branch if needed.

## Manual publish (emergency)

```bash
npm login && npm publish --access public
```

## Recovery: re-run a failed release

If a release workflow fails (check the `npm publish` step logs):

1. Fix the underlying issue (e.g. Trusted Publishing misconfiguration, or
   npm outage)
2. Go to the failed workflow run in GitHub Actions
3. Click **"Re-run failed jobs"**

The git tag and version bump are already in place, so no need to re-tag. The
GitHub Release may or may not have been created depending on which step failed;
if it was created, it stays; if not, the re-run will create it.
