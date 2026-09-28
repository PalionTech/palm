# src/lib

Generic primitives with no palm concepts (no Kind, Scope, Entity or PalmError). Nothing here
imports from the rest of `src`. Filesystem errors propagate unchanged and parse errors are plain
`Error`s whose message names the file; callers wrap them in `PalmError`. Import with the `.js`
suffix, e.g. `import { isRecord } from '../lib/object.js'`.

## object.ts

- `isRecord(v: unknown): v is Record<string, unknown>`: non-null object, not an array, not a Date.
- `deepEqual(a: unknown, b: unknown): boolean`: plain data; key order and undefined-valued keys ignored, Dates by time, NaN equals NaN, `5n` equals `5`.
- `withoutUndefined<T extends object>(o: T): T`: shallow copy without undefined-valued keys (never mutates).
- `withoutUndefinedDeep<T>(v: T): T`: the same at every depth, through arrays (array lengths kept).

## fs.ts

- `errnoCode(e: unknown): string | undefined` (`'ENOENT'`, `'EACCES'`, …) and `isEnoent(e: unknown): boolean`
- `pathExists(p: string): Promise<boolean>`: follows symlinks (a broken link is false).
- `isSameFile(a: string, b: string): Promise<boolean>`: same device and inode (a case variant on a case-insensitive filesystem, a hard link); false when either is missing.
- `ensureDir(dir: string): Promise<void>`: `mkdir -p`.
- `isWithin(child: string, parent: string, opts?: { strict?: boolean }): boolean`: lexical, absolute paths; `child === parent` is true unless `strict: true`; `isWithin('/a/bc', '/a/b')` is false.
- `toPosix(p: string): string`: platform separator to `/`.
- `writeFileAtomic(file: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void>`: temp file + rename in the same dir, creates parents, keeps the old file's mode unless `mode` is given, removes the temp file on failure. A symlinked `file` (a chain, relative or dangling links included) is written through to its final target, so the link survives.
- `resolveWriteTarget(file: string): Promise<string>`: the path a write to `file` lands on (the final target of a symlinked file, relative links resolved against the real directory holding them; ELOOP after 40 hops).
- `readTextIfExists(file: string): Promise<string | undefined>`: undefined only for ENOENT.
- `readJsonFile<T = unknown>(file: string, opts?: { tolerant?: boolean }): Promise<T>`: BOM ignored; `tolerant` accepts `//` and `/* */` comments and trailing commas; invalid JSON throws `invalid JSON in <file>: …`.
- `readJsonIfExists<T = unknown>(file: string, opts?: { tolerant?: boolean }): Promise<T | undefined>`: undefined when missing or blank.
- `writeJsonFile(file: string, value: unknown, opts?: { mode?: number }): Promise<void>`: `stringifyJson` + `writeFileAtomic`.
- `removeEmptyParents(from: string, stopAt: string): Promise<string[]>`: rmdir from `dirname(from)` upwards, never `stopAt` or outside it; skips missing dirs, stops at the first it cannot remove; returns the removed dirs.
- `walkFiles(root: string, opts?: WalkOptions): Promise<WalkResult>`: every regular file below the directory `root` as `{ rel, abs, mode }` (depth first, names sorted). Symlinks are followed only when their real target stays inside `opts.boundary` (default `root`); links leaving it, broken links and a root resolving outside it (`'.'`) go to `skipped`. `opts.skip(name, rel)` drops entries by name before they are examined. Each real directory is walked once (no loops). The one walk behind the copy (targets/fs-utils `listCopyFiles`) and content hashes (core/hash `hashPath`).

## json.ts

- `parseJson<T = unknown>(text: string, opts?: { tolerant?: boolean }): T`: BOM ignored; throws SyntaxError.
- `stripJsonComments(text: string): string`: comments outside strings become spaces (positions kept).
- `stripTrailingCommas(text: string): string`: commas before `}`/`]` outside strings become spaces.
- `stringifyJson(value: unknown): string`: 2-space indent plus trailing newline.

## json-pointer.ts

- `escapeSegment(s: string): string` (`~` → `~0`, `/` → `~1`) and `unescapeSegment(s: string): string` (RFC 6901).
- `parsePointer(pointer: string): string[]`: `''` and `'/'` are the root (`[]`); throws `invalid JSON pointer: …` unless it starts with `/`.
- `formatPointer(segments: readonly string[]): string` (`''` for none) and `joinPointer(pointer: string, key: string): string`.

## text.ts

- `stripBom(text: string): string` and `normalizeText(text: string): string` (BOM stripped, CRLF and CR to LF).

## names.ts

- `SLUG_RE: RegExp` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), `MAX_SLUG_LENGTH = 64`, `ALIAS_RE: RegExp` (`^[a-z0-9][a-z0-9._-]*$`).
- `slugify(text: string): string`: accents dropped, camelCase split when there are no separators, other runs to `-`, max 64, `''` when nothing is left; idempotent.
- `isSlug(s: string): boolean`: `SLUG_RE` and at most 64 characters.
- `isSafeName(s: string): boolean`: one path segment, `[A-Za-z0-9][A-Za-z0-9._-]*` without `..`. Every name that becomes a file or dir name must pass it.
- `isValidAlias(s: string): boolean`: `ALIAS_RE`.
- `stemOf(file: string, exts: readonly string[]): string`: basename minus the longest matching extension, case-insensitive (`stemOf('a.agent.md', ['.md', '.agent.md']) === 'a'`).

## placeholders.ts

- `PLACEHOLDER_RE: RegExp`: global; `${VAR}`, `${env:VAR}`, `${VAR:-default}`, `${env:VAR:-default}`; group 1 = name, group 2 = default.
- `type PlaceholderStyle = 'dollar' | 'env-colon' | 'dollar-default'`; `interface Placeholder { name: string; style: PlaceholderStyle; default?: string; raw: string }`
- `findPlaceholders(text: string): Placeholder[]`
- `parsePlaceholder(text: string): Placeholder | undefined`: only when `text` is exactly one token.
- `replacePlaceholders(text: string, fn: (p: Placeholder) => string | undefined): string`: undefined keeps the token.
- `envRef(name: string, style?: PlaceholderStyle, fallback?: string): string`: `${name}`, `${env:name}`, `${name:-fallback}`.
- `RUNTIME_VARS: ReadonlySet<string>`, `isRuntimeVar(name: string): boolean`: harness/OS variables, never secrets.
- `isFillInValue(value: string): boolean`: `''`, `<your key>`, `your-token…` (was `isPlaceholderValue` in mcp/secrets).

## frontmatter.ts

- `interface FrontmatterSplit { hasFrontmatter: boolean; raw: string; body: string }`, `interface Frontmatter { data: Record<string, unknown>; body: string }`
- `splitFrontmatter(text: string): FrontmatterSplit`: BOM and CRLF tolerated; an unclosed fence is no frontmatter.
- `parseFrontmatterYaml(raw: string): Record<string, unknown>`: never throws; duplicate keys allowed, per-key fallback for invalid YAML, literal `version` text kept.
- `parseFrontmatter(text: string): Frontmatter`: `{ data: {}, body: text }` without frontmatter.
- `readFrontmatterFile(file: string): Promise<Frontmatter>`
- `normalizeBody(body: string): string`: LF, no leading blank lines, one trailing newline, `''` stays `''`.
- `withFrontmatter(yaml: string, body: string): string`: `---\n<yaml>\n---\n\n<body>` from ready YAML text; just the body when `yaml` is `''`.
- `stringifyFrontmatter(data: Record<string, unknown>, body: string): string`: undefined values dropped, key order kept; just the body when no key is defined.

## yaml.ts

- `parseYaml<T = unknown>(text: string, source?: string): T | undefined`: undefined for an empty document; throws `invalid YAML in <source>: …`.
- `stringifyYaml(value: unknown): string` (block style, no folding, trailing newline); `yamlScalar(value: string): string` (quoted only when needed).
- `readYamlFile<T = unknown>(file: string): Promise<T | undefined>`: undefined when missing or empty.
- `writeYamlFile(file: string, value: unknown, opts?: WriteYamlOptions): Promise<void>`: atomic; patches the file's current YAML (or `preserveFrom` text) so comments, order and unchanged nodes survive. A new key goes where `value` orders it among the existing keys (not at the end); a new top-level `flowKeys` list is written in flow style.
- `interface WriteYamlOptions { preserveFrom?: string | false; flowKeys?: readonly string[]; comment?: string; mode?: number }`: `preserveFrom: false` always writes fresh; `flowKeys` and `comment` (lines without `#`) apply to fresh documents.

Also in `src/core/errors.ts`: `messageOf(e: unknown): string` and the `E_CANCELLED` code.

## unicode.ts

Hidden-Unicode detection for text palm deploys (`palm audit`, the pre-deploy scan).

- `type HiddenUnicodeSeverity = 'critical' | 'warning'`; `interface HiddenUnicodeFinding { severity; codePoint: number; index: number; name: string }` (`index`: UTF-16 offset, what `text.slice` uses; `name`: the Unicode name, e.g. `RIGHT-TO-LEFT OVERRIDE`).
- `scanHiddenUnicode(text: string): HiddenUnicodeFinding[]`: in order. Critical: bidi embeddings/overrides U+202A–U+202E and isolates U+2066–U+2069, tag characters U+E0000–U+E007F, variation selectors 17–256 U+E0100–U+E01EF. Warning: every invisible format character (category Cf: U+200B–U+200F, U+2060–U+2064, U+206A–U+206F, U+00AD, U+061C, U+180E, U+FFF9–U+FFFB, …) plus the Hangul fillers and U+034F; U+FEFF only after offset 0. Not reported: a BOM at offset 0, a ZWJ joining two emoji, visible Cf marks (U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891, U+08E2, U+110BD, U+110CD), VS1–16.
- `MAY_HIDE_UNICODE: RegExp`: a native-regex pre-check that matches every code point `hiddenUnicodeSeverity` reports; `scanHiddenUnicode` returns `[]` at once when it does not match (most text). `hiddenUnicodeSeverity(cp: number): HiddenUnicodeSeverity | undefined`: the per-character rule, ignoring position.
- `stripHiddenUnicode(text: string, opts?: { severity?: HiddenUnicodeSeverity }): string`: removes the findings (default every one; `'critical'` only critical), everything else byte for byte.
- `hasHiddenUnicode(text: string, severity?: HiddenUnicodeSeverity): boolean` (default: any finding).
- `describeCodePoint(cp: number): string` (`U+202E RIGHT-TO-LEFT OVERRIDE`) and `codePointName(cp: number): string` (`FORMAT CHARACTER` when unnamed).
