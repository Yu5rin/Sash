// コールバックと VBA の同期（仕様書 §8.2）。VBA の読み込み状態を持ち、挿入とリネームを行う。

import { app } from './app';
import { invoke, type VbaReadStatus } from './bridge';
import { ask } from './dialogs/modal';
import { t } from './i18n';
import { allElements, elementAt, type Path } from './model';
import { attributes, isVbaIdentifier } from './schema';
import { reportRefusal } from './store';
import {
  bareCallbackName, callbackName, generateStub, matchCallbacks, parseProcedures, renameDeclaration,
  RIBBON_HOLDER_MODULE, RIBBON_HOLDER_MODULE_NAME, type CallbackStatus, type NamingRule, type VbaModule,
} from './vba';

class VbaState {
  status: VbaReadStatus | 'idle' = 'idle';
  modules: VbaModule[] | null = null;
  loading = false;

  /** VBA を読み直す。Excel で開いていなければ notOpen になる。 */
  async refresh(): Promise<void> {
    const s = app.session;
    // ファイルのないセッション（サンプル）は、Excel で開かれていることがないので読みに行かない（空のパスを送らない）
    if (!s || !s.path) return;
    this.loading = true;
    app.emit('vba');
    try {
      const r = await invoke('vba.read', { path: s.path });
      this.status = r.status;
      this.modules = r.status === 'ok' ? r.modules : null;
    } catch {
      this.status = 'idle';
      this.modules = null;
    } finally {
      this.loading = false;
      app.emit('vba');
    }
  }

  get canWrite(): boolean {
    return this.status === 'ok';
  }

  statusMessage(): string {
    switch (this.status) {
      case 'ok':
        return t('VBAと照合しています');
      case 'notOpen':
        return t('ブックがExcelで開かれていないため、VBAと照合できません。Excelで開いてから再読み込みしてください');
      case 'trustDenied':
        return t('Excelの［トラスト センター］→［マクロの設定］で「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」をオンにすると、VBAと照合できます');
      case 'locked':
        return t('VBAプロジェクトがパスワードで保護されているため、照合できません');
      case 'noExcel':
        return t('Excelが見つからないため、VBAとは照合できません。雛形のコピーは使えます');
      default:
        return '';
    }
  }

  private memo: { doc: Document; text: string; modules: VbaModule[] | null; result: CallbackStatus[] } | null = null;

  /**
   * XML と VBA の照合結果。描画のたび・行ごとに呼ばれるので、文書（と XML の文字列）と VBA のモジュールが
   * 変わらない間は前の結果を返す。返した配列は書き換えないこと。
   */
  statuses(): CallbackStatus[] {
    const store = app.store;
    if (!store) return [];
    const modules = this.status === 'ok' ? this.modules : null;
    const m = this.memo;
    if (m && m.doc === store.doc && m.text === store.text && m.modules === modules) return m.result;
    const result = matchCallbacks(store.doc, modules);
    this.memo = { doc: store.doc, text: store.text, modules, result };
    return result;
  }
}

export const vba = new VbaState();

app.on('session', () => {
  vba.status = 'idle';
  vba.modules = null;
  // パスのないセッション（同梱のサンプル）は Excel で開かれていないので、VBA を読みに行かない
  if (app.session && app.session.path && app.info.excelInstalled) void vba.refresh();
});

export function namingRule(): NamingRule {
  const s = app.settings;
  return { pattern: s.callbackPattern, shared: s.callbackShared, sharedPattern: s.callbackSharedPattern };
}

/**
 * 要素と属性から、命名規則に沿ったコールバック名を作る。
 * ほかの要素が使っているコールバック名と重なるとき（id の記号を _ にした結果が同じになったときなど）は番号を付けて避ける。
 */
export function defaultCallbackName(el: Element, attr: string): string {
  const id = el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName;
  const taken = new Set<string>();
  for (const other of allElements(el.ownerDocument)) {
    if (other === el) continue;
    for (const a of Array.from(other.attributes)) if (attributes.get(a.name)?.kind === 'callback' && a.value) taken.add(bareCallbackName(a.value));
  }
  return callbackName(namingRule(), id, attr, el.localName, taken);
}

/** 共通コード（modRibbonCore）がまだ VBA になければ入れる。入れたら true。 */
async function ensureCoreModule(path: string): Promise<boolean> {
  if (vba.modules!.some((m) => m.name === RIBBON_HOLDER_MODULE_NAME)) return false;
  await invoke('vba.insert', { path, module: RIBBON_HOLDER_MODULE_NAME, code: RIBBON_HOLDER_MODULE, documentModule: false });
  return true;
}

/** 未実装のコールバックの雛形を、まとめてモジュールに挿入する。onLoad があれば共通コードも入れる。 */
export async function insertStubs(statuses: CallbackStatus[], options: { core?: boolean } = {}): Promise<string> {
  const s = app.session;
  if (!s || !vba.canWrite) throw new Error(vba.statusMessage() || t('VBAに書き込めません'));
  const missing = statuses.filter((x) => x.state === 'missing' && x.uses.length > 0);
  const wantsCore = options.core === true || missing.some((x) => x.uses.some((u) => u.attr === 'onLoad'));
  const addedCore = wantsCore ? await ensureCoreModule(s.path) : false;
  if (missing.length === 0) {
    if (addedCore) await vba.refresh();
    return addedCore ? t('共通コード {core} を追加しました。Excelでブックを保存してください', { core: RIBBON_HOLDER_MODULE_NAME }) : t('挿入するものはありません');
  }
  const code = missing.map((x) => generateStub({ ...x, name: bareCallbackName(x.name) })).join('\r\n');
  await invoke('vba.insert', { path: s.path, module: app.settings.callbackModule, code, documentModule: false });
  await vba.refresh();
  return addedCore
    ? t('{n} 件の雛形を {module} に追加しました（共通コード {core} も追加）。Excelでブックを保存してください', { n: missing.length, module: app.settings.callbackModule, core: RIBBON_HOLDER_MODULE_NAME })
    : t('{n} 件の雛形を {module} に追加しました。Excelでブックを保存してください', { n: missing.length, module: app.settings.callbackModule });
}

/**
 * インスペクタでコールバック名を変えたとき、VBA 側の Sub 名も変えるかを確認する（仕様書 §8.2）。
 * 変える場合は宣言行だけを書き換え、同じ名前を使っている他のコントロールのコールバック属性もそろえる
 * （label や tag に同じ文字列があっても書き換えない）。
 * 呼び出し側は await してもしなくてもよい。失敗は例外にせず、トーストで知らせる。
 * 戻り値は、XML を書き換えたかどうか。
 */
export async function renameCallback(path: Path, attr: string, oldName: string, newName: string): Promise<boolean> {
  try {
    return await renameCallbackUnsafe(path, attr, oldName, newName);
  } catch (e) {
    reportRefusal(t('コールバック名を変えられませんでした：{message}', { message: (e as Error).message }));
    return false;
  }
}

async function renameCallbackUnsafe(path: Path, attr: string, oldName: string, newName: string): Promise<boolean> {
  const store = app.store;
  const s = app.session;
  if (!store || !s) return false;
  const newBare = bareCallbackName(newName);
  if (!isVbaIdentifier(newBare)) {
    reportRefusal(t('「{name}」はVBAのSub名として使えません', { name: newBare }));
    return false;
  }
  const label = t('コールバック名の変更（{old} → {name}）', { old: oldName, name: newName });
  const apply = (all: boolean) =>
    store.edit('inspector', (doc) => {
      const targets = all
        ? allElements(doc).flatMap((el) =>
            Array.from(el.attributes)
              .filter((a) => a.value === oldName && attributes.get(a.name)?.kind === 'callback')
              .map((a) => ({ el, name: a.name })),
          )
        : [];
      const self = elementAt(doc, path);
      if (self) self.setAttribute(attr, newName);
      for (const x of targets) x.el.setAttribute(x.name, newName);
      return undefined;
    }, label);

  const oldBare = bareCallbackName(oldName).toLowerCase();
  const proc = vba.canWrite ? vba.modules!.flatMap(parseProcedures).find((p) => p.name.toLowerCase() === oldBare) : undefined;
  if (!proc) return apply(false);
  const r = await ask(t('VBAのSub名も変えますか？'), t('VBAの {module} に {name} があります。宣言行の名前も {newName} に変えますか？（Subの中身や、ほかの場所からの呼び出しは書き換えません）', { module: proc.module, name: proc.name, newName: newBare }), [
    { value: 'both', label: t('VBAも変える'), primary: true },
    { value: 'xml', label: t('XMLだけ変える') },
    { value: 'cancel', label: t('キャンセル') },
  ]);
  if (r === 'cancel' || r === null) return false;
  if (r === 'xml') return apply(false);
  // VBA を先に書き換えるので、XML を書き換えられない状態（構文エラー中）なら VBA にも触らない
  if (store.syncError) {
    reportRefusal(t('XMLに構文エラーがあるため、この操作はできません。先にXMLエディタでエラーを直してください'));
    return false;
  }
  const replaced = await invoke('vba.replaceLine', { path: s.path, module: proc.module, line: proc.line, expected: proc.declaration, replacement: renameDeclaration(proc.declaration, proc.name, newBare) });
  if (!replaced) {
    // 読み込んだあとに VBA が変わっていて、宣言行が見つからなかった。XML も変えずに、読み直してもらう
    reportRefusal(t('VBAの {module} が読み込んだときから変わっているため、Sub名を変えられませんでした。VBAを再読み込みしてからやり直してください', { module: proc.module }));
    await vba.refresh();
    return false;
  }
  const ok = apply(true);
  await vba.refresh();
  return ok;
}

export interface VbaRenameResult {
  /** VBA の宣言行を書き換えたもの（古い名前、bare）。 */
  renamed: string[];
  /** VBA に Sub がなかったもの（XML だけ変えればよい）。 */
  notFound: string[];
  /** 書き換えられなかったもの。 */
  failed: { name: string; reason: string }[];
}

/**
 * VBA の Sub 名をまとめて変える（ID の一括置換から使う）。renameCallback と同じく宣言行だけを書き換える。
 * 1件ずつ順に書き換え、失敗しても残りは続ける（どれが失敗したかを呼び出し側が利用者に示し、XML の側もそれに合わせるため）。
 * XML は書き換えない。終わったら VBA を読み直す。
 */
export async function renameVbaSubs(renames: readonly { oldName: string; newName: string }[]): Promise<VbaRenameResult> {
  const result: VbaRenameResult = { renamed: [], notFound: [], failed: [] };
  const s = app.session;
  if (!s || !vba.canWrite || renames.length === 0) {
    result.notFound = renames.map((r) => bareCallbackName(r.oldName));
    return result;
  }
  const procs = vba.modules!.flatMap(parseProcedures);
  for (const r of renames) {
    const oldBare = bareCallbackName(r.oldName);
    const newBare = bareCallbackName(r.newName);
    const proc = procs.find((p) => p.name.toLowerCase() === oldBare.toLowerCase());
    if (!proc) {
      result.notFound.push(oldBare);
      continue;
    }
    if (!isVbaIdentifier(newBare)) {
      result.failed.push({ name: oldBare, reason: t('「{name}」はVBAのSub名として使えません', { name: newBare }) });
      continue;
    }
    if (procs.some((p) => p !== proc && p.name.toLowerCase() === newBare.toLowerCase())) {
      result.failed.push({ name: oldBare, reason: t('VBAに同じ名前の {name} がすでにあります', { name: newBare }) });
      continue;
    }
    try {
      const ok = await invoke('vba.replaceLine', { path: s.path, module: proc.module, line: proc.line, expected: proc.declaration, replacement: renameDeclaration(proc.declaration, proc.name, newBare) });
      if (ok) result.renamed.push(oldBare);
      else result.failed.push({ name: oldBare, reason: t('読み込んだときから {module} が変わっています', { module: proc.module }) });
    } catch (e) {
      result.failed.push({ name: oldBare, reason: (e as Error).message });
    }
  }
  await vba.refresh();
  return result;
}

/** §8.3：onLoad で IRibbonUI を保持し、Invalidate できるようにする雛形を入れる。 */
export async function setupRibbonHolder(): Promise<string> {
  const store = app.store;
  if (!store) return '';
  if (!store.doc.documentElement.getAttribute('onLoad')) {
    const ok = store.edit('inspector', (doc) => {
      doc.documentElement.setAttribute('onLoad', defaultCallbackName(doc.documentElement, 'onLoad'));
      return [];
    }, t('onLoad の設定'));
    // XML の構文エラーなどで onLoad を設定できなければ、VBA にも何も入れない（理由は edit が知らせている）
    if (!ok) return '';
  }
  const onLoad = store.doc.documentElement.getAttribute('onLoad');
  if (!vba.canWrite) {
    // Excel で開いていないときは、共通コードと onLoad の雛形の両方をコピーする（片方だけだと onLoad が動かない）
    const stub = onLoad
      ? generateStub({ name: bareCallbackName(onLoad), expected: '', uses: [{ attr: 'onLoad', tag: 'customUI', id: 'customUI', path: [] }] })
      : '';
    const text = [`' ===== ${RIBBON_HOLDER_MODULE_NAME} =====`, RIBBON_HOLDER_MODULE, stub ? `' ===== ${app.settings.callbackModule} =====\r\n${stub}` : ''].filter(Boolean).join('\r\n');
    await navigator.clipboard.writeText(text);
    return t('customUI に onLoad を設定し、共通コードと onLoad の雛形をクリップボードにコピーしました（Excelで開いていればモジュールに直接挿入できます）');
  }
  // onLoad の Sub がすでにあっても、共通コードがなければ入れる
  return insertStubs(vba.statuses(), { core: true });
}

// VBA に存在しないコールバックを Lint の警告として出す（仕様書 §5.6、Excel 連携時のみ）
app.problemProviders.push(() => {
  if (vba.status !== 'ok') return [];
  return vba.statuses().flatMap((st) =>
    st.state === 'missing' || st.state === 'mismatch'
      ? st.uses.map((u) => ({
          severity: 'warning' as const,
          message: st.state === 'missing' ? t('コールバック {name} がVBAにありません', { name: st.name }) : t('コールバック {name} の引数が合いません：{reason}', { name: st.name, reason: st.reason ?? '' }),
          path: u.path,
          attr: u.attr,
        }))
      : [],
  );
});
app.on('vba', () => app.scheduleLint());
