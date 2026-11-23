// シェル（メニュー・通知・ホーム）で使う追加の SVG アイコン。src/icons.ts と同じ描き方（16px、currentColor）。
// icons.ts は他の担当と共有しているため、シェルだけで使うものはここに置く。

const wrap = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const shellIcons = {
  check: wrap('<path d="M3.5 8.5l3 3 6-7"/>'),
  success: wrap('<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8.2l1.8 1.8 3.2-3.6"/>'),
  submenu: wrap('<path d="M6 4l4 4-4 4"/>'),
  folder: wrap('<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>'),
  file: wrap('<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>'),
  excel: wrap('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>'),
  refresh: wrap('<path d="M13 8a5 5 0 11-1.5-3.6"/><path d="M13 3v2.5h-2.5"/>'),
  restore: wrap('<path d="M3 8a5 5 0 105-5H6"/><path d="M7.5 1.5L6 3l1.5 1.5"/><path d="M8 5.5V8l2 1.5"/>'),
  keyboard: wrap('<rect x="1.5" y="4" width="13" height="8" rx="1.2"/><path d="M4 6.5h1M7 6.5h1M10 6.5h1M4 9.5h8"/>'),
  help: wrap('<circle cx="8" cy="8" r="5.5"/><path d="M6.5 6.5a1.6 1.6 0 113 .8c-.6.4-1.5.8-1.5 1.7M8 11.2v.2"/>'),
  search: wrap('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>'),
  plus: wrap('<path d="M8 3v10M3 8h10"/>'),
  chevronDown: wrap('<path d="M4 6l4 4 4-4"/>'),
  panelBottom: wrap('<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 10h12"/>'),
};
