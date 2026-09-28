// Terminal sessions recorded by scripts/capture.mjs for the docs.
//
// A spec runs in a fresh sandbox home (printed as ~) with an empty project at ~/project:
//   name       output file: src/captures/<name>.txt (and <name>.files.txt with `files: true`)
//   origins    fixture origins: test/fixtures/<fixture> is copied to ~/src/<dir> and added with
//              `palm origin add ~/src/<dir> --alias <alias>` before the shown commands (not shown)
//   commands   palm argument lists, run in ~/project and shown with their real output;
//              an argument starting with ~/ is expanded as a shell would
//   files      also record which files under ~/project the shown commands created or changed
//
// Pages include a capture with <Capture name="..." /> and its files with <CaptureTree name="..." />.

export const specs = [
  {
    name: 'palm-help',
    commands: [['--help']],
  },
  {
    name: 'landing',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    commands: [
      ['install', 'agent', 'comment-sicko', '--target', 'claude,codex,copilot,cursor'],
      ['install', 'skill', 'tdd@mattpocock'],
    ],
    files: true,
  },
];
