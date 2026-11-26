// 別のブックのリボンから、タブ・グループなどを選んで取り込むダイアログ（仕様書 §23.3）。
// 1 段目：左に取り込み元の部品（チェックつき）、右に取り込んだときの様子（id の振り直し・画像・使うコールバック・XML）。
// 2 段目：取り込んだあとの結果と、VBA は運ばれないので要る Sub の案内（コピー・VBA へ挿入）。

import { app } from '../app';
import { insertStubs, namingRule, vba } from '../callbacks';
import { copyText } from '../clipboard';
import type { SourceBook } from '../importFlow';
import { h } from '../dom';
import { t } from '../i18n';
import { elementAt, parseXml, serialize } from '../model';
import {
  applyImport, callbackUses, flatten, listCandidates, normalizePicks, planImages, previewIdRenames, usedImageIds,
  type ImportCandidate, type ImportOutcome,
} from '../ribbonImport';
import { generateStub, bareCallbackName, parseProcedures } from '../vba';
import { openModal } from './modal';
import { toast } from '../shell/toast';

const KIND_LABEL: Readonly<Record<ImportCandidate['kind'], string>> = {
  tab: 'タブ',
  group: 'グループ',
  tabSet: 'コンテキストタブ',
  contextMenu: '右クリックメニュー',
  backstage: 'Backstage',
};

/** 選んだ部品の XML（プレビュー用）。名前空間の宣言は省く。 */
function fragmentXml(source: Document, c: ImportCandidate): string {
  const el = elementAt(source, c.path);
  if (!el) return '';
  const tmp = document.implementation.createDocument(el.namespaceURI, null, null);
  tmp.appendChild(tmp.importNode(el, true));
  return serialize(tmp).replace(/^(<[^\s>/]+)\s+xmlns(:\w+)?="[^"]*"/, '$1').trimEnd();
}

export function openImportDialog(book: SourceBook): void {
  const store = app.store;
  if (!store) return;
  // 編集中のパーツと同じ世代のパーツを読む。なければ最初のもの（2007 と 2010 の違いは取り込み先の名前空間に直す）
  let part = book.parts.find((p) => p.version === store.version) ?? book.parts[0]!;
  let sourceDoc: Document;
  let images: Map<string, string>;
  let candidates: ImportCandidate[] = [];
  let all: ImportCandidate[] = [];
  const picked = new Set<string>();
  let groupTarget: 'new' | number[] = 'new';
  let renameIds = true;

  const load = (): boolean => {
    const parsed = parseXml(part.xml);
    if (!parsed.ok) {
      toast({ kind: 'error', message: t('「{file}」の XML に構文エラーがあります：{message}', { file: book.name, message: parsed.message }) });
      return false;
    }
    sourceDoc = parsed.doc;
    images = new Map(part.images.map((i) => [i.id, `data:${i.contentType};base64,${i.base64}`]));
    candidates = listCandidates(sourceDoc, store.doc);
    all = flatten(candidates);
    picked.clear();
    return true;
  };
  if (!load()) return;
  if (all.length === 0) {
    toast({ kind: 'warning', message: t('「{file}」には、取り込めるタブ・グループなどがありません', { file: book.name }) });
    return;
  }
  // 最初から、いちばん上のタブを選んでおく（すぐ［取り込む］を押せるように）
  const first = candidates.find((c) => !c.disabledReason);
  if (first) picked.add(first.key);

  /** 取り込み先の、グループを入れられるタブ。 */
  const destTabs = () => Array.from(store.doc.querySelectorAll('tabs > tab')).map((el) => ({ path: pathOfEl(el), label: el.getAttribute('label') || el.getAttribute('id') || el.getAttribute('idMso') || 'tab' }));
  const pathOfEl = (el: Element): number[] => {
    const path: number[] = [];
    for (let cur: Element = el; cur.parentElement; cur = cur.parentElement) path.unshift(Array.prototype.indexOf.call(cur.parentElement.children, cur) as number);
    return path;
  };

  const tree = h('div', { class: 'import-tree', role: 'group', 'aria-label': t('取り込み元の部品') });
  const side = h('div', { class: 'import-side' });
  const importBtn = h('button', { type: 'button', class: 'primary', onclick: () => run() }, t('取り込む'));
  const cancelBtn = h('button', { type: 'button', onclick: () => handle.close() }, t('キャンセル'));
  const closeBtn = h('button', { type: 'button', 'data-initial-focus': '', onclick: () => handle.close() }, t('閉じる'));
  const body = h('div', { class: 'import-dialog' });

  const picks = () => normalizePicks(all, picked);

  const row = (c: ImportCandidate, impliedByTab: boolean): HTMLElement => {
    const checked = picked.has(c.key) || impliedByTab;
    const input = h('input', {
      type: 'checkbox',
      checked,
      disabled: !!c.disabledReason || impliedByTab,
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) picked.add(c.key);
        else picked.delete(c.key);
        renderTree();
        renderSide();
      },
    });
    return h('label', { class: `import-row ${c.kind}${c.disabledReason ? ' disabled' : ''}`, title: c.disabledReason ?? '' },
      input,
      h('span', { class: 'import-title' }, c.title),
      h('span', { class: 'import-kind' }, t(KIND_LABEL[c.kind])),
      c.detail ? h('span', { class: 'import-id' }, c.detail) : null,
      c.disabledReason ? h('span', { class: 'import-reason muted' }, c.disabledReason) : null);
  };

  const renderTree = () => {
    const rows: HTMLElement[] = [];
    for (const c of candidates) {
      rows.push(row(c, false));
      const implied = picked.has(c.key) && !c.disabledReason;
      for (const g of c.children) rows.push(h('div', { class: 'import-child' }, row(g, implied)));
    }
    tree.replaceChildren(...rows);
  };

  const renderSide = () => {
    const chosen = picks();
    importBtn.disabled = chosen.length === 0;
    if (chosen.length === 0) {
      side.replaceChildren(h('p', { class: 'muted' }, t('取り込む部品を、左のチェックで選んでください。')));
      return;
    }
    const els = chosen.map((c) => elementAt(sourceDoc, c.path)).filter((e): e is Element => e !== null);
    const counts = (['tab', 'group', 'tabSet', 'contextMenu', 'backstage'] as const)
      .map((k) => [k, chosen.filter((c) => c.kind === k).length] as const)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${t(KIND_LABEL[k])} ${n}`)
      .join(t('・'));
    const imgPlan = planImages(usedImageIds(els), images, new Map([...store.images.values()].map((i) => [i.id, i.dataUrl])));
    const renames = renameIds ? previewIdRenames(store.doc, sourceDoc, chosen) : [];
    const collisions = previewIdRenames(store.doc, sourceDoc, chosen);
    const cbs = new Set(callbackUses(els).map((u) => u.name));
    const hasGroups = chosen.some((c) => c.kind === 'group');
    const tabs = destTabs();
    const current = groupTarget === 'new' ? null : groupTarget.join('.');
    if (hasGroups && current !== null && !tabs.some((x) => x.path.join('.') === current)) groupTarget = 'new';

    const destSelect = hasGroups
      ? h('label', { class: 'import-opt' }, h('span', null, t('グループを入れるタブ')),
          h('select', {
            'aria-label': t('グループを入れるタブ'),
            onchange: (e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              groupTarget = v === 'new' ? 'new' : v.split('.').map(Number);
            },
          },
          ...tabs.map((x) => h('option', { value: x.path.join('.'), selected: current === x.path.join('.') }, x.label)),
          h('option', { value: 'new', selected: groupTarget === 'new' }, t('（新しいタブを作る）'))))
      : null;

    const idCheck = h('label', { class: 'setting-check' },
      h('input', { type: 'checkbox', checked: renameIds, onchange: (e: Event) => { renameIds = (e.target as HTMLInputElement).checked; renderSide(); } }),
      t('id が重なるものを振り直す'));

    side.replaceChildren(...([
      h('p', null, h('strong', null, t('取り込むもの：')), counts),
      destSelect,
      idCheck,
      collisions.length
        ? h('p', { class: renameIds ? 'muted' : 'field-error' }, renameIds
            ? t('id が重なる {n} 件を振り直します：{list}', { n: collisions.length, list: renames.slice(0, 6).map(([a, b]) => `${a} → ${b}`).join(t('、')) + (renames.length > 6 ? t(' ほか') : '') })
            : t('id が重なる {n} 件があります。このまま取り込むと、Excel でリボンが表示されなくなります（エラー）。', { n: collisions.length }))
        : h('p', { class: 'muted' }, t('id の重なりはありません。')),
      imgPlan.add.length || imgPlan.missing.length
        ? h('p', { class: 'muted' }, imgPlan.add.length ? t('画像 {n} 個を一緒に運びます。', { n: imgPlan.add.length }) + (imgPlan.renamed.length ? ' ' + t('（同じ名前で中身が違う画像は番号を付けます：{list}）', { list: imgPlan.renamed.map(([a, b]) => `${a} → ${b}`).join(t('、')) }) : '') : null,
            imgPlan.missing.length ? h('span', { class: 'field-error' }, ' ' + t('このファイルには画像がないため、運べません：{list}', { list: imgPlan.missing.join(t('、')) })) : null)
        : null,
      cbs.size
        ? h('p', { class: 'import-vba' }, t('VBA は運ばれません。使っているコールバック {n} 件は、取り込んだあとに VBA 側で用意してください（次の画面で雛形を案内します）。', { n: cbs.size }))
        : null,
      h('h3', null, t('取り込まれる XML')),
      h('pre', { class: 'import-xml' }, chosen.map((c) => fragmentXml(sourceDoc, c)).join('\n')),
    ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => x !== null));
  };

  /** 2 段目：結果と、要る Sub の案内。 */
  const showResult = (out: ImportOutcome) => {
    const lines: string[] = [t('取り込みました。元に戻す（Ctrl+Z）で、取り込む前に戻せます。')];
    const details: HTMLElement[] = [];
    if (out.renamedIds.length) details.push(h('p', { class: 'muted' }, t('id を振り直したもの：{list}', { list: out.renamedIds.map(([a, b]) => `${a} → ${b}`).join(t('、')) })));
    if (out.addedImages.length) details.push(h('p', { class: 'muted' }, t('一緒に運んだ画像：{list}', { list: out.addedImages.join(t('、')) })));
    if (out.renamedImages.length) details.push(h('p', { class: 'muted' }, t('番号を付けた画像：{list}', { list: out.renamedImages.map(([a, b]) => `${a} → ${b}`).join(t('、')) })));
    if (out.mergedInto.length) details.push(h('p', { class: 'muted' }, t('同じ組み込みのものがすでにあるため、中へ足しました：{list}', { list: out.mergedInto.join(t('、')) })));
    if (out.renamedCallbacks.length) details.push(h('p', { class: 'muted' }, t('id を振り直したので、命名規則で付けたコールバック名も付け直しました：{list}', { list: out.renamedCallbacks.map(([a, b]) => `${a} → ${b}`).join(t('、')) })));
    if (out.sharedCallbacks.length) details.push(h('p', { class: 'field-error' }, t('次のコールバック名は、取り込み先のほかのコントロールと同じです。押すと、そちらと同じ Sub が動きます。別の名前に付け直してください：{list}', { list: out.sharedCallbacks.join(t('、')) })));
    if (out.renamedIds.length && out.callbacks.length) details.push(h('p', { class: 'muted' }, t('共通のコールバックで control.Id を Select Case で振り分けている場合、振り直した id とは一致しなくなります。VBA 側の Case を確かめてください。')));
    if (out.droppedKeytips.length) details.push(h('p', { class: 'muted' }, t('取り込み先と重なるため、キーヒント（keytip）を外したもの：{list}', { list: out.droppedKeytips.map((k) => `${k.id}（${k.keytip}）`).join(t('、')) })));
    if (out.mergeDroppedAttrs.length) details.push(h('p', { class: 'muted' }, t('合流させたため、取り込み元のタブ・メニュー自身の属性は使いません（捨てました）：{list}', { list: out.mergeDroppedAttrs.map((m) => `${m.idMso}（${m.attrs.join(', ')}）`).join(t('、')) })));
    if (out.addedPrefixes.length) details.push(h('p', { class: 'muted' }, t('idQ などで使う名前空間の接頭辞の宣言を、取り込み先のルートに足しました：{list}', { list: out.addedPrefixes.join(t('、')) })));
    if (out.missingImages.length) details.push(h('p', { class: 'field-error' }, t('運べなかった画像（このファイルにありません）：{list}', { list: out.missingImages.join(t('、')) })));

    const renderCallbacks = () => {
      const statuses = vba.statuses();
      const items = out.callbacks.map((c) => ({ c, st: statuses.find((x) => x.name === c.name) }));
      const need = items.filter((x) => x.st && (x.st.state === 'missing' || x.st.state === 'mismatch') && x.st.uses.length > 0);
      const stateText = (x: (typeof items)[number]) =>
        !vba.canWrite ? t('未確認') : x.st?.state === 'implemented' ? t('VBA にあります') : x.st?.state === 'mismatch' ? t('引数が合いません') : t('VBA にありません');
      const stubs = items.filter((x) => x.st && x.st.state !== 'implemented').map((x) => generateStub({ ...x.st!, name: bareCallbackName(x.st!.name) }));
      return h('section', { class: 'import-callbacks' },
        h('h3', null, t('VBA は運ばれません。次の Sub が要ります')),
        out.callbacks.length === 0
          ? h('p', { class: 'muted' }, t('取り込んだ部品は、コールバック（VBA の Sub）を使っていません。'))
          : h('div', null,
              h('p', { class: 'muted' }, vba.canWrite ? t('いま Excel で開いているブックの VBA と照合しています。') : t('Excel で開いていないため、VBA と照合できません。必要な Sub は、雛形をコピーして用意してください。')),
              h('ul', { class: 'import-cb-list' }, items.map((x) =>
                h('li', null, h('code', null, x.c.name), h('span', { class: 'import-cb-where muted' }, x.c.uses.join(', ')), h('span', { class: `cb-state ${x.st?.state ?? 'none'}` }, stateText(x))))),
              h('div', { class: 'import-cb-actions' },
                stubs.length ? h('button', { type: 'button', class: 'small', onclick: () => copyText(stubs.join('\r\n'), t('{n} 件の Sub の雛形をコピーしました', { n: stubs.length })) }, t('Sub の一覧をコピー')) : null,
                need.length && vba.canWrite
                  ? h('button', { type: 'button', class: 'small primary', onclick: () => void insertStubs(need.map((x) => x.st!)).then((m) => { toast({ kind: 'success', message: m }); body.replaceChildren(...resultBody()); }).catch((e: Error) => toast({ kind: 'error', message: e.message })) }, t('VBA に挿入'))
                  : null)));
    };
    const resultBody = () => [h('p', { class: 'modal-message' }, ...lines), ...details, renderCallbacks()];
    body.replaceChildren(...resultBody());
    handle.root.querySelector('footer')?.replaceChildren(closeBtn);
    closeBtn.focus();
  };

  const run = () => {
    const chosen = picks();
    if (chosen.length === 0) return;
    let out: ImportOutcome | null = null;
    try {
      out = applyImport(store, { doc: sourceDoc, images }, chosen, { renameIds, groupTarget, naming: namingRule(), takenCallbacks: new Set((vba.modules ?? []).flatMap(parseProcedures).map((p) => p.name)) });
    } catch (e) {
      toast({ kind: 'error', message: t('取り込めませんでした：{message}', { message: (e as Error).message }) });
      return;
    }
    // 取り込めなかった理由（XML の構文エラー中など）は、ストアが知らせている
    if (!out) return;
    // 取り込んだあと、VBA の状態を最新にしてから案内する
    void vba.refresh().finally(() => showResult(out!));
    showResult(out);
  };

  const partSelect = book.parts.length > 1
    ? h('select', { 'aria-label': t('読むパーツ'), onchange: (e: Event) => {
        part = book.parts.find((p) => p.version === (e.target as HTMLSelectElement).value) ?? part;
        if (load()) {
          renderTree();
          renderSide();
        }
      } }, book.parts.map((p) => h('option', { value: p.version, selected: p === part }, p.version === 'office2010' ? 'customUI14.xml' : 'customUI.xml')))
    : null;
  const versionNote = part.version !== store.version
    ? h('p', { class: 'muted' }, t('このブックのリボンは {from} 形式です。取り込み先は {to} 形式なので、名前空間を取り込み先に合わせて入れます。', { from: part.version === 'office2010' ? '2010' : '2007', to: store.version === 'office2010' ? '2010' : '2007' }))
    : null;

  body.append(...([
    h('p', { class: 'modal-message' }, t('「{file}」から取り込む部品を選びます。選んだものを、いま編集している文書へ追加します（画像も一緒に運びます）。', { file: book.name })),
    versionNote,
    h('div', { class: 'import-grid' },
      h('div', { class: 'import-left' }, partSelect, tree),
      side)] as (HTMLElement | null)[]).filter((x): x is HTMLElement => x !== null));
  renderTree();
  renderSide();

  const handle = openModal(t('別のブックから取り込む'), body, {
    size: 'lg',
    key: 'importBook',
    footer: [importBtn, cancelBtn],
    initialFocus: importBtn.disabled ? undefined : importBtn,
  });
}
