#!/usr/bin/env bash
# End-to-end check of palm against real public repositories (network required).
#
#   scripts/e2e.sh
#
# Every run builds dist/ (unless PALM_BIN is set), creates a fresh sandbox and points HOME /
# PALM_HOME into it, so the real ~/.palm, ~/.claude, ~/.codex, ~/.copilot, ~/.cursor and
# ~/.claude.json are never touched. Prints PASS/FAIL per step; exits 1 when any step failed.
#
# Environment:
#   PALM_E2E_ROOT     where run-XXXXXX sandboxes are created   (default: ${TMPDIR:-/tmp}/palm-e2e)
#   PALM_E2E_CATALOG  marketplace.json for the import step     (no default; skipped when unset)
#   PALM_BIN          palm executable to test, e.g. `palm` from a global install of the packed
#                     tarball (resolved via PATH); step 00 then smoke-tests it instead of building
#   PALM_E2E_KEEP=1   keep the sandbox after a fully passing run
#   PALM_E2E_TSX=1    run the TypeScript sources through tsx instead of dist/cli.js
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_HOME="$HOME"
CATALOG="${PALM_E2E_CATALOG:-}"
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
unset CLAUDE_CONFIG_DIR CODEX_HOME COPILOT_HOME XDG_CONFIG_HOME
export CI=1 NO_COLOR=1 GIT_TERMINAL_PROMPT=0
if [[ "$HOME" == "$REAL_HOME" || "$HOME" != "$SB/"* ]]; then
  echo "refusing to run: HOME=$HOME is not inside the sandbox $SB" >&2
  exit 99
fi
P1="$SB/proj"    # claude + codex project
P4="$SB/proj4"   # claude + codex + copilot + cursor project
mkdir -p "$HOME" "$P1/.claude" "$P1/.codex" "$P4/.claude" "$P4/.codex" "$P4/.cursor" "$P4/.github"
: >"$P4/.github/copilot-instructions.md"
# Each project is its own git root, so palm never climbs into an enclosing repository.
git init -q "$P1"
git init -q "$P4"

LOG="$SB/e2e.log"
: >"$LOG"
echo "palm e2e sandbox: $SB"
echo "log: $LOG"

# --- helpers -----------------------------------------------------------------------------
palm() {
  if [[ "$HOME" != "$SB/home" || "$PALM_HOME" != "$SB/home/.palm" ]]; then
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
# Like run, but the command must fail; $OUT has its output.
run_fails() {
  local dir="$1"
  shift
  echo "\$ (cd ${dir#"$SB"/} && palm $*)   # expected to fail"
  if OUT="$(cd "$dir" && palm "$@" 2>&1)"; then
    echo "$OUT"
    fail "palm $* succeeded but should have failed"
  fi
  echo "$OUT"
}
fail() {
  echo "ASSERTION FAILED: $*" >&2
  exit 1
}
has() { grep -qF -- "$1" <<<"$OUT" || fail "output lacks: $1"; }
lacks() { if grep -qF -- "$1" <<<"$OUT"; then fail "output unexpectedly contains: $1"; fi; }
file() { [[ -f "$1" ]] || fail "missing file ${1#"$SB"/}"; }
nofile() { [[ ! -e "$1" ]] || fail "should not exist: ${1#"$SB"/}"; }
contains() { grep -qF -- "$2" "$1" || fail "${1#"$SB"/} does not contain: $2"; }
# js FILE 'expression over d' — d is the parsed JSON (or TOML with js_toml, YAML with js_yaml).
js() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!(eval(process.argv[2]))) process.exit(1)' "$1" "$2" || fail "${1#"$SB"/}: expected $2"; }
js_toml() { (cd "$REPO" && node --input-type=module -e 'import {parse} from "smol-toml"; import fs from "node:fs"; const d=parse(fs.readFileSync(process.argv[1],"utf8")); if(!(eval(process.argv[2]))) process.exit(1)' "$1" "$2") || fail "${1#"$SB"/}: expected $2"; }
js_yaml() { (cd "$REPO" && node --input-type=module -e 'import {parse} from "yaml"; import fs from "node:fs"; const d=parse(fs.readFileSync(process.argv[1],"utf8")); if(!(eval(process.argv[2]))) process.exit(1)' "$1" "$2") || fail "${1#"$SB"/}: expected $2"; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

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
skip() {
  RESULTS+=("SKIP  $1 ($2)")
  echo "SKIP  $1 ($2)"
}

# --- steps -------------------------------------------------------------------------------
s00_build() {
  if [[ -z "$PALM_BIN" ]]; then
    (cd "$REPO" && npm run build --silent >/dev/null 2>&1) || fail "npm run build failed"
    head -1 "$REPO/dist/cli.js" | grep -qx '#!/usr/bin/env node' || fail "dist/cli.js has no shebang"
    [[ -x "$REPO/dist/cli.js" ]] || fail "dist/cli.js is not executable"
    OUT="$("$REPO/node_modules/.bin/tsx" "$REPO/src/cli.ts" --version)"
    [[ -n "$OUT" ]] || fail "tsx src/cli.ts --version printed nothing"
  fi
  local bin="${PALM_BIN:-$REPO/dist/cli.js}"
  OUT="$("$bin" --version)"
  [[ "$OUT" == "$(node -p "require('$REPO/package.json').version")" ]] || fail "$bin --version printed $OUT"
  OUT="$(palm --help)"
  has "install (add, i)"
  has "Verbs:"
  has "Utilities:"
  OUT="$(palm install --help)"
  has "palm install mcp fs -- npx"
  has "--url https://example.com/mcp"
  has "name[@origin][#ref]"
  palm completion bash | bash -n || fail "palm completion bash is not valid bash"
}

s01_origins() {
  run "$P1" install origin mattpocock/skills
  has "+ origin mattpocock"
  run "$P1" install origin obra/superpowers
  has "+ origin superpowers"
  run "$P1" install origin cursor/plugins/pstack --alias pstack
  has "+ origin pstack"
  run "$P1" install origin anthropics/skills
  has "+ origin anthropics"
  run "$P1" install origin openai/skills
  has "+ origin openai"
  # Auto-detection must see skills/.curated (a dot directory)...
  run "$P1" describe skill gh-fix-ci@openai
  has "skills/.curated/gh-fix-ci"
  # ...and a layout descriptor narrows an origin to exactly what it names.
  run "$P1" install origin openai/skills --alias openai-curated --layout 'skills=skills/.curated/*'
  has "detected: descriptor"
  js_yaml "$PALM_HOME/config.yaml" 'd.origins.find(o => o.alias === "openai-curated").layout.skills[0] === "skills/.curated/*"'
  # A repository that cannot be fetched is never saved (fetch and index come first).
  run_fails "$P1" install origin anthropic/palm-e2e-no-such-repo
  has "was not added"
  js_yaml "$PALM_HOME/config.yaml" '!d.origins.some(o => o.alias === "palm-e2e-no-such-repo" || o.alias === "anthropic")'
  run "$P1" get skills --available --json
  node -e '
    const g = JSON.parse(process.argv[1]).items; const n = (a) => g.find((x) => x.origin === a).entities.length;
    if (!(n("openai-curated") > 30 && n("openai-curated") < n("openai"))) process.exit(1);
    if (!g.find((x) => x.origin === "openai-curated").entities.every((e) => e.path.startsWith("skills/.curated/"))) process.exit(1);
  ' "$OUT" || fail "openai-curated should hold only skills/.curated/* (fewer than auto-detected openai)"
  run "$P1" get origins
  has "mattpocock"
  has "v1."   # latest semver tag of mattpocock/skills
  run "$P1" get origins --verbose
  has "detected: marketplace"
  has "detected: descriptor"
  run "$P1" describe origin mattpocock
  has "https://github.com/mattpocock/skills.git"
  has "index file"
  # the old grammar still works
  run "$P1" origin list
  has "pstack"
}

s02_import() {
  local before after
  before="$(cd "$(dirname "$(dirname "$CATALOG")")" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum)"
  run "$P1" install origin "$CATALOG" -y
  has "local-skills"
  has "caveman-skill"
  has "last30days-skill"
  has "superpowers: already registered as superpowers"
  has "mattpocock-skills: already registered as mattpocock"
  has "pstack: already registered as pstack"
  js_yaml "$PALM_HOME/config.yaml" 'd.origins.find(o => o.alias === "local-skills").type === "local" && d.origins.find(o => o.alias === "local-skills").path === "'"$(dirname "$(dirname "$CATALOG")")"'"'
  js_yaml "$PALM_HOME/config.yaml" 'd.origins.find(o => o.alias === "caveman-skill").root === "skills/caveman"'
  js_yaml "$PALM_HOME/config.yaml" '!d.origins.some(o => o.alias === "mattpocock-skills")'
  run "$P1" get origins
  has "local-skills"
  lacks "not indexed"
  after="$(cd "$(dirname "$(dirname "$CATALOG")")" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum)"
  [[ "$before" == "$after" ]] || fail "the local catalog directory was modified"
}

s03_search() {
  run "$P1" search tdd
  has "mattpocock"
  has "pstack"
  run "$P1" search unslop
  has "unslop"
  has "pstack"
  run "$P1" search mcp context7
  has "io.github.upstash/context7"
  run "$P1" get --available
  has "mattpocock ("
  has "pstack ("
  has "superpowers ("
}

s04_install_skill() {
  run "$P1" install skill unslop -y
  has "installed"
  file "$P1/.claude/skills/unslop/SKILL.md"
  file "$P1/.agents/skills/unslop/SKILL.md"
  js_yaml "$P1/palm.lock.yaml" 'd.entries.some(e => e.kind === "skill" && e.name === "unslop" && e.origin === "pstack")'
}

s05_ambiguous() {
  run_fails "$P1" install skill tdd -y --json
  has '"code": "E_AMBIGUOUS"'
  has "tdd@mattpocock"
  has "tdd@pstack"
  run "$P1" install skill tdd@mattpocock -y
  file "$P1/.claude/skills/tdd/SKILL.md"
  contains "$P1/palm.yaml" "tdd@mattpocock"
}

s06_plural() {
  run "$P1" install skills grill-me wayfinder -y
  file "$P1/.claude/skills/grill-me/SKILL.md"
  file "$P1/.claude/skills/wayfinder/SKILL.md"
  file "$P1/.agents/skills/wayfinder/SKILL.md"
}

s07_agent() {
  run "$P1" install agent comment-sicko -y
  file "$P1/.claude/agents/comment-sicko.md"
  file "$P1/.codex/agents/comment-sicko.toml"
  js_toml "$P1/.codex/agents/comment-sicko.toml" 'd.name === "comment-sicko" && d.developer_instructions.length > 100'
  js_yaml "$P1/palm.lock.yaml" 'd.entries.some(e => e.kind === "agent" && e.name === "comment-sicko" && e.origin === "pstack")'
}

s08_plugin_hooks() {
  printf '{"permissions":{"allow":["Bash(ls:*)"]}}\n' >"$P1/.claude/settings.json"
  run "$P1" install plugin superpowers -y
  js "$P1/.claude/settings.json" 'd.permissions.allow[0] === "Bash(ls:*)"'
  js "$P1/.claude/settings.json" 'd.hooks.SessionStart[0].hooks[0].command.includes("$CLAUDE_PROJECT_DIR/.palm/hooks/superpowers/")'
  [[ -x "$P1/.palm/hooks/superpowers/hooks/run-hook.cmd" ]] || fail "hook script missing or not executable"
  nofile "$P1/.palm/hooks/superpowers/tests"
  nofile "$P1/.palm/hooks/superpowers/docs"
  js "$P1/.codex/hooks.json" 'd.hooks.SessionStart[0].hooks[0].type === "command"'
  js_yaml "$P1/palm.lock.yaml" 'd.entries.filter(e => e.via === "plugin:superpowers").length >= 10'
  js_yaml "$P1/palm.lock.yaml" 'd.entries.find(e => e.kind === "plugin" && e.name === "superpowers").deps.length >= 10'
  # Run the installed SessionStart hook the way Claude Code would: it must find its skill file.
  local cmd
  cmd="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hooks.SessionStart[0].hooks[0].command)' "$P1/.claude/settings.json")"
  OUT="$(cd "$P1" && CLAUDE_PROJECT_DIR="$P1" bash -c "$cmd")" || fail "the SessionStart hook failed"
  has "hookSpecificOutput"
  lacks "Error reading"
}

s09_mcp() {
  run "$P1" install mcp context7 -y
  js "$P1/.mcp.json" 'd.mcpServers.context7.url.startsWith("https://")'
  # An optional secret must not break Claude's config loading when unset.
  js "$P1/.mcp.json" '!JSON.stringify(d.mcpServers.context7).match(/\$\{[A-Z0-9_]+\}/)'
  js_toml "$P1/.codex/config.toml" 'd.mcp_servers.context7.url.startsWith("https://")'
  contains "$P1/palm.yaml" "io.github.upstash/context7"
  run "$P1" install mcp fs -y -- npx -y @modelcontextprotocol/server-filesystem .
  js "$P1/.mcp.json" 'd.mcpServers.fs.command === "npx" && d.mcpServers.fs.args.join(" ") === "-y @modelcontextprotocol/server-filesystem ."'
  js_toml "$P1/.codex/config.toml" 'd.mcp_servers.fs.command === "npx"'
  run "$P1" install mcp docs -y --url https://example.com/mcp --header 'Authorization=Bearer ${DOCS_TOKEN}'
  has "export DOCS_TOKEN"
  js "$P1/.mcp.json" 'd.mcpServers.docs.headers.Authorization === "Bearer ${DOCS_TOKEN}"'
  js_toml "$P1/.codex/config.toml" 'd.mcp_servers.docs.bearer_token_env_var === "DOCS_TOKEN"'
}

s10_get_describe() {
  run "$P1" get
  has "comment-sicko"
  has "plugin:superpowers"
  run "$P1" get skills
  has "unslop"
  lacks "comment-sicko"
  run "$P1" describe skill unslop
  has "installed (project)"
  has ".claude/skills/unslop/SKILL.md"
  run "$P1" describe agent comment-sicko
  has ".codex/agents/comment-sicko.toml"
  run "$P1" describe target codex
  has ".codex/agents/<name>.toml"
  run "$P1" get all --json
  node -e 'const d = JSON.parse(process.argv[1]); if (!(d.installed.length && d.origins.length && d.targets.active.includes("codex"))) process.exit(1)' "$OUT" || fail "get all --json lacks installed entities, origins or targets"
  run "$P1" cache info
  has "checkouts"
}

s11_sync() {
  run "$P1" install
  lacks "installed  "
  lacks "updated"
  has "unchanged"
  rm -rf "$P1/.claude/skills/unslop"
  run "$P1" install
  has "restored missing files"
  file "$P1/.claude/skills/unslop/SKILL.md"
}

s12_update_doctor() {
  run "$P1" update --dry-run
  run "$P1" update --dry-run --json
  node -e '
    const r = JSON.parse(process.argv[1]); const keys = r.outcomes.map((o) => `${o.entry.kind} ${o.entry.name} ${o.entry.origin}`);
    if (new Set(keys).size !== keys.length) process.exit(1);
  ' "$OUT" || fail "update --dry-run lists an entity twice"
  run "$P1" doctor
  has "no problems"
  lacks "warning"
}

s13_uninstall() {
  run "$P1" uninstall plugin superpowers
  js "$P1/.claude/settings.json" 'JSON.stringify(d) === JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } })'
  nofile "$P1/.codex/hooks.json"
  nofile "$P1/.claude/skills/brainstorming"
  nofile "$P1/.palm"
  js_yaml "$P1/palm.lock.yaml" '!d.entries.some(e => e.via === "plugin:superpowers" || e.name === "superpowers")'
  run "$P1" uninstall agent comment-sicko
  nofile "$P1/.claude/agents/comment-sicko.md"
  nofile "$P1/.codex/agents"
  run "$P1" uninstall mcp docs
  js "$P1/.mcp.json" '!d.mcpServers.docs && !!d.mcpServers.fs'
  js_toml "$P1/.codex/config.toml" '!d.mcp_servers.docs && !!d.mcp_servers.fs'
  run "$P1" uninstall skill unslop tdd
  nofile "$P1/.claude/skills/unslop"
  nofile "$P1/.agents/skills/tdd"
  file "$P1/.claude/skills/wayfinder/SKILL.md"
  js_yaml "$P1/palm.yaml" '!d.plugins && !d.agents && d.skills.length === 2'
  run "$P1" doctor --offline
  has "no problems"
  lacks "warning"
}

s14_global() {
  mkdir -p "$HOME/.claude" "$HOME/.codex"
  run "$P1" install -g skill unslop -y
  file "$HOME/.claude/skills/unslop/SKILL.md"
  file "$HOME/.agents/skills/unslop/SKILL.md"
  nofile "$P1/.claude/skills/unslop"
  run "$P1" install -g mcp fs -y -- npx -y @modelcontextprotocol/server-filesystem /tmp
  js "$HOME/.claude.json" 'd.mcpServers.fs.args.includes("/tmp")'
  js_toml "$HOME/.codex/config.toml" 'd.mcp_servers.fs.args.includes("/tmp")'
  [[ "$(mode_of "$HOME/.claude.json")" == 600 ]] || fail "~/.claude.json should be 0600"
  run "$P1" get -g
  has "unslop"
  has "fs"
  run "$P1" uninstall -g skill unslop
  nofile "$HOME/.claude/skills/unslop"
  nofile "$HOME/.agents"
  file "$HOME/.claude.json"
}

s15_four_targets() {
  run "$P4" get targets
  has "claude"
  has "copilot"
  has "cursor"
  run "$P4" install skill unslop@pstack -y
  has "claude,codex,copilot,cursor"
  file "$P4/.claude/skills/unslop/SKILL.md"
  file "$P4/.agents/skills/unslop/SKILL.md"
  run "$P4" install agent comment-sicko@pstack -y
  file "$P4/.github/agents/comment-sicko.agent.md"
  file "$P4/.cursor/agents/comment-sicko.md"
  file "$P4/.claude/agents/comment-sicko.md"
  file "$P4/.codex/agents/comment-sicko.toml"
  run "$P4" install origin github/awesome-copilot
  run "$P4" install instruction playwright-typescript@awesome-copilot -y
  file "$P4/.claude/rules/playwright-typescript.md"
  file "$P4/.cursor/rules/playwright-typescript.mdc"
  file "$P4/.github/instructions/playwright-typescript.instructions.md"
  contains "$P4/AGENTS.md" "<!-- palm:begin instruction:playwright-typescript -->"
  run "$P4" install mcp docs -y --url https://example.com/mcp --header 'Authorization=Bearer ${DOCS_TOKEN}'
  js "$P4/.vscode/mcp.json" 'd.servers.docs.headers.Authorization === "Bearer ${env:DOCS_TOKEN}"'
  js "$P4/.cursor/mcp.json" 'd.mcpServers.docs.headers.Authorization === "Bearer ${env:DOCS_TOKEN}"'
  js "$P4/.mcp.json" 'd.mcpServers.docs.headers.Authorization === "Bearer ${DOCS_TOKEN}"'
  run "$P4" uninstall instruction playwright-typescript
  nofile "$P4/AGENTS.md"
  nofile "$P4/.cursor/rules"
}

s16_real_home_untouched() {
  # The sandbox never leaked: nothing palm-shaped appeared under the real home during this run.
  [[ "$(find "$REAL_HOME/.palm" -newer "$LOG" -print -quit 2>/dev/null)" == "" ]] || fail "the real ~/.palm changed during the run"
}

# --- run ---------------------------------------------------------------------------------
if [[ -n "$PALM_BIN" ]]; then
  step "00 installed palm smoke ($PALM_BIN: --version, --help, install --help)" s00_build
else
  step "00 build + dist smoke (shebang, --version, --help, install --help)" s00_build
fi
step "01 install origin ×5, layout descriptor, unreachable origin not saved, get/describe origins" s01_origins
if [[ -n "$CATALOG" && -f "$CATALOG" ]]; then
  step "02 install origin marketplace.json (local origin read-only, dedupe)" s02_import
else
  skip "02 install origin marketplace.json" "PALM_E2E_CATALOG unset or missing: ${CATALOG:-none}"
fi
step "03 search tdd / unslop / mcp context7, get --available" s03_search
step "04 install skill unslop → claude + codex" s04_install_skill
step "05 install skill tdd → E_AMBIGUOUS, then tdd@mattpocock" s05_ambiguous
step "06 install skills grill-me wayfinder" s06_plural
step "07 install agent comment-sicko (valid Codex TOML)" s07_agent
step "08 install plugin superpowers (hooks merged, script runs)" s08_plugin_hooks
step "09 install mcp: registry context7, ad hoc stdio fs, ad hoc http docs" s09_mcp
step "10 get, get skills, describe skill/agent/target, get all, cache info" s10_get_describe
step "11 bare install is a no-op; restores a deleted skill" s11_sync
step "12 update --dry-run (no duplicates), doctor clean" s12_update_doctor
step "13 uninstall plugin/agent/mcp/skills; settings.json restored" s13_uninstall
step "14 global scope: skill + mcp into sandbox home, uninstall" s14_global
step "15 four targets: skill, agent, instruction, mcp" s15_four_targets
step "16 real home untouched" s16_real_home_untouched

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
