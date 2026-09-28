/**
 * `palm why <kind> <name[@origin]>`: why an entity is installed: listed in palm.yaml, or
 * pulled in by a plugin or agent (the chain up to what palm.yaml lists), and which other
 * installed plugins and agents still need it.
 */
import pc from 'picocolors';
import { parseKind } from '../core/kinds.js';
import { DepRef } from '../domain/dep-ref.js';
import type { WhyNode, WhyReport } from '../engine/why.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { type GlobalOptions, makeContext, scopeOf } from './shared.js';

const label = (n: WhyNode): string => `${n.kind} ${n.name}`;

function installedBy(r: WhyReport): string {
  if (r.direct) return `palm.yaml (${r.listedIn})`;
  const parent = r.chain[1];
  if (parent) return label(parent);
  return pc.yellow('nothing: no plugin, agent or palm.yaml entry lists it');
}

function chainText(r: WhyReport): string {
  const links = r.chain.map(label);
  if (r.listedIn) links.push(`palm.yaml (${r.listedIn})`);
  return links.join(pc.dim(' ← '));
}

function row(out: Output, name: string, value: string): void {
  out.out(`  ${pc.dim(name.padEnd(14))}${value}`);
}

function printReport(out: Output, r: WhyReport): void {
  out.out(`${pc.bold(label(r.entry))}  ${pc.dim(`(origin ${r.entry.origin}, ${r.scope} scope)`)}`);
  row(out, 'installed by', installedBy(r));
  if (r.chain.length > 1) row(out, 'chain', chainText(r));
  if (r.neededBy.length) row(out, 'needed by', r.neededBy.map(label).join(', '));
  if (!r.listedIn) {
    const flag = r.scope === 'global' ? ' -g' : '';
    out.hint(`  remove it: palm uninstall ${r.entry.kind} ${r.entry.name}${flag}`);
  }
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const [kindWord, spec, ...extra] = inv.names;
  const kind = parseKind(kindWord);
  if (!kind || !spec || extra.length)
    throw usage(
      kind ? `name one ${kind}` : `"${kindWord ?? ''}" is not an entity kind`,
      `palm why <kind> <name>   e.g. palm why skill ${kind ? (spec ?? 'tdd') : (kindWord ?? 'tdd')}`,
    );
  const g = inv.opts as GlobalOptions;
  const ref = DepRef.parse(spec);
  const ctx = await makeContext(app, g, { interactive: false });
  const { whyInstalled } = await import('../engine/why.js');
  const reports = await whyInstalled(
    ctx,
    { kind, name: ref.name, origin: ref.origin },
    { scope: scopeOf(g) },
  );
  if (app.out.jsonMode) return app.out.json(reports);
  reports.forEach((r, i) => {
    if (i > 0) app.out.out();
    printReport(app.out, r);
  });
}
