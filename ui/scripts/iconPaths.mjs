// アイコン集のビルドで共有する、パスの扱い（Lucide の図形要素をパスに直す・空白を詰める・つなぐ）。
// build-lucide-icons.mjs と build-sash-icons.mjs が使う。保存の形は build-tabler-icons.mjs と同じ。

/** 数字を短い文字にする（小数 4 桁まで、末尾の 0 は落とす）。 */
export function num(v) {
  const n = Math.round(Number(v) * 10000) / 10000;
  if (!Number.isFinite(n)) throw new Error(`数字ではありません: ${v}`);
  return String(n);
}

/** 空白を詰める。コマンド文字の前後と負号の前だけを詰める（数字どうしの区切りは、読み違えるので残す）。 */
export function minify(d) {
  return d
    .replace(/\s*([A-Za-z])\s*/g, '$1')
    .replace(/\s+-/g, '-')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 数字の並び（コマンド文字を含む）。詰める前後で同じでなければ、詰め方が壊している。 */
export function tokens(d) {
  return d.replace(/,/g, ' ').match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
}

const PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;

/** 1 本のパスを詰める。詰める前後で数字の並びが同じことを確かめる。 */
export function tidy(d, where) {
  if (!PATH_OK.test(d)) throw new Error(`想定外の文字があります: ${where}`);
  const small = minify(d);
  if (tokens(small).join(' ') !== tokens(d).join(' ')) throw new Error(`詰めたら数字が変わりました: ${where}`);
  return small;
}

/**
 * パスの先頭を絶対指定の M にそろえる（つないだときに、前のパスの終点からの相対にならないように）。
 * 先頭が小文字の m のときは、最初の 1 組だけが絶対位置なので、そこだけを M にして残りは相対のまま（l）にする。
 */
export function absoluteStart(d, where) {
  if (d.startsWith('M')) return d;
  const m = /^m(-?(?:\d+\.?\d*|\.\d+))[ ,]?(-?(?:\d+\.?\d*|\.\d+))(.*)$/s.exec(d);
  if (!m) throw new Error(`M か m で始まりません: ${where}`);
  const rest = m[3];
  // 残りが（空白をはさんで）数字で始まるなら、暗黙の相対 lineto なので l を足す。正規表現が x と y のあいだの区切りで空白を食べるため、先頭の空白を許す
  const sep = /^\s*[\d.-]/.test(rest) ? 'l' : '';
  return `M${m[1]} ${m[2]}${sep}${rest.trimStart()}`;
}

/** 図形要素（SVG の circle・rect など）を、パスの d に直す。 */
export function elementToPath(tag, a, where) {
  const f = (k, def) => (a[k] === undefined ? def : Number(a[k]));
  switch (tag) {
    case 'path':
      return a.d;
    case 'circle': {
      const cx = f('cx', 0), cy = f('cy', 0), r = f('r', 0);
      return `M${num(cx - r)} ${num(cy)}a${num(r)} ${num(r)} 0 1 0 ${num(2 * r)} 0a${num(r)} ${num(r)} 0 1 0 ${num(-2 * r)} 0z`;
    }
    case 'ellipse': {
      const cx = f('cx', 0), cy = f('cy', 0), rx = f('rx', 0), ry = f('ry', 0);
      return `M${num(cx - rx)} ${num(cy)}a${num(rx)} ${num(ry)} 0 1 0 ${num(2 * rx)} 0a${num(rx)} ${num(ry)} 0 1 0 ${num(-2 * rx)} 0z`;
    }
    case 'rect': {
      const x = f('x', 0), y = f('y', 0), w = f('width', 0), h = f('height', 0);
      let rx = a.rx === undefined ? (a.ry === undefined ? 0 : f('ry', 0)) : f('rx', 0);
      let ry = a.ry === undefined ? rx : f('ry', 0);
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx === 0 || ry === 0) return `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}z`;
      const arc = (dx, dy) => `a${num(rx)} ${num(ry)} 0 0 1 ${num(dx)} ${num(dy)}`;
      return `M${num(x + rx)} ${num(y)}h${num(w - 2 * rx)}${arc(rx, ry)}v${num(h - 2 * ry)}${arc(-rx, ry)}h${num(-(w - 2 * rx))}${arc(-rx, -ry)}v${num(-(h - 2 * ry))}${arc(rx, -ry)}z`;
    }
    case 'line':
      return `M${num(f('x1', 0))} ${num(f('y1', 0))}L${num(f('x2', 0))} ${num(f('y2', 0))}`;
    case 'polyline':
    case 'polygon': {
      const pts = String(a.points).trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4 || pts.length % 2 !== 0 || pts.some((n) => !Number.isFinite(n))) throw new Error(`points が読めません: ${where}`);
      let d = `M${num(pts[0])} ${num(pts[1])}`;
      for (let i = 2; i < pts.length; i += 2) d += `L${num(pts[i])} ${num(pts[i + 1])}`;
      return tag === 'polygon' ? `${d}z` : d;
    }
    default:
      throw new Error(`想定外の要素です: ${tag} (${where})`);
  }
}

/** パスの一覧を 1 本の文字列につなぐ（どれも M で始まるので、つないでも前のパスの終点からの相対にならない。線だけなので見た目も変わらない）。 */
export function packPaths(list) {
  return list.join('');
}
