// Sash のオリジナルのアイコン（作品としてこのリポジトリに入れる）。どのアイコン集にもなかった、業務の場面に合うものを描いた。
//
// 作り：Tabler と同じ 24×24、線幅 2、丸い端・丸い角の線。外側に 2px 程度の余白を残す（線の太さ分が枠からはみ出さないように）。
// 16px で表示しても読み取れるよう、細かい部分は省き、線どうしの間は 2px 以上あける。
// ライセンス：このリポジトリ（Sash）と同じ。出どころは「Sash（自作）」と明記する（LICENSE-sash-icons.txt）。
//
// 形：名前 → [カテゴリ, タグ（空白区切りの英語）, パス（空白で区切った複数の部分パスを、配列で渡してもよい）]
// build-sash-icons.mjs が src/fluent/sashIcons.json にする。パスの d は、Tabler と同じく M で始める。

export const SASH_ICONS = {
  // ---- エレベーター・昇降（Tabler の elevator は箱に上下の矢印。ここは実物の部分を描き分ける）----
  'elevator-car': ['Industry', 'elevator lift car cabin door doors floor building', ['M5 21v-15a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v15', 'M3 21h18', 'M9 21v-10', 'M15 21v-10', 'M9 8h6']],
  'elevator-shaft': ['Industry', 'elevator lift shaft hoistway rope cable car rails', ['M5 3v18', 'M19 3v18', 'M12 3v6', 'M8 9h8v9h-8z']],
  'elevator-call': ['Industry', 'elevator lift call button panel hall up down', ['M7 5a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2z', 'M10 9l2 -2l2 2', 'M10 15l2 2l2 -2']],
  'freight-lift': ['Industry', 'lift freight dumbwaiter hoist platform load goods', ['M12 3v5', 'M9.5 5.5l2.5 -2.5l2.5 2.5', 'M8 12h8v5h-8z', 'M4 20h16', 'M6 17v3', 'M18 17v3']],

  // ---- 工作機械・加工 ----
  'lathe': ['Industry', 'lathe turning machine tool chuck workpiece cutting', ['M3 20h18', 'M3 20v-13h6v13', 'M9 10h8v4h-8z', 'M15 3h4v4l-2 3l-2 -3z']],
  'machining-center': ['Industry', 'machining center cnc milling machine spindle table cutting tool nc', ['M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z', 'M12 4v4', 'M10 8h4v3l-2 3l-2 -3z', 'M7 18h10']],
  'press-machine': ['Industry', 'press machine stamping forming die ram punching', ['M6 3h12v4h-12z', 'M8 7v14', 'M16 7v14', 'M11 7v3', 'M10 10h4v3h-4z', 'M5 21h14']],
  'mold-die': ['Industry', 'mold die tooling injection casting core cavity', ['M4 3h16v5h-5v3h-6v-3h-5z', 'M4 21v-7h5v3h6v-3h5v7z']],
  'welding-torch': ['Industry', 'welding torch weld spark arc solder', ['M4 20l7 -7', 'M10 9l5 5l-2 2l-5 -5z', 'M17 11l1.5 -1.5', 'M18 14h3', 'M14 6v-3', 'M18 6l1.5 -1.5']],
  'conveyor-belt': ['Industry', 'conveyor belt line production box transport assembly', ['M9 4h6v5h-6z', 'M6 12h12a3 3 0 0 1 0 6h-12a3 3 0 0 1 0 -6z', 'M7 18v3', 'M17 18v3']],
  'caliper': ['Industry', 'caliper vernier measure gauge dimension inspection', ['M3 4h18v4h-18z', 'M6 8v12', 'M12 8h6v4h-6z', 'M12 12v8']],
  'motor': ['Industry', 'motor electric drive shaft actuator servo', ['M3 7h12v10h-12z', 'M15 12h6', 'M7 10v4', 'M11 10v4', 'M5 17v3', 'M13 17v3']],

  // ---- 部品 ----
  'hex-bolt': ['Industry', 'bolt screw fastener hex thread part', ['M7 3h10v4h-10z', 'M10 7v14h4v-14', 'M10 11l4 2', 'M10 16l4 2']],
  'bearing': ['Industry', 'bearing ball race rotation part', ['M21 12a9 9 0 1 0 -18 0a9 9 0 1 0 18 0z', 'M15 12a3 3 0 1 0 -6 0a3 3 0 1 0 6 0z', 'M12 7.5h.01', 'M12 16.5h.01', 'M7.5 12h.01', 'M16.5 12h.01']],
  'spring': ['Industry', 'spring coil part suspension elastic', ['M12 2v3l6 2.5l-12 3l12 3l-12 3l6 2.5v3']],
  'valve': ['Industry', 'valve pipe piping flow control plumbing', ['M2 17h4', 'M18 17h4', 'M6 13l6 4l-6 4z', 'M18 13l-6 4l6 4z', 'M12 17v-8', 'M8 8h8']],
  'parts-tree': ['Industry', 'parts list bom bill of materials structure tree assembly', ['M8 3h8v5h-8z', 'M12 8v4', 'M5.5 16v-4h13v4', 'M2 16h7v5h-7z', 'M15 16h7v5h-7z']],
  'prototype-cube': ['Industry', 'prototype trial model cube wireframe sample development', ['M12 3l4 2.25', 'M20 7.5v3', 'M20 13.5v3l-4 2.25', 'M12 21l-4 -2.25', 'M4 16.5v-3', 'M4 10.5v-3l4 -2.25', 'M12 12l8 -4.5', 'M12 12v9', 'M12 12l-8 -4.5']],
  'drawing-sheet': ['Industry', 'drawing blueprint sheet cad design plan title block', ['M5.5 3h13a1.5 1.5 0 0 1 1.5 1.5v15a1.5 1.5 0 0 1 -1.5 1.5h-13a1.5 1.5 0 0 1 -1.5 -1.5v-15a1.5 1.5 0 0 1 1.5 -1.5z', 'M12.5 9.5a3 3 0 1 0 -6 0a3 3 0 1 0 6 0z', 'M12 17h8', 'M12 17v4']],

  // ---- 物流・在庫 ----
  'pallet': ['E-commerce', 'pallet skid wooden logistics warehouse shipping', ['M3 7h18v4h-18z', 'M5 11v4', 'M12 11v4', 'M19 11v4', 'M3 15h18v3h-18z']],
  'pallet-stack': ['E-commerce', 'pallet stack boxes load cargo', ['M4 3h7v7h-7z', 'M13 3h7v7h-7z', 'M3 14h18', 'M5 14v5', 'M12 14v5', 'M19 14v5']],
  'shelf-stock': ['E-commerce', 'shelf rack stock inventory storage warehouse', ['M4 3v18', 'M20 3v18', 'M4 9h16', 'M4 15h16', 'M8 9v-3h3v3', 'M14 15v-3h4v3']],
  'stock-in': ['E-commerce', 'stock in receipt receiving warehouse incoming', ['M11 7h9v11h-9z', 'M2 12h6', 'M5.5 9.5l2.5 2.5l-2.5 2.5']],
  'stock-out': ['E-commerce', 'stock out issue shipping warehouse outgoing', ['M3 7h9v11h-9z', 'M16 12h6', 'M19.5 9.5l2.5 2.5l-2.5 2.5']],
  'packing-box': ['E-commerce', 'packing carton box this side up fragile shipping', ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z', 'M3 8h18', 'M12 17.5v-6.5', 'M9 14.5l3 -3.5l3 3.5']],

  // ---- 営業・事務の書類 ----
  'estimate-sheet': ['Document', 'estimate quotation quote sheet price yen', ['M6 2h8l6 6v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2z', 'M8.5 10l3.5 5l3.5 -5', 'M12 15v5', 'M9.5 17h5']],
  'purchase-order': ['Document', 'purchase order placing order outgoing sheet', ['M6 2h8l6 6v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2z', 'M12 19.5v-9', 'M8.5 14l3.5 -3.5l3.5 3.5']],
  'sales-order': ['Document', 'sales order receiving order incoming sheet', ['M6 2h8l6 6v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2z', 'M12 10.5v9', 'M8.5 16l3.5 3.5l3.5 -3.5']],
  'delivery-note': ['Document', 'delivery note slip packing list goods', ['M6 2h8l6 6v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2z', 'M8.5 12h7v7h-7z', 'M8.5 15.5h7']],
  'deadline-calendar': ['Document', 'deadline due date delivery schedule calendar flag', ['M5 6.5a1.5 1.5 0 0 1 1.5 -1.5h11a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1 -1.5 1.5h-11a1.5 1.5 0 0 1 -1.5 -1.5z', 'M9 3v3.5', 'M15 3v3.5', 'M5 10.5h14', 'M12 13.5v2.5', 'M12 18.8v.01']],
  'business-card': ['Communication', 'business card name card contact sales meishi', ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z', 'M7 10h4', 'M7 14h3', 'M14 10h3', 'M14 14h3']],
  'cost-down': ['Charts', 'cost down reduction saving coin decrease price', ['M13 8a5 5 0 1 0 -10 0a5 5 0 1 0 10 0z', 'M3 20h10', 'M18 4v11', 'M14.5 12l3.5 3.5l3.5 -3.5']],
};
