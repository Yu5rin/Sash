import { describe, expect, it, vi } from 'vitest';
import { elementAt, insertSmart, pathOf } from '../src/model';
import { ABORT, PartStore, setEditRefusedHandler, type ImageEntry } from '../src/store';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">\n  <ribbon>\n    <tabs>\n      <tab id="t" label="T">\n        <group id="g" label="G">\n          <button id="b" label="B" />\n        </group>\n      </tab>\n    </tabs>\n  </ribbon>\n</customUI>\n`;

const img = (id: string, content = 'QUJD', isNew = false): ImageEntry => ({ id, dataUrl: `data:image/png;base64,${content}`, isNew });

describe('PartStore.edit', () => {
  it('ABORT を返すと履歴にも通知にも残さず false を返す', () => {
    const s = new PartStore('office2010', XML, []);
    const listener = vi.fn();
    s.subscribe(listener);
    const r = s.edit('canvas', (doc) => {
      doc.querySelector('button')!.setAttribute('label', 'X');
      return ABORT;
    });
    expect(r).toBe(false);
    expect(s.canUndo).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    // 途中で書き換えた文書も元に戻る
    expect(s.doc.querySelector('button')!.getAttribute('label')).toBe('B');
    expect(s.dirty).toBe(false);
  });

  it('何も変わらない編集は履歴を増やさず、XML も整形し直さない', () => {
    const raw = `<customUI xmlns="${NS}"><ribbon/></customUI>`;
    const s = new PartStore('office2010', raw, []);
    expect(s.edit('other', () => undefined)).toBe(false);
    expect(s.canUndo).toBe(false);
    expect(s.text).toBe(raw);
  });

  it('例外を投げたら文書を戻して投げ直す', () => {
    const s = new PartStore('office2010', XML, []);
    expect(() =>
      s.edit('canvas', (doc) => {
        doc.querySelector('button')!.remove();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.doc.querySelector('button')).not.toBeNull();
    expect(s.canUndo).toBe(false);
  });

  it('XML に構文エラーがある間は編集を断り、理由を知らせる', () => {
    const s = new PartStore('office2010', XML, []);
    const refused = vi.fn();
    setEditRefusedHandler(refused);
    s.setText('<customUI><ribbon></customUI>');
    const fn = vi.fn(() => undefined);
    expect(s.edit('inspector', fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledTimes(1);
    // 書きかけの XML は捨てない
    expect(s.text).toBe('<customUI><ribbon></customUI>');
    expect(s.addImageAndApply(img('i1'), () => undefined)).toBe(false);
    expect(s.images.has('i1')).toBe(false);
    setEditRefusedHandler(() => undefined);
  });

  it('元に戻す・やり直しの説明を返す', () => {
    const s = new PartStore('office2010', XML, []);
    expect(s.undoLabel).toBeNull();
    s.edit('canvas', (doc) => {
      doc.querySelector('button')!.remove();
      return undefined;
    }, 'ボタン『B』の削除');
    expect(s.undoLabel).toBe('ボタン『B』の削除');
    s.setText(s.text.replace('label="T"', 'label="U"'));
    expect(s.undoLabel).toBe('XML の編集');
    s.undo();
    expect(s.redoLabel).toBe('XML の編集');
    expect(s.undoLabel).toBe('ボタン『B』の削除');
    s.undo();
    expect(s.redoLabel).toBe('ボタン『B』の削除');
    s.redo();
    expect(s.undoLabel).toBe('ボタン『B』の削除');
  });

  it('置ける場所がない挿入（パレットのダブルクリック）では履歴が増えない', () => {
    const s = new PartStore('office2010', `<customUI xmlns="${NS}"><ribbon><tabs><tab id="t"><group id="g"><dialogBoxLauncher><button id="d"/></dialogBoxLauncher></group></tab></tabs></ribbon></customUI>`, []);
    s.select([0, 0, 0, 0], 'canvas');
    const ok = s.edit('canvas', (doc) => {
      const r = insertSmart(doc, s.selectedElement && elementAt(doc, s.selection!), 'dialogBoxLauncher');
      return 'error' in r ? ABORT : pathOf(r.el);
    });
    expect(ok).toBe(false);
    expect(s.canUndo).toBe(false);
  });

  it('選択だけが変わる編集は履歴に残す', () => {
    const s = new PartStore('office2010', XML, []);
    expect(s.edit('canvas', () => [0, 0, 0])).toBe(true);
    expect(s.canUndo).toBe(true);
  });

  it('format は整形済みなら何もしない', () => {
    const s = new PartStore('office2010', XML, []);
    s.format();
    expect(s.canUndo).toBe(false);
    const raw = new PartStore('office2010', `<customUI xmlns="${NS}"><ribbon/></customUI>`, []);
    raw.format();
    expect(raw.canUndo).toBe(true);
    expect(raw.undoLabel).toBe('XML の整形');
  });
});

describe('保存の管理（画像）', () => {
  it('画像を消して元に戻すと、保存しても何も消さない', () => {
    const s = new PartStore('office2010', XML, [img('a')]);
    s.removeImages(['a']);
    expect(s.pendingImageChanges().remove).toEqual(['a']);
    expect(s.dirty).toBe(true);
    s.undo();
    expect(s.pendingImageChanges()).toEqual({ add: [], remove: [] });
    expect(s.dirty).toBe(false);
    expect([...s.removedImages]).toEqual([]);
  });

  it('.sash.json の読み込み（replaceAll）を元に戻すと、元の画像に戻り何も書き込まない', () => {
    const s = new PartStore('office2010', XML, [img('a'), img('b')]);
    s.replaceAll(XML, [img('b', 'WFla', true), img('c', 'Q0Q=', true)]);
    const p = s.pendingImageChanges();
    expect(p.add.map((i) => i.id).sort()).toEqual(['b', 'c']);
    expect(p.remove).toEqual(['a']);
    s.undo();
    expect(s.pendingImageChanges()).toEqual({ add: [], remove: [] });
    expect([...s.images.keys()].sort()).toEqual(['a', 'b']);
    expect(s.dirty).toBe(false);
  });

  it('消して保存したあとに元に戻すと、その画像は書き込み直す対象になる', () => {
    const s = new PartStore('office2010', XML, [img('a')]);
    s.removeImages(['a']);
    s.markSaved(s.saveSnapshot());
    expect(s.dirty).toBe(false);
    s.undo();
    const p = s.pendingImageChanges();
    expect(p.add.map((i) => i.id)).toEqual(['a']);
    expect(p.remove).toEqual([]);
    expect(s.images.get('a')!.isNew).toBe(true);
    expect(s.dirty).toBe(true);
  });

  it('追加して保存したあとに元に戻すと、その画像は消す対象になる', () => {
    const s = new PartStore('office2010', XML, []);
    s.addImage(img('n', 'QUJD', true));
    s.markSaved();
    expect(s.images.get('n')!.isNew).toBe(false);
    s.undo();
    expect(s.pendingImageChanges().remove).toEqual(['n']);
  });

  it('保存中に行った編集は、保存のあとも未保存のまま残る', () => {
    const s = new PartStore('office2010', XML, []);
    s.edit('canvas', (doc) => {
      doc.querySelector('button')!.setAttribute('label', 'X');
      return undefined;
    });
    const snap = s.saveSnapshot();
    s.addImage(img('late', 'QUJD', true));
    s.edit('canvas', (doc) => {
      doc.querySelector('button')!.setAttribute('label', 'Y');
      return undefined;
    });
    s.markSaved(snap);
    expect(s.dirty).toBe(true);
    expect(s.savedXml).toBe(snap.text);
    expect(s.pendingImageChanges().add.map((i) => i.id)).toEqual(['late']);
  });

  it('isNew は表示用で、保存の内容は差分から決まる', () => {
    // 呼び出し側が isNew を付け間違えても、保存済みの画像と同じなら書き込まない
    const s = new PartStore('office2010', XML, [img('a', 'QUJD', true)]);
    expect(s.pendingImageChanges().add).toEqual([]);
    expect(s.images.get('a')!.isNew).toBe(false);
  });

  it('新しく作ったパーツは、空の編集をしなくても未保存', () => {
    const s = new PartStore('office2010', XML, [], { unsaved: true });
    expect(s.dirty).toBe(true);
    expect(s.canUndo).toBe(false);
    s.markSaved();
    expect(s.dirty).toBe(false);
  });

  it('addImageAndApply で ABORT すると、画像も追加しない', () => {
    const s = new PartStore('office2010', XML, []);
    expect(s.addImageAndApply(img('x', 'QUJD', true), () => ABORT)).toBe(false);
    expect(s.images.has('x')).toBe(false);
    expect(s.addImageAndApply(img('x', 'QUJD', true), (doc) => {
      doc.querySelector('button')!.setAttribute('image', 'x');
      return undefined;
    })).toBe(true);
    expect(s.images.get('x')!.isNew).toBe(true);
    s.undo();
    expect(s.images.has('x')).toBe(false);
  });
});
