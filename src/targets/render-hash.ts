/**
 * The render hash (DESIGN.md section 4) as a render records it and as the engine recomputes it
 * over the disk to tell an edit from an upgrade: `renderHashOf` over the files and fragments in
 * lock form. Under -g, text has the expanded palm home and home directory written as `<palm>`
 * and `<home>`, so the hash is the same on every machine while the bytes keep real paths.
 * Fragment values have every secret value replaced by its `${VAR}` placeholder, plus a marker
 * for the `literal` policy, so a policy change re-renders and a rotated secret does not. The
 * marker does not depend on the values at hand (S6 J3' Y2'): `check` renders a `secrets:
 * literal` server without the values palm never stores, and must hash it as the install did.
 */
import type { RenderedFile, RenderedFragment, Scope, SecretPolicy } from '../core/types.js';
import { renderHashOf } from '../domain/lock.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { redactSecrets } from './placeholder-match.js';

/** Bytes checked for a NUL before a file counts as binary (git's rule). */
const BINARY_SNIFF = 8000;

/** How a render is hashed: its scope (tokens), and the secret policy and values it used. */
export interface HashForm {
  scope: Scope;
  paths: Pick<ScopePaths, 'token'>;
  secretPolicy?: SecretPolicy | undefined;
  secretValues?: Record<string, string> | undefined;
}

/** Under -g, `text` with the palm home and home directory as `<palm>` and `<home>`. */
function tokenised(text: string, form: HashForm): string {
  if (form.scope !== 'global') return text;
  const pairs: Array<[string, string]> = [
    [form.paths.token('palm'), '<palm>'],
    [form.paths.token('home'), '<home>'],
  ];
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((t, [abs, token]) => t.split(abs).join(token), text);
}

/** The files as the hash sees them: text contents tokenised (binary files as they are). */
function hashedFiles(files: readonly RenderedFile[], form: HashForm): RenderedFile[] {
  if (form.scope !== 'global') return [...files];
  return files.map((f) => {
    if (Buffer.from(f.data).subarray(0, BINARY_SNIFF).includes(0)) return f;
    const text = Buffer.from(f.data).toString('utf8');
    return { ...f, data: Buffer.from(tokenised(text, form), 'utf8') };
  });
}

/** The fragments as the hash sees them: secret values replaced by placeholders, tokenised. */
function hashedFragments(
  fragments: readonly RenderedFragment[],
  form: HashForm,
): RenderedFragment[] {
  const values = form.secretValues;
  const tokenise = (v: unknown): unknown =>
    JSON.parse(tokenised(JSON.stringify(v) ?? 'null', form));
  const out: RenderedFragment[] = fragments.map((f) => ({
    file: f.file,
    at: f.at,
    id: f.id,
    key: f.key,
    value: tokenise(redactSecrets(f.value, values)),
  }));
  if (form.secretPolicy === 'literal')
    out.push({ file: '', at: 'secrets', id: 'policy', key: 'literal', value: 'literal' });
  return out;
}

/** The render hash of `files` and `fragments` (lock form) rendered as `form` says. */
export function renderHash(
  files: readonly RenderedFile[],
  fragments: readonly RenderedFragment[],
  form: HashForm,
): string {
  return renderHashOf({
    files: hashedFiles(files, form),
    fragments: hashedFragments(fragments, form),
  });
}
