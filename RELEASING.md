# Releasing

A release is a version bump, a tag, one approval on npmjs.com and one button. No token is stored anywhere: npm and the MCP Registry both trust this repository's GitHub identity (OIDC).

## One-time setup

1. **npm trusted publisher.** On npmjs.com open the package `@mmoonport-labs/unifi-mcp`, then Settings, then **Trusted publisher**, choose GitHub Actions and enter: organization `mmoonport-labs`, repository `unifi-mcp`, workflow filename `release.yml`. Leave the environment empty. (You can also use `npm trust`.)
2. **GitHub.** Nothing to configure. If you want a human gate before staging, add a required reviewer to a `release` environment and name it in `release.yml`.
3. The MCP Registry needs nothing: the `registry.yml` workflow logs in with GitHub's OIDC identity. If it is refused, the repository owner must be allowed to publish under `io.github.mmoonport-labs/*` (an Owner of the organization).

## Each release

1. Bump the version in `package.json`, `package-lock.json`, `server.json` (two places), `.claude-plugin/plugin.json` and `src/tools.ts`. `test/release.spec.ts` fails if they drift. Open a PR, merge it.
2. On `main`, tag and push: `git tag v0.2.1 && git push origin v0.2.1`.
3. The **Release (stage on npm)** workflow checks the tag is on `main` and matches every version file, runs the typecheck, tests and build, and **stages** the package with provenance (`npm stage publish`). Nothing is public yet.
4. **Approve the staged version** (this needs your 2FA): npmjs.com, the package, Staged Packages, or `npm stage list` then `npm stage approve <id>`.
5. Run the **Publish to the MCP Registry** workflow (Actions tab, Run workflow) with the version, for example `0.2.1`. It refuses unless that version is live on npm.

CI (`ci.yml`) runs the typecheck, tests (100% coverage is enforced), build and a pack dry run on every pull request and push to `main`.

## If something goes wrong

- A published npm version cannot be changed or reused. Fix forward with the next patch version.
- `npm stage list` shows what is waiting; `npm stage reject <id>` drops a staged version you do not want.
- The workflows pin actions to commit hashes and `mcp-publisher` to a version and checksum; Dependabot proposes updates. Check the hash it proposes against the release before merging.
