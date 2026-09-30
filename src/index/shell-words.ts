/**
 * Just enough of the POSIX shell grammar to find references in a hook command: words as written
 * (quotes kept, so a word is an exact substring of the line), whether a word stands where a
 * command name goes, and the command substitutions (`$(…)`, backticks) the line contains.
 * Single quotes make everything literal; double quotes still expand `$(…)`.
 */

interface ShellWord {
  /** The word as written, quotes included. */
  text: string;
  /** First word of a command (after `;`, `&&`, `||`, `|`, `(` or leading assignments). */
  commandPosition: boolean;
  /** The word contains a command substitution. */
  substituted: boolean;
}

export interface ShellLine {
  words: ShellWord[];
  substitutions: string[];
}

const OPERATORS = new Set([';', '&', '|', '(', ')', '<', '>']);
const COMMAND_SEPARATORS = new Set([';', '&', '|', '(']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

class ShellScanner implements ShellLine {
  readonly words: ShellWord[] = [];
  readonly substitutions: string[] = [];
  private current = '';
  private substituted = false;
  private quote: '' | '"' | "'" = '';
  private atCommand = true;
  private i = 0;

  constructor(private readonly text: string) {}

  run(): this {
    while (this.i < this.text.length) this.step(this.text[this.i] as string);
    this.flush();
    return this;
  }

  private step(ch: string): void {
    if (this.quote === "'") {
      if (ch === "'") this.quote = '';
      this.take(1);
    } else if (ch === '\\') this.take(2);
    else if (this.startsSubstitution(ch)) this.substitution();
    else if (ch === '"' || ch === "'") this.toggleQuote(ch);
    else if (this.quote === '' && /\s/.test(ch)) this.separate(false);
    else if (this.quote === '' && OPERATORS.has(ch)) this.separate(COMMAND_SEPARATORS.has(ch));
    else this.take(1);
  }

  private startsSubstitution(ch: string): boolean {
    if (ch === '`') return true;
    return this.text.startsWith('$(', this.i) && !this.text.startsWith('$((', this.i);
  }

  private toggleQuote(ch: '"' | "'"): void {
    if (this.quote === '') this.quote = ch;
    else if (this.quote === ch) this.quote = '';
    this.take(1);
  }

  private take(n: number): void {
    this.current += this.text.slice(this.i, this.i + n);
    this.i += n;
  }

  private separate(commandFollows: boolean): void {
    this.flush();
    if (commandFollows) this.atCommand = true;
    this.i++;
  }

  /** `$(…)` with nesting, or a backtick span; unterminated ones run to the end of the line. */
  private substitution(): void {
    const end =
      this.text[this.i] === '`' ? this.text.indexOf('`', this.i + 1) : this.closingParen();
    const stop = end === -1 ? this.text.length : end + 1;
    this.substitutions.push(this.text.slice(this.i, stop));
    this.substituted = true;
    this.take(stop - this.i);
  }

  private closingParen(): number {
    let depth = 0;
    for (let j = this.i + 1; j < this.text.length; j++) {
      if (this.text[j] === '(') depth++;
      else if (this.text[j] === ')' && --depth === 0) return j;
    }
    return -1;
  }

  private flush(): void {
    if (this.current === '') return;
    const word = {
      text: this.current,
      commandPosition: this.atCommand,
      substituted: this.substituted,
    };
    this.words.push(word);
    this.atCommand = this.atCommand && ASSIGNMENT.test(this.current);
    this.current = '';
    this.substituted = false;
  }
}

export function scanShell(text: string): ShellLine {
  return new ShellScanner(text).run();
}

/** The word's value without shell quoting (escapes resolved, quote characters dropped). */
export function unquote(text: string): string {
  return text.replace(/\\(.)|["']/g, (_m, escaped: string | undefined) => escaped ?? '');
}
