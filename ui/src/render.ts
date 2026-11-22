import { tabsOf, type UINode } from './model';

const paletteItems = ['button', 'toggleButton', 'checkBox', 'menu', 'splitButton', 'dropDown', 'comboBox', 'editBox', 'gallery', 'separator'];

export function renderPalette(list: HTMLElement): void {
  list.replaceChildren(
    ...paletteItems.map((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      li.draggable = true;
      return li;
    }),
  );
}

export function renderTree(list: HTMLElement, root: UINode): void {
  list.replaceChildren(...root.children.map((c) => treeItem(c)));
}

function treeItem(node: UINode): HTMLLIElement {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'tree-row';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = node.tag;
  const name = document.createElement('span');
  name.textContent = node.label ?? node.id ?? '';
  row.append(kind, name);
  li.append(row);
  if (node.children.length > 0) {
    const ul = document.createElement('ul');
    ul.append(...node.children.map(treeItem));
    li.append(ul);
  }
  return li;
}

/** リボンのプレビュー。現段階ではタブとグループ、コントロールのラベルを並べるだけの仮表示。 */
export function renderCanvas(host: HTMLElement, root: UINode): void {
  const tabs = tabsOf(root);
  const tabBar = document.createElement('div');
  tabBar.className = 'ribbon-tabs';
  for (const name of ['ファイル', 'ホーム', '挿入']) tabBar.append(tabLabel(name, true));
  tabs.forEach((t, i) => tabBar.append(tabLabel(t.label ?? t.id ?? 'tab', false, i === 0)));

  const body = document.createElement('div');
  body.className = 'ribbon-body';
  for (const group of tabs[0]?.children.filter((c) => c.tag === 'group') ?? []) {
    const g = document.createElement('div');
    g.className = 'ribbon-group';
    const controls = document.createElement('div');
    controls.className = 'ribbon-controls';
    for (const c of group.children) {
      const el = document.createElement('div');
      el.className = c.attrs['size'] === 'large' ? 'ctl large' : 'ctl';
      el.textContent = c.label ?? c.id ?? c.tag;
      controls.append(el);
    }
    const label = document.createElement('div');
    label.className = 'ribbon-group-label';
    label.textContent = group.label ?? group.id ?? '';
    g.append(controls, label);
    body.append(g);
  }
  host.replaceChildren(tabBar, body);
}

function tabLabel(text: string, builtIn: boolean, active = false): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = ['ribbon-tab', builtIn ? 'builtin' : '', active ? 'active' : ''].join(' ').trim();
  span.textContent = text;
  return span;
}
