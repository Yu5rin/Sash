// 最初に評価されるモジュール。main.ts の先頭の import に置く。
// ES モジュールの import は書いた順に評価されるので、ここで受け皿（総点検 G-5）を登録すれば、
// それより後ろの import（Monaco の読み込みなど）の評価中に起きた例外も拾える。
// main.ts の本文（import がすべて評価された後に動く）で登録したのでは、その前の失敗を取りこぼす。

import { installErrorReporting } from './shell/errorReport';

installErrorReporting();
