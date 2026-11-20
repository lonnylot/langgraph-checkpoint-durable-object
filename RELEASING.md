# Releasing

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). GitHub Actions mints a short-lived OIDC token for `.github/workflows/release.yml`. The workflow does not read an npm access token or a registry auth token from the environment.

Trusted publishing needs npm CLI 11.5.1 or newer and Node.js 22.14.0 or newer. The release job installs npm 11.15.0 on Node 22.14.0. Provenance is attached automatically for a public package published from this public repository. The publish command does not pass `--provenance`.

The workflow file is `release.yml`. The job does not set a GitHub environment. On npmjs.com, leave **Environment name** empty. If that field is filled in, npm will reject the publish because the OIDC token will not carry a matching environment claim.

`package.json` `repository.url` is `git+https://github.com/lonnylot/langgraph-checkpoint-durable-object.git`. Leave it pointed at this repository. npm checks that field when a GitHub Actions trusted publisher publishes.

## Why the first publish is local

npm will not save a trusted publisher for a package that does not exist yet. The `npm trust` command documents that requirement: the package must already be on the registry. There is no way to register the GitHub workflow against the name `langgraph-checkpoint-durable-object` before some version of it has been created.

A trusted publisher also has to complete one successful publish within 2 days of being saved. That publish is what validates the configuration. Skipping because the version is already on npm does not count. The steps below create the package name without using up `0.1.0`, then let the Release workflow publish `0.1.0` with OIDC.

## First release

Do these in order, signed in to npm as the account that will own the package. Enable 2FA on that account first. Use `npm login`, not a granular access token that bypasses 2FA. Locally, install npm 11.15.0 or newer (`npm install -g npm@11.15.0`). Staged publishing needs that CLI.

1. Check out the commit that should become `0.1.0` (this repository at `main` after the release workflow is merged). From the package root, create the name:

   ```bash
   npm stage publish --access public
   ```

   npm publishes a public placeholder, `0.0.0-stage`, and stages `0.1.0`. The staged `0.1.0` is not installable yet. A staged version occupies that version number, so reject it before CI publishes.

2. Reject the staged `0.1.0`. This asks for 2FA. The placeholder package remains.

   ```bash
   npm stage list langgraph-checkpoint-durable-object
   npm stage reject <stage-id>
   ```

3. On npmjs.com, open `langgraph-checkpoint-durable-object` → **Settings** → **Trusted Publisher**. Choose **GitHub Actions** and enter:

   | Field                | Value                                 |
   | -------------------- | ------------------------------------- |
   | Organization or user | `lonnylot`                            |
   | Repository           | `langgraph-checkpoint-durable-object` |
   | Workflow filename    | `release.yml`                         |
   | Environment name     | Leave empty                           |
   | Allowed actions      | Allow direct `npm publish`            |

   Enter only the filename, including `.yml`. New publisher configurations already allow `npm stage publish`. This workflow runs `npm publish`, so direct publish has to be enabled as well. Save the publisher.

4. Within 2 days, run the Release workflow on `main`. Merging the commit that contains `.github/workflows/release.yml` starts it. If that run happened before step 3, open the failed run and run it again. The job publishes `0.1.0` with OIDC and provenance. That success validates the trusted publisher. If the 2 days pass with no successful publish, delete the publisher, create it again with the same fields, and publish within the new 2 days.

5. After `0.1.0` is on npm, open **Settings** → **Publishing access** and select **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working. Do this only after step 4 has succeeded.

## Later releases

1. Add a changeset (`npx changeset`) in the pull request that should ship.
2. Merge to `main`. The Release workflow opens a **Version Packages** pull request.
3. Merge that pull request. The same workflow publishes the new version with the trusted publisher from step 3 above.

No npm token is added to GitHub. Protect `main` so releases only move through pull requests. This repository cannot turn that setting on by itself.
