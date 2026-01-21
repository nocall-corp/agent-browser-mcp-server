# Agent Browser MCP Server

Vercel上でホストされたブラウザ自動化MCPサーバーです。Cursor AgentsやローカルCursorからブラウザ操作を実行できます。

## 機能

- `browser_open` - URLを開いて新しいセッションを開始（Basic認証対応）
- `browser_snapshot` - ページのアクセシビリティスナップショットを取得
- `browser_click` - 要素をクリック
- `browser_fill` - フォームフィールドに値を入力
- `browser_type` - テキストをタイプ（人間らしい入力）
- `browser_get_text` - 要素からテキストを取得
- `browser_screenshot` - スクリーンショットを撮影
- `browser_wait` - 要素が表示されるまで待機
- `browser_press_key` - キーを押す
- `browser_close` - セッションを終了

## セットアップ

### 1. 環境変数

Vercelダッシュボードで以下の環境変数を設定:

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `MCP_AUTH_TOKEN` | MCP認証トークン | Yes |
| `BROWSERLESS_TOKEN` | Browserless.io APIトークン | Yes |
| `KV_REST_API_URL` | Vercel KV URL | Yes |
| `KV_REST_API_TOKEN` | Vercel KV Token | Yes |

### 2. Browserless.io

[Browserless.io](https://browserless.io)でアカウントを作成し、APIトークンを取得してください。

### 3. Vercel KV

Vercelダッシュボードでプロジェクトに「KV」ストレージを追加してください。

## 使用例

### Basic認証が必要なサイトを開く

Basic認証で保護されたサイトにアクセスする場合は、basic_authパラメータを指定します:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "browser_open",
    "arguments": {
      "url": "https://protected-site.example.com",
      "basic_auth": {
        "username": "your-username",
        "password": "your-password"
      }
    }
  }
}
\`\`\`

認証情報はセッションに保存されるため、同じセッションIDを使う後続の操作でも認証が維持されます。

## Cursor Agents での使用方法

リポジトリの .cursor/mcp.json に以下を追加:

\`\`\`json
{
  "mcpServers": {
    "agent-browser": {
      "url": "https://agent-browser-mcp-server.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer \${env:AGENT_BROWSER_MCP_AUTH_TOKEN}"
      }
    }
  }
}
\`\`\`

そして、Cursor Dashboard の Cloud Agents → Secrets で AGENT_BROWSER_MCP_AUTH_TOKEN を登録してください。

## セッション管理

セッションには以下が含まれます:
- Cookie
- localStorage
- 現在のURL
- Basic認証情報

セッションは15分間有効です。

## ライセンス

MIT
