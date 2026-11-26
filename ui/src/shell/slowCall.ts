// Excel が応答しないときの待ち（総点検 W-5）。
// UI の invoke には時間切れがない。Excel が固まっている・見えないダイアログ（マクロの MsgBox、保護ビューなど）を出している、
// などで COM の呼び出しが返らないと、「Excel へ反映しています…」が出たまま、保存も開くも「終わるまでお待ちください」で断られ続ける。
// 15 秒を超えたら、理由の心当たりを添えて知らせ、反映では「待つのをやめる」を選べるようにする
// （ホストの処理は続く。結果が後から届いたら、そのときに知らせる）。

import { t } from '../i18n';
import { toast, type ToastHandle } from './toast';

/** この時間（ミリ秒）を超えたら、待っていることを知らせる。 */
export const SLOW_AFTER_MS = 15000;

/** 待つのをやめたことを表す値。 */
export const STOPPED_WAITING = Symbol('stopped-waiting');

export function slowMessage(): string {
  return t('Excel の応答を待っています。Excel 側にメッセージが出ていないか確かめてください');
}

/**
 * 呼び出しが遅いとき（既定 15 秒）だけ通知を出し、終わったら閉じる。待つのをやめる操作は付けない
 * （VBA の読み書きのように、UI の側に待ちの状態を握っていないもの用）。
 */
export function notifyIfSlow<T>(call: Promise<T>, afterMs = SLOW_AFTER_MS): Promise<T> {
  let handle: ToastHandle | null = null;
  const timer = window.setTimeout(() => {
    handle = toast({ kind: 'warning', message: slowMessage(), timeout: 0 });
  }, afterMs);
  const done = () => {
    window.clearTimeout(timer);
    handle?.close();
  };
  call.then(done, done);
  return call;
}

export interface StoppableOptions<T> {
  afterMs?: number;
  /** 遅いと判断したとき。stop を呼ぶと待つのをやめる。 */
  onSlow: (stop: () => void) => void;
  /** 待つのをやめたあとで結果が届いたとき（成功は value、失敗は error）。 */
  onLate: (outcome: { value: T } | { error: unknown }) => void;
}

/**
 * 呼び出しの結果を待つ。遅いときに onSlow へ stop を渡し、stop されたら STOPPED_WAITING で先に戻る。
 * そのあとで届いた結果は onLate に渡す（捨てない）。
 */
export function waitStoppable<T>(call: Promise<T>, opts: StoppableOptions<T>): Promise<T | typeof STOPPED_WAITING> {
  return new Promise((resolve, reject) => {
    let state: 'waiting' | 'stopped' | 'done' = 'waiting';
    const timer = window.setTimeout(() => {
      if (state !== 'waiting') return;
      opts.onSlow(() => {
        if (state !== 'waiting') return;
        state = 'stopped';
        resolve(STOPPED_WAITING);
      });
    }, opts.afterMs ?? SLOW_AFTER_MS);
    call.then(
      (value) => {
        window.clearTimeout(timer);
        if (state === 'stopped') opts.onLate({ value });
        else {
          state = 'done';
          resolve(value);
        }
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        if (state === 'stopped') opts.onLate({ error });
        else {
          state = 'done';
          reject(error);
        }
      },
    );
  });
}
