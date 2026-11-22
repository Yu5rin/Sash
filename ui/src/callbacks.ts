// コールバックと VBA の同期（仕様書 §8.2）。VBA の読み込み状態を持ち、挿入とリネームを行う。

import { app } from './app';
import { invoke, type VbaReadStatus } from './bridge';
import { ask } from './dialogs/modal';
import { allElements, elementAt, type Path } from './model';
import {
  callbackName, generateStub, matchCallbacks, parseProcedures, renameDeclaration,
  RIBBON_HOLDER_MODULE, RIBBON_HOLDER_MODULE_NAME, type CallbackStatus, type NamingRule, type VbaModule,
} from './vba';

class VbaState {
  status: VbaReadStatus | 'idle' = 'idle';
  modules: VbaModule[] | null = null;
  loading = false;

  /** VBA を読み直す。Excel で開いていなければ notOpen になる。 */
  async refresh(): Promise<void> {
    const s = app.session;
    if (!s) return;
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
        return 'VBAと照合しています';
      case 'notOpen':
        return 'ブックがExcelで開かれていないため、VBAと照合できません。Excelで開いてから再読み込みしてください';
      case 'trustDenied':
        return 'Excelの［トラスト センター］→［マクロの設定］で「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」をオンにすると、VBAと照合できます';
      case 'locked':
        return 'VBAプロジェクトがパスワードで保護されているため、照合できません';
      case 'noExcel':
        return 'Excelが見つからないため、VBAとは照合できません。雛形のコピーは使えます';
      default:
        return '';
    }
  }

  statuses(): CallbackStatus[] {
    const store = app.store;
    return store ? matchCallbacks(store.doc, this.status === 'ok' ? this.modules : null) : [];
  }
}

export const vba = new VbaState();

app.on('session', () => {
  vba.status = 'idle';
  vba.modules = null;
  if (app.session && app.info.excelInstalled) void vba.refresh();
});

export function namingRule(): NamingRule {
  const s = app.settings;
  return { pattern: s.callbackPattern, shared: s.callbackShared, sharedPattern: s.callbackSharedPattern };
}

/** 要素と属性から、命名規則に沿ったコールバック名を作る。 */
export function defaultCallbackName(el: Element, attr: string): string {
  const id = el.getAttribute('id') ?? el.getAttribute('idMso') ?? el.localName;
  return callbackName(namingRule(), id, attr, el.localName);
}

/** 未実装のコールバックの雛形を、まとめてモジュールに挿入する。onLoad があれば共通コードも入れる。 */
export async function insertStubs(statuses: CallbackStatus[]): Promise<string> {
  const s = app.session;
  if (!s || !vba.canWrite) throw new Error(vba.statusMessage() || 'VBAに書き込めません');
  const missing = statuses.filter((x) => x.state === 'missing' && x.uses.length > 0);
  if (missing.length === 0) return '挿入するものはありません';
  const needsCore = missing.some((x) => x.uses.some((u) => u.attr === 'onLoad')) && !vba.modules!.some((m) => m.name === RIBBON_HOLDER_MODULE_NAME);
  if (needsCore) await invoke('vba.insert', { path: s.path, module: RIBBON_HOLDER_MODULE_NAME, code: RIBBON_HOLDER_MODULE, documentModule: false });
  const code = missing.map((x) => generateStub({ ...x, name: x.name.replace(/^.*[.!]/, '') })).join('\r\n');
  await invoke('vba.insert', { path: s.path, module: app.settings.callbackModule, code, documentModule: false });
  await vba.refresh();
  return `${missing.length} 件の雛形を ${app.settings.callbackModule} に追加しました${needsCore ? `（共通コード ${RIBBON_HOLDER_MODULE_NAME} も追加）` : ''}。Excelでブックを保存してください`;
}

/**
 * インスペクタでコールバック名を変えたとき、VBA 側の Sub 名も変えるかを確認する（仕様書 §8.2）。
 * 変える場合は宣言行だけを書き換え、同じ名前を使っている他のコントロールの属性もそろえる。
 */
export async function renameCallback(path: Path, attr: string, oldName: string, newName: string): Promise<void> {
  const store = app.store;
  const s = app.session;
  if (!store || !s) return;
  const apply = (all: boolean) =>
    store.edit('inspector', (doc) => {
      const targets = all ? allElements(doc).flatMap((el) => Array.from(el.attributes).filter((a) => a.value === oldName).map((a) => ({ el, name: a.name }))) : [];
      const self = elementAt(doc, path);
      if (self) self.setAttribute(attr, newName);
      for (const t of targets) t.el.setAttribute(t.name, newName);
      return undefined;
    });

  const proc = vba.canWrite ? vba.modules!.flatMap(parseProcedures).find((p) => p.name.toLowerCase() === oldName.replace(/^.*[.!]/, '').toLowerCase()) : undefined;
  if (!proc) {
    apply(false);
    return;
  }
  const r = await ask('VBAのSub名も変えますか？', `VBAの ${proc.module} に ${proc.name} があります。宣言行の名前も ${newName} に変えますか？（Subの中身や、ほかの場所からの呼び出しは書き換えません）`, [
    { value: 'both', label: 'VBAも変える', primary: true },
    { value: 'xml', label: 'XMLだけ変える' },
    { value: 'cancel', label: 'キャンセル' },
  ]);
  if (r === 'cancel' || r === null) return;
  if (r === 'both') {
    await invoke('vba.replaceLine', { path: s.path, module: proc.module, line: proc.line, expected: proc.declaration, replacement: renameDeclaration(proc.declaration, proc.name, newName) });
    apply(true);
    await vba.refresh();
  } else {
    apply(false);
  }
}

/** §8.3：onLoad で IRibbonUI を保持し、Invalidate できるようにする雛形を入れる。 */
export async function setupRibbonHolder(): Promise<string> {
  const store = app.store;
  if (!store) return '';
  if (!store.doc.documentElement.getAttribute('onLoad')) {
    store.edit('inspector', (doc) => {
      doc.documentElement.setAttribute('onLoad', defaultCallbackName(doc.documentElement, 'onLoad'));
      return [];
    });
  }
  if (!vba.canWrite) {
    await navigator.clipboard.writeText(RIBBON_HOLDER_MODULE);
    return 'customUI に onLoad を設定し、共通コードをクリップボードにコピーしました（Excelで開いていればモジュールに直接挿入できます）';
  }
  return insertStubs(vba.statuses());
}

// VBA に存在しないコールバックを Lint の警告として出す（仕様書 §5.6、Excel 連携時のみ）
app.problemProviders.push(() => {
  if (vba.status !== 'ok') return [];
  return vba.statuses().flatMap((st) =>
    st.state === 'missing' || st.state === 'mismatch'
      ? st.uses.map((u) => ({
          severity: 'warning' as const,
          message: st.state === 'missing' ? `コールバック ${st.name} がVBAにありません` : `コールバック ${st.name} の引数が合いません：${st.reason}`,
          path: u.path,
          attr: u.attr,
        }))
      : [],
  );
});
app.on('vba', () => app.scheduleLint());
