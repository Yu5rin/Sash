// 英語の辞書（0.4.0：アイコンエディタに足した［新しく描く］［描いて編集…］の文言。SPEC §25）。キーは日本語の文言そのもの。

export const en: Readonly<Record<string, string>> = {
  'もっと新しい版の Sash で描いた絵です。見た目はそのまま使えますが、描き直しはできません': 'This picture was drawn in a newer version of Sash. It looks the same, but it cannot be redrawn.',
  '今の加工の結果を下絵にします。余白や色の設定は初期化されます（描いたあとに、もう一度かけられます）': 'The current result becomes the underlay. Padding and color settings are reset (you can apply them again after drawing).',
  '今の見た目を下絵にして、鉛筆や塗りつぶしで直します': 'Use the current look as an underlay and touch it up with the pencil and fill tools',
  '描いた絵（{canvas} × {canvas}）': 'Drawn picture ({canvas} × {canvas})',
  '描いて編集…': 'Draw & edit…',
  '描く絵の大きさを選んでください。16 × 16 はドット絵向きで、出力の大きさに合わせて拡大されます。': 'Choose the size of the picture. 16 × 16 suits pixel art and is enlarged to the output size.',
  '新しく描く': 'Draw new',
  '空の絵を、鉛筆や塗りつぶしで一から描きます（16 × 16 のドット絵も描けます）': 'Draw from a blank picture with the pencil and fill tools (16 × 16 pixel art is also possible)',
  '描いた絵を捨てますか？': 'Discard the picture you drew?',
  '描いた絵は、［設定する］を押さないと、ブックに入りません。': 'The picture is not added to the workbook unless you press [Apply].',
  '戻る': 'Go back',
};
