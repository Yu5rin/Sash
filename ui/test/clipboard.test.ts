import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import {
  allowedIndex, canMove, childTags, copy, cut, duplicate, findInsertSpot, moveSelected, paste, removeSelected, renameDuplicateIds, siblingTags,
} from '../src/clipboard';
import { elementAt, parseXml, pathOf, usedIds } from '../src/model';
import { minimalEdit } from '../src/views/textDiff';
import { clearToasts } from '../src/shell/toast';

const NS = 'http://schemas.microsoft.com/office/2009/07/customui';
const XML = `<customUI xmlns="${NS}">
  <ribbon>
    <tabs>
      <tab id="t" label="T">
        <group id="g" label="G">
          <button id="b1" label="B1" />
          <button id="b2" label="B2" />
          <dialogBoxLauncher>
            <button id="dl" />
          </dialogBoxLauncher>
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>
`;

function doc(xml: string): Document {
  const r = parseXml(xml);
  if (!r.ok) throw new Error(r.message);
  return r.doc;
}

function select(selector: string): void {
  const store = app.store!;
  const el = store.doc.querySelector(selector)!;
  store.select(pathOf(el), 'canvas');
}

function ids(): string[] {
  return Array.from(app.store!.doc.querySelectorAll('group > *')).map((e) => e.getAttribute('id') ?? e.localName);
}

afterEach(() => clearToasts());

beforeEach(() => {
  app.open({ path: 'test.xlam', parts: [{ version: 'office2010', xml: XML, images: [] }] });
});

describe('renameDuplicateIds', () => {
  it('重なる id に数字を付けて振り直す', () => {
    const d = doc(XML);
    const copyEl = d.querySelector('group')!.cloneNode(true) as Element;
    const renamed = renameDuplicateIds(copyEl, usedIds(d));
    expect(copyEl.getAttribute('id')).toBe('g2');
    expect(copyEl.querySelector('button')!.getAttribute('id')).toBe('b3');
    expect(renamed.get('g')).toBe('g2');
  });
});

describe('allowedIndex', () => {
  it('ダイアログ起動ツールより後ろには置かない', () => {
    const d = doc(XML);
    const g = d.querySelector('group')!;
    expect(allowedIndex(g, 'button', 3)).toBe(2);
    expect(allowedIndex(g, 'dialogBoxLauncher', 0)).toBeNull();
  });

  it('置けない親なら null', () => {
    const d = doc(XML);
    expect(allowedIndex(d.querySelector('tab')!, 'button', 0)).toBeNull();
  });
});

describe('findInsertSpot', () => {
  it('中に置けなければ後ろに置く', () => {
    const d = doc(XML);
    const b1 = d.querySelector('#b1, [id="b1"]')!;
    const spot = findInsertSpot(b1, 'button', d)!;
    expect(spot.parent.localName).toBe('group');
    expect(spot.index).toBe(1);
  });
});

describe('コピーと貼り付け', () => {
  it('貼り付けると選択の後ろに入り、id を振り直して選択する', () => {
    select('[id="b1"]');
    expect(copy()).toBe(true);
    expect(paste('canvas')).toBe(true);
    expect(ids()).toEqual(['b1', 'b3', 'b2', 'dialogBoxLauncher']);
    expect(app.store!.selectedElement!.getAttribute('id')).toBe('b3');
  });

  it('切り取りは元を消し、Undo で戻せる', () => {
    select('[id="b2"]');
    expect(cut()).toBe(true);
    expect(ids()).toEqual(['b1', 'dialogBoxLauncher']);
    app.store!.undo();
    expect(ids()).toEqual(['b1', 'b2', 'dialogBoxLauncher']);
  });

  it('グループを選んで貼り付けると、グループの中（起動ツールの前）に入る', () => {
    select('[id="b1"]');
    copy();
    select('group');
    expect(paste('canvas')).toBe(true);
    expect(ids()).toEqual(['b1', 'b2', 'b3', 'dialogBoxLauncher']);
  });
});

describe('複製・削除・移動', () => {
  it('複製は直後に入る', () => {
    select('[id="b1"]');
    expect(duplicate('canvas')).toBe(true);
    expect(ids()).toEqual(['b1', 'b3', 'b2', 'dialogBoxLauncher']);
  });

  it('tabs のように1つしか置けないものは複製しない', () => {
    select('tabs');
    expect(duplicate('canvas')).toBe(false);
  });

  it('最後のコントロールを複製しても、ダイアログ起動ツールの前に入る', () => {
    select('[id="b2"]');
    expect(duplicate('canvas')).toBe(true);
    expect(ids()).toEqual(['b1', 'b2', 'b3', 'dialogBoxLauncher']);
  });

  it('削除の「元に戻す」付きの通知は、そのあとに別の編集や元に戻すがあったら閉じる', () => {
    const undoToast = () => Array.from(document.querySelectorAll('.toast')).find((e) => e.querySelector('.toast-action')?.textContent === '元に戻す');
    select('[id="g"]');
    expect(removeSelected('canvas')).toBe(true);
    expect(undoToast()).toBeDefined();
    // 選択が変わっただけなら残す
    select('[id="t"]');
    expect(undoToast()).toBeDefined();
    // 別の編集をしたら、押しても削除は取り消されないので閉じる
    app.store!.edit('inspector', (d) => { d.querySelector('[id="t"]')!.setAttribute('label', 'X'); }, 'test');
    expect(undoToast()).toBeUndefined();

    select('tabs');
    expect(removeSelected('canvas')).toBe(true);
    expect(undoToast()).toBeDefined();
    app.store!.undo();
    expect(undoToast()).toBeUndefined();
  });

  it('コントロール 1 つの削除は通知しない。複数や、中身のある要素は通知し、前の通知は積まない（総点検 G-17）', () => {
    const undoToasts = () => Array.from(document.querySelectorAll('.toast')).filter((e) => e.querySelector('.toast-action')?.textContent === '元に戻す');
    select('[id="b1"]');
    expect(removeSelected('canvas')).toBe(true);
    expect(undoToasts()).toHaveLength(0);
    // 中身のあるグループを消す → 通知。続けて別の中身のある要素を消しても、通知は 1 つのまま
    select('[id="g"]');
    expect(removeSelected('canvas')).toBe(true);
    expect(undoToasts()).toHaveLength(1);
    app.store!.undo();
    app.store!.undo();
    select('[id="t"]');
    expect(removeSelected('canvas')).toBe(true);
    expect(undoToasts()).toHaveLength(1);
  });

  it('削除すると次の兄弟を選ぶ', () => {
    select('[id="b1"]');
    expect(removeSelected('canvas')).toBe(true);
    expect(app.store!.selectedElement!.getAttribute('id')).toBe('b2');
  });

  it('customUI は削除しない', () => {
    app.store!.select([], 'canvas');
    expect(removeSelected('canvas')).toBe(false);
  });

  it('上下に動かせる。起動ツールの後ろには動かさない', () => {
    select('[id="b2"]');
    expect(canMove(app.store!.selectedElement!, 1)).toBe(false);
    expect(moveSelected(-1, 'canvas')).toBe(true);
    expect(ids()).toEqual(['b2', 'b1', 'dialogBoxLauncher']);
    expect(elementAt(app.store!.doc, app.store!.selection!)!.getAttribute('id')).toBe('b2');
  });
});

describe('右クリックメニューの候補', () => {
  it('前に挿入・子を追加はスキーマで置けるものだけ', () => {
    const d = doc(XML);
    const b1 = d.querySelector('[id="b1"]')!;
    expect(siblingTags(b1)).toContain('toggleButton');
    expect(siblingTags(b1)).not.toContain('dialogBoxLauncher');
    expect(childTags(b1)).toEqual([]);
    expect(childTags(d.querySelector('tab')!)).toEqual(['group']);
  });
});

describe('minimalEdit', () => {
  it('変わった部分だけを返す', () => {
    expect(minimalEdit('abcXYZdef', 'abcQdef')).toEqual({ start: 3, end: 6, text: 'Q' });
    expect(minimalEdit('same', 'same')).toBeNull();
    expect(minimalEdit('aaa', 'aaaa')).toEqual({ start: 3, end: 3, text: 'a' });
  });
});
