#!/usr/bin/env bash
# End-to-end check of palm 0.2 against real public repositories (network required).
#
#   scripts/e2e.sh
#
# Every run builds dist/ (unless PALM_BIN is set), creates a fresh sandbox and points HOME /
# PALM_HOME into it, so the real ~/.palm, ~/.claude, ~/.codex, ~/.copilot, ~/.cursor, ~/.gemini,
# ~/.config/opencode and ~/.claude.json are never touched. Prints PASS/FAIL per step; exits 1
# when any step failed.
#
# Sources: mattpocock/skills, obra/superpowers, trailofbits/skills, anthropics/skills, the APM
# package microsoft/apm-sample-package, and one in-repo source (./agent-kit). The last steps
# commit a project, clone it into a machine that never ran palm, and run the CI gate there.
#
# Environment:
#   PALM_E2E_ROOT     where run-XXXXXX sandboxes are created   (default: ${TMPDIR:-/tmp}/palm-e2e)
#   PALM_BIN          palm executable to test, e.g. `palm` from a global install of the packed
#                     tarball (resolved via PATH); step 00 then smoke-tests it instead of building
#   PALM_E2E_KEEP=1   keep the sandbox after a fully passing run
#   PALM_E2E_TSX=1    run the TypeScript sources through tsx instead of dist/cli.js
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_HOME="$HOME"
PALM_BIN="${PALM_BIN:-}"
if [[ -n "$PALM_BIN" ]]; then
  PALM_BIN="$(command -v "$PALM_BIN")" || { echo "PALM_BIN not found on PATH" >&2; exit 99; }
fi
ROOT="${PALM_E2E_ROOT:-${TMPDIR:-/tmp}/palm-e2e}"
mkdir -p "$ROOT"
SB="$(cd "$(mktemp -d "$ROOT/run-XXXXXX")" && pwd -P)"

# --- sandbox -----------------------------------------------------------------------------
export HOME="$SB/home"
export PALM_HOME="$SB/home/.palm"
unset CLAUDE_CONFIG_DIR CODEX_HOME COPILOT_HOME XDG_CONFIG_HOME GEMINI_CLI_HOME OPENCODE_DISABLE_EXTERNAL_SKILLS
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export CI=1 NO_COLOR=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=palm-e2e GIT_AUTHOR_EMAIL=e2e@palm.invalid
export GIT_COMMITTER_NAME=palm-e2e GIT_COMMITTER_EMAIL=e2e@palm.invalid
if [[ "$HOME" == "$REAL_HOME" || "$HOME" != "$SB/"* ]]; then
  echo "refusing to run: HOME=$HOME is not inside the sandbox $SB" >&2
  exit 99
fi
P1="$SB/proj"    # claude + codex project (the team project that CI checks)
P4="$SB/proj4"   # claude + codex + copilot + cursor project
P5="$SB/proj5"   # gemini + opencode project
C1="$SB/clone"   # P1 cloned on a machine that never ran palm
mkdir -p "$HOME" "$P1/.claude" "$P1/.codex" "$P4/.claude" "$P4/.codex" "$P4/.cursor" "$P4/.github"
mkdir -p "$P5/.gemini" "$P5/.opencode"
: >"$P4/.github/copilot-instructions.md"
# Each project is its own git root, so palm never climbs into an enclosing repository.
git init -q -b main "$P1"
git init -q -b main "$P4"
git init -q -b main "$P5"

LOG="$SB/e2e.log"
: >"$LOG"
echo "palm e2e sandbox: $SB"
echo "log: $LOG"

# --- helpers -----------------------------------------------------------------------------
palm() {
  if [[ "$HOME" != "$SB/home"* || "$PALM_HOME" != "$HOME/.palm" ]]; then
    echo "unsafe environment: HOME=$HOME PALM_HOME=$PALM_HOME" >&2
    exit 99
  fi
  if [[ -n "$PALM_BIN" ]]; then
    "$PALM_BIN" "$@"
  elif [[ "${PALM_E2E_TSX:-}" == 1 ]]; then
    "$REPO/node_modules/.bin/tsx" "$REPO/src/cli.ts" "$@"
  else
    node "$REPO/dist/cli.js" "$@"
  fi
}
# Run palm in a project directory; output goes to the step log and into $OUT.
OUT=""
run() {
  local dir="$1"
  shift
  echo "\$ (cd ${dir#"$SB"/} && palm $*)"
  OUT="$(cd "$dir" && palm "$@" 2>&1)" || { echo "$OUT"; fail "palm $* exited non-zero"; }
  echo "$OUT"
}
# Like run, but the command must exit with the given code; $OUT has its output.
run_exit() {
  local want="$1" dir="$2"
  shift 2
  echo "\$ (cd ${dir#"$SB"/} && palm $*)   # expected to exit $want"
  local rc=0
  OUT="$(cd "$dir" && palm "$@" 2>&1)" || rc=$?
  echo "$OUT"
  [[ $rc -eq $want ]] || fail "palm $* exited $rc, expected $want"
}
fail() {
  echo "ASSERTION FAILED: $*" >&2
  exit 1
}
has() { grep -qF -- "$1" <<<"$OUT" || fail "output lacks: $1"; }
lacks() { if grep -qF -- "$1" <<<"$OUT"; then fail "output unexpectedly contains: $1"; fi; }
first_line() { [[ "$(head -1 <<<"$OUT")" == "$1" ]] || fail "first line is: $(head -1 <<<"$OUT")"; }
file() { [[ -f "$1" ]] || fail "missing file ${1#"$SB"/}"; }
nofile() { [[ ! -e "$1" ]] || fail "should not exist: ${1#"$SB"/}"; }
contains() { grep -qF -- "$2" "$1" || fail "${1#"$SB"/} does not contain: $2"; }
lacks_in() { if grep -qF -- "$2" "$1"; then fail "${1#"$SB"/} contains: $2"; fi; }
# The --allow-exec value an E_UNTRUSTED_EXEC error printed on its `then:` line.
allow_exec() { sed -n 's/^ *then: .*--allow-exec \([^ ]*\).*$/\1/p' <<<"$OUT" | tail -1; }
# js FILE 'expression over d' — d is the parsed JSON (or TOML with js_toml, YAML with js_yaml).
js() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!(eval(process.argv[2]))) process.exit(1)' "$1" "$2" || fail "${1#"$SB"/}: expected $2"; }
js_toml() { (cd "$REPO" && node --input-type=module -e 'import {parse} from "smol-toml"; import fs from "node:fs"; const d=parse(fs.readFileSync(process.argv[1],"utf8")); if(!(eval(process.argv[2]))) process.exit(1)' "$1" "$2") || fail "${1#"$SB"/}: expected $2"; }
js_yaml() { (cd "$REPO" && node --input-type=module -e 'import {parse} from "yaml"; import fs from "node:fs"; const d=parse(fs.readFileSync(process.argv[1],"utf8")); if(!(eval(process.argv[2]))) process.exit(1)' "$1" "$2") || fail "${1#"$SB"/}: expected $2"; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
# Invariant 1: no absolute path, home directory or hostname in palm.yaml or the lock.
portable() {
  local f
  for f in "$@"; do
    [[ -f "$f" ]] || continue
    lacks_in "$f" "$SB"
    lacks_in "$f" "$(hostname)"
  done
}

# Commit what palm wrote: check warns on untracked outputs. Nothing to commit is fine.
commit_all() {
  (cd "$1" && git add -A && { git diff --cached --quiet || git commit -q -m "$2"; }) || fail "commit failed"
}

RESULTS=()
FAILED=0
step() {
  local name="$1"
  shift
  set +e
  (
    set -euo pipefail
    "$@"
  ) >"$SB/step.out" 2>&1
  local rc=$?
  set -e
  { printf '\n### %s (exit %s)\n' "$name" "$rc"; cat "$SB/step.out"; } >>"$LOG"
  if [[ $rc -eq 0 ]]; then
    RESULTS+=("PASS  $name")
    echo "PASS  $name"
  else
    RESULTS+=("FAIL  $name")
    FAILED=$((FAILED + 1))
    echo "FAIL  $name"
    tail -25 "$SB/step.out" | sed 's/^/      /'
  fi
}

# --- steps -------------------------------------------------------------------------------
s00_build() {
  if [[ -z "$PALM_BIN" ]]; then
    (cd "$REPO" && npm run build --silent >/dev/null 2>&1) || fail "npm run build failed"
    head -1 "$REPO/dist/cli.js" | grep -qx '#!/usr/bin/env node' || fail "dist/cli.js has no shebang"
    [[ -x "$REPO/dist/cli.js" ]] || fail "dist/cli.js is not executable"
  fi
  local bin="${PALM_BIN:-$REPO/dist/cli.js}"
  OUT="$("$bin" --version)"
  [[ "$OUT" == "$(node -p "require('$REPO/package.json').version")" ]] || fail "$bin --version printed $OUT"
  OUT="$(palm --help)"
  has "install (add, i)"
  has "remove (uninstall, rm)"
  has "Verbs:"
  has "Utilities:"
  has "Kinds:"
  lacks "origin"
  OUT="$(palm install --help)"
  has "--all"
  has "--snippet"
  palm completion bash | bash -n || fail "palm completion bash is not valid bash"
}

s01_onboarding_errors() {
  # PLAN.md 4.9: a word that is no repository fails with the fix on line one; no network.
  run_exit 2 "$P1" install superpowers
  first_line 'x "superpowers" is not a repository. palm installs from git repositories:'
  has "palm install obra/superpowers"
  run_exit 2 "$P1" install tdd
  has "palm install mattpocock/skills tdd"
  lacks "origin"
  nofile "$P1/palm.yaml"
}

s02_list_saves_nothing() {
  run "$P1" install obra/superpowers
  has "Nothing written. Install some:"
  has "palm install obra/superpowers --all"
  has "(a program; asks before installing)"
  run "$P1" install anthropics/skills
  has "skill  pdf"
  run "$P1" install microsoft/apm-sample-package
  has "agent        design-reviewer"
  # L15: the index notes for maintainers are one count line (details under PALM_DEBUG).
  has "notes from indexing microsoft/apm-sample-package"
  nofile "$P1/palm.yaml"
  nofile "$P1/palm.lock.yaml"
}

s03_named_skills() {
  run "$P1" install mattpocock/skills tdd grill-with-docs
  has "saved to palm.yaml (latest tag"
  has "targets: claude, codex"
  has "+ skill  tdd"
  file "$P1/.claude/skills/tdd/SKILL.md"
  file "$P1/.agents/skills/tdd/SKILL.md"
  file "$P1/.claude/skills/grill-with-docs/SKILL.md"
  js_yaml "$P1/palm.yaml" 'd.sources["mattpocock/skills"].ref.startsWith("^") && d.sources["mattpocock/skills"].skills.includes("tdd")'
  js_yaml "$P1/palm.lock.yaml" 'd.version === 3 && /^[0-9a-f]{40}$/.test(d.sources["mattpocock/skills"].sha)'
  js_yaml "$P1/palm.lock.yaml" 'd.entries.find(e => e.name === "tdd").render.claude.startsWith("sha256:")'
  portable "$P1/palm.yaml" "$P1/palm.lock.yaml"
  # A second run is a no-op.
  run "$P1" install mattpocock/skills tdd
  has "= skill  tdd"
}

s04_all_leaves_programs_out() {
  run "$P1" install obra/superpowers --all
  has "! hook"
  has "runs a program on your machine; not installed"
  has "see it:      palm install obra/superpowers"
  has "install it:  palm install obra/superpowers"
  file "$P1/.claude/skills/brainstorming/SKILL.md"
  nofile "$P1/.claude/settings.json"
  # D28: the program left out is excluded on the plugin entry in palm.yaml; the lock has no entry for it.
  js_yaml "$P1/palm.lock.yaml" '!d.entries.some(e => e.kind === "hook" && e.source === "obra/superpowers")'
  js_yaml "$P1/palm.yaml" 'd.sources["obra/superpowers"].plugins.length === 1'
  js_yaml "$P1/palm.yaml" 'd.sources["obra/superpowers"].plugins[0].exclude.includes("hook:superpowers")'
  # Declined stays quiet: a bare install does not ask again and changes nothing.
  run "$P1" install
  lacks "not installed"
  lacks "consent"
}

s05_program_consent() {
  # No terminal: the prompt is an error naming the review command and the full-hash line.
  run_exit 1 "$P1" install trailofbits/skills hook:gh-cli
  has "This install adds 1 program that will run on your machine."
  has "x 1 program needs your consent and there is no terminal"
  has "review:  palm install trailofbits/skills hook:gh-cli --dry-run --review"
  local allow
  allow="$(allow_exec)"
  [[ "$allow" =~ ^hook:gh-cli@trailofbits/skills=sha256:[0-9a-f]{64}$ ]] || fail "no full-hash --allow-exec line: $allow"
  # --yes never consents.
  run_exit 1 "$P1" install trailofbits/skills hook:gh-cli --yes
  nofile "$P1/.claude/settings.json"
  run "$P1" install trailofbits/skills hook:gh-cli --allow-exec "$allow"
  has "+ hook  gh-cli"
  local assets="$P1/.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks"
  file "$assets/persist-session-id.sh"
  [[ "$(mode_of "$assets/persist-session-id.sh")" == 755 ]] || fail "hook script lost its mode"
  js "$P1/.claude/settings.json" 'JSON.stringify(d.hooks.SessionStart).includes(".palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/persist-session-id.sh")'
  js_yaml "$P1/palm.lock.yaml" '(e => e.trust.includes(e.exec.hash))(d.entries.find(e => e.name === "gh-cli"))'
  # Trusted: replayed silently; unchanged entries are one count line (K21).
  run "$P1" install
  has " unchanged."
  lacks "consent"
  lacks "not installed"
}

s06_four_targets() {
  run "$P4" install anthropics/skills pdf
  has "targets: claude, codex, copilot, cursor"
  file "$P4/.claude/skills/pdf/SKILL.md"
  file "$P4/.agents/skills/pdf/SKILL.md"
  nofile "$P4/.cursor/skills"
  run "$P4" install mcp docs --url https://example.com/mcp --header 'Authorization=Bearer ${DOCS_TOKEN}'
  js "$P4/.vscode/mcp.json" 'd.servers.docs.headers.Authorization === "Bearer ${env:DOCS_TOKEN}"'
  js "$P4/.cursor/mcp.json" 'd.mcpServers.docs.headers.Authorization === "Bearer ${env:DOCS_TOKEN}"'
  js "$P4/.mcp.json" 'd.mcpServers.docs.headers.Authorization === "Bearer ${DOCS_TOKEN}"'
  js_toml "$P4/.codex/config.toml" 'd.mcp_servers.docs.bearer_token_env_var === "DOCS_TOKEN"'
  js_yaml "$P4/palm.yaml" 'd.mcp.docs.url === "https://example.com/mcp"'
  # A README snippet from stdin; a stdio server is a program and needs consent.
  OUT="$(cd "$P4" && printf '%s' '{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }' | palm install mcp --snippet - 2>&1)" && fail "a stdio server installed without consent"
  echo "$OUT"
  has "mcp:fs@manifest="
  local allow
  allow="$(allow_exec)"
  OUT="$(cd "$P4" && printf '%s' '{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }' | palm install mcp --snippet - --allow-exec "$allow" 2>&1)" || { echo "$OUT"; fail "install mcp --snippet failed"; }
  echo "$OUT"
  js "$P4/.mcp.json" 'd.mcpServers.fs.command === "npx"'
  run "$P4" get mcp
  has "docs"
  has "DOCS_TOKEN"
  run "$P4" remove docs
  js "$P4/.mcp.json" '!d.mcpServers.docs && !!d.mcpServers.fs'
  lacks_in "$P4/palm.yaml" "docs:"
  portable "$P4/palm.yaml" "$P4/palm.lock.yaml"
}

s07_apm_gemini_opencode() {
  run "$P5" install microsoft/apm-sample-package --all
  has "targets: gemini, opencode"
  file "$P5/.agents/skills/accessibility-audit/SKILL.md"
  file "$P5/.gemini/agents/design-reviewer.md"
  file "$P5/.opencode/agents/design-reviewer.md"
  contains "$P5/.opencode/agents/design-reviewer.md" "mode: subagent"
  contains "$P5/GEMINI.md" "<!-- palm:begin instruction:design-standards -->"
  file "$P5/.opencode/instructions/design-standards.md"
  js "$P5/opencode.json" 'd.instructions.includes(".opencode/instructions/design-standards.md")'
  # The package installed as a plugin: a member leaves it for the team with --exclude.
  run_exit 1 "$P5" remove design-standards
  has "palm remove microsoft/apm-sample-package design-standards --exclude"
  run "$P5" remove microsoft/apm-sample-package design-standards --exclude
  nofile "$P5/GEMINI.md"
  nofile "$P5/.opencode/instructions"
  nofile "$P5/opencode.json"
}

s08_in_repo_source() {
  run "$P1" create skill review
  has "+ source ./agent-kit → palm.yaml"
  file "$P1/agent-kit/skills/review/SKILL.md"
  file "$P1/.claude/skills/review/SKILL.md"
  run_exit 1 "$P1" create hook quality
  local allow
  allow="$(allow_exec)"
  run "$P1" create hook quality --allow-exec "$allow"
  js "$P1/.claude/settings.json" 'JSON.stringify(d.hooks.SessionStart).includes("agent-kit/hooks/quality/scripts/quality.sh")'
  nofile "$P1/.palm/assets/agent-kit"
  # The source is the truth: an edit fails check until a bare install re-renders it.
  echo "Be thorough." >>"$P1/agent-kit/skills/review/SKILL.md"
  run_exit 1 "$P1" check
  has "changed since palm.lock.yaml"
  run "$P1" install
  has "1 re-rendered"
  contains "$P1/.claude/skills/review/SKILL.md" "Be thorough."
  # Untracked outputs warn in check: commit what palm wrote first.
  commit_all "$P1" "in-repo source"
  run "$P1" check
  has "no problems"
}

s09_get_describe() {
  run "$P1" get
  has "tdd"
  has "gh-cli"
  run "$P1" get sources
  has "mattpocock/skills"
  has "./agent-kit"
  run "$P1" get targets
  has "claude"
  run "$P1" get --files
  has ".claude/skills/tdd/SKILL.md"
  run "$P1" describe skill tdd
  has "mattpocock/skills"
  run "$P1" describe .claude/skills/tdd/SKILL.md
  has "tdd"
  run "$P1" describe hook gh-cli
  has "trusted"
  run "$P1" check --json
  node -e 'const d=JSON.parse(process.argv[1]); if (!d.ok || !Array.isArray(d.checks)) process.exit(1)' "$OUT" || fail "check --json is not one ok document"
}

s10_update() {
  run "$P1" update --dry-run
  run "$P1" update mattpocock/skills --to v1.2.0 --yes
  js_yaml "$P1/palm.yaml" 'd.sources["mattpocock/skills"].ref === "v1.2.0"'
  js_yaml "$P1/palm.lock.yaml" 'd.sources["mattpocock/skills"].ref === "v1.2.0"'
  run "$P1" update mattpocock/skills --to ^1.2 --yes
  js_yaml "$P1/palm.yaml" 'd.sources["mattpocock/skills"].ref === "^1.2"'
  commit_all "$P1" "update"
  run "$P1" check
  has "no problems"
}

s11_ci_clean_clone() {
  commit_all "$P1" "palm setup"
  git clone -q "$P1" "$C1"
  # A machine that never ran palm: another home, no cache.
  HOME="$SB/home2" PALM_HOME="$SB/home2/.palm"
  export HOME PALM_HOME
  mkdir -p "$HOME"
  run "$C1" check
  has "no problems"
  # Invariant 3: on a clean clone a bare install writes neither palm.yaml nor the lock.
  run "$C1" install
  lacks "+ "
  [[ -z "$(cd "$C1" && git status --porcelain)" ]] || fail "bare install on a clean clone changed files: $(cd "$C1" && git status --porcelain)"
  # Drift is caught; a bare install restores a deleted file.
  rm "$C1/.claude/skills/tdd/SKILL.md"
  run_exit 1 "$C1" check
  has "is missing"
  run "$C1" install
  has "↺"
  file "$C1/.claude/skills/tdd/SKILL.md"
  [[ -z "$(cd "$C1" && git status --porcelain)" ]] || fail "restore left changes: $(cd "$C1" && git status --porcelain)"
  # An edited file is kept and fails.
  echo "edited" >>"$C1/.claude/skills/tdd/SKILL.md"
  run_exit 1 "$C1" install
  has "modified (kept)"
  contains "$C1/.claude/skills/tdd/SKILL.md" "edited"
  (cd "$C1" && git checkout -q -- .)
}

s12_remove() {
  run_exit 1 "$P1" remove brainstorming
  has "--exclude"
  run "$P1" remove obra/superpowers brainstorming --exclude
  nofile "$P1/.claude/skills/brainstorming"
  js_yaml "$P1/palm.yaml" 'd.sources["obra/superpowers"].plugins[0].exclude.includes("skill:brainstorming")'
  run "$P1" remove gh-cli
  nofile "$P1/.palm/assets/trailofbits__skills"
  lacks_in "$P1/.claude/settings.json" "gh-cli"
  run "$P1" remove gh-cli
  has "is not installed"
  run "$P1" remove quality review
  nofile "$P1/.claude/skills/review"
  run "$P1" check
  has "no problems"
}

s13_global() {
  # No harness home yet: the error names the init line; with ~/.claude, claude is detected.
  run_exit 2 "$P1" install -g mattpocock/skills tdd
  has "palm init --target claude -g"
  mkdir -p "$HOME/.claude"
  run "$P1" install -g mattpocock/skills tdd
  file "$HOME/.claude/skills/tdd/SKILL.md"
  file "$PALM_HOME/palm.yaml"
  file "$PALM_HOME/applied.yaml"
  contains "$PALM_HOME/palm.lock.yaml" "<claude>/skills/tdd/SKILL.md"
  portable "$PALM_HOME/palm.yaml" "$PALM_HOME/palm.lock.yaml"
  run "$P1" check -g
  has "no problems"
  run "$P1" remove -g tdd
  nofile "$HOME/.claude/skills/tdd"
}

s14_old_format() {
  # A palm 0.1 project on a machine with the 0.1 ~/.palm/config.yaml.
  HOME="$SB/home3" PALM_HOME="$SB/home3/.palm"
  export HOME PALM_HOME
  local old="$SB/old" sha
  mkdir -p "$old/.claude" "$PALM_HOME"
  git init -q -b main "$old"
  sha="$(git ls-remote https://github.com/mattpocock/skills.git 'refs/tags/v1.2.3^{}' | cut -f1)"
  printf 'origins:\n  - alias: mattpocock\n    type: git\n    url: https://github.com/mattpocock/skills.git\n' >"$PALM_HOME/config.yaml"
  printf 'targets: [claude]\nskills:\n  - tdd@mattpocock\n' >"$old/palm.yaml"
  printf 'version: 2\nentries:\n  - { kind: skill, name: tdd, origin: mattpocock, ref: v1.2.3, sha: %s, path: skills/engineering/tdd, targets: [claude] }\n' "$sha" >"$old/palm.lock.yaml"
  run_exit 2 "$old" install
  first_line "x palm.yaml is in the 0.1 format"
  has "palm migrate"
  run "$old" migrate --dry-run
  has "mattpocock/skills"
  run "$old" migrate
  file "$old/.claude/skills/tdd/SKILL.md"
  js_yaml "$old/palm.lock.yaml" 'd.version === 3'
  commit_all "$old" "palm migrate"
  run "$old" check
  has "no problems"
}

s15_real_home_untouched() {
  [[ "$(find "$REAL_HOME/.palm" -newer "$LOG" -print -quit 2>/dev/null)" == "" ]] || fail "the real ~/.palm changed during the run"
}

# --- run ---------------------------------------------------------------------------------
if [[ -n "$PALM_BIN" ]]; then
  step "00 installed palm smoke ($PALM_BIN: --version, --help, install --help)" s00_build
else
  step "00 build + dist smoke (shebang, --version, --help, install --help)" s00_build
fi
step "01 onboarding: a bare word fails with the fix on line one" s01_onboarding_errors
step "02 install <source> lists and saves nothing (superpowers, anthropics, APM package)" s02_list_saves_nothing
step "03 install mattpocock/skills tdd grill-with-docs → claude + codex" s03_named_skills
step "04 install obra/superpowers --all leaves the program out; bare install quiet" s04_all_leaves_programs_out
step "05 trailofbits gh-cli hook: consent error, --yes never consents, --allow-exec" s05_program_consent
step "06 four targets: anthropics/skills pdf, mcp by flags and by --snippet" s06_four_targets
step "07 APM package --all into gemini + opencode, remove an instruction" s07_apm_gemini_opencode
step "08 in-repo source: create skill and hook, drift fails check, bare install re-renders" s08_in_repo_source
step "09 get, get sources/targets/--files, describe, check --json" s09_get_describe
step "10 update --dry-run, update --to moves the ref and back" s10_update
step "11 CI: clean clone passes check, bare install writes nothing, restores, keeps edits" s11_ci_clean_clone
step "12 remove: plugin member --exclude, hook with assets, absent, in-repo entities" s12_remove
step "13 global scope: tokens in the lock, applied.yaml, remove" s13_global
step "14 a 0.1 palm.yaml points at palm migrate" s14_old_format
step "15 real home untouched" s15_real_home_untouched

echo
echo "== summary =="
printf '%s\n' "${RESULTS[@]}"
if [[ $FAILED -gt 0 ]]; then
  echo "$FAILED step(s) failed; sandbox kept at $SB (log: $LOG)"
  exit 1
fi
if [[ "${PALM_E2E_KEEP:-}" != 1 ]]; then
  rm -rf "$SB"
  echo "all steps passed; sandbox removed"
else
  echo "all steps passed; sandbox kept at $SB"
fi
