// 英語の辞書（0.2.0 の総点検の対応）。キーは日本語の文言そのもの。

export const en: Readonly<Record<string, string>> = {
  '予期しないエラーが起きました：{message}': 'An unexpected error occurred: {message}',
  'エラー': 'Errors',
  '警告': 'Warnings',
  'このまま配ると、Excel でリボンが表示されません（エラー {n} 件）': 'If you distribute this as it is, the ribbon will not appear in Excel ({n} errors)',
  'すべて選択': 'Select all',
  'XML を整形': 'Format XML',
  'キャンバスへ戻る': 'Back to the canvas',
  '貼り付けできませんでした。Ctrl+V で貼り付けられます': 'Could not paste. You can paste with Ctrl+V.',
  '構文エラーになる前の内容に戻します。元に戻す（Ctrl+Z）で、いまの内容に戻せます。': 'Restores the content from before the syntax error. Undo (Ctrl+Z) brings back the current content.',
};
