// テスト用に、loadIconSet（fluent.ts）と同じ並びで 4 つのアイコン集を合わせたもの。
import fluentData from '../../src/fluent/fluentIcons.json';
import tablerData from '../../src/fluent/tablerIcons.json';
import lucideData from '../../src/fluent/lucideIcons.json';
import sashData from '../../src/fluent/sashIcons.json';
import { toIcons, toTablerIcons, type FluentData, type FluentIcon, type TablerData } from '../../src/fluent/fluent';

export const fluentIcons = toIcons(fluentData as unknown as FluentData);
export const tablerIcons = toTablerIcons(tablerData as unknown as TablerData);
export const lucideIcons = toTablerIcons(lucideData as unknown as TablerData, 'lucide');
export const sashIcons = toTablerIcons(sashData as unknown as TablerData, 'sash');
export const allIcons: FluentIcon[] = [...fluentIcons, ...tablerIcons, ...lucideIcons, ...sashIcons];
