// ほかで書き換えられたファイルの検知（仕様書 §23.4。§22.11 で見送っていた W-6）。
// 開いた・保存した時点のリボンの内容の照合値を控えておき、保存・反映の前と、窓に戻ったときに、ファイルの今の照合値と比べる。
// 照合値はホストが XML を正規化し、画像は中身で求める。バイト列は比べない（Excel が保存し直しただけで変わって誤って知らせるため）。

import { app, type Session } from './app';
import { invoke, type Fingerprint } from './bridge';
import { isSampleSession } from './sample';

/** 2 つの照合値が同じか（パーツの種類も、その値も同じ）。どちらかがなければ比べられないので false。 */
export function sameFingerprint(a: Fingerprint | null | undefined, b: Fingerprint | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

export type ExternalState =
  /** 基準と同じ（変わっていない）。 */
  | 'same'
  /** 開いた・保存したあとに、ファイルのリボンの内容が変わっている。 */
  | 'changed'
  /** 調べられない（基準がない・ファイルが読めない・検知を切っている・サンプル）。何も知らせない。 */
  | 'unknown';

/** 検知の対象にしてよいセッションか（設定が入で、ファイルがあり、サンプルでなく、基準がある）。 */
export function isWatchable(s: Session | null): s is Session {
  return !!s && !!s.path && s.fingerprint !== null && app.settings.detectExternalChanges && !isSampleSession();
}

/** ファイルの今の照合値を読んで、基準と比べる。読めない・失敗は unknown（検知をあきらめるだけで、保存や反映は止めない）。 */
export async function checkExternalChange(s: Session): Promise<{ state: ExternalState; current: Fingerprint | null }> {
  if (!isWatchable(s)) return { state: 'unknown', current: null };
  try {
    const { fingerprint } = await invoke('file.fingerprint', { path: s.path });
    if (!fingerprint) return { state: 'unknown', current: null };
    return { state: sameFingerprint(s.fingerprint, fingerprint) ? 'same' : 'changed', current: fingerprint };
  } catch {
    return { state: 'unknown', current: null };
  }
}

/** 基準を、いまのファイルの内容に置き換える（保存・反映が終わったあと。自分が書いた内容を「ほかの変更」と取り違えないため）。 */
export async function refreshBaseline(s: Session): Promise<void> {
  if (!s.path || isSampleSession()) return;
  try {
    const { fingerprint } = await invoke('file.fingerprint', { path: s.path });
    // 読んでいる間に別のファイルへ替わっていたら、触らない
    if (app.session === s) s.fingerprint = fingerprint;
  } catch {
    if (app.session === s) s.fingerprint = null;
  }
}
