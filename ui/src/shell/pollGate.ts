// 「窓に戻るたびに Excel へ問い合わせる」ような取り直しを、間引いて重ねないための門番（見直し 中4）。
// Excel への問い合わせ（COM）は 1 本の待ち行列で動くので、focus のたびに投げると、F5（反映）がその後ろで待たされる。

export interface PollGateOptions {
  /** 前回の開始から、この時間（ミリ秒）たつまでは、強制でない呼び出しを見送る。 */
  minIntervalMs: number;
  /** true の間は送らない（保存・反映・VBA の読み書き中など）。 */
  busy: () => boolean;
  now?: () => number;
}

/**
 * run を、問い合わせ中は重ねず・間引き・busy 中は送らずに呼ぶ関数を返す。
 * force（ファイルを開いた・反映が終わったなど、状態が変わったことが分かっているとき）は間引きだけ飛ばす。
 * 問い合わせ中に force が来たときは、終わってからもう 1 回だけ取り直す（途中でファイルが替わった場合に古い結果が残らないように）。
 * busy 中は force でも送らない（busy が終われば呼び出し側が force で呼び直す）。
 */
export function createPollGate(run: () => Promise<void>, opts: PollGateOptions): (force?: boolean) => Promise<void> {
  const now = opts.now ?? (() => Date.now());
  let inflight = false;
  let again = false;
  let last = -Infinity;
  const gate = async (force = false): Promise<void> => {
    if (opts.busy()) return;
    if (inflight) {
      if (force) again = true;
      return;
    }
    if (!force && now() - last < opts.minIntervalMs) return;
    inflight = true;
    last = now();
    try {
      await run();
    } finally {
      inflight = false;
    }
    if (again) {
      again = false;
      await gate(true);
    }
  };
  return gate;
}
