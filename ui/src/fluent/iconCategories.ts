// アイコン集のカテゴリ（ピッカーの絞り込みチップ）と、アイコンへの割り当て。純粋な処理にして、テストできるようにする。
//
// 割り当ての考え方：
// - Tabler は元データにカテゴリ（Animals・Vehicles など 40 種）があるので、まず自分のカテゴリに読み替える。
// - Fluent にはカテゴリがないので、名前の最初の単語（arrow_・document_・vehicle_ …）で振り分ける。
// - どちらも、名前の単語による追加の割り当てをする。1 つのアイコンが複数のカテゴリに入ってよい
//   （トラックは「乗り物」であり、物流として「ビジネス」でもある）。ビジネス・動物・食べ物のように、
//   元のカテゴリが細かく分かれていなかったり、取りこぼしやすいものを補うため。
// - カテゴリは 32 個以内に収め、アイコンごとにビットで持つ（絞り込みを速くするため）。

import type { FluentIcon } from './fluent';

export interface IconCategory {
  id: string;
  /** チップに出す名前（t() のキーでもある）。 */
  ja: string;
  /** 検索で「このカテゴリに入っている」ことを当てるための英語の言葉。 */
  words: readonly string[];
}

export const CATEGORIES: readonly IconCategory[] = [
  { id: 'business', ja: 'ビジネス', words: ['business', 'office', 'work'] },
  { id: 'document', ja: '文書・ファイル', words: ['document', 'file', 'folder'] },
  { id: 'arrow', ja: '矢印', words: ['arrow', 'arrows'] },
  { id: 'shape', ja: '図形', words: ['shape', 'shapes'] },
  { id: 'animal', ja: '動物', words: ['animal', 'animals', 'pet'] },
  { id: 'vehicle', ja: '乗り物', words: ['vehicle', 'vehicles', 'transport'] },
  { id: 'food', ja: '食べ物', words: ['food', 'drink', 'meal'] },
  { id: 'nature', ja: '天気・自然', words: ['weather', 'nature', 'plant'] },
  { id: 'people', ja: '人・コミュニケーション', words: ['people', 'person', 'communication'] },
  { id: 'device', ja: '機器', words: ['device', 'devices', 'electronics'] },
  { id: 'text', ja: '文字・数字', words: ['letter', 'letters', 'alphabet', 'number', 'numbers', 'text'] },
  { id: 'symbol', ja: '記号', words: ['symbol', 'symbols', 'sign'] },
  { id: 'place', ja: '建物・場所', words: ['building', 'buildings', 'place', 'map'] },
  { id: 'health', ja: '医療・健康', words: ['health', 'medical'] },
  { id: 'leisure', ja: 'スポーツ・ゲーム', words: ['sport', 'sports', 'game', 'games'] },
  { id: 'ui', ja: '操作・画面', words: ['interface', 'ui', 'system'] },
  { id: 'other', ja: 'その他', words: [] },
];

/** カテゴリの id → ビット。 */
const BIT = new Map(CATEGORIES.map((c, i) => [c.id, 1 << i]));

export function categoryBit(id: string): number {
  return BIT.get(id) ?? 0;
}

/** マスクに入っているカテゴリの id。 */
export function categoryIds(mask: number): string[] {
  return CATEGORIES.filter((c) => (mask & (BIT.get(c.id) ?? 0)) !== 0).map((c) => c.id);
}

/** Tabler のカテゴリ → 自分のカテゴリ。 */
const TABLER_CATEGORY: Readonly<Record<string, string>> = {
  'System': 'ui', 'Devices': 'device', 'Design': 'ui', 'Arrows': 'arrow', 'Map': 'place', 'Document': 'document',
  'E-commerce': 'business', 'Letters': 'text', 'Text': 'text', 'Numbers': 'text', 'Shapes': 'shape', 'Media': 'ui',
  'Communication': 'people', 'Buildings': 'place', 'Food': 'food', 'Vehicles': 'vehicle', 'Math': 'symbol', 'Health': 'health',
  'Sport': 'leisure', 'Currencies': 'business', 'Development': 'ui', 'Database': 'device', 'Weather': 'nature',
  'Photography': 'device', 'Mood': 'people', 'Nature': 'nature', 'Games': 'leisure', 'Computers': 'device', 'Laundry': 'other',
  'Charts': 'business', 'Symbols': 'symbol', 'Badges': 'symbol', 'Version control': 'ui', 'Animals': 'animal',
  'Electrical': 'device', 'Gender': 'symbol', 'Gestures': 'people', 'Extensions': 'ui', 'Zodiac': 'symbol', 'Logic': 'symbol',
};

/** Fluent の名前の最初の単語 → カテゴリ。ここにないものは「操作・画面」（Fluent は画面部品が多い）。 */
const FLUENT_FIRST_WORD: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {};
  const add = (id: string, words: string) => words.split(' ').forEach((w) => (m[w] = id));
  add('arrow', 'arrow chevron caret');
  add('document', 'document folder clipboard book notebook notepad archive note news');
  add('text', 'text number font');
  add('business', 'calendar data table briefcase receipt money cart shopping tag target gift card wallet bank board task form');
  add('people', 'person people chat comment mail emoji contact call channel presence voicemail hand send share thumb');
  add('vehicle', 'vehicle airplane');
  add('food', 'food drink');
  add('animal', 'animal');
  add('nature', 'weather leaf tree plant earth sun moon cloud');
  add('device', 'phone desktop laptop keyboard battery camera speaker mic cellular bluetooth wifi plug device tablet headset print usb video');
  add('place', 'building home location globe map door');
  add('shape', 'circle square triangle rectangle shape star heart diamond hexagon pentagon octagon');
  add('health', 'heart_pulse stethoscope pill syringe');
  add('leisure', 'sport game games trophy');
  add('symbol', 'checkmark dismiss add subtract warning info question prohibited');
  return m;
})();

/** 名前の単語による追加の割り当て（Tabler・Fluent 共通）。単語は名前を - と _ で分けたものと比べる。 */
const WORD_RULES: readonly { id: string; words: ReadonlySet<string> }[] = [
  {
    id: 'business',
    words: new Set(('chart charts report briefcase money cash coin coins currency invoice receipt calendar presentation contract factory warehouse store shop shopping cart basket package packages box ' +
      'inventory bank wallet calculator analytics graph stats statistics percentage certificate trophy award handshake target presentation podium truck forklift crane delivery shipping ' +
      'building-factory building-warehouse building-store building-bank brand-excel pie timeline kanban abacus report-money report-analytics coins moneybag bill pig-money ' +
      'credit-card cash-banknote tax discount ticket label tag barcode qrcode clipboard-list clipboard-check file-invoice file-dollar user-dollar scale ' +
      'schedule meeting agenda goal flag-3 stamp signature id-badge businessplan speakerphone').split(' ')),
  },
  {
    id: 'document',
    words: new Set('file files document folder folders notes note notebook article clipboard paper book books archive report newspaper news script sticker-2 template contract'.split(' ')),
  },
  {
    id: 'animal',
    words: new Set(('cat dog fish bird horse pig deer dragon bat snail spider paw butterfly bug rabbit turtle bear mouse cow elephant monkey duck chicken frog shark whale owl penguin sheep ' +
      'bee ant ladybug snake crab octopus lion tiger panda squirrel fox wolf dinosaur shell bone feather egg worm').split(' ')),
  },
  {
    id: 'vehicle',
    words: new Set(('car truck bus train plane airplane ship ferry bike bicycle motorcycle motorbike scooter helicopter rocket forklift crane tractor subway taxi cab boat sailboat vehicle ' +
      'trailer ambulance firetruck tir trolley moped drone submarine speedboat jetski camper caravan tank backhoe bulldozer rv parachute zeppelin sleigh skateboard segway').split(' ')),
  },
  {
    id: 'food',
    words: new Set(('coffee tea beer wine pizza burger bread cake apple food drink cup mug bowl egg salad soup ice-cream cookie candy chocolate cheese meat sausage carrot banana lemon grape ' +
      'melon mushroom pepper salt milk bottle glass cocktail champagne whisk chef kitchen cooker bake dumpling noodles rice sushi toast croissant baguette avocado cherry nut pretzel popcorn ' +
      'lollipop donut cupcake teapot bubble microwave grill fork spoon chopsticks wheat').split(' ')),
  },
  {
    id: 'people',
    words: new Set('user users person people team contact mood emoji message messages chat mail comment comments phone call hand-click friends social share thumb-up thumb-down'.split(' ')),
  },
  {
    id: 'text',
    words: new Set('letter alphabet number numbers abc font typography numeric digit'.split(' ')),
  },
  {
    id: 'health',
    words: new Set('medical pill pills stethoscope syringe first-aid heartbeat heart-rate hospital vaccine bandage microscope virus thermometer ambulance'.split(' ')),
  },
  {
    id: 'place',
    words: new Set('building buildings home house factory warehouse store shop hospital school bank hotel map location pin city office tower castle'.split(' ')),
  },
  {
    id: 'nature',
    words: new Set('sun moon cloud rain snow wind flower leaf plant tree mountain wave water drop flame fire seedling cactus star-moon storm thunder lightning umbrella rainbow'.split(' ')),
  },
  {
    id: 'leisure',
    words: new Set('ball basketball football soccer baseball golf tennis ski swim run trophy medal dice chess cards puzzle gamepad joystick'.split(' ')),
  },
];

/** 名前（- と _ で単語に分けたもの）を、規則の単語と比べる。「ice-cream」のようなハイフンつきの規則は、つないだ形で名前に含まれるかを見る。 */
function matchesRule(words: readonly string[], joined: string, rule: ReadonlySet<string>): boolean {
  for (const w of words) if (rule.has(w)) return true;
  for (const r of rule) if (r.includes('-') && joined.includes(`-${r}-`)) return true;
  return false;
}

/** アイコンのカテゴリをビットのマスクにする。 */
export function categorize(icon: Pick<FluentIcon, 'name' | 'words' | 'set' | 'tablerCategory'>): number {
  let mask = 0;
  const first = icon.words[0] ?? '';
  const joined = `-${icon.words.join('-')}-`;
  if (icon.set === 'tabler') {
    mask |= categoryBit(TABLER_CATEGORY[icon.tablerCategory ?? ''] ?? 'other');
  } else {
    mask |= categoryBit(FLUENT_FIRST_WORD[icon.words.slice(0, 2).join('_')] ?? FLUENT_FIRST_WORD[first] ?? 'ui');
  }
  for (const rule of WORD_RULES) {
    // 「ui」「other」のように元の割り当てだけで十分なものは規則にない。規則に当たったら足す
    if (matchesRule(icon.words, joined, rule.words)) mask |= categoryBit(rule.id);
  }
  // 矢印・図形のアイコンは、他の言葉（arrow-left-right など）で別のカテゴリに入れない（ノイズになるため）
  if ((mask & categoryBit('arrow')) !== 0 && icon.set !== 'tabler') mask = categoryBit('arrow');
  return mask === 0 ? categoryBit('other') : mask;
}
