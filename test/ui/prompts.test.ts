import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createClackUI } from '../../src/ui/prompts.js';

/** A clack UI on fake streams: `keys` are typed once the prompt has rendered. */
function driven(keys: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (d: Buffer) => {
    screen += d.toString();
  });
  const ui = createClackUI({ input, output });
  const type = async (): Promise<void> => {
    for (const k of keys) {
      await new Promise((r) => setTimeout(r, 20));
      input.write(k);
    }
  };
  return { ui, type, screen: () => screen };
}

describe('createClackUI', () => {
  it('secret() masks what is typed and returns it', async () => {
    const d = driven(['s3cr3t', '\r']);
    const [value] = await Promise.all([d.ui.secret('Token?'), d.type()]);
    expect(value).toBe('s3cr3t');
    expect(d.screen()).toContain('••••••');
    expect(d.screen()).not.toContain('s3cr3t');
  });

  it('Ctrl-C in a prompt is E_CANCELLED', async () => {
    const d = driven(['\x03']);
    const [result] = await Promise.all([d.ui.text('Name?').catch((e: unknown) => e), d.type()]);
    expect(result).toMatchObject({ code: 'E_CANCELLED' });
  });
});
