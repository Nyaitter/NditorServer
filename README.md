# NditorServer

NditorのWebUI、クラウドScratch VM、共同作業APIとBash CLIです。

## セットアップ

Node.js 22以上、npm、Git、Bashが必要です。WindowsではGit Bashを使用してください。

```bash
git clone https://github.com/Nyaitter/NditorServer.git
cd NditorServer
bash bin/nditor install
# 任意: CLIをPATHへ登録
npm link --ignore-scripts
```

installはNyaitterの依存Forkをvendor/sources.jsonの固定コミットで取得し、npm依存のインストールとWebUIのビルドを行います。既存checkoutに変更がある場合は停止します。取得のみならinstall --no-build、後からビルドする場合はbuildを使用します。

## 設定

```bash
nditor config url set http://127.0.0.1:3001
nditor config nyaitter_url set https://nyaitter.example
nditor config token set 'YOUR_EXTENSION_TOKEN'
nditor serve
```

npm linkを使用しない場合はnditorをbash bin/nditorに置き換えてください。

| ID | 内容 |
| --- | --- |
| url | WebUIの公開URL。明示的なポートがあれば配信ポートにも使用 |
| nyaitter_url | NyaitterServerのURL |
| token | NyaitterServerで発行した拡張トークン |

config <id> set <value>はリポジトリ直下のconfig.jsonへ保存します。.envが存在する場合は同じ設定も更新します。config <id> getとstatusではtokenの値を表示しません。

起動中のサーバーへの反映には再起動が必要です。

Nyaitter式の設定優先順位は、プロセス環境変数 > .env > config.json > 既定値です。空の値は未設定として扱います。

### config.json

```json
{
  "url": "http://127.0.0.1:3001",
  "nyaitter_url": "https://nyaitter.example",
  "token": "YOUR_EXTENSION_TOKEN"
}
```

### .env

```ini
NDITOR_URL=http://127.0.0.1:3001
NDITOR_NYAITTER_URL=https://nyaitter.example
NDITOR_TOKEN=YOUR_EXTENSION_TOKEN
```

.env.exampleとconfig.example.jsonを参考にしてください。実際の.envとconfig.jsonはGit管理対象外です。設定ファイルは可能なOSで権限600として保存します。

トークンはサーバーだけが使用し、WebUIへ配信しません。CLIの値引数はOSのプロセス一覧に一時的に現れることがあるため、必要なら設定ファイルを直接編集してください。

## 配信

```bash
nditor serve
nditor serve --host 0.0.0.0 --port 8080
nditor serve --web-root /absolute/path/to/build
nditor serve --development
nditor status
```

WebUIは/editor/で配信します。Bashのserve引数で指定したhost、port、web-rootはその起動で設定を上書きします。公開ドメインをurlに指定した場合のlisten hostは既定127.0.0.1です。TLSはリバースプロキシで終端してください。HTTPS公開URLにポートを省略した場合、バックエンドの配信ポートは3001です。

NyaitterServer側のnscliでnyaitter-authスコープの拡張キーを発行し、実際に使用するWebUIのオリジンを許可してください。ポート変更時も許可オリジンを更新します。ユーザーの認証はWebUIのNyaitterAuthログインで行います。

APIパスを変更する場合はNDITOR_NYAITTER_API_PATHまたはconfig.jsonのnyaitter_api_pathを使用します。ローカルHTTPは使用できます。リモートHTTPはNDITOR_ALLOW_HTTP=trueまたはconfig.jsonのallow_http=trueが必要です。

クラウド拡張はQuickJS（WASM）で隔離し、CPU・メモリ・通信を制限します。DOM/WebGL依存の制約についてはdocs/nditor-extensions.mdを参照してください。

## 依存Fork

- https://github.com/Nyaitter/scratch-vm
- https://github.com/Nyaitter/scratch-paint
- https://github.com/Nyaitter/scratch-render
- https://github.com/Nyaitter/paper.js

既存依存には脆弱性監査での残存指摘があります。依存更新を完了したリリースではありません。

## ライセンスと由来

GPL-3.0。NditorとTurboWarp/Scratch GUIを基にしたWebUIを含みます。上流の著作権表示・各依存のライセンスを維持しています。
GUI上流: https://github.com/TurboWarp/scratch-gui
