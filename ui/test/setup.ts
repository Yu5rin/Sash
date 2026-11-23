import { afterAll, afterEach } from 'vitest';

// app（シングルトン）が予約した検査タイマーが、テストファイルの jsdom 破棄後に発火すると
// 「window is not defined」が未処理エラーになり CI が落ちる。ファイルの終わりで必ず止める。
// app を import すると無関係のテストまで読み込むため、app 側が公開した取っ手を使う。
function cancelAppTimers(): void {
  (globalThis as { __sashCancelTimers?: () => void }).__sashCancelTimers?.();
}

afterEach(cancelAppTimers);
afterAll(cancelAppTimers);
