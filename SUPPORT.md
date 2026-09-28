# Getting help with palm

## Where to ask

- **Questions** ("how do I install one skill for Cursor only?", "why did palm pick this
  origin?"): ask in [GitHub Discussions, Q&A](https://github.com/PalionTech/palm/discussions/categories/q-a).
  Check the [documentation](https://paliontech.github.io/palm) first; most answers are there.
- **Ideas** that are not yet a concrete proposal: [Discussions, Ideas](https://github.com/PalionTech/palm/discussions/categories/ideas).
- **Bugs**, meaning palm did something wrong or failed with an error:
  [open an issue](https://github.com/PalionTech/palm/issues/new/choose) with the bug form.
- **Feature requests** with a concrete proposal: open an issue with the feature form.
- **Security problems**: do not post them in public. Follow [SECURITY.md](SECURITY.md).

## What to include

Run these in the directory where the problem happens and paste the output:

```sh
palm --version
palm doctor --json
```

Then add:

- the exact command you ran and its full output, run again with `--verbose`;
- what you expected to happen;
- your OS and Node.js version (`node --version`);
- which harnesses are involved (Claude Code, Codex, Copilot, Cursor);
- the origin repository, if the problem is about one origin.

`palm doctor --json` shows your git and Node.js versions, palm's home directory and cache,
which harnesses palm detects, and whether your origins are reachable. It contains file paths;
remove anything you consider private before posting.

## Response times

palm is maintained by a small team. We read every issue and discussion, usually within a few
working days, but we cannot promise a fix date. A report with a way to reproduce the problem is
the fastest to fix.
