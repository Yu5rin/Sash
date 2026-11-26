// サードパーティのライセンス（バージョン情報の「サードパーティのライセンス」から開く）。
// 全文をリポジトリに置くだけでは、配布する exe を受け取った人に届かない。MIT License は「複製に著作権表示と
// 許諾表示を含める」ことを求めるので、テキストのまま UI に取り込み、アプリの中で読めるようにする。
// ?raw で取り込むと、ビルドで JS のチャンクに入り、wwwroot ごと exe に埋め込まれる。
// バージョン情報を開いたときにだけ読み込む（起動時の読み込みを重くしないため）。

import fluentIcons from '../fluent/LICENSE-fluentui-system-icons.txt?raw';
import tablerIcons from '../fluent/LICENSE-tabler-icons.txt?raw';
import lucideIcons from '../fluent/LICENSE-lucide.txt?raw';
import sashIcons from '../fluent/LICENSE-sash-icons.txt?raw';
import commandIds from '../catalog/LICENSE-office-fluent-ui-command-identifiers.txt?raw';
import monacoLicense from 'monaco-editor/LICENSE?raw';
import monacoNotices from 'monaco-editor/ThirdPartyNotices.txt?raw';

export interface LicenseEntry {
  /** 部品の名前（固有名詞なので訳さない）。 */
  name: string;
  /** 何に使っているか（t() に渡す日本語のキー）。 */
  usage: string;
  text: string;
}

export const THIRD_PARTY_LICENSES: readonly LicenseEntry[] = [
  { name: 'Fluent UI System Icons', usage: 'アイコン集', text: fluentIcons },
  { name: 'Tabler Icons', usage: 'アイコン集', text: tablerIcons },
  { name: 'Lucide', usage: 'アイコン集', text: lucideIcons },
  { name: 'Sash original icons', usage: 'アイコン集（自作）', text: sashIcons },
  { name: 'office-fluent-ui-command-identifiers', usage: 'idMso / imageMso の一覧', text: commandIds },
  { name: 'Monaco Editor', usage: 'XML エディタ', text: monacoLicense },
  { name: 'Monaco Editor — Third Party Notices', usage: 'XML エディタが含む部品', text: monacoNotices },
];
