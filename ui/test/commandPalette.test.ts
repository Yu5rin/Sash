import { describe, expect, it } from 'vitest';
import { rankCommands, type Command } from '../src/dialogs/commandPalette';

const cmd = (id: string, title: string, group = 'ファイル', keywords?: string): Command => ({ id, title, group, keywords, run: () => undefined });

describe('rankCommands', () => {
  const commands = [cmd('save', '保存'), cmd('open', '開く'), cmd('btn', 'ボタンを追加', '追加', 'button'), cmd('theme', 'テーマを切り替える', '表示', 'dark light')];

  it('検索語がなければ最近使った順', () => {
    expect(rankCommands(commands, '', ['theme', 'open']).map((c) => c.id).slice(0, 2)).toEqual(['theme', 'open']);
  });

  it('タイトルと別名で絞り込む', () => {
    expect(rankCommands(commands, 'button').map((c) => c.id)).toEqual(['btn']);
    expect(rankCommands(commands, 'dark').map((c) => c.id)).toEqual(['theme']);
    expect(rankCommands(commands, '保存')[0]!.id).toBe('save');
  });
});
