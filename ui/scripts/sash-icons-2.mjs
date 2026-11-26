// Sash のオリジナルのアイコン（第 3 弾：町工場・ビジネスマン・エレベーター・エスカレーター。0.3.1）。作りは sash-icons.mjs と同じ
// （24×24・線幅 2・丸い端と丸い角・塗りなし。外側に 1px 以上の余白、線どうしは 1〜2px 以上あける）。
// 16px で読み取れるよう、細部は省く。法規の標識（JIS・ISO の図記号）や特定の会社の形は写さず、物の一般的な形で描く。
// 形：名前 → [カテゴリ, 英語のタグ, 部分パスの配列]（sash-icons.mjs と同じ）。

/** 角丸の長方形。 */
const rr = (x, y, w, h, r = 2) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;
/** 円。 */
const ci = (cx, cy, r) => `M${cx + r} ${cy}a${r} ${r} 0 1 0 ${-2 * r} 0a${r} ${r} 0 1 0 ${2 * r} 0z`;
/** 点（丸い端の長さ 0 の線）。 */
const dot = (x, y) => `M${x} ${y}h.01`;
/** 線。 */
const ln = (x1, y1, x2, y2) => `M${x1} ${y1}L${x2} ${y2}`;
/** 上向き・右向きなどの矢じり（先端 (x,y)、向き a は 'u' 'd' 'l' 'r'）。 */
const head = (x, y, a, s = 2.5) => {
  const v = { u: [-s, s, s, s], d: [-s, -s, s, -s], l: [s, -s, s, s], r: [-s, -s, -s, s] }[a];
  return `M${x + v[0]} ${y + v[1]}L${x} ${y}L${x + v[2]} ${y + v[3]}`;
};

/** 点列を指定の中心まわりに deg 度回して、閉じた多角形のパスにする（斜めに置く物の形を、まっすぐ描いてから回すため）。 */
const rotPoly = (pts, cx, cy, deg, close = true) => {
  const t = (deg * Math.PI) / 180;
  const f = (n) => Math.round(n * 100) / 100;
  const q = pts.map(([x, y]) => [f(cx + (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t)), f(cy + (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t))]);
  return `M${q[0][0]} ${q[0][1]}` + q.slice(1).map(([x, y]) => `L${x} ${y}`).join('') + (close ? 'z' : '');
};
/** 楕円。 */
const el = (cx, cy, rx, ry) => `M${cx + rx} ${cy}a${rx} ${ry} 0 1 0 ${-2 * rx} 0a${rx} ${ry} 0 1 0 ${2 * rx} 0z`;

export const SASH_ICONS_2 = {
  // ---- 町工場：加工 ----
  'grinding-wheel': ['Industry', 'grinding wheel grinder polishing buff sparks', [ci(9, 12, 5.5), dot(9, 12), ln(16, 7, 19, 4), ln(17, 11, 21, 10), ln(15, 5, 16, 2.5), 'M3 21h12']],
  'sheet-bending': ['Industry', 'sheet metal bending press brake plate', ['M5 4L5 19L20 19L20 16L8 16L8 4z', 'M12 5a6 6 0 0 1 6 6', head(18, 11.5, 'd', 2.2)]],
  'casting-ladle': ['Industry', 'casting ladle molten metal pour foundry', ['M3 5l8 -1.5l1.5 6.5l-7.5 1.5z', 'M12 10q1.5 2 1 4', rr(9, 15, 12, 6, 1), ln(13, 15, 13, 17.5)]],
  'plating-tank': ['Industry', 'plating tank surface treatment dip bath', ['M3 9v12h18v-12', 'M3 13q2.25 -2 4.5 0t4.5 0t4.5 0t4.5 0', ln(6, 4, 18, 4), ln(12, 4, 12, 9), 'M10 9h4v8h-4z']],
  'furnace': ['Industry', 'furnace kiln heat treatment quenching flame chimney', [rr(4, 6, 16, 15, 2), ln(15, 6, 15, 3), 'M8 21v-9h8v9', 'M12 19.5a2.2 2.2 0 0 0 2.2 -2.2c0 -1.5 -1.2 -2.3 -2.2 -4c-1 1.7 -2.2 2.5 -2.2 4a2.2 2.2 0 0 0 2.2 2.2z']],
  'c-clamp': ['Industry', 'c clamp jig fixture holding vise clamping', ['M18 5H7a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h11', 'M12 21V9', 'M9 9h6', 'M9 21h6']],
  'end-mill': ['Industry', 'end mill cutter cutting tool flute bit', [rotPoly([[10.5, 2], [13.5, 2], [13.5, 8], [10.5, 8]], 12, 12, 40), rotPoly([[8.5, 8], [15.5, 8], [15.5, 21], [8.5, 21]], 12, 12, 40), rotPoly([[8.5, 12], [15.5, 15]], 12, 12, 40, false), rotPoly([[8.5, 16.5], [15.5, 19.5]], 12, 12, 40, false)]],
  'rasp-file': ['Industry', 'file rasp deburring finishing hand tool', ['M5.5 15l9 -9l4 4l-9 9z', ln(7.5, 17, 4, 20.5), 'M10 11.5l2.5 2.5', 'M12.5 9l2.5 2.5']],
  'soldering-iron': ['Industry', 'soldering iron solder electronics', [ln(4, 21, 11, 14), 'M11 14l6 -6l3 3l-6 6z', 'M18.5 9.5q2.5 -2 2.5 -5']],

  'control-chart': ['Industry', 'control chart spc variation limit quality', ['M3 6h4 M10 6h4 M17 6h4', 'M3 18h4 M10 18h4 M17 18h4', 'M4 13l4 -3l4 4l4 -3l4 -6', ci(20, 4, 1.2)]],
  'pareto-chart': ['Industry', 'pareto chart abc analysis cumulative bars', ['M5 21v-15', 'M9 21v-10', 'M13 21v-6', 'M17 21v-3', 'M5 6l4 -1.5l4 -1l6 -.5']],
  'changeover': ['Industry', 'changeover setup tooling swap exchange', ['M3 13h7v7h-7z', ci(17, 7, 3.5), 'M5 10a8 8 0 0 1 7 -6.5', head(12, 3.5, 'r', 2.2), 'M19 14a8 7 0 0 1 -6 6', head(13, 20, 'l', 2.2)]],
  'outsource': ['Industry', 'outsource subcontract external factory out', ['M3 21v-9l4 3v-3l4 3v6z', 'M3 21h8', ln(12, 10, 20, 3), 'M14.5 3h5.5v5.5']],
  'in-house': ['Industry', 'in-house inhouse own production internal factory in', ['M21 21v-9l-4 3v-3l-4 3v6z', 'M21 21h-8', ln(3, 3, 10, 10), 'M10 4.5v5.5h-5.5']],
  'bar-stock': ['Industry', 'bar stock round bar material raw steel rod cylinder', ['M18 4h-12a1.5 3 0 0 0 0 6h12', el(18, 7, 1.5, 3), 'M18 13h-12a1.5 3 0 0 0 0 6h12', el(18, 16, 1.5, 3)]],
  'h-beam': ['Industry', 'h beam steel girder section structural', ['M5 4h14v3.5h-14z', 'M5 16.5h14v3.5h-14z', 'M12 7.5v9']],
  'metal-chips': ['Industry', 'metal chips swarf scrap cuttings curl', ['M3 21h18', 'M4 17l5 -3v3z', 'M9 14c0 -5 4 -8 8 -6s1 6 -2 5s-2 -3 0 -3', 'M14 20c0 -2 2.5 -3 4.5 -2s.5 3 -1.5 2.5']],
  'oil-can': ['Industry', 'oil can lubrication grease coolant oiler', ['M4 12h10l2 9h-13z', 'M9 12l-.5 -3', 'M8.5 9l11.5 -5', dot(20, 8), 'M4 14.5h-1a2 2 0 0 0 0 4h1']],
  'hydraulic-cylinder': ['Industry', 'hydraulic cylinder piston rod actuator', ['M3 8h12v8h-12z', ln(11, 8, 11, 16), ln(15, 12, 21, 12), ln(21, 10, 21, 14), ln(5, 8, 5, 6), ln(13, 8, 13, 6)]],
  'belt-pulley': ['Industry', 'belt pulley drive transmission chain', [ci(7, 15, 4), ci(18, 7, 2.5), 'M9.7 18L19.7 8.9', 'M5 11.5L16.8 4.8']],
  'control-panel': ['Industry', 'control panel switchboard plc lamp switch', [rr(5, 3, 14, 18, 2), dot(8.5, 7), dot(12, 7), dot(15.5, 7), 'M8 11.5h8v3h-8z', ln(16, 17, 16, 19)]],
  'emergency-stop': ['Industry', 'emergency stop button e-stop push mushroom head', ['M3 12a9 5.5 0 0 1 18 0z', 'M10 12v5h4v-5', 'M5 17h14v4h-14z']],
  'signal-tower': ['Industry', 'signal tower andon lamp status light', ['M9 3h6v12h-6z', 'M9 7h6', 'M9 11h6', ln(12, 15, 12, 19), ln(8, 21, 16, 21), ln(6, 4, 4, 3), ln(18, 4, 20, 3)]],
  'work-order': ['Industry', 'work order instruction sheet clipboard job', [rr(5, 4, 14, 17, 2), 'M9.5 4V2.5h5V4', ln(8, 9.5, 16, 9.5), ln(8, 12.5, 13, 12.5), ci(14.5, 17, 2.2)]],
  'load-capacity': ['Industry', 'load capacity workload scheduling limit bars', ['M5 21v-10', 'M10 21v-16', 'M15 21v-9', 'M20 21v-14', 'M3 9h3 M9.5 9h3 M16 9h3']],
  'lead-time': ['Industry', 'lead time duration delivery period clock', [ci(12, 8, 4.5), 'M12 8v-2.2', 'M12 8h2', 'M3 18h18', ln(3, 15, 3, 21), ln(21, 15, 21, 21), 'M6 15.5L3 18l3 2.5', 'M18 15.5l3 2.5l-3 2.5']],
  'stagnant-stock': ['Industry', 'stagnant stock dead stock excess inventory old hourglass', ['M3 10h11v11h-11z', ln(3, 13, 14, 13), ln(15, 3, 21, 3), ln(15, 13, 21, 13), 'M15 3l6 10', 'M21 3l-6 10']],
  'reorder-point': ['Industry', 'reorder point safety stock replenish level threshold', ['M12 3v6', 'M8.5 6l3.5 3l3.5 -3', 'M3 13h3 M9 13h3 M15 13h3 M21 13h.01', 'M9 16h6v5h-6z']],
  'item-tag': ['Industry', 'item tag part tag barcode label slip tracking', [rr(6, 3, 12, 18, 2), dot(12, 6), ln(9, 10, 15, 10), ln(9, 13, 15, 13), 'M9 16v3 M12 16v3 M15 16v3']],
  'poka-yoke': ['Industry', 'poka yoke mistake proofing fit guide check', ['M3 9h5l3 3l-3 3h-5z', 'M21 9h-7l3 3l-3 3h7z', 'M16 4.5l1.5 1.5l3 -3']],
  'agv': ['Industry', 'agv automated guided vehicle transport robot cart', [rr(3, 12, 18, 4, 1), ci(7, 19, 1.5), ci(17, 19, 1.5), 'M8 5h8v7', 'M3 22.5h3 M9 22.5h3 M15 22.5h3']],
  'five-s': ['Industry', 'five s 5s sort tidy shine seiri seiton clean', ['M3 20h18', 'M4.5 14h3v6h-3z', 'M10.5 14h3v6h-3z', 'M16.5 14h3v6h-3z', 'M8 4.5v5 M5.5 7h5', 'M17 4v4 M15 6h4']],
  'near-miss': ['Industry', 'near miss hiyari hatto incident report hazard caution', [rr(5, 4, 14, 17, 2), 'M9.5 4V2.5h5V4', 'M12 8.5l5.5 10h-11z', 'M12 12.5v2.5', dot(12, 16.5)]],
  'safety-goggles': ['Industry', 'safety goggles glasses eye protection', [rr(3, 9, 8, 7, 3), rr(13, 9, 8, 7, 3), ln(11, 12.5, 13, 12.5), 'M3 6h18']],
  'work-glove': ['Industry', 'work glove gloves hand protection', ['M7 18v-5l-3.5 -3.5a1.4 1.4 0 0 1 2 -2l1.5 1.5v-6a1.5 1.5 0 0 1 3 0v5v-5a1.5 1.5 0 0 1 3 0v5.5v-4a1.5 1.5 0 0 1 3 0v10l-1 3', 'M7 18h9.5v3h-9.5z']],
  'shutter': ['Industry', 'shutter roll up door loading dock warehouse door raised', ['M3 3h18v3h-18z', ln(3, 6, 3, 21), ln(21, 6, 21, 21), 'M3 21h18', 'M5 9.5h14', 'M5 12.5h14', 'M11 15.5h2']],
  'time-card': ['Industry', 'time card attendance clock punch timecard', [rr(3, 3, 10, 18, 2), ln(6, 7, 10, 7), ln(6, 10, 10, 10), ci(18, 15, 3.5), 'M18 13.3v1.7h1.5']],
  'pallet-jack': ['Industry', 'pallet jack hand lift hand pallet truck', ['M3 3h4', 'M5 3l2 12', 'M7 15v2h14', dot(8, 20.5), dot(19, 20.5)]],
  'chain-hoist': ['Industry', 'chain hoist hook slinging crane lift', [ln(3, 3, 21, 3), rr(8, 5, 8, 5, 1), 'M12 10v1.5 M12 13v1.5', 'M12 14.5v4a3 3 0 0 1 -6 0v-1']],
  'first-article': ['Industry', 'first article first off sample inspection first piece', ['M3 11h11v10h-11z', ln(3, 14, 14, 14), ci(18, 6.5, 4), 'M16.8 5.5l1.7 -1.2v4.5']],
  'pinch-hazard': ['Industry', 'pinch point entanglement roller nip hazard caught', [ci(7.5, 15, 4), ci(16.5, 15, 4), ln(12, 3, 12, 9), head(12, 9, 'd', 2.2)]],

  // ---- ビジネスマン・オフィス ----
  'businessperson': ['Communication', 'businessperson businessman salaryman suit tie office worker', [ci(12, 6, 3), 'M4 21v-1a6 6 0 0 1 6 -6h4a6 6 0 0 1 6 6v1', 'M9.5 14l2.5 3l2.5 -3', 'M12 17l1.5 2l-1.5 2l-1.5 -2z']],
  'circulation': ['Document', 'circulation routing circular memo pass around', [rr(8, 7, 8, 10, 1.5), ln(10.5, 11, 13.5, 11), ln(10.5, 14, 13.5, 14), 'M20 12a8 8 0 1 1 -2.3 -5.7', 'M18 3v3.5h-3.5']],
  'promissory-note': ['Document', 'promissory note bill check cheque draft payment', [rr(2, 6, 20, 12, 2.5), ln(5, 10, 13, 10), ln(5, 14, 11, 14), ci(17, 12, 3)]],
  'binder': ['Document', 'binder file filing ring binder folder', [rr(5, 3, 14, 18, 2), 'M10.5 3v18', dot(7.5, 8), dot(7.5, 16), 'M13 7h3.5v4h-3.5z']],
  'meeting-room': ['Communication', 'meeting room conference table chairs oval', [el(12, 12, 7, 3.5), dot(8, 5.5), dot(12, 4.5), dot(16, 5.5), dot(8, 18.5), dot(12, 19.5), dot(16, 18.5)]],
  'stapler': ['Document', 'stapler stationery office staple', ['M3 18h18v3h-18z', 'M3 14l16 -2l2 2', ln(3, 14, 3, 18)]],

  // ---- エレベーター ----
  'floor-indicator': ['Industry', 'floor indicator elevator display number position', [rr(3, 7, 18, 10, 2), 'M5.5 13l2 -3l2 3', 'M13 10h4v4h-4', 'M14.5 12h2.5']],
  'door-open-button': ['Industry', 'door open button elevator open doors', [ln(12, 6, 12, 18), 'M8.5 8v8l-5.5 -4z', 'M15.5 8v8l5.5 -4z']],
  'door-close-button': ['Industry', 'door close button elevator close doors', [ln(12, 6, 12, 18), 'M3.5 8v8l6 -4z', 'M20.5 8v8l-6 -4z']],
  'emergency-call': ['Industry', 'emergency call intercom alarm bell help elevator', [rr(3, 3, 18, 18, 3), 'M7 15h10', 'M8.5 15v-5a3.5 3.5 0 0 1 7 0v5', 'M11 17.5h2']],
  'elevator-trapped': ['Industry', 'elevator trapped stuck rescue person inside alert', ['M3 3h14v18h-14z', ci(10, 9, 2), 'M6 18a4 4 0 0 1 8 0', ln(20.5, 4, 20.5, 9), dot(20.5, 12.5)]],
  'capacity-plate': ['Industry', 'capacity plate passengers load limit sign persons', ['M5 6h14l3 3v6l-3 3h-14l-3 -3v-6z', ci(8, 10.5, 1.5), 'M6 15l2 -2.5l2 2.5', ln(13, 10, 18, 10), ln(13, 14, 17, 14)]],
  'elevator-inspection': ['Industry', 'elevator inspection periodic check certified car door', ['M3 4h8v16h-8z', ln(7, 4, 7, 20), ci(17.5, 16, 4), 'M15.5 16l1.5 1.5l2.5 -3']],
  'counterweight': ['Industry', 'counterweight pulley rope balance elevator', [ci(12, 4, 2), 'M10 4v7', 'M4 11h7.5v9.5h-7.5z', 'M14 4v5', 'M13 9h5v10h-5z', 'M13 12.5h5 M13 15.5h5']],
  'car-panel': ['Industry', 'car operating panel floor buttons elevator buttons', [rr(6, 2, 12, 20, 2.5), dot(10, 7), dot(14, 7), dot(10, 12), dot(14, 12), dot(10, 17), dot(14, 17)]],
  'earthquake': ['Industry', 'earthquake seismic shaking building control quake', ['M8 4h8v13h-8z', ln(11, 8, 13, 8), ln(11, 12, 13, 12), 'M5.5 8l-1 3l1 3', 'M3 7l-1 4l1 4', 'M18.5 8l1 3l-1 3', 'M21 7l1 4l-1 4', 'M3 21.5l4 -2l4 2l4 -2l4 2']],
  'building-floors': ['Industry', 'building floors storeys skyscraper levels tower', ['M5 21h14', 'M8 21V3.5h8V21', dot(10.5, 7.5), dot(13.5, 7.5), dot(10.5, 11.5), dot(13.5, 11.5), dot(10.5, 15.5), dot(13.5, 15.5)]],

  // ---- エスカレーター・動く歩道 ----
  'moving-walkway': ['Industry', 'moving walkway travelator moving sidewalk conveyor passenger', ['M4 17h16a2 2 0 0 1 0 4h-16a2 2 0 0 1 0 -4z', ci(9, 5, 1.8), 'M9 7v5', 'M9 12l-2 4 M9 12l2 4', ln(14, 10, 20, 10), head(20.5, 10, 'r', 2.5)]],
  'handrail': ['Industry', 'handrail escalator rail balustrade moving handrail', ['M3 15L16 4', 'M6 19L19 8', 'M10 16v5 M16 11v10', 'M3 21h18']],
  'stand-still': ['Industry', 'stand still do not walk escalator etiquette two people stairs', ['M3 21h4v-4h4v-4h4v-4h6', ci(9, 9.5, 1.3), 'M9 12v5', ci(17.5, 3.5, 1.3), 'M17.5 6v3']],
  'ramp': ['Industry', 'ramp slope incline barrier free access', ['M3 20h18v-12z', 'M8 18l7 -4.7', 'M11.5 12.8l3.5 .5l-.8 3.3']],
  'step-caution': ['Industry', 'step caution watch your step level difference trip hazard', ['M3 21h8v-6h10', 'M15.5 3l5.5 10h-11z', 'M15.5 7v3', dot(15.5, 11.5)]],
};
