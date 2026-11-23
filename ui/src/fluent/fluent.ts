// アイコン集（Fluent UI System Icons、MIT License）のデータの扱い。検索と SVG の組み立てだけを持つ純粋な処理にして、テストできるようにする。
// データ（fluentIcons.json）は 2.6MB あるので、最初の画面の読み込みに含めないよう、使うときに動的 import で読む。
// データの作り方は scripts/build-fluent-icons.mjs、ライセンス文は LICENSE-fluentui-system-icons.txt。

export type FluentVariant = 'regular' | 'filled';

/** 1つのアイコンのパス。パスが複数あるときは配列（1本につなぐと重なった部分の塗りが変わりうるため、分けたまま持つ）。0 はその種類がない。 */
export type PathData = string | readonly string[] | 0;

export interface FluentData {
  source: string;
  version: string;
  license: string;
  /** 名前 → [regular, filled] か [regular, filled, 元のサイズ]（24 以外のときだけ）。 */
  icons: Readonly<Record<string, readonly [PathData, PathData] | readonly [PathData, PathData, number]>>;
}

export interface FluentIcon {
  /** パッケージでの名前（例：arrow_clockwise）。 */
  name: string;
  /** 名前を単語に分けたもの（検索用）。 */
  words: readonly string[];
  regular: PathData;
  filled: PathData;
  /** viewBox の大きさ。ほとんどは 24、24 がないものだけ 20。 */
  size: number;
}

/** リボン（Excel の明るいリボン）に置いて見やすい既定の色。画面のテーマの文字色を使うと、暗いテーマで白いアイコンができてしまうため固定にする。 */
export const DEFAULT_COLOR = '#424242';

/** 色の候補。Excel の緑と、注意・強調に使われやすい色。 */
export const COLOR_PRESETS: readonly { color: string; label: string }[] = [
  { color: '#424242', label: 'グレー（標準）' },
  { color: '#217346', label: 'Excel の緑' },
  { color: '#0f6cbd', label: '青' },
  { color: '#c42b1c', label: '赤' },
  { color: '#ca5010', label: 'オレンジ' },
  { color: '#000000', label: '黒' },
];

export function toIcons(data: FluentData): FluentIcon[] {
  return Object.entries(data.icons).map(([name, e]) => ({ name, words: name.split('_'), regular: e[0], filled: e[1], size: e[2] ?? 24 }));
}

/** 表示用の名前（単語をスペースで区切る）。 */
export function displayName(name: string): string {
  return name.replace(/_/g, ' ');
}

export function hasVariant(icon: FluentIcon, variant: FluentVariant): boolean {
  return icon[variant] !== 0;
}

/** #rrggbb だけを通す（SVG の属性に入れるので、それ以外の文字列は既定の色にする）。 */
export function safeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : DEFAULT_COLOR;
}

/**
 * パスのデータから SVG の文字列を組み立てる。px を渡すと width / height を付ける（省略時は元のサイズ）。
 * その種類がないときは null。
 */
export function buildSvg(icon: FluentIcon, variant: FluentVariant, color: string, px?: number): string | null {
  const data = icon[variant];
  if (data === 0) return null;
  const paths = (typeof data === 'string' ? [data] : data).filter((d) => /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/.test(d));
  if (paths.length === 0) return null;
  const s = px ?? icon.size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${icon.size} ${icon.size}" fill="${safeColor(color)}">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

// ---- 検索 ----

/**
 * 日本語の言葉 → アイコン名の英単語。検索欄に日本語を入れたときに使う。
 * 値は名前の単語（例：save）か、単語の並び（例：arrow_sync）。よく使う操作や物を中心に選んだ。
 */
export const JA_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  '保存': ['save'],
  '上書き': ['save'],
  '開く': ['open', 'folder_open'],
  '閉じる': ['dismiss'],
  '削除': ['delete', 'dismiss', 'subtract'],
  'ごみ箱': ['delete', 'bin'],
  '消す': ['delete', 'eraser'],
  '検索': ['search', 'find'],
  '探す': ['search'],
  '置換': ['replace'],
  '設定': ['settings', 'options'],
  'オプション': ['options', 'settings'],
  '印刷': ['print'],
  'プリンター': ['print'],
  'メール': ['mail'],
  '送信': ['send', 'mail_arrow'],
  '受信': ['mail_inbox', 'inbox'],
  '表': ['table'],
  'テーブル': ['table'],
  'セル': ['cell', 'table_cell'],
  '行': ['row', 'table_row'],
  '列': ['column', 'table_column'],
  'シート': ['table', 'document_table'],
  'グラフ': ['chart', 'data'],
  'チャート': ['chart'],
  '棒グラフ': ['data_bar', 'chart'],
  '円グラフ': ['data_pie'],
  '折れ線': ['data_line', 'data_trending'],
  'フィルター': ['filter'],
  '絞り込み': ['filter'],
  '並べ替え': ['sort', 'arrow_sort'],
  'ソート': ['sort'],
  'コピー': ['copy'],
  '貼り付け': ['clipboard_paste'],
  'ペースト': ['clipboard_paste'],
  '切り取り': ['cut'],
  'クリップボード': ['clipboard'],
  '更新': ['arrow_sync', 'arrow_clockwise', 'sync'],
  '再読み込み': ['arrow_clockwise', 'arrow_sync'],
  '同期': ['sync', 'arrow_sync'],
  '追加': ['add'],
  'プラス': ['add'],
  '新規': ['add', 'document_add', 'new'],
  'マイナス': ['subtract'],
  '編集': ['edit', 'pen'],
  'ペン': ['pen', 'edit'],
  '鉛筆': ['edit', 'pen'],
  '実行': ['play'],
  '再生': ['play'],
  '開始': ['play', 'start'],
  '停止': ['stop', 'record_stop'],
  '一時停止': ['pause'],
  '警告': ['warning'],
  '注意': ['warning', 'important'],
  'エラー': ['error_circle', 'error', 'warning'],
  '情報': ['info'],
  'ヘルプ': ['question', 'question_circle', 'help'],
  '質問': ['question'],
  'ユーザー': ['person'],
  '人': ['person', 'people'],
  '人々': ['people'],
  'チーム': ['people_team', 'people'],
  'グループ': ['group', 'people'],
  'フォルダー': ['folder'],
  'ファイル': ['document'],
  '文書': ['document'],
  'ドキュメント': ['document'],
  'ページ': ['document', 'page'],
  'カレンダー': ['calendar'],
  '日付': ['calendar'],
  '予定': ['calendar'],
  '時計': ['clock'],
  '時間': ['clock', 'timer'],
  'タイマー': ['timer'],
  '履歴': ['history'],
  '矢印': ['arrow'],
  '上': ['arrow_up', 'up'],
  '下': ['arrow_down', 'down'],
  '左': ['arrow_left', 'left'],
  '右': ['arrow_right', 'right'],
  '戻る': ['arrow_left', 'arrow_undo', 'back'],
  '進む': ['arrow_right', 'arrow_redo', 'forward'],
  '元に戻す': ['arrow_undo'],
  'やり直し': ['arrow_redo'],
  'ダウンロード': ['arrow_download'],
  'アップロード': ['arrow_upload'],
  '取り込み': ['arrow_import'],
  'インポート': ['arrow_import'],
  'エクスポート': ['arrow_export', 'share'],
  '書き出し': ['arrow_export'],
  '共有': ['share'],
  'リンク': ['link'],
  'ホーム': ['home'],
  '家': ['home'],
  'チェック': ['checkmark'],
  '完了': ['checkmark', 'checkmark_circle'],
  'ok': ['checkmark'],
  'キャンセル': ['dismiss'],
  'バツ': ['dismiss'],
  '星': ['star'],
  'お気に入り': ['star', 'heart'],
  'ハート': ['heart'],
  'ロック': ['lock'],
  '鍵': ['key', 'lock'],
  'キー': ['key'],
  'セキュリティ': ['shield', 'lock'],
  'カメラ': ['camera'],
  '写真': ['image', 'camera'],
  '画像': ['image'],
  '動画': ['video'],
  'ビデオ': ['video'],
  '音楽': ['music'],
  '音量': ['speaker'],
  'スピーカー': ['speaker'],
  'マイク': ['mic'],
  '電話': ['call', 'phone'],
  'スマホ': ['phone'],
  'チャット': ['chat'],
  'コメント': ['comment'],
  'メッセージ': ['chat', 'comment', 'mail'],
  '通知': ['alert'],
  'ベル': ['alert'],
  'お知らせ': ['alert', 'megaphone'],
  '地図': ['map'],
  '場所': ['location'],
  '地球': ['globe'],
  'web': ['globe'],
  'ウェブ': ['globe'],
  'インターネット': ['globe'],
  'クラウド': ['cloud'],
  'データベース': ['database'],
  'サーバー': ['server'],
  'パソコン': ['desktop', 'laptop'],
  'ノート': ['notebook', 'note'],
  'メモ': ['note', 'notepad'],
  '付箋': ['note'],
  'ブック': ['book'],
  '本': ['book'],
  'リスト': ['list', 'text_bullet_list'],
  '一覧': ['list'],
  '箇条書き': ['text_bullet_list'],
  '番号': ['text_number_list', 'number'],
  '数字': ['number'],
  '計算': ['calculator'],
  '電卓': ['calculator'],
  '合計': ['autosum'],
  '数式': ['math_formula'],
  '関数': ['math_formula'],
  'お金': ['money'],
  '通貨': ['money', 'currency'],
  '請求': ['receipt'],
  'レシート': ['receipt'],
  '買い物': ['cart', 'shopping'],
  'カート': ['cart'],
  'タグ': ['tag'],
  'ラベル': ['tag'],
  'しおり': ['bookmark'],
  'ブックマーク': ['bookmark'],
  'ピン': ['pin'],
  '固定': ['pin', 'lock'],
  '旗': ['flag'],
  'フラグ': ['flag'],
  '電球': ['lightbulb'],
  'アイデア': ['lightbulb'],
  'ひらめき': ['lightbulb'],
  '目': ['eye'],
  '表示': ['eye'],
  '非表示': ['eye_off'],
  'プレビュー': ['eye', 'preview'],
  '拡大': ['zoom_in'],
  '縮小': ['zoom_out'],
  'ズーム': ['zoom_in', 'zoom_out'],
  '全画面': ['full_screen', 'maximize'],
  '文字': ['text'],
  'テキスト': ['text'],
  'フォント': ['font', 'text_font'],
  '太字': ['text_bold'],
  '斜体': ['text_italic'],
  '下線': ['text_underline'],
  '色': ['color'],
  '塗りつぶし': ['paint_bucket', 'color_fill'],
  'ブラシ': ['paint_brush', 'brush'],
  '書式': ['paint_brush', 'text_font'],
  '整列': ['align'],
  '中央': ['center', 'align_center'],
  'レイアウト': ['layout'],
  'グリッド': ['grid'],
  'ウィンドウ': ['window'],
  'アプリ': ['apps', 'app'],
  'ツール': ['toolbox', 'wrench'],
  '工具': ['wrench'],
  '道具': ['toolbox'],
  '修理': ['wrench'],
  'コード': ['code'],
  'プログラム': ['code'],
  'マクロ': ['code', 'play'],
  'vba': ['code'],
  'デバッグ': ['bug'],
  '虫': ['bug'],
  'バグ': ['bug'],
  'キーボード': ['keyboard'],
  'マウス': ['cursor'],
  'クリック': ['cursor_click'],
  '電源': ['power'],
  'ログイン': ['person_arrow_left', 'key'],
  'ログアウト': ['sign_out', 'arrow_exit'],
  '終了': ['arrow_exit', 'power'],
  '会社': ['building'],
  '建物': ['building'],
  '店': ['building_shop', 'store'],
  '車': ['vehicle_car'],
  'トラック': ['vehicle_truck'],
  '配送': ['vehicle_truck', 'box'],
  '箱': ['box'],
  '在庫': ['box'],
  '荷物': ['box'],
  'かばん': ['briefcase'],
  '仕事': ['briefcase'],
  'ギフト': ['gift'],
  'プレゼント': ['gift'],
  'スライド': ['slide'],
  '発表': ['presenter', 'slide'],
  'ダッシュボード': ['board', 'grid'],
  'レポート': ['document_data', 'data_bar'],
  '分析': ['data_trending', 'chart'],
  '傾向': ['data_trending'],
  '統計': ['data_bar', 'data_pie'],
  '天気': ['weather'],
  '晴れ': ['weather_sunny'],
  '雨': ['weather_rain'],
  '雪': ['weather_snow'],
  '雷': ['flash', 'lightning'],
  '稲妻': ['flash'],
  '高速': ['flash'],
  'ai': ['sparkle', 'bot'],
  'ロボット': ['bot'],
  'キラキラ': ['sparkle'],
  '魔法': ['sparkle', 'wand'],
  '自動': ['sparkle', 'flash'],
  '承認': ['checkmark', 'thumb_like'],
  'いいね': ['thumb_like'],
  '拒否': ['thumb_dislike', 'prohibited'],
  '禁止': ['prohibited'],
  '無効': ['prohibited'],
  '接続': ['plug_connected', 'link'],
  'プラグ': ['plug'],
  'バッテリー': ['battery'],
  'ネットワーク': ['wifi', 'globe'],
  '無線': ['wifi'],
  '展開': ['chevron_down', 'expand'],
  '折りたたみ': ['chevron_up', 'collapse'],
  'メニュー': ['navigation', 'line_horizontal_3'],
  'もっと': ['more_horizontal'],
  'その他': ['more_horizontal'],
  '目標': ['target'],
  'ターゲット': ['target'],
  '進捗': ['data_bar', 'hourglass'],
  '待機': ['hourglass'],
  '砂時計': ['hourglass'],
  '繰り返し': ['arrow_repeat_all'],
  'ループ': ['arrow_repeat_all'],
  '回転': ['arrow_rotate', 'arrow_clockwise'],
  '移動': ['arrow_move'],
  '入れ替え': ['arrow_swap'],
  '分割': ['split'],
  '結合': ['merge', 'link'],
  'マージ': ['merge'],
  '比較': ['compare'],
  '集計': ['autosum', 'data_bar'],
  '会議': ['people', 'calendar'],
  '学校': ['hat_graduation'],
  '卒業': ['hat_graduation'],
  '健康': ['heart_pulse'],
  '病院': ['building', 'heart_pulse'],
  '食べ物': ['food'],
  '飲み物': ['drink'],
  'コーヒー': ['drink_coffee'],
  'ゲーム': ['games', 'xbox_controller'],
  'パズル': ['puzzle_piece'],
  'スポーツ': ['sport'],
};

/** 比べる前の正規化：全角半角をそろえ、小文字にし、ひらがなをカタカナにする（「ふぉるだー」でもフォルダーに当たるように）。 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .trim();
}

/** 長音の有無の揺れ（フォルダ / フォルダー、ユーザ / ユーザー）を吸収する。 */
function stripLong(text: string): string {
  return text.replace(/ー/g, '');
}

const normalizedJa: readonly { key: string; terms: readonly string[] }[] = Object.entries(JA_KEYWORDS).map(([k, v]) => ({ key: stripLong(normalize(k)), terms: v }));

/** 日本語の語を、アイコン名の英単語（の並び）に置き換える。見つからなければ空。 */
export function jaToEnglish(token: string): string[] {
  const t = stripLong(normalize(token));
  if (!t) return [];
  const out = new Set<string>();
  for (const { key, terms } of normalizedJa) {
    // 入力の途中（「フォル」）と、言い回しの付いたもの（「保存する」）の両方で当たるようにする。
    // 1文字の語（上・下・表など）は、入力と完全に一致したときだけ使う（「上書き」で「上」が当たらないように）
    const hit = key === t || (t.length >= 2 && key.startsWith(t)) || (key.length >= 2 && t.startsWith(key));
    if (hit) for (const term of terms) out.add(term);
  }
  return [...out];
}

/** term（単語か、_ でつないだ単語の並び）がアイコン名にどれだけ合うか。0 は合わない。 */
function termScore(icon: FluentIcon, term: string): number {
  if (term.includes('_')) {
    // 単語の並びは、名前の中に単語の区切りどおりに含まれるときだけ当てる
    if (icon.name === term) return 5;
    if (icon.name.startsWith(`${term}_`)) return 4;
    return `_${icon.name}_`.includes(`_${term}_`) ? 3.5 : 0;
  }
  let best = 0;
  icon.words.forEach((w, i) => {
    let s = 0;
    if (w === term) s = 4;
    else if (w.startsWith(term)) s = 2.5;
    else if (term.length >= 3 && w.includes(term)) s = 1;
    // 先頭の単語が主題なので、そこに当たったものを上に出す（「save」で save_arrow… より save を先に）
    if (s > 0 && i === 0) s += 1;
    if (s > best) best = s;
  });
  return best;
}

/**
 * 検索する。空白で区切った語はすべてに合うもの（AND）だけを残し、合い方の強い順に並べる。
 * 日本語の語は JA_KEYWORDS で英単語に置き換えて探す。英語の語は単語の先頭一致を基本にする。
 */
export function searchIcons(icons: readonly FluentIcon[], query: string, variant?: FluentVariant): FluentIcon[] {
  const pool = variant ? icons.filter((i) => hasVariant(i, variant)) : [...icons];
  const q = normalize(query);
  if (!q) return pool.sort((a, b) => a.name.localeCompare(b.name));
  const tokens = q.split(/[\s　]+/).filter(Boolean);
  const alternatives = tokens.map((tok) => {
    if (/^[a-z0-9_-]+$/.test(tok)) {
      const ascii = tok.replace(/-/g, '_');
      // 英語の語でも、辞書に載っている短い言葉（ai, web, vba など）はその置き換えも使う
      return [ascii, ...(JA_KEYWORDS[ascii] ?? [])];
    }
    return jaToEnglish(tok);
  });
  if (alternatives.some((a) => a.length === 0)) return [];
  const scored: { icon: FluentIcon; score: number }[] = [];
  for (const icon of pool) {
    let total = 0;
    for (const alts of alternatives) {
      let best = 0;
      // 辞書で先に書いた言葉ほど代表的な意味なので、同じ合い方なら少しだけ上にする
      alts.forEach((term, j) => {
        const s = termScore(icon, term);
        if (s > 0) best = Math.max(best, s - j * 0.05);
      });
      if (best === 0) {
        total = 0;
        break;
      }
      total += best;
    }
    if (total > 0) scored.push({ icon, score: total });
  }
  // 同じ点なら、単語の少ない（形の素直な）アイコンを先に出す
  return scored.sort((a, b) => b.score - a.score || a.icon.words.length - b.icon.words.length || a.icon.name.localeCompare(b.icon.name)).map((x) => x.icon);
}

let cache: Promise<{ icons: FluentIcon[]; version: string }> | null = null;

/** データを読み込む（初回だけ。失敗したら次にもう一度読み込めるよう、覚えておかない）。 */
export function loadFluentIcons(): Promise<{ icons: FluentIcon[]; version: string }> {
  cache ??= import('./fluentIcons.json')
    .then((m) => {
      const data = (m as unknown as { default: FluentData }).default;
      return { icons: toIcons(data), version: data.version };
    })
    .catch((e: unknown) => {
      cache = null;
      throw e;
    });
  return cache;
}
