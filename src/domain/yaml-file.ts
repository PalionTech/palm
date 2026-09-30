/** Reading palm's own YAML files (manifest, lock, applied record) with palm's error codes. */
import { messageOf, PalmError } from '../core/errors.js';
import { errnoCode } from '../lib/fs.js';
import { readYamlFile } from '../lib/yaml.js';

/**
 * The parsed content of a palm YAML file; undefined when it is missing or empty. A read failure
 * is E_IO, invalid YAML is E_PARSE naming the file.
 */
export async function loadYaml(file: string): Promise<unknown> {
  try {
    return await readYamlFile(file);
  } catch (e) {
    if (errnoCode(e)) throw new PalmError('E_IO', `cannot read ${file}: ${messageOf(e)}`);
    throw new PalmError('E_PARSE', messageOf(e), `fix the YAML in ${file}, or restore it from git`);
  }
}
