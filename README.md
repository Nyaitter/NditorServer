# NditorServer

NditorのWebUI、クラウドScratch VM、共同作業APIとセットアップCLIです。

## セットアップ

Node.js 22以上、npm、Gitが必要です。現行の開発環境はNode.js 26です。

```sh
git clone https://github.com/Nyaitter/NditorServer.git
cd NditorServer
node bin/nditor.cjs install
```

`install` は `vendor/sources.json` に記録されたNyaitterのForkを、固定コミットで取得します。その後npm依存をインストールし、WebUIをビルドします。依存のインストールフックは実行しません。既存の依存checkoutに未コミットの変更があれば停止します。

依存の取得だけ行う場合は `node bin/nditor.cjs install --no-build`、後からビルドする場合は `node bin/nditor.cjs build` を使用します。

CLIをPATHへ登録したい場合は、セットアップ後に `npm link --ignore-scripts` を実行してください。以降は `nditor` または `nditorserver` として呼び出せます。

## NyaitterServerへ接続

NyaitterServer側の `nscli` でNditor用の拡張トークンを発行してください。WebUIを配信する実際のオリジンを許可します。

```sh
nscli extension-key create --name Nditor --scope nyaitter-auth \
  --redirect-origin http://localhost:3001 \
  --redirect-origin http://127.0.0.1:3001 \
  --output /private/nditor-extension-token
```

NditorServerで接続先とトークンを設定します。

```sh
nditor connect --server https://nyaitter.example \
  --token-file /private/nditor-extension-token
```

APIのルートは通常 `/server` です。異なる場合は `--api-path /prefix` を指定します。ローカルのNyaitterServerには `--server http://127.0.0.1:3000` を指定できます。リモートのHTTPは明示的に `--allow-http` を付けた場合のみ使用できます。

`connect` は設定を保存します。実際の認証とユーザートークンの取得はWebUIのNyaitterAuthログインで行います。拡張トークンはサーバーだけが使用し、ブラウザには配信しません。

設定とトークンはWindowsでは `%LOCALAPPDATA%/nditor-server`、Linux等では `$XDG_CONFIG_HOME/nditor-server` または `~/.config/nditor-server` に保存します。`--config-dir DIR` でリポジトリ外の保存先へ変更できます。トークンの値はCLIの出力に表示しません。

## 指定ポートでWebUIを配信

```sh
nditor serve --port 3001
# LAN・リバースプロキシから受け付ける場合
nditor serve --host 0.0.0.0 --port 8080
```

WebUIは `http://localhost:3001/editor/`、共同作業APIは同じポートで配信します。ポートや公開ホストを変更した場合は、NyaitterServerの拡張トークンで許可するオリジンも更新してください。

WebUIだけなら接続設定なしでも配信できます。Nyaitterログインや連携機能には有効な接続設定が必要です。

```sh
nditor serve --web-root /absolute/path/to/built-ui --port 8080
nditor serve --development --port 3001
nditor status
```

ローカルのプロジェクトストレージは設定領域の `storage/` に保存します。`NDITOR_STORAGE_ROOT` などの環境変数で変更できます。環境変数の例は `.env.example` を参照してください。

## 依存Fork

- [Nyaitter/scratch-vm](https://github.com/Nyaitter/scratch-vm)
- [Nyaitter/scratch-paint](https://github.com/Nyaitter/scratch-paint)
- [Nyaitter/scratch-render](https://github.com/Nyaitter/scratch-render)
- [Nyaitter/paper.js](https://github.com/Nyaitter/paper.js)

クラウドのカスタム拡張はQuickJS（WASM）で隔離し、JSヒープ・CPU・通信を制限します。DOMやWebGLを直接使用する拡張には制約があります。

既存依存には脆弱性監査での残存指摘があります。これは依存更新を完了したリリースではありません。

## ライセンスと由来

GPL-3.0。NditorとTurboWarp/Scratch GUIを基にしたWebUIを含みます。
上流の著作権表示・各依存のライセンスを維持しています。
GUI上流: https://github.com/TurboWarp/scratch-gui
