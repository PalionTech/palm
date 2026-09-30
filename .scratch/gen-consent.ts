import { consentText, nonInteractiveError } from '../src/exec/consent.js';
import { ghCliUnit, teamHelperUnit } from '../test/exec/examples.js';

const req = {
  operation: 'install' as const,
  units: [ghCliUnit(), teamHelperUnit()],
  prompts: [{ entity: 'fp-check', event: 'Stop' }],
  lockFile: '/work/app/palm.lock.yaml',
};
console.log(consentText(req, { scope: 'project', lockFile: 'palm.lock.yaml' }));
console.log('-----');
const units = [
  {
    ...ghCliUnit(),
    hash: 'sha256:a7cc7911f2bd0a61d9686cbc62fcfb17c8e8276fa2ea5aa0c69e646a0b23ad60',
  },
  {
    ...teamHelperUnit(),
    hash: 'sha256:75aafd9baefdaaee905cd992fe17dbe17b4fa390f7f487399d6a57f282682c79',
  },
];
const e = nonInteractiveError(
  { operation: 'install', units, prompts: [], lockFile: 'palm.lock.yaml' },
  { args: ['install'] },
);
console.log(`x ${e.message}\n  ${e.hint?.split('\n').join('\n  ')}`);
