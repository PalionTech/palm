# Repository rulesets

These files are the source of truth for the rulesets on `PalionTech/palm`. GitHub does not
read them from the repository; apply them with the GitHub API. Both were checked against the
API (created disabled, then deleted) on 2026-09-28.

| File | Protects | Rules |
|---|---|---|
| `main.json` | the default branch | no deletion, no force-push, changes only through a pull request, the `gate` check from `ci.yml` must pass |
| `tags.json` | tags matching `v*` | anyone with write access may create one; only repository admins may move or delete one |

Admins can bypass `main.json` only through a pull request (`bypass_mode: pull_request`), so
nobody pushes to `main` directly, but an admin can still merge a pull request whose checks did
not run.

## Apply after the first push

`main.json` requires a pull request for every change to `main`, so it would block the first
push. Push `main` first, then run from the repository root:

```sh
gh api -X POST repos/PalionTech/palm/rulesets --input .github/rulesets/main.json
gh api -X POST repos/PalionTech/palm/rulesets --input .github/rulesets/tags.json
gh api repos/PalionTech/palm/rulesets   # both should be listed with enforcement "active"
```

To change a ruleset later, edit the file and replace the live one:

```sh
id=$(gh api repos/PalionTech/palm/rulesets --jq '.[] | select(.name == "main") | .id')
gh api -X PUT "repos/PalionTech/palm/rulesets/$id" --input .github/rulesets/main.json
```

## The tag ruleset and automated releases

`release.yml` runs `changesets/action`, which pushes the `v<version>` tag with the workflow's
`GITHUB_TOKEN`. That token acts as the GitHub Actions app, and a repository ruleset cannot list
that app as a bypass actor (the API rejects it). A `creation` rule on `v*` would therefore let
npm publishing succeed and then fail the tag push and the GitHub Release.

For that reason `tags.json` has no `creation` rule. Anyone with write access can create a `v*`
tag, including the release workflow, but only admins can move or delete one. This is enough
while the maintainers are the only people with write access.

To restrict tag creation later, create a GitHub App owned by the PalionTech organization with
`contents: write` and `pull-requests: write`, install it on `palm`, add it to `bypass_actors`
in `tags.json` (`"actor_type": "Integration"`, `"actor_id": <app id>`), add
`{ "type": "creation" }` back to `rules`, and pass a token from
`actions/create-github-app-token` to the `github-token` input of `changesets/action`. Pull
requests opened with an app token also trigger `ci.yml`, which the default `GITHUB_TOKEN` does
not.

## The "Version Packages" pull request

Pull requests opened with `GITHUB_TOKEN` do not start other workflows, so `ci.yml` does not
run on the "Version Packages" pull request and `gate` never reports. Close and reopen the pull
request to run CI, or merge it with the admin bypass. The GitHub App token described above
removes this step.
