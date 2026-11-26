import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 0.3.0 の見直し（中 7 件・低 10 件）への対応のテスト

const invoke = vi.fn();
const askRecovery = vi.fn();
const askExternalChange = vi.fn();
vi.mock('../src/bridge', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../src/dialogs/recoveryDialog', () => ({ askRecovery: (...a: unknown[]) => askRecovery(...a), formatWhen: (s: string) => s, openRecoveryDiff: vi.fn() }));
vi.mock('../src/dialogs/externalChangeDialog', () => ({ askExternalChange: (...a: unknown[]) => askExternalChange(...a), openExternalDiff: vi.fn() }));

const { app } = await import('../src/app');
const rec = await import('../src/recovery');
const { openFile, applyToExcel, setPendingEditFlusher } = await import('../src/shell/fileOps');
const { createExternalWatcher } = await import('../src/shell/externalWatch');
const { clearToasts } = await import('../src/shell/toast');
const { applyImport, listCandidates, flatten } = await import('../src/ribbonImport');
const { parseXml } = await import('../src/model');
const { lint } = await import('../src/lint');
const { PartStore } = await import('../src/store');
const { DEFAULT_NAMING } = await import('../src/vba');
const cb = await import('../src/callbacks');
const { listMacros } = await import('../src/macroAssign');
const stats = await import('../src/imageStats');
const { collectChecks, onLoadHoldsRibbon } = await import('../src/distributionCheck');

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="a" label="A"/></group></tab></tabs></ribbon></customUI>`;
const doc = (xml: string): Document => {
  const r = parseXml(xml);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
};
const calls = (type: string) => invoke.mock.calls.filter((c) => c[0] === type);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openDoc(path = 'C:\\book.xlsm', fingerprint: Record<string, string> | null = { office2010: 'base' }): void {
  app.open({ path, parts: [{ version: 'office2010', xml: XML, images: [] }], fingerprint } as never);
}
function edit(label = 'B'): void {
  app.store!.edit('inspector', (d) => {
    d.querySelector('[id="a"]')!.setAttribute('label', label);
    return undefined;
  }, '編集');
}

afterEach(() => {
  setPendingEditFlusher(() => undefined);
  clearToasts();
  vi.useRealTimers();
});

// ---- 中 1・5・低 14・15：取り込み ----

describe('取り込み：コールバック名の付け直しと警告（中 1）', () => {
  const SRC = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="tabA" label="経理"><group id="grpSum"><button id="btnSum" onAction="Ribbon_btnSum_onAction"/><button id="btnQ" onAction="Quick"/></group></tab></tabs></ribbon></customUI>`;
  const TGT = `<customUI xmlns="${NS}"><ribbon><tabs><tab id="tabMine"><group id="grpSum"><button id="btnSum" onAction="Ribbon_btnSum_onAction"/><button id="other" onAction="Quick"/></group></tab></tabs></ribbon></customUI>`;
  const run = (naming: typeof DEFAULT_NAMING | undefined, tgt = TGT, src = SRC) => {
    const store = new PartStore('office2010', tgt, []);
    const d = doc(src);
    const pick = flatten(listCandidates(d, store.doc)).find((c) => c.kind === 'tab')!;
    const out = applyImport(store, { doc: d, images: new Map() }, [pick], { renameIds: true, groupTarget: 'new', naming })!;
    return { store, out };
  };

  it('id を振り直したら、規則で付けたコールバック名も付け直す（既存のボタンの Sub を共有しない）', () => {
    const { store, out } = run(DEFAULT_NAMING);
    expect(out.renamedCallbacks).toEqual([['Ribbon_btnSum_onAction', 'Ribbon_btnSum2_onAction']]);
    expect(store.doc.querySelector('[id="btnSum2"]')!.getAttribute('onAction')).toBe('Ribbon_btnSum2_onAction');
    // 取り込み先の既存のボタンはそのまま
    expect(store.doc.querySelector('[id="btnSum"]')!.getAttribute('onAction')).toBe('Ribbon_btnSum_onAction');
    expect(out.callbacks.map((c) => c.name)).toContain('Ribbon_btnSum2_onAction');
  });

  it('規則外の名前（Quick）で取り込み先と重なるものは、付け直さず警告に挙げる', () => {
    const { store, out } = run(DEFAULT_NAMING);
    expect(store.doc.querySelector('[id="btnQ"]')!.getAttribute('onAction')).toBe('Quick');
    expect(out.sharedCallbacks).toEqual(['Quick']);
  });

  it('規則を渡さない・Sub を共有する規則のときは、名前を触らない', () => {
    expect(run(undefined).out.renamedCallbacks).toEqual([]);
    expect(run({ ...DEFAULT_NAMING, shared: true }).out.renamedCallbacks).toEqual([]);
  });

  it('付け直した名前が VBA の既存の Sub と重なるなら、番号をさらに進める', () => {
    const store = new PartStore('office2010', TGT, []);
    const d = doc(SRC);
    const pick = flatten(listCandidates(d, store.doc)).find((c) => c.kind === 'tab')!;
    const out = applyImport(store, { doc: d, images: new Map() }, [pick], { renameIds: true, groupTarget: 'new', naming: DEFAULT_NAMING, takenCallbacks: new Set(['Ribbon_btnSum2_onAction']) })!;
    expect(out.renamedCallbacks[0]![1]).toBe('Ribbon_btnSum2_onAction2');
  });
});

describe('取り込み：接頭辞の宣言（中 5）', () => {
  const SRC = `<customUI xmlns="${NS}" xmlns:x="urn:other-addin"><ribbon><tabs><tab id="tabA"><group id="g2" insertAfterQ="x:grpOther"><button idQ="x:btn" label="B"/></group></tab></tabs></ribbon></customUI>`;
  const pickTab = (store: InstanceType<typeof PartStore>, d: Document) => flatten(listCandidates(d, store.doc)).find((c) => c.kind === 'tab')!;

  it('idQ・insertAfterQ の接頭辞の宣言を、取り込み先のルートへ足す。書き出して読み直しても宣言されている', () => {
    const store = new PartStore('office2010', XML, []);
    const d = doc(SRC);
    const out = applyImport(store, { doc: d, images: new Map() }, [pickTab(store, d)], { renameIds: true, groupTarget: 'new' })!;
    expect(out.addedPrefixes).toEqual(['x']);
    expect(store.text).toContain('xmlns:x="urn:other-addin"');
    const re = doc(store.text);
    expect(lint(re, { version: 'office2010', imageIds: new Set(), knownIdMso: new Set(), missingImageMso: new Set() }).filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('同じ接頭辞が別の名前空間で宣言済みなら、接頭辞を付け替えて値も直す', () => {
    const store = new PartStore('office2010', XML.replace('<customUI ', '<customUI xmlns:x="urn:mine" '), []);
    const d = doc(SRC);
    const out = applyImport(store, { doc: d, images: new Map() }, [pickTab(store, d)], { renameIds: true, groupTarget: 'new' })!;
    expect(out.addedPrefixes).toEqual(['x2']);
    expect(store.text).toContain('xmlns:x="urn:mine"');
    expect(store.text).toContain('xmlns:x2="urn:other-addin"');
    expect(store.text).toContain('idQ="x2:btn"');
    expect(store.text).toContain('insertAfterQ="x2:grpOther"');
  });

  it('宣言済みの同じ名前空間なら、何も足さない', () => {
    const store = new PartStore('office2010', XML.replace('<customUI ', '<customUI xmlns:x="urn:other-addin" '), []);
    const d = doc(SRC);
    expect(applyImport(store, { doc: d, images: new Map() }, [pickTab(store, d)], { renameIds: true, groupTarget: 'new' })!.addedPrefixes).toEqual([]);
  });

  it('Lint：接頭辞が宣言されていない idQ・insertAfterQ をエラーにする', () => {
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g" insertAfterQ="y:z"><button idQ="y:b"/></group></tab></tabs></ribbon></customUI>`);
    const errors = lint(d, { version: 'office2010', imageIds: new Set(), knownIdMso: new Set(), missingImageMso: new Set() }).filter((p) => p.message.includes('宣言されていません'));
    expect(errors.map((e) => e.attr)).toEqual(['insertAfterQ', 'idQ']);
    expect(errors.every((e) => e.severity === 'error')).toBe(true);
  });
});

describe('取り込み：keytip の重なりと合流で捨てる属性（低 14・15）', () => {
  it('取り込み先と重なる keytip は外して知らせ、重ならないものは残す', () => {
    const store = new PartStore('office2010', `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t" keytip="Y"/></tabs></ribbon></customUI>`, []);
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="a" keytip="y"><group id="g"><button id="b" keytip="Z"/></group></tab></tabs></ribbon></customUI>`);
    const pick = flatten(listCandidates(d, store.doc)).find((c) => c.kind === 'tab')!;
    const out = applyImport(store, { doc: d, images: new Map() }, [pick], { renameIds: true, groupTarget: 'new' })!;
    expect(out.droppedKeytips).toEqual([{ id: 'a', keytip: 'y' }]);
    expect(store.doc.querySelector('[id="a"]')!.hasAttribute('keytip')).toBe(false);
    expect(store.doc.querySelector('[id="b"]')!.getAttribute('keytip')).toBe('Z');
  });

  it('同じ idMso のタブへ合流させるとき、取り込み元のタブ自身の属性を捨てたことを知らせる', () => {
    const store = new PartStore('office2010', `<customUI xmlns="${NS}"><ribbon><tabs><tab idMso="TabHome"/></tabs></ribbon></customUI>`, []);
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab idMso="TabHome" label="ホーム改" getVisible="Vis"><group id="g"/></tab></tabs></ribbon></customUI>`);
    const pick = flatten(listCandidates(d, store.doc)).find((c) => c.kind === 'tab')!;
    const out = applyImport(store, { doc: d, images: new Map() }, [pick], { renameIds: true, groupTarget: 'new' })!;
    expect(out.mergeDroppedAttrs).toEqual([{ idMso: 'TabHome', attrs: ['label', 'getVisible'] }]);
  });
});

// ---- 中 2：開き直した直後の退避 ----

describe('同じブックの開き直し（中 2）', () => {
  beforeEach(async () => {
    rec.startRecovery();
    app.close();
    await sleep(0);
    invoke.mockReset();
    askRecovery.mockReset();
    app.settings.autoRecovery = true;
  });

  it('捨てた退避の削除が終わる前に読んで、復旧を聞いてしまわない', async () => {
    let stored: unknown = { path: 'C:\\book.xlsm', savedAt: 'x', editCount: 3, parts: [{ version: 'office2010', xml: XML, addImages: [], removeImages: [] }] };
    invoke.mockImplementation(async (type: string) => {
      if (type === 'file.open') return { path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }], fingerprint: { office2010: 'base' } };
      // ホストの削除は少し遅れて終わる
      if (type === 'recovery.delete') {
        await sleep(30);
        stored = null;
        return null;
      }
      if (type === 'recovery.read') return stored;
      return null;
    });
    openDoc();
    edit();
    await openFile('C:\\book.xlsm', { force: true });
    expect(askRecovery).not.toHaveBeenCalled();
  });
});

// ---- 中 3：窓に戻ったときの黙った読み直し ----

describe('窓に戻ったときの検知（中 3）', () => {
  beforeEach(async () => {
    app.settings.detectExternalChanges = true;
    app.settings.autoRecovery = false;
    app.close();
    await sleep(0);
    invoke.mockReset();
    askExternalChange.mockReset();
  });
  const host = (onFingerprint?: () => void) =>
    invoke.mockImplementation(async (type: string) => {
      if (type === 'file.fingerprint') {
        onFingerprint?.();
        return { fingerprint: { office2010: 'other' } };
      }
      if (type === 'file.open') return { path: 'C:\\book.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }], fingerprint: { office2010: 'other' } };
      return null;
    });

  it('確定前の入力（インスペクタの欄）があるときは、編集ありとして読み直さない', async () => {
    openDoc();
    host();
    setPendingEditFlusher(() => edit('入力中'));
    await createExternalWatcher(0)();
    expect(calls('file.open')).toHaveLength(0);
    expect(app.store!.text).toContain('label="入力中"');
    expect(document.querySelectorAll('.toast.warning')).toHaveLength(1);
  });

  it('照合している間に編集が入ったら、読み直さず通知に回す', async () => {
    openDoc();
    host(() => edit('照合中'));
    await createExternalWatcher(0)();
    expect(calls('file.open')).toHaveLength(0);
    expect(document.querySelectorAll('.toast.warning')).toHaveLength(1);
  });
});

// ---- 中 4：編集なしの反映で基準を動かさない ----

describe('編集のない反映（中 4）', () => {
  it('ほかの変更を照合しないまま基準にしない（次の保存で検知できる）', async () => {
    app.settings.detectExternalChanges = true;
    app.close();
    invoke.mockReset();
    invoke.mockImplementation(async (type: string) => (type === 'excel.apply' ? { status: 'applied', message: 'ok' } : type === 'file.fingerprint' ? { fingerprint: { office2010: 'other' } } : null));
    openDoc();
    await applyToExcel();
    await sleep(20);
    expect(calls('excel.apply')).toHaveLength(1);
    expect(app.session!.fingerprint).toEqual({ office2010: 'base' });
    expect(calls('file.fingerprint')).toHaveLength(0);
  });
});

// ---- 中 7：割り当てる間に文書が変わる ----

describe('マクロの割り当て中に文書が変わったとき（中 7）', () => {
  const MAIN = { name: 'modMain', type: 1, code: 'Public Sub 集計()\r\nEnd Sub\r\n' };
  it('同じパスが別の要素を指すようになっても、別の要素には付けない', async () => {
    app.close();
    invoke.mockReset();
    openDoc();
    cb.vba.status = 'ok';
    cb.vba.modules = [MAIN];
    invoke.mockImplementation(async (type: string) => {
      if (type === 'vba.insert') {
        // 挿入を待つ間に、グループの先頭へ別のボタンが入り、a の位置がずれる
        app.store!.edit('inspector', (d) => {
          const g = d.querySelector('[id="g"]')!;
          g.insertBefore(g.firstElementChild!.cloneNode(false) as Element, g.firstElementChild);
          g.firstElementChild!.setAttribute('id', 'intruder');
          return undefined;
        }, '割り込み');
        return true;
      }
      return { status: 'ok', modules: [MAIN] };
    });
    const macro = listMacros([MAIN])[0]!;
    await expect(cb.assignMacro([{ path: [0, 0, 0, 0, 0], attr: 'onAction' }], macro)).rejects.toThrow('文書が変わった');
    expect(app.store!.doc.querySelector('[id="intruder"]')!.hasAttribute('onAction')).toBe(false);
    expect(app.store!.doc.querySelector('[id="a"]')!.hasAttribute('onAction')).toBe(false);
  });
});

// ---- 低 8・9・16：退避の送り方・破棄・元に戻す ----

describe('退避の送り方と破棄', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  beforeEach(async () => {
    vi.useFakeTimers();
    rec.startRecovery();
    app.close();
    await vi.advanceTimersByTimeAsync(0);
    invoke.mockReset();
    invoke.mockResolvedValue(null);
    app.settings.autoRecovery = true;
    openDoc();
  });

  it('toWire：前回送ったものと違う画像だけを addImages に入れ、いまの画像の id は全部 addImageIds に入れる', () => {
    const parts = [{ version: 'office2010' as const, xml: 'x', addImages: [{ id: 'a', dataUrl: 'A' }, { id: 'b', dataUrl: 'B2' }], removeImages: [] }];
    const wire = rec.toWire(parts, new Map([['office2010:a', 'A'], ['office2010:b', 'B']]));
    expect(wire[0]!.addImages).toEqual([{ id: 'b', dataUrl: 'B2' }]);
    expect(wire[0]!.addImageIds).toEqual(['a', 'b']);
  });

  it('samePayload：XML・画像・編集の回数が同じときだけ同じ', () => {
    const p = { path: 'p', editCount: 1, parts: [{ version: 'office2010' as const, xml: 'x', addImages: [{ id: 'a', dataUrl: 'A' }], removeImages: ['r'] }] };
    const copy = JSON.parse(JSON.stringify(p)) as typeof p;
    expect(rec.samePayload(p, copy)).toBe(true);
    expect(rec.samePayload(p, { ...copy, editCount: 2 })).toBe(false);
    expect(rec.samePayload(p, { ...copy, parts: [{ ...copy.parts[0]!, addImages: [{ id: 'a', dataUrl: 'A2' }] }] })).toBe(false);
    expect(rec.samePayload(null, p)).toBe(false);
  });

  it('2 回目の書き込みでは、前回送った画像を送り直さない。書き込みに失敗したら、次は全部送り直す', async () => {
    app.store!.addImageAndApply({ id: 'img1', dataUrl: PNG, isNew: true }, () => undefined, '画像');
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    edit('二回目');
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    const w = calls('recovery.write');
    expect(w).toHaveLength(2);
    expect((w[0]![1] as { parts: { addImages: unknown[] }[] }).parts[0]!.addImages).toHaveLength(1);
    expect((w[1]![1] as { parts: { addImages: unknown[]; addImageIds: string[] }[] }).parts[0]).toMatchObject({ addImages: [], addImageIds: ['img1'] });

    // 失敗すると、ホストに何が入ったか分からないので、次は画像も送り直す
    invoke.mockImplementationOnce(async () => {
      throw new Error('失敗');
    });
    edit('三回目');
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    edit('四回目');
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    const last = calls('recovery.write').at(-1)![1] as { parts: { addImages: unknown[] }[] };
    expect(last.parts[0]!.addImages).toHaveLength(1);
  });

  it('discardCurrentRecovery：書く予約を取り消し、退避を消す（保存しないで終わる・読み込み直す・更新するとき）', async () => {
    edit();
    await rec.discardCurrentRecovery();
    await vi.advanceTimersByTimeAsync(rec.RECOVERY_DELAY_MS + 50);
    expect(calls('recovery.write')).toHaveLength(0);
    expect(calls('recovery.delete').at(-1)![1]).toEqual({ path: 'C:\\book.xlsm' });
  });
});

describe('復旧のあとの［元に戻す］（低 9）', () => {
  it('復旧したすべてのパーツを戻す', async () => {
    rec.startRecovery();
    app.close();
    await sleep(0);
    invoke.mockReset();
    askRecovery.mockResolvedValue('restore');
    const X07 = XML.replace(NS, 'http://schemas.microsoft.com/office/2006/01/customui');
    invoke.mockImplementation(async (type: string) => {
      if (type === 'file.open') return { path: 'C:\\two.xlsm', parts: [{ version: 'office2010', xml: XML, images: [] }, { version: 'office2007', xml: X07, images: [] }], fingerprint: null };
      if (type === 'recovery.read') return { path: 'C:\\two.xlsm', savedAt: 'x', editCount: 2, parts: [{ version: 'office2010', xml: XML.replace('label="A"', 'label="新"'), addImages: [], removeImages: [] }, { version: 'office2007', xml: X07.replace('label="A"', 'label="旧新"'), addImages: [], removeImages: [] }] };
      return null;
    });
    await openFile('C:\\two.xlsm', { force: true });
    expect(app.dirty).toBe(true);
    Array.from(document.querySelectorAll<HTMLButtonElement>('.toast button')).find((b) => b.textContent === '元に戻す')!.click();
    expect(app.dirty).toBe(false);
  });
});

// ---- 低 11・12・13：画像の覚え・定数・行継続 ----

describe('画像の色の覚え（低 11）', () => {
  it('読めなかった画像も「調べ終えた」と区別でき、「調べています」が消える', () => {
    stats.rememberStats('data:image/png;base64,BROKEN', null);
    const info = stats.imageInfoMap([{ id: 'x', dataUrl: 'data:image/png;base64,BROKEN', isNew: false }]).get('x')!;
    expect(info.examined).toBe(true);
    expect(info.stats).toBeUndefined();
    const d = doc(`<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><button id="b" image="x"/></group></tab></tabs></ribbon></customUI>`);
    const s = collectChecks({ doc: d, problems: [], statuses: [], vbaChecked: false, imageIds: ['x'], fit: null, images: new Map([['x', info]]) });
    expect(s.find((x) => x.id === 'themeIcons')!.note).not.toContain('調べています');
    const pending = collectChecks({ doc: d, problems: [], statuses: [], vbaChecked: false, imageIds: ['x'], fit: null, images: new Map([['x', { ...info, examined: false }]]) });
    expect(pending.find((x) => x.id === 'themeIcons')!.note).toContain('調べています');
  });

  it('覚えには上限があり、閉じたファイルの分は捨てられる', async () => {
    for (let i = 0; i < stats.PIXEL_CACHE_LIMIT + 20; i++) stats.rememberStats(`k${i}`, null);
    expect(stats.cacheSize()).toBe(stats.PIXEL_CACHE_LIMIT);
    stats.rememberStats('keep', null);
    await stats.ensurePixelStats([{ id: 'k', dataUrl: 'keep', isNew: false }]);
    expect(stats.cacheSize()).toBe(1);
  });
});

describe('onLoad の判定（低 12・13）', () => {
  it('宣言が行継続で複数行でも、宣言の引数名を本体の使用と取り違えない', () => {
    const decl = 'Public Sub Ribbon_onLoad( _\r\n    ByVal ribbon As IRibbonUI)\r\n';
    const m = (body: string) => [{ name: 'm', type: 1, code: `${decl}${body}End Sub\r\n` }];
    // 本体で ribbon を使っていない（宣言の 2 行目に ribbon があるだけ）
    expect(onLoadHoldsRibbon(m("    ' TODO\r\n"), 'Ribbon_onLoad', 'm')).toBe(false);
    expect(onLoadHoldsRibbon(m('    Set gRibbon = ribbon\r\n'), 'Ribbon_onLoad', 'm')).toBe(true);
  });
});
