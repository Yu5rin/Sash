// customUI（2007 / 2010以降）の要素と属性の定義。
// インスペクタの入力欄、Lint の構造チェック、XML エディタの補完の三つが、この定義を共有する。
// 対象はリボン、QAT、commands、コンテキストメニュー、Backstage。

import { t } from './i18n';

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
  /** 2007形式（customUI）でだけ使える（officeMenu など、2010以降の形式から外されたもの）。 */
  only2007?: boolean;
  /**
   * 子要素の並び順（XSD の sequence）。前の枠の要素は、後ろの枠の要素より前に置く。
   * 枠ごとに個数の上限・下限を持つ。どの枠にもない子要素は、並び順と個数を問わない。
   */
  childOrder?: readonly ChildSlot[];
}

/** 子要素の並びの「枠」。tags のどれかを、min 個以上 max 個以下置ける。 */
export interface ChildSlot {
  tags: readonly string[];
  /** 省略すると上限なし。 */
  max?: number;
  /** 省略すると 0。 */
  min?: number;
}

/** 形式ごとの customUI の名前空間。 */
export const NAMESPACES = {
  office2007: 'http://schemas.microsoft.com/office/2006/01/customui',
  office2010: 'http://schemas.microsoft.com/office/2009/07/customui',
} as const;

// ---- 属性 ----

const a = (def: AttrDef): AttrDef => def;

const pair = (name: string, dyn: string, kind: AttrKind, category: Category, desc: string, extra: Partial<AttrDef> = {}): AttrDef[] => [
  a({ name, kind, category, desc, dynamic: dyn, ...extra }),
  a({ name: dyn, kind: 'callback', category: '動作', desc: `${desc}（VBA で動的に返す）`, staticOf: name }),
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
  a({ name: 'getImage', kind: 'callback', category: '動作', desc: 'アイコンを VBA で動的に返す', staticOf: 'image' }),
  a({ name: 'onAction', kind: 'callback', category: '動作', desc: 'クリックされたときに呼ばれる VBA の Sub' }),
  a({ name: 'getPressed', kind: 'callback', category: '動作', desc: '押された状態（True / False）を VBA で返す' }),
  a({ name: 'onChange', kind: 'callback', category: '動作', desc: '文字が入力されたときに呼ばれる VBA の Sub' }),
  a({ name: 'getText', kind: 'callback', category: '動作', desc: '入力欄に表示する文字列を VBA で返す' }),
  a({ name: 'getContent', kind: 'callback', category: '動作', desc: 'メニューの中身（XML 文字列）を VBA で返す' }),
  a({ name: 'getItemCount', kind: 'callback', category: '動作', desc: '項目の数を VBA で返す' }),
  a({ name: 'getItemLabel', kind: 'callback', category: '動作', desc: '各項目のラベルを VBA で返す' }),
  a({ name: 'getItemImage', kind: 'callback', category: '動作', desc: '各項目のアイコンを VBA で返す' }),
  a({ name: 'getItemID', kind: 'callback', category: '動作', desc: '各項目のidを VBA で返す' }),
  a({ name: 'getItemScreentip', kind: 'callback', category: '動作', desc: '各項目のヒントの見出しを VBA で返す' }),
  a({ name: 'getItemSupertip', kind: 'callback', category: '動作', desc: '各項目のヒントの本文を VBA で返す' }),
  a({ name: 'getSelectedItemID', kind: 'callback', category: '動作', desc: '選択中の項目のidを VBA で返す' }),
  a({ name: 'getSelectedItemIndex', kind: 'callback', category: '動作', desc: '選択中の項目の番号を VBA で返す' }),
  a({ name: 'getItemWidth', kind: 'callback', category: '動作', desc: '項目の幅を VBA で返す' }),
  a({ name: 'getItemHeight', kind: 'callback', category: '動作', desc: '項目の高さを VBA で返す' }),
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
  // invalidateContentOnDrop は customUI14（2009/07）で加わった属性（2006/01 の XSD にはない）
  a({ name: 'invalidateContentOnDrop', kind: 'bool', category: '詳細', desc: '開くたびに中身を作り直す', since2010: true }),
  // ギャラリーをリボン上に直接並べるか。customUI14 で加わった属性（実機の Excel では未確認）
  a({ name: 'showInRibbon', kind: 'bool', category: '表示', desc: 'ギャラリーの項目をリボン上に直接並べる', since2010: true }),
  a({ name: 'alignLabel', kind: 'enum', category: '表示', desc: 'ラベルの位置', values: ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'], since2010: true }),
  a({ name: 'noWrap', kind: 'bool', category: '表示', desc: '折り返さない', since2010: true }),
  // ---- Backstage（2010以降） ----
  a({ name: 'onShow', kind: 'callback', category: '動作', desc: 'Backstage を開いたときに呼ばれる VBA の Sub', since2010: true }),
  a({ name: 'onHide', kind: 'callback', category: '動作', desc: 'Backstage を閉じたときに呼ばれる VBA の Sub', since2010: true }),
  a({ name: 'isDefinitive', kind: 'bool', category: '動作', desc: 'クリックしたら Backstage を閉じてブックに戻る', since2010: true }),
  a({ name: 'columnWidthPercent', kind: 'int', category: '表示', desc: '1列目の幅（全体に対する %）', since2010: true }),
  a({ name: 'firstColumnMinWidth', kind: 'int', category: '詳細', desc: '1列目の最小幅（px）', since2010: true }),
  a({ name: 'firstColumnMaxWidth', kind: 'int', category: '詳細', desc: '1列目の最大幅（px）', since2010: true }),
  a({ name: 'secondColumnMinWidth', kind: 'int', category: '詳細', desc: '2列目の最小幅（px）', since2010: true }),
  a({ name: 'secondColumnMaxWidth', kind: 'int', category: '詳細', desc: '2列目の最大幅（px）', since2010: true }),
  ...pair('helperText', 'getHelperText', 'string', '表示', 'グループの見出しの下に出る説明文', { since2010: true }),
  ...pair('style', 'getStyle', 'string', '表示', '見た目の種類。グループは normal / warning / error、ボタンは normal / borderless / large', { since2010: true, example: 'warning' }),
  ...pair('target', 'getTarget', 'string', '基本', 'リンク先のURL', { since2010: true, example: 'https://example.com/' }),
  ...pair('altText', 'getAltText', 'string', '表示', '画像の代替テキスト', { since2010: true }),
  a({ name: 'allowedTaskSizes', kind: 'enum', category: '表示', desc: 'タスクの表示サイズ', values: ['large', 'medium', 'small'], since2010: true }),
  a({ name: 'layoutChildren', kind: 'enum', category: '基本', desc: '中身を並べる向き', values: ['horizontal', 'vertical'], since2010: true }),
  a({ name: 'align', kind: 'enum', category: '表示', desc: '配置', values: ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'], since2010: true }),
  a({ name: 'expand', kind: 'enum', category: '表示', desc: '広げる方向', values: ['horizontal', 'vertical', 'both', 'neither'], since2010: true }),
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
// QAT（sharedControls / documentControls）に置けるのは control・button・separator だけ（CT_QatItems）
const QAT_CONTROLS = ['control', 'button', 'separator'];
/** id / idQ / tag だけを持つ要素（box・buttonGroup・separator は idMso で組み込みを指せない）。 */
const ID_ONLY = ['id', 'idQ', 'tag'];
const one = (tag: string): ChildSlot => ({ tags: [tag], max: 1 });

const e = (def: Omit<ElementDef, 'idRequired' | 'isControl'> & Partial<ElementDef>): ElementDef => ({
  idRequired: false,
  isControl: false,
  ...def,
});

// gallery / dropDown は item を並べた後ろに button を置く（XSD の sequence。上限は item 1000、button 16）
const ITEMS_THEN_BUTTONS: readonly ChildSlot[] = [{ tags: ['item'], max: 1000 }, { tags: ['button'], max: 16 }];

const elementList: ElementDef[] = [
  e({ tag: 'customUI', title: 'customUI', attrs: ['onLoad', 'loadImage'], children: ['commands', 'ribbon', 'backstage', 'contextMenus'], childOrder: [one('commands'), one('ribbon'), one('backstage'), one('contextMenus')] }),
  // backstage の中身は backstageElements で定義する（ここは customUI 直下に置けることを示すため）
  e({ tag: 'backstage', title: 'Backstage', attrs: ['onShow', 'onHide'], children: ['tab', 'button'], since2010: true }),
  e({ tag: 'commands', title: 'コマンドの上書き', attrs: [], children: ['command'] }),
  e({ tag: 'command', title: 'コマンド', attrs: ['idMso', ...EN, 'onAction'], children: [], idRequired: true }),
  e({ tag: 'ribbon', title: 'リボン', attrs: ['startFromScratch'], children: ['officeMenu', 'qat', 'tabs', 'contextualTabs'], childOrder: [one('officeMenu'), one('qat'), one('tabs'), one('contextualTabs')] }),
  e({ tag: 'officeMenu', title: 'Officeメニュー（2007）', attrs: [], children: MENU_CONTROLS, opaque: true, only2007: true }),
  e({ tag: 'qat', title: 'クイックアクセスツールバー', attrs: [], children: ['sharedControls', 'documentControls'], childOrder: [one('sharedControls'), one('documentControls')] }),
  e({ tag: 'sharedControls', title: '共有コントロール', attrs: [], children: QAT_CONTROLS }),
  e({ tag: 'documentControls', title: 'ブック固有のコントロール', attrs: [], children: QAT_CONTROLS }),
  e({ tag: 'tabs', title: 'タブの一覧', attrs: [], children: ['tab'] }),
  e({ tag: 'contextualTabs', title: 'コンテキストタブ', attrs: [], children: ['tabSet'] }),
  e({ tag: 'tabSet', title: 'タブセット', attrs: ['idMso', ...VIS], children: ['tab'], idRequired: true }),
  e({ tag: 'tab', title: 'タブ', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, ...KEYTIP], children: ['group'], idRequired: true }),
  e({ tag: 'group', title: 'グループ', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...TIPS, ...KEYTIP, 'autoScale', 'centerVertically'], children: GROUP_CONTROLS, idRequired: true,
    // dialogBoxLauncher は1つまでで、ほかのコントロールの後ろ（末尾）に置く（CT_Group の sequence）
    childOrder: [{ tags: GROUP_CONTROLS.filter((x) => x !== 'dialogBoxLauncher') }, one('dialogBoxLauncher')] }),
  e({ tag: 'button', title: 'ボタン', attrs: [...BUTTONLIKE, 'onAction'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'toggleButton', title: 'トグルボタン', attrs: [...BUTTONLIKE, 'getPressed', 'onAction'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'checkBox', title: 'チェックボックス', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, ...EN, ...TIPS, ...KEYTIP, ...DESC, 'getPressed', 'onAction'], children: [], idRequired: true, isControl: true }),
  // 分割ボタン自身は label / screentip / supertip / image / imageMso / getImage / showImage を持てない（XSD の CT_SplitButtonRestricted で
  // prohibited）。これらは中の先頭の button / toggleButton から受け継ぐので、インスペクタなどは中のボタンに書く（iconTarget.ts）
  e({ tag: 'splitButton', title: '分割ボタン', attrs: [...ID, ...INSERT, ...SIZE, ...VIS, ...EN, ...SHOWLABEL, ...KEYTIP], children: ['button', 'toggleButton', 'menu'], idRequired: true, isControl: true,
    // 先頭に button か toggleButton をちょうど1つ、その後ろに menu をちょうど1つ
    childOrder: [{ tags: ['button', 'toggleButton'], min: 1, max: 1 }, { tags: ['menu'], min: 1, max: 1 }] }),
  e({ tag: 'menu', title: 'メニュー', attrs: [...BUTTONLIKE, 'itemSize'], children: MENU_CONTROLS, idRequired: true, isControl: true }),
  e({ tag: 'dynamicMenu', title: '動的メニュー', attrs: [...BUTTONLIKE, 'getContent', 'invalidateContentOnDrop'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'gallery', title: 'ギャラリー', attrs: [...BUTTONLIKE, 'columns', 'rows', 'itemWidth', 'itemHeight', 'getItemWidth', 'getItemHeight', 'showItemLabel', 'showItemImage', 'sizeString', ...ITEMS, 'getSelectedItemID', 'getSelectedItemIndex', 'onAction', 'invalidateContentOnDrop', 'showInRibbon'], children: ['item', 'button'], idRequired: true, isControl: true, childOrder: ITEMS_THEN_BUTTONS }),
  e({ tag: 'dropDown', title: 'ドロップダウン', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...EN, ...SHOWLABEL, ...SHOWIMG, ...TIPS, ...KEYTIP, 'sizeString', 'showItemLabel', 'showItemImage', ...ITEMS, 'getSelectedItemID', 'getSelectedItemIndex', 'onAction'], children: ['item', 'button'], idRequired: true, isControl: true, childOrder: ITEMS_THEN_BUTTONS }),
  e({ tag: 'comboBox', title: 'コンボボックス', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...EN, ...SHOWLABEL, ...SHOWIMG, ...TIPS, ...KEYTIP, 'sizeString', 'maxLength', 'showItemImage', ...ITEMS, 'getText', 'onChange', 'invalidateContentOnDrop'], children: ['item'], idRequired: true, isControl: true }),
  e({ tag: 'editBox', title: 'テキストボックス', attrs: [...ID, ...INSERT, ...LABEL, ...IMG, ...VIS, ...EN, ...SHOWLABEL, ...SHOWIMG, ...TIPS, ...KEYTIP, 'sizeString', 'maxLength', 'getText', 'onChange'], children: [], idRequired: true, isControl: true }),
  e({ tag: 'labelControl', title: 'ラベル', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, ...EN, ...SHOWLABEL, ...TIPS], children: [], idRequired: true, isControl: true }),
  e({ tag: 'box', title: 'ボックス', attrs: [...ID_ONLY, ...INSERT, ...VIS, 'boxStyle'], children: BOX_CONTROLS, isControl: true }),
  e({ tag: 'buttonGroup', title: 'ボタングループ', attrs: [...ID_ONLY, ...INSERT, ...VIS], children: ['button', 'toggleButton', 'splitButton', 'menu', 'dynamicMenu', 'gallery', 'control'], isControl: true }),
  e({ tag: 'separator', title: '区切り線', attrs: [...ID_ONLY, ...INSERT, ...VIS], children: [], isControl: true }),
  e({ tag: 'menuSeparator', title: 'メニューの区切り線', attrs: ['id', 'idQ', 'tag', ...INSERT, 'title', 'getTitle'], children: [], isControl: true }),
  e({ tag: 'control', title: '組み込みコントロール', attrs: [...BUTTONLIKE], children: [], idRequired: true, isControl: true }),
  e({ tag: 'dialogBoxLauncher', title: 'ダイアログ起動ツール', attrs: [], children: ['button'], isControl: true, childOrder: [{ tags: ['button'], min: 1, max: 1 }] }),
  // item の id は XSD では省略できる（項目の識別は getItemID や番号でもできるため）
  e({ tag: 'item', title: '項目', attrs: ['id', 'label', 'image', 'imageMso', 'screentip', 'supertip'], children: [] }),
  e({ tag: 'contextMenus', title: 'コンテキストメニューの一覧', attrs: [], children: ['contextMenu'], since2010: true }),
  e({ tag: 'contextMenu', title: 'コンテキストメニュー', attrs: ['idMso'], children: MENU_CONTROLS, idRequired: true, since2010: true }),
];

export const elements: ReadonlyMap<string, ElementDef> = new Map(elementList.map((d) => [d.tag, d]));

// ---- Backstage（2010以降）。tab や group などはリボンと同じ名前で中身が違うので、別の表で持つ ----

const BS = { since2010: true } as const;
const BS_ITEMS = ['button', 'checkBox', 'editBox', 'dropDown', 'radioGroup', 'comboBox', 'hyperlink', 'labelControl', 'groupBox', 'layoutContainer', 'imageControl'];
const BS_COMMON = [...ID, ...INSERT, ...LABEL, ...VIS, ...EN, ...KEYTIP];

const backstageList: ElementDef[] = [
  e({ tag: 'backstage', title: 'Backstage', attrs: ['onShow', 'onHide'], children: ['tab', 'button'], ...BS }),
  e({ tag: 'tab', title: 'Backstageのタブ', attrs: [...BS_COMMON, 'title', 'getTitle', 'columnWidthPercent', 'firstColumnMinWidth', 'firstColumnMaxWidth', 'secondColumnMinWidth', 'secondColumnMaxWidth'], children: ['firstColumn', 'secondColumn'], idRequired: true, childOrder: [one('firstColumn'), one('secondColumn')], ...BS }),
  e({ tag: 'firstColumn', title: '1列目', attrs: [], children: ['group', 'taskGroup', 'taskFormGroup'], ...BS }),
  e({ tag: 'secondColumn', title: '2列目', attrs: [], children: ['group', 'taskGroup', 'taskFormGroup'], ...BS }),
  e({ tag: 'group', title: 'Backstageのグループ', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, 'helperText', 'getHelperText', 'style', 'getStyle', 'showLabel', 'getShowLabel'], children: ['primaryItem', 'topItems', 'bottomItems'], idRequired: true, childOrder: [one('primaryItem'), one('topItems'), one('bottomItems')], ...BS }),
  // primaryItem には button か menu のどちらか1つだけを置く
  e({ tag: 'primaryItem', title: '主な項目', attrs: [], children: ['button', 'menu'], childOrder: [{ tags: ['button', 'menu'], min: 1, max: 1 }], ...BS }),
  e({ tag: 'topItems', title: '上の項目', attrs: [], children: BS_ITEMS, ...BS }),
  e({ tag: 'bottomItems', title: '下の項目', attrs: [], children: BS_ITEMS, ...BS }),
  e({ tag: 'taskGroup', title: 'タスクグループ', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, 'helperText', 'getHelperText', 'showLabel', 'getShowLabel'], children: ['category'], idRequired: true, ...BS }),
  e({ tag: 'taskFormGroup', title: 'タスクフォームグループ', attrs: [...ID, ...INSERT, ...LABEL, ...VIS, 'helperText', 'getHelperText', 'showLabel', 'getShowLabel', 'allowedTaskSizes'], children: ['category'], idRequired: true, ...BS }),
  e({ tag: 'category', title: 'カテゴリ', attrs: [...ID, ...INSERT, ...LABEL, ...VIS], children: ['task'], idRequired: true, ...BS }),
  e({ tag: 'task', title: 'タスク', attrs: [...BS_COMMON, ...IMG, ...DESC, 'onAction', 'isDefinitive'], children: ['group'], idRequired: true, ...BS }),
  e({ tag: 'button', title: 'Backstageのボタン', attrs: [...BS_COMMON, ...IMG, ...TIPS, ...DESC, 'style', 'getStyle', 'onAction', 'isDefinitive'], children: [], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'checkBox', title: 'チェックボックス', attrs: [...BS_COMMON, ...TIPS, ...DESC, 'getPressed', 'onAction'], children: [], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'editBox', title: 'テキストボックス', attrs: [...BS_COMMON, ...TIPS, 'alignLabel', 'maxLength', 'sizeString', 'getText', 'onChange'], children: [], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'dropDown', title: 'ドロップダウン', attrs: [...BS_COMMON, ...TIPS, 'sizeString', ...ITEMS, 'getSelectedItemIndex', 'onAction'], children: ['item'], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'comboBox', title: 'コンボボックス', attrs: [...BS_COMMON, ...TIPS, 'sizeString', 'maxLength', ...ITEMS, 'getText', 'onChange'], children: ['item'], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'radioGroup', title: 'ラジオボタン', attrs: [...BS_COMMON, ...TIPS, ...ITEMS, 'getSelectedItemIndex', 'onAction'], children: ['radioButton'], idRequired: true, isControl: true, ...BS }),
  // Backstage の radioButton・dropDown / comboBox の item は、どちらも XSD では CT_BackstageItem（id・label・getLabel だけ）。
  // リボンの item（CT_Item）と違い、image / imageMso / screentip / supertip は持てない
  e({ tag: 'radioButton', title: 'ラジオボタンの選択肢', attrs: ['id', 'label', 'getLabel'], children: [], idRequired: true, ...BS }),
  e({ tag: 'item', title: '項目', attrs: ['id', 'label', 'getLabel'], children: [], ...BS }),
  e({ tag: 'hyperlink', title: 'リンク', attrs: [...BS_COMMON, ...IMG, ...TIPS, 'target', 'getTarget', 'onAction'], children: [], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'labelControl', title: 'ラベル', attrs: [...BS_COMMON, 'noWrap'], children: [], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'imageControl', title: '画像', attrs: [...ID, ...INSERT, ...VIS, ...EN, ...IMG, 'altText', 'getAltText'], children: [], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'groupBox', title: '枠', attrs: [...ID, ...INSERT, ...LABEL, 'expand'], children: BS_ITEMS, isControl: true, ...BS }),
  e({ tag: 'layoutContainer', title: 'レイアウト', attrs: [...ID, ...INSERT, 'layoutChildren', 'align', 'expand'], children: BS_ITEMS, isControl: true, ...BS }),
  // Backstage の menu の直下に置けるのは menuGroup だけ。ボタンなどは menuGroup の中に入れる（customUI14.xsd の CT_BackstageMenuBase）
  e({ tag: 'menu', title: 'メニュー', attrs: [...BS_COMMON, ...IMG, ...TIPS, ...DESC], children: ['menuGroup'], idRequired: true, isControl: true, ...BS }),
  e({ tag: 'menuGroup', title: 'メニューのグループ', attrs: [...ID, ...INSERT, ...LABEL, 'itemSize'], children: ['button', 'checkBox', 'menu', 'toggleButton'], ...BS }),
  e({ tag: 'toggleButton', title: 'トグルボタン', attrs: [...BS_COMMON, ...IMG, ...TIPS, ...DESC, 'getPressed', 'onAction'], children: [], idRequired: true, isControl: true, ...BS }),
];

export const backstageElements: ReadonlyMap<string, ElementDef> = new Map(backstageList.map((d) => [d.tag, d]));

/** 要素が Backstage の中にあるか（backstage 要素自身を含む）。 */
export function inBackstage(el: Element | null): boolean {
  for (let cur = el; cur; cur = cur.parentElement) if (cur.localName === 'backstage') return true;
  return false;
}

/**
 * メニューやボタングループなどの中に置くコントロールは、XSD では「Regular」の型になり、size / getSize を持たない。
 * （CT_ButtonRegular など。menu・buttonGroup・splitButton・dialogBoxLauncher・contextMenu・QAT・officeMenu の中）
 */
const REGULAR_PARENTS = new Set(['menu', 'buttonGroup', 'splitButton', 'dialogBoxLauncher', 'contextMenu', 'sharedControls', 'documentControls', 'officeMenu']);
const regularDefs = new Map<string, ElementDef>();

function regularDef(def: ElementDef): ElementDef {
  if (!def.attrs.includes('size')) return def;
  let r = regularDefs.get(def.tag);
  if (!r) {
    r = { ...def, attrs: def.attrs.filter((n) => n !== 'size' && n !== 'getSize') };
    regularDefs.set(def.tag, r);
  }
  return r;
}

function ribbonDefIn(parentTag: string | undefined, tag: string): ElementDef | undefined {
  const def = elements.get(tag);
  return def && parentTag !== undefined && REGULAR_PARENTS.has(parentTag) ? regularDef(def) : def;
}

/** 要素の場所に応じた定義を返す。 */
export function defFor(el: Element): ElementDef | undefined {
  return inBackstage(el) ? backstageElements.get(el.localName) : ribbonDefIn(el.parentElement?.localName, el.localName);
}

/** 親要素の中に置いたときの、子要素の定義。 */
export function defForChild(parent: Element | null, tag: string): ElementDef | undefined {
  return (tag !== 'backstage' && inBackstage(parent)) ? backstageElements.get(tag) : ribbonDefIn(parent?.localName, tag);
}

/** 親要素の中に、その要素を置けるか。 */
export function canContainEl(parent: Element, childTag: string): boolean {
  return defFor(parent)?.children.includes(childTag) ?? false;
}

export function attrsOfEl(el: Element): AttrDef[] {
  return (defFor(el)?.attrs ?? []).map((n) => attributes.get(n)).filter((d): d is AttrDef => d !== undefined);
}

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
    case 'onShow':
    case 'onHide':
      // Backstage の onShow / onHide は IRibbonControl ではなく、表示中の文書などを表す Object を受け取る
      return 'contextObject As Object';
    case 'loadImage':
      return 'imageId As String, ByRef image';
    case 'onAction':
      if (tag === 'toggleButton' || tag === 'checkBox') return `${RC}, pressed As Boolean`;
      // Backstage の radioGroup も、dropDown と同じく選ばれた項目の id と番号を受け取る
      if (tag === 'dropDown' || tag === 'gallery' || tag === 'radioGroup') return `${RC}, id As String, index As Integer`;
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

/**
 * id の規則（XML の NCName に相当する）。日本語などの文字も使える。
 * 先頭は文字か _、2文字目以降は文字・数字・結合文字・_ . - ・（中黒 U+00B7）。
 */
export const ID_PATTERN = /^[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00B7]*$/u;

/** XML の id（NCName）として使えるか。 */
export function isXmlId(s: string): boolean {
  return ID_PATTERN.test(s);
}

/**
 * VBA の識別子（Sub 名・変数名）として使えるか。VBA は日本語などの文字も識別子に使える。
 * 長さの上限は 255 文字。
 */
export function isVbaIdentifier(s: string): boolean {
  return s.length > 0 && s.length <= 255 && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(s);
}

/** 子要素の並びの中で、tag が入る枠の番号（並び順の決まりがなければ -1）。 */
export function slotIndex(def: ElementDef | undefined, tag: string): number {
  return def?.childOrder?.findIndex((s) => s.tags.includes(tag)) ?? -1;
}

/** id の接頭辞（種類＋連番で id を提案する）。 */
export const ID_PREFIX: Readonly<Record<string, string>> = {
  tab: 'tab', group: 'grp', button: 'btn', toggleButton: 'tgl', checkBox: 'chk', splitButton: 'spl',
  menu: 'mnu', dynamicMenu: 'dmn', gallery: 'gal', dropDown: 'ddn', comboBox: 'cbo', editBox: 'edt',
  labelControl: 'lbl', box: 'box', buttonGroup: 'bgp', separator: 'sep', menuSeparator: 'msp', item: 'itm',
  control: 'ctl', taskGroup: 'tgp', taskFormGroup: 'tfg', category: 'cat', task: 'tsk', hyperlink: 'lnk',
  imageControl: 'img', groupBox: 'gbx', layoutContainer: 'lay', radioGroup: 'rdg', radioButton: 'rdb', menuGroup: 'mgp',
};

/** パレットやコマンドに出す、要素の日本語名。 */
export function titleOf(tag: string): string {
  const title = elements.get(tag)?.title ?? backstageElements.get(tag)?.title;
  return title !== undefined ? t(title) : tag;
}
