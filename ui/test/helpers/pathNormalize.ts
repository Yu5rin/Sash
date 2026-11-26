// パスの d を、すべて絶対座標の命令の並びに直す（相対指定・暗黙の繰り返し・h/v・円弧のフラグの続け書きを展開する）。
// 座標の比較（元のパスと変わっていないか・ほかの集と同じ図形でないか）に使う。

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** パスを、すべて絶対座標の命令の並び（"M 1 2" のような文字）に直す。暗黙の繰り返し・相対指定・h/v・閉じるを展開する。 */
export function absolute(d: string): string[] {
  const out: string[] = [];
  let pos = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let cmd = '';
  const r = (v: number) => String(Math.round(v * 1e4) / 1e4);
  const skip = () => { while (pos < d.length && /[\s,]/.test(d[pos]!)) pos++; };
  const number = (): number => {
    skip();
    const m = /^-?(?:\d+\.?\d*|\.\d+)/.exec(d.slice(pos));
    if (!m) throw new Error(`数字が読めません: ${d.slice(pos, pos + 10)}`);
    pos += m[0].length;
    return Number(m[0]);
  };
  // 円弧のフラグは 1 文字（0 か 1）。「011.414」のように、あとの数字と続けて書かれることがある
  const flag = (): number => {
    skip();
    const c = d[pos++];
    if (c !== '0' && c !== '1') throw new Error('円弧のフラグが読めません');
    return Number(c);
  };
  for (;;) {
    skip();
    if (pos >= d.length) break;
    if (/[A-Za-z]/.test(d[pos]!)) cmd = d[pos++]!;
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    if (lower === 'z') {
      out.push('Z');
      cx = sx; cy = sy;
      continue;
    }
    const a: number[] = [];
    for (let k = 0; k < ARGS[lower]!; k++) a.push(lower === 'a' && (k === 3 || k === 4) ? flag() : number());
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    let seg: number[];
    if (lower === 'h') { seg = [a[0]! + ox]; cx = seg[0]!; }
    else if (lower === 'v') { seg = [a[0]! + oy]; cy = seg[0]!; }
    else if (lower === 'a') { seg = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]! + ox, a[6]! + oy]; cx = seg[5]!; cy = seg[6]!; }
    else {
      seg = a.map((v, k) => v + (k % 2 === 0 ? ox : oy));
      cx = seg[seg.length - 2]!; cy = seg[seg.length - 1]!;
    }
    if (lower === 'm') { sx = cx; sy = cy; }
    // h・v は L にそろえて比べる（H 10 と L 10 y は同じ線）
    if (lower === 'h') out.push(`L ${r(seg[0]!)} ${r(cy)}`);
    else if (lower === 'v') out.push(`L ${r(cx)} ${r(seg[0]!)}`);
    else out.push(`${lower.toUpperCase()} ${seg.map(r).join(' ')}`);
  }
  return out;
}


/**
 * パスを、部分パス（M ごと）の比べる形の一覧にする。
 * - M を含めて 4 命令以上（M のあとに 3 命令以上）：平行移動と、絶対／相対の書き方の違いに左右されない形
 *   （各命令の座標をいまの点からの差にして、0.5 単位に丸めたもの）。1 単位ずらした写しや、相対座標に書き直した写しも同じ形になる。
 * - M を含めて 3 命令（M のあとに 2 命令。矢じり・山形）：絶対座標のまま完全一致（ありふれた山形が、ずらしただけで誤って一致しないように）。
 * - それより短い単純な線は、どの集にもあるので除く。
 */
export function shapes(d: string): string[] {
  const r = (v: number) => String(Math.round(v * 2) / 2);
  const subs: { abs: string[]; rel: string[] }[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const c of absolute(d)) {
    const [cmd, ...nums] = c.split(' ');
    const a = nums.map(Number);
    if (cmd === 'Z') { subs[subs.length - 1]?.abs.push('Z'); subs[subs.length - 1]?.rel.push('Z'); cx = sx; cy = sy; continue; }
    const n = a.length;
    if (cmd === 'M') { subs.push({ abs: [c], rel: [] }); sx = a[0]!; sy = a[1]!; cx = sx; cy = sy; continue; }
    const rel = a.map((v, k) => (cmd === 'A' ? (k < 5 ? v : k === 5 ? v - cx : v - cy) : v - (k % 2 === 0 ? cx : cy)));
    const cur = (subs[subs.length - 1] ??= { abs: [], rel: [] });
    cur.abs.push(c);
    cur.rel.push(`${cmd} ${rel.map(r).join(' ')}`);
    cx = a[n - 2]!; cy = a[n - 1]!;
  }
  const out: string[] = [];
  for (const s of subs) {
    if (s.rel.length >= 3) out.push(`R:${s.rel.join('|')}`);
    else if (s.rel.length === 2) out.push(`A:${s.abs.join('|')}`);
  }
  return out;
}
