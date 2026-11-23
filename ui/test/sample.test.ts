import { describe, expect, it } from 'vitest';
import { knownIdMso } from '../src/catalog/catalog';
import { lint } from '../src/lint';
import { parseXml } from '../src/model';
import { sampleDocument } from '../src/sample';

describe('同梱のサンプル', () => {
  it('パスのない文書として、customUI14 を1つ持つ', () => {
    const d = sampleDocument();
    expect(d.path).toBe('');
    expect(d.parts.map((p) => p.version)).toEqual(['office2010']);
  });

  it('Lint のエラーも警告も出ない（最初に見せるものなので）', () => {
    const r = parseXml(sampleDocument().parts[0]!.xml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const problems = lint(r.doc, { version: 'office2010', imageIds: new Set(), knownIdMso, missingImageMso: new Set() });
    expect(problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });
});
