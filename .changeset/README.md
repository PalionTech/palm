# Changesets

Each Markdown file in this folder is a changeset: a note for users about one change, plus the
version bump it needs. Add one with `npx changeset` in any pull request that changes something
users can see. CONTRIBUTING.md explains which bump to pick while palm is on 0.x.

When the "Version Packages" pull request is merged, Changesets turns these files into a
`CHANGELOG.md` entry, bumps the version in `package.json` and deletes them. See
[changesets.dev](https://changesets.dev) for the file format.
