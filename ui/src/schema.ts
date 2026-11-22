// customUI（2007 / 2010以降）の要素と属性の定義。
// インスペクタの入力欄、Lint の構造チェック、XML エディタの補完の三つが、この定義を共有する。
// 対象は第1弾の範囲（リボン、QAT、commands）。backstage と contextMenus は中身を検証しない。

export type AttrKind =
  | 'id'
  | 'string'
  | 'bool'
  | 'enum'
  | 'int'
  | 'idMso'
  | 'imageMso'
  | 'image'
  | 'callback';

export type Category = '基本' | '表示' | '動作' | '詳細';

export interface AttrDef {
  name: string;
  kind: AttrKind;
  category: Category;
  /** 日本語の説明（ホバーで表示する）。 */
  desc: string;
  /** 指定例。 */
  example?: string;
  /** kind が enum のときの値。 */
  values?: readonly string[];
  /** 静的属性に対応する get 系コールバック（例：label → getLabel）。 */
  dynamic?: string;
  /** get 系コールバックに対応する静的属性（例：getLabel → label）。 */
  staticOf?: string;
  /** 2010以降の形式でのみ使える。 */
  since2010?: boolean;
}

export interface ElementDef {
  tag: string;
  /** パレットやツリーに出す日本語名。 */
  title: string;
  attrs: readonly string[];
  children: readonly string[];
  /** id / idMso / idQ のいずれかが必須か。 */
  idRequired: boolean;
  /** キャンバスに置けるコントロールか（グループの中身になれるか）。 */
  isControl: boolean;
  /** 子要素の中身を検証しない（第2弾以降の対象）。 */
  opaque?: boolean;
  since2010?: boolean;
}

// ---- 属性 ----

const a = (def: AttrDef): AttrDef => def;

const pair = (name: string, dyn: string, kind: AttrKind, category: Category, desc: string, extra: Partial<AttrDef> = {}): AttrDef[] => [
  a({ name, kind, category, desc, dynamic: dyn, ...extra }),
  a({ name: dyn, kind: 'callback', category: '動作', desc: `${desc}（VBAで動的に返す）`, staticOf: name }),
];

const attrList: AttrDef[] = [
  a({ name: 'id', kind: 'id', category: '基本', desc: '自分で作るコントロールの識別子。ファイル内で一意にする', example: 'btn1' }),
  a({ name: 'idMso', kind: 'idMso', category: '基本', desc: '組み込みのタブ・グループ・コマンドを指す識別子', example: 'TabHome' }),
  a({ name: 'idQ', kind: 'string', category: '詳細', desc: '名前空間つきの識別子。複数のアドインで同じタブを共有するときに使う', example: 'x:tabShared' }),
  a({ name: 'tag', kind: 'string', category: '詳細', desc: 'コールバックで control.Tag として受け取れる任意の文字列' }),
  a({ name: 'insertAfterMso', kind: 'idMso', category: '詳細', desc: '指定した組み込みコントロールの後ろに配置する', example: 'GroupFont' }),
  a({ name: 'insertBeforeMso', kind: 'idMso', category: '詳細', desc: '指定した組み込みコントロールの前に配置する', example: 'TabHome' }),
  a({ name: 'insertAfterQ', kind: 'string', category: '詳細', desc: '指定した idQ のコントロールの後ろに配置する' }),
  a({ name: 'insertBeforeQ', kind: 'string', category: '詳細', desc: '指定した idQ のコントロールの前に配置する' }),
  ...pair('label', 'getLabel', 'string', '基本', '表示する文字列', { example: '集計する' }),
  ...pair('visible', 'getVisible', 'bool', '表示', '表示するかどうか'),
  ...pair('enabled', 'getEnabled', 'bool', '表示', '押せるかどうか'),
  ...pair('showLabel', 'getShowLabel', 'bool', '表示', 'ラベルを表示するかどうか'),
  ...pair('showImage', 'getShowImage', 'bool', '表示', 'アイコンを表示するかどうか'),
  ...pair('screentip', 'getScreentip', 'string', '表示', 'ホバー時のヒントの見出し'),
  ...pair('supertip', 'getSupertip', 'string', '表示', 'ホバー時のヒントの本文'),
  ...pair('keytip', 'getKeytip', 'string', '表示', 'Altキーを押したときのアクセスキー（1〜3文字）', { example: 'S' }),
  ...pair('size', 'getSize', 'enum', '基本', '大きさ。large は縦長の大きいボタン', { values: ['normal', 'large'] }),
  ...pair('description', 'getDescription', 'string', '表示', 'メニュー内で itemSize="large" のときに出る説明文'),
  ...pair('title', 'getTitle', 'string', '基本', 'メニューの区切り線に付ける見出し'),
  a({ name: 'image', kind: 'image', category: '表示', desc: 'ファイルに埋め込んだ画像（customUI/images）のId', dynamic: 'getImage', example: 'img_btn1' }),
  a({ name: 'imageMso', kind: 'imageMso', category: '表示', desc: '組み込みアイコンの名前', dynamic: 'getImage', example: 'AutoSum' }),
  a({ name: 'getImage', kind: 'callback', category: '動作', desc: 'アイコンをVBAで動的に返す', staticOf: 'image' }),
  a({ name: 'onAction', kind: 'callback', category: '動作', desc: 'クリックされたときに呼ばれるVBAのSub' }),
  a({ name: 'getPressed', kind: 'callback', category: '動作', desc: '押された状態（True / False）をVBAで返す' }),
  a({ name: 'onChange', kind: 'callback', category: '動作', desc: '文字が入力されたときに呼ばれるVBAのSub' }),
  a({ name: 'getText', kind: 'callback', category: '動作', desc: '入力欄に表示する文字列をVBAで返す' }),
  a({ name: 'getContent', kind: 'callback', category: '動作', desc: 'メニューの中身（XML文字列）をVBAで返す' }),
  a({ name: 'getItemCount', kind: 'callback', category: '動作', desc: '項目の数をVBAで返す' }),
  a({ name: 'getItemLabel', kind: 'callback', category: '動作', desc: '各項目のラベルをVBAで返す' }),
  a({ name: 'getItemImage', kind: 'callback', category: '動作', desc: '各項目のアイコンをVBAで返す' }),
  a({ name: 'getItemID', kind: 'callback', category: '動作', desc: '各項目のidをVBAで返す' }),
  a({ name: 'getItemScreentip', kind: 'callback', category: '動作', desc: '各項目のヒントの見出しをVBAで返す' }),
  a({ name: 'getItemSupertip', kind: 'callback', category: '動作', desc: '各項目のヒントの本文をVBAで返す' }),
  a({ name: 'getSelectedItemID', kind: 'callback', category: '動作', desc: '選択中の項目のidをVBAで返す' }),
  a({ name: 'getSelectedItemIndex', kind: 'callback', category: '動作', desc: '選択中の項目の番号をVBAで返す' }),
  a({ name: 'getItemWidth', kind: 'callback', category: '動作', desc: '項目の幅をVBAで返す' }),
  a({ name: 'getItemHeight', kind: 'callback', category: '動作', desc: '項目の高さをVBAで返す' }),
  a({ name: 'onLoad', kind: 'callback', category: '動作', desc: 'リボンの読み込み時に呼ばれ、IRibbonUI を受け取る。Invalidate に必要' }),
  a({ name: 'loadImage', kind: 'callback', category: '動作', desc: 'image 属性の値から画像を返す共通のコールバック' }),
  a({ name: 'startFromScratch', kind: 'bool', category: '詳細', desc: '組み込みのタブをすべて隠し、自分のタブだけにする' }),
  a({ name: 'autoScale', kind: 'bool', category: '詳細', desc: '画面幅に合わせてグループ内の大きさを自動で調整する', since2010: true }),
  a({ name: 'centerVertically', kind: 'bool', category: '詳細', desc: 'グループ内のコントロールを縦方向の中央にそろえる', since2010: true }),
  a({ name: 'itemSize', kind: 'enum', category: '表示', desc: 'メニュー項目の大きさ', values: ['normal', 'large'] }),
  a({ name: 'boxStyle', kind: 'enum', category: '基本', desc: '並べる向き', values: ['horizontal', 'vertical'] }),
  a({ name: 'sizeString', kind: 'string', category: '詳細', desc: '幅の基準にする文字列（この文字列が収まる幅になる）', example: 'WWWWWWWWWW' }),
  a({ name: 'maxLength', kind: 'int', category: '詳細', desc: '入力できる最大の文字数' }),
  a({ name: 'showItemLabel', kind: 'bool', category: '表示', desc: '項目のラベルを表示するかどうか' }),
  a({ name: 'showItemImage', kind: 'bool', category: '表示', desc: '項目のアイコンを表示するかどうか' }),
  a({ name: 'columns', kind: 'int', category: '表示', desc: 'ギャラリーの列数' }),
  a({ name: 'rows', kind: 'int', category: '表示', desc: 'ギャラリーの行数' }),
  a({ name: 'itemWidth', kind: 'int', category: '表示', desc: 'ギャラリー項目の幅（px）' }),
  a({ name: 'itemHeight', kind: 'int', category: '表示', desc: 'ギャラリー項目の高さ（px）' }),
  a({ name: 'invalidateContentOnDrop', kind: 'bool', category: '詳細', desc: '開くたびに中身を作り直す' }),
];

export const attributes: ReadonlyMap<string, AttrDef> = new Map(attrList.map((d) => [d.name, d]));

// ---- 要素 ----

const ID = ['id', 'idMso', 'idQ', 'tag'];
const INSERT = ['insertAfterMso', 'insertBeforeMso', 'insertAfterQ', 'insertBeforeQ'];
const VIS = ['visible', 'getVisible'];
const EN = ['enabled', 'getEnabled'];
const LABEL = ['label', 'getLabel'];
const SHOWLABEL = ['showLabel', 'getShowLabel'];
const IMG = ['image', 'imageMso', 'getImage'];
const SHOWIMG = ['showImage', 'getShowImage'];
const TIPS = ['screentip', 'getScreentip', 'supertip', 'getSupertip'];
const KEYTIP = ['keytip', 'getKeytip'];
const SIZE = ['size', 'getSize'];
const DESC = ['description', 'getDescription'];
const ITEMS = ['getItemCount', 'getItemLabel', 'getItemImage', 'getItemID', 'getItemScreentip', 'getItemSupertip'];
const BUTTONLIKE = [...ID, ...INSERT, ...LABEL, ...IMG, ...SIZE, ...VIS, ...EN, ...SHOWLABEL, ...SHOWIMG, ...TIPS, ...KEYTIP, ...DESC];

const GROUP_CONTROLS = [
  'button', 'toggleButton', 'checkBox', 'splitButton', 'menu', 'dynamicMenu', 'gallery', 'dropDown',
  'comboBox', 'editBox', 'labelControl', 'box', 'buttonGroup', 'separator', 'control', 'dialogBoxLauncher',
];
const BOX_CONTROLS = GROUP_CONTROLS.filter((t) => t !== 'separator' && t !== 'dialogBoxLauncher');
const MENU_CONTROLS = ['button', 'toggleButton', 'checkBox', 'splitButton', 'menu', 'dynamicMenu', 'gallery', 'menuSeparator', 'control'];
const QAT_CONTROLS = ['button', 'toggleButton', 'checkBox', 'splitButton', 'menu', 'dynamicMenu', 'gallery', 'dropDown', 'comboBox', 'editBox', 'labelControl', 'box', 'buttonGroup', 'separator', 'control'];

const e = (def: Omit<ElementDef, 'idRequired' | 'isControl'> & Partial<ElementDef>): ElementDef => ({
  idRequired: false,
  isControl: false,
  ...def,
});

const elementList: ElementDef[] = [
  e({ tag: 'customUI', title: 'customUI', attrs: ['onLoad', 'loadImage'], children: ['commands', 'ribbon', 'backstage', 'contextMenus'] }),
  e({ tag: 'commands', title: 'コマンドの上書き', attrs: [], children: ['command'] }),
  e({ tag: 'command', title: 'コマンド', attrs: ['idMso', ...EN, 'onAction'], children: [], idRequired: true }),
  e({ tag: 'ribbon', title: 'リボン', attrs: ['startFromScratch'], children: ['officeMenu', 'qat', 'tabs', 'contextualTabs'] }),
  e({ tag: 'officeMenu', title: 'Officeメニュー（2007）', attrs: [], children: MENU_CONTROLS, opaque: true }),
  e({ tag: 'qat', title: 'クイックアクセスツールバー', attrs: [], children: ['sharedControls', 'documentControls'] }),
  e({ tag: 'sharedControls', title: '共有コントロール', attrs: [], children: QAT_CONTROLS }),
  e({ tag: 'documentControls', title: 'ブック固有のコントロール', attrs: [], children: QAT_CONTROLS }),
  e({ tag: 'tabs', title: 'タブの一覧', attrs: [], children: ['tab'] }),
  e({ tag: 'contextualTabs', title: 'コンテキストタブ', attrs: [], children: ['tabSet'] }),
  e({ tag: 'tabSet', title: 'タブセット', attrs: ['idMso', ...VIS], children: ['tab'], idRequired: true }),
  e({ tag: 'tab', title: 'タブ', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, ...KEYTIP], children: ['group'], idRequired: true }),
  e({ tag: 'group', title: 'グループ', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...TIPS, ...KEYTIP, 'autoScale', 'centerVertically'], children: GROUP_CONTROLS, idRequired: true }),
  e({ tag: 'button', title: 'ボタン', attrs: [...BUTTONLIKE, 'onAction'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'toggleButton', title: 'トグルボタン', attrs: [...BUTTONLIKE, 'getPressed', 'onAction'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'checkBox', title: 'チェックボックス', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, ...EN, ...TIPS, ...KEYTIP, ...DESC, 'getPressed', 'onAction'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'splitButton', title: '分割ボタン', attrs: [...ID, ...INSERT, ...SIZE, ...VIS, ...EN, ...SHOWLABEL, ...KEYTIP], children: ['button', 'toggleButton', 'menu'], idRequired: true, isControl: true }),
  e({ tag: 'menu', title: 'メニュー', attrs: [...BUTTONLIKE, 'itemSize'], children: MENU_CONTROLS, idRequired: true, isControl: true }),
  e({ tag: 'dynamicMenu', title: '動的メニュー', attrs: [...BUTTONLIKE, 'getContent', 'invalidateContentOnDrop'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'gallery', title: 'ギャラリー', attrs: [...BUTTONLIKE, 'columns', 'rows', 'itemWidth', 'itemHeight', 'getItemWidth', 'getItemHeight', 'showItemLabel', 'showItemImage', 'sizeString', ...ITEMS, 'getSelectedItemID', 'getSelectedItemIndex', 'onAction', 'invalidateContentOnDrop'], children: ['item', 'button'], idRequired: true, isControl: true }),
  e({ tag: 'dropDown', title: 'ドロップダウン', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...EN, ...SHOWLABEL, ...SHOWIMG, ...TIPS, ...KEYTIP, 'sizeString', 'showItemLabel', 'showItemImage', ...ITEMS, 'getSelectedItemID', 'getSelectedItemIndex', 'onAction'], children: ['item', 'button'], idRequired: true, isControl: true }),
  e({ tag: 'comboBox', title: 'コンボボックス', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...EN, ...SHOWLABEL, ...SHOWIMG, ...TIPS, ...KEYTIP, 'sizeString', 'maxLength', 'showItemImage', ...ITEMS, 'getText', 'onChange', 'invalidateContentOnDrop'], children: ['item'], idRequired: true, isControl: true }),
  e({ tag: 'editBox', title: 'テキストボックス', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...EN, ...SHOWLABEL, ...SHOWIMG, ...TIPS, ...KEYTIP, 'sizeString', 'maxLength', 'getText', 'onChange'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'labelControl', title: 'ラベル', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, ...EN, ...SHOWLABEL, ...TIPS], children: [], idRequired: true, isControl: true }),
  e({ tag: 'box', title: 'ボックス', attrs: [...ID, ...INSERT, ...VIS, 'boxStyle'], children: BOX_CONTROLS, isControl: true }),
  e({ tag: 'buttonGroup', title: 'ボタングループ', attrs: [...ID, ...INSERT, ...VIS], children: ['button', 'toggleButton', 'splitButton', 'menu', 'dynamicMenu', 'gallery', 'control'], isControl: true }),
  e({ tag: 'separator', title: '区切り線', attrs: [...ID, ...INSERT, ...VIS], children: [], isControl: true }),
  e({ tag: 'menuSeparator', title: 'メニューの区切り線', attrs: ['id', 'idQ', 'tag', ...INSERT, 'title', 'getTitle'], children: [], isControl: true }),
  e({ tag: 'control', title: '組み込みコントロール', attrs: [...BUTTONLIKE], children: [], idRequired: true, isControl: true }),
  e({ tag: 'dialogBoxLauncher', title: 'ダイアログ起動ツール', attrs: [], children: ['button'], isControl: true }),
  e({ tag: 'item', title: '項目', attrs: ['id', 'label', 'image', 'imageMso', 'screentip', 'supertip'], children: [], idRequired: true }),
  e({ tag: 'backstage', title: 'Backstage', attrs: ['onShow', 'onHide'], children: [], opaque: true, since2010: true }),
  e({ tag: 'contextMenus', title: 'コンテキストメニューの一覧', attrs: [], children: ['contextMenu'], since2010: true }),
  e({ tag: 'contextMenu', title: 'コンテキストメニュー', attrs: ['idMso'], children: MENU_CONTROLS, idRequired: true, since2010: true }),
];

export const elements: ReadonlyMap<string, ElementDef> = new Map(elementList.map((d) => [d.tag, d]));

export function attrsOf(tag: string): AttrDef[] {
  return (elements.get(tag)?.attrs ?? []).map((n) => attributes.get(n)).filter((d): d is AttrDef => d !== undefined);
}

export function canContain(parentTag: string, childTag: string): boolean {
  return elements.get(parentTag)?.children.includes(childTag) ?? false;
}

// ---- コールバックのシグネチャ（仕様書 §8.1） ----

const RC = 'control As IRibbonControl';

/** コールバック属性と要素の組から、VBA の引数リストを返す。 */
export function callbackSignature(attr: string, tag: string): string {
  switch (attr) {
    case 'onLoad':
      return 'ribbon As IRibbonUI';
    case 'loadImage':
      return 'imageId As String, ByRef image';
    case 'onAction':
      if (tag === 'toggleButton' || tag === 'checkBox') return `${RC}, pressed As Boolean`;
      if (tag === 'dropDown' || tag === 'gallery') return `${RC}, id As String, index As Integer`;
      if (tag === 'command') return `${RC}, ByRef cancelDefault`;
      return RC;
    case 'onChange':
      return `${RC}, text As String`;
    case 'getItemCount':
      return `${RC}, ByRef count`;
    case 'getItemLabel':
    case 'getItemID':
    case 'getItemImage':
    case 'getItemScreentip':
    case 'getItemSupertip':
      return `${RC}, index As Integer, ByRef returnedVal`;
    case 'getContent':
      return `${RC}, ByRef content`;
    default:
      return `${RC}, ByRef returnedVal`;
  }
}

/** 名前の規則（XML の NCName に相当する、ASCII に限った簡易版）。 */
export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** id の接頭辞（種類＋連番で id を提案する）。 */
export const ID_PREFIX: Readonly<Record<string, string>> = {
  tab: 'tab', group: 'grp', button: 'btn', toggleButton: 'tgl', checkBox: 'chk', splitButton: 'spl',
  menu: 'mnu', dynamicMenu: 'dmn', gallery: 'gal', dropDown: 'ddn', comboBox: 'cbo', editBox: 'edt',
  labelControl: 'lbl', box: 'box', buttonGroup: 'bgp', separator: 'sep', menuSeparator: 'msp', item: 'itm',
  control: 'ctl',
};
