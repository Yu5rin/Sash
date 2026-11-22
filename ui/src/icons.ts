// UI で使う SVG アイコン（絵文字は使わない：仕様書 §9.3）。16px、currentColor で描く。

const wrap = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const uiIcons = {
  open: wrap('<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>'),
  save: wrap('<path d="M3 2.5h8l2 2v9H3z"/><path d="M5.5 2.5v3h5v-3M5 13.5v-4h6v4"/>'),
  apply: wrap('<path d="M5 3l8 5-8 5z"/>'),
  undo: wrap('<path d="M5 6H10a3 3 0 010 6H6"/><path d="M7 3.5L4.5 6 7 8.5"/>'),
  redo: wrap('<path d="M11 6H6a3 3 0 000 6h4"/><path d="M9 3.5L11.5 6 9 8.5"/>'),
  format: wrap('<path d="M3 4h10M5 7h8M5 10h8M3 13h10"/>'),
  catalog: wrap('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>'),
  settings: wrap('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/>'),
  close: wrap('<path d="M4 4l8 8M12 4l-8 8"/>'),
  chevron: wrap('<path d="M6 4l4 4-4 4"/>'),
  error: wrap('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 10.8v.2"/>'),
  warning: wrap('<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.2v.2"/>'),
  info: wrap('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5M8 5.2v.2"/>'),
  image: wrap('<rect x="2.5" y="3" width="11" height="10" rx="1"/><circle cx="6" cy="6.5" r="1.2"/><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 2.5"/>'),
  trash: wrap('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9"/>'),
  star: wrap('<path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8-2.8-2.6 3.8-.5z"/>'),
  swap: wrap('<path d="M4 3v10M2 11l2 2 2-2M12 13V3M10 5l2-2 2 2"/>'),
};

/** 要素の種類ごとのツリー用アイコン。 */
export function kindIcon(tag: string): string {
  switch (tag) {
    case 'tab':
    case 'tabSet':
      return wrap('<path d="M2 13V6h4V4h8v9z"/>');
    case 'group':
      return wrap('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 10.5h12"/>');
    case 'button':
    case 'control':
      return wrap('<rect x="2.5" y="4.5" width="11" height="7" rx="1.5"/>');
    case 'toggleButton':
      return wrap('<rect x="1.5" y="5" width="13" height="6" rx="3"/><circle cx="11.5" cy="8" r="1.8"/>');
    case 'checkBox':
      return wrap('<rect x="3" y="3" width="10" height="10" rx="1"/><path d="M5.5 8l2 2 3-4"/>');
    case 'menu':
    case 'dynamicMenu':
    case 'splitButton':
      return wrap('<path d="M3 4.5h10M3 8h10M3 11.5h6"/>');
    case 'dropDown':
    case 'comboBox':
      return wrap('<rect x="2" y="5" width="12" height="6" rx="1"/><path d="M10 7.3l1.2 1.4 1.2-1.4"/>');
    case 'editBox':
      return wrap('<rect x="2" y="5" width="12" height="6" rx="1"/><path d="M4.5 6.8v2.4"/>');
    case 'gallery':
      return wrap('<rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/>');
    case 'labelControl':
      return wrap('<path d="M4 4h8M8 4v8"/>');
    case 'separator':
    case 'menuSeparator':
      return wrap('<path d="M8 2.5v11"/>');
    case 'box':
    case 'buttonGroup':
      return wrap('<rect x="2" y="4" width="12" height="8" rx="1" stroke-dasharray="2 1.5"/>');
    case 'item':
      return wrap('<circle cx="8" cy="8" r="1.5"/>');
    case 'dialogBoxLauncher':
      return wrap('<path d="M5 11l6-6M7 5h4v4"/>');
    default:
      return wrap('<path d="M4 5l-2.5 3L4 11M12 5l2.5 3L12 11"/>');
  }
}
