# Releasing

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). GitHub Actions mints a short-lived OIDC token for `.github/workflows/release.yml`. The workflow does not read an npm access token or a registry auth token from the environment.

Trusted publishing needs npm CLI 11.5.1 or newer and Node.js 22.14.0 or newer. The release job installs npm 11.15.0 on Node 22.14.0. Provenance is attached automatically for a public package published from this public repository. The publish command does not pass `--provenance`.

The workflow file is `release.yml`. The job does not set a GitHub environment. On npmjs.com, leave **Environment name** empty. If that field is filled in, npm will reject the publish because the OIDC token will not carry a matching environment claim.

`package.json` `repository.url` is `git+https://github.com/lonnylot/langgraph-checkpoint-durable-object.git`. Leave it pointed at this repository. npm checks that field when a GitHub Actions trusted publisher publishes.

npm will not save a trusted publisher until the package exists. `0.1.0` is published once, from a local checkout. Every later version is published by the Release workflow.

## Do not stage-reject a new package

Do not run `npm stage publish` and then `npm stage reject` to create this package. Staging a name that does not exist yet publishes a public placeholder, `0.0.0-stage`, and stages the real version. Rejecting that staged version unpublishes the placeholder as well. The package page disappears, so there is no Settings page on which to add a trusted publisher.

When every version of a name is unpublished, the registry blocks publishing that name again for 24 hours. This name was fully unpublished at `2026-11-20T11:12:17Z` (`time.unpublished`, versions `[0.0.0-stage]`), about 20 seconds after the staged `0.1.0` was rejected. `npm publish` of `0.1.0` cannot succeed until that 24-hour window ends.

## First release

Do these in order. Sign in with `npm login` on the account that will own the package, with 2FA enabled. Do not use a granular access token that bypasses 2FA.

1. Publish `0.1.0` yourself, after the 24-hour unpublish window has ended. Check out the exact commit that should be that release (this pull request merged to `main`, with a clean working tree) and run:

   ```bash
   npm publish --access public
   ```

   npm prompts for 2FA. This publish is what creates the package page. It is not done by GitHub Actions, and it does not use trusted publishing. The Release workflow does not publish `0.1.0` again. On a push to `main` that does not come from a Changesets version bump, Changesets finds no unpublished changesets and does nothing.

2. On npmjs.com, open `langgraph-checkpoint-durable-object` → **Settings** → **Trusted Publisher**. Choose **GitHub Actions** and enter:

   | Field                | Value                                 |
   | -------------------- | ------------------------------------- |
   | Organization or user | `lonnylot`                            |
   | Repository           | `langgraph-checkpoint-durable-object` |
   | Workflow filename    | `release.yml`                         |
   | Environment name     | Leave empty                           |
   | Allowed actions      | Allow direct `npm publish`            |

   Enter only the filename, including `.yml`. Save the publisher. A new publisher has to be used for one successful publish within 2 days or it expires. Because CI will not publish `0.1.0` again, that validating publish is the next version. Ship it within 2 days of saving the publisher, or delete the publisher and create it again with the same fields.

3. Later releases go through the workflow. Add a changeset (`npx changeset`) in the pull request that should ship. Merge to `main`. The Release workflow opens a **Version Packages** pull request. Merge that pull request. Changesets runs `node scripts/publish.mjs`, which publishes only a version that is not already on npm. Provenance is attached automatically.

4. After one of those workflow publishes has succeeded, open **Settings** → **Publishing access** and select **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working. Do this only after step 3 has succeeded, so a publisher that is not validated yet cannot block the only way to publish.

No npm token is added to GitHub. Protect `main` so releases only move through pull requests. This repository cannot turn that setting on by itself.
