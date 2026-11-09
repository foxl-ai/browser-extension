# Releasing

One dispatch does the whole release, the Chrome Web Store included:

```sh
gh workflow run release.yml --repo foxl-ai/browser-extension -f version=X.Y.Z
```

It checks the version against `manifest.json` and `CHANGELOG.md`, audits, tests, builds the
reproducible zip, tags `vX.Y.Z`, publishes the GitHub release, then uploads the zip to the store
and submits it for review (`publish=false` leaves a draft instead). The store publishes on approval.
Review runs after the workflow ends and never blocks it.

Afterwards, ask the store where the item stands (read-only):

```sh
gh workflow run cws-status.yml --repo foxl-ai/browser-extension
```

## How the store step signs in

- **Who:** the publisher's service account `foxl-cws-publisher@foxl-489707.iam.gserviceaccount.com`
  (Google Cloud project `foxl-489707`, Chrome Web Store API enabled). It holds no Google Cloud role.
  It is added in the Developer Dashboard under Settings > Service accounts; a publisher can have one.
- **Where the key lives:** the `chrome-web-store` environment of this repository. The secret is
  `CWS_SERVICE_ACCOUNT_JSON`; the variables are `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID`. Only `main`
  can use the environment, so no pull request workflow can read the key.
- **What it calls:** `scripts/cws-publish.mjs`, with no dependency. Its header cites the source of every
  wire constant (the v2 upload, fetchStatus and publish methods, and the token exchange).

## What still needs a person in the dashboard

- A NEW permission, or a new kind of data the extension handles, needs its justification or its
  privacy disclosure filled in the dashboard once. Until then the submit fails, and the workflow says so.
- Rotating the key: in the Cloud console, create a new JSON key for the account, put it in the
  environment secret, run `cws-status.yml`, then delete the old key.
