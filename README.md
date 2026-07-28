# 家計簿AI

Claude API (claude-sonnet-4-6) を使った AI 自動分類付き家計簿 Web アプリです。

## 機能

- **CSV インポート** — クレジットカードの CSV をアップロードすると、AI が列を自動認識して取引を抽出
- **画像 OCR** — 利用明細の写真を Claude Vision で解析し取引を抽出
- **手入力** — フォームから直接支出を入力
- **AI 自動分類** — 登録済みカテゴリを毎回渡して AI が支出を分類（新カテゴリにも追従）
- **ルールベース分類** — キーワードルールで確定的に分類（AI の前に優先適用）
- **ダッシュボード** — 月次の円グラフ・棒グラフ/折れ線グラフで支出を可視化
- **明細一覧** — カテゴリをインラインで修正可能
- **カテゴリ管理** — 分類項目を自由に追加・編集・削除
- **ルール管理** — キーワードルールを優先度付きで管理

## 技術スタック

| 項目 | 採用技術 |
|------|----------|
| フレームワーク | Next.js 16 (App Router, TypeScript) |
| DB | Supabase Postgres + Prisma 7 |
| AI | Anthropic API (claude-sonnet-4-6) |
| グラフ | recharts |
| スタイル | Tailwind CSS |
| デプロイ | Vercel |

## セットアップ手順

### 1. リポジトリをクローン

```bash
git clone <your-repo-url>
cd kakeibo-ai
npm install
```

### 2. Supabase プロジェクトを作成

1. [supabase.com](https://supabase.com) でアカウントを作成しプロジェクトを新規作成
2. **Settings → Database** から以下の接続文字列を取得:
   - **Transaction pooler** (ポート 6543) → `DATABASE_URL`
   - **Session pooler** (ポート 5432) → `DIRECT_URL`

### 3. 環境変数を設定

`.env.example` をコピーして `.env.local` を作成:

```bash
cp .env.example .env.local
```

`.env.local` を編集:

```env
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://postgres.[ref]:[pass]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.[ref]:[pass]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
```

### 4. DB マイグレーション

```bash
npx prisma migrate dev --name init
```

### 5. 開発サーバー起動

```bash
npm run dev
```

`http://localhost:3000` でアプリが起動します。

---

## Vercel へのデプロイ

### 1. GitHub にプッシュ

```bash
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<your-username>/kakeibo-ai.git
git push -u origin main
```

### 2. Vercel でプロジェクトをインポート

1. [vercel.com](https://vercel.com) にログインし "Add New Project" をクリック
2. GitHub リポジトリを選択して Import
3. **Environment Variables** に以下を追加:
   - `ANTHROPIC_API_KEY`
   - `DATABASE_URL`
   - `DIRECT_URL`
4. Deploy をクリック

### 3. 本番 DB マイグレーション

ローカルから本番 DB に対してマイグレーションを実行:

```bash
# DIRECT_URL を本番のものに合わせてから実行
npx prisma migrate deploy
```

---

## ディレクトリ構成

```
src/
├── app/
│   ├── page.tsx                # ダッシュボード
│   ├── transactions/page.tsx   # 明細一覧
│   ├── import/page.tsx         # データ取り込み（CSV/手入力/画像）
│   ├── categories/page.tsx     # カテゴリ管理
│   ├── rules/page.tsx          # ルール管理
│   └── api/
│       ├── transactions/       # CRUD
│       ├── categories/         # CRUD
│       ├── rules/              # CRUD
│       ├── import/             # CSV・画像取り込み
│       ├── ai/classify/        # AI 再分類
│       └── summary/            # 集計データ
├── components/
│   ├── ui/                     # Button, Card, Badge
│   ├── charts/                 # 円グラフ・棒グラフ
│   └── layout/                 # サイドバー
├── lib/
│   ├── anthropic.ts            # Anthropic SDK (サーバー専用)
│   ├── classifiers.ts          # AI 分類・OCR ロジック
│   ├── csv-parser.ts           # CSV パースロジック
│   ├── prisma.ts               # Prisma クライアント
│   └── utils.ts                # ユーティリティ
└── types/index.ts
```

## セキュリティ方針

- `ANTHROPIC_API_KEY` は **サーバーサイド (Route Handler) のみ** で使用し、クライアントには絶対に露出させない
- `src/lib/anthropic.ts` は Client Component から import しないこと
- CSV・画像の内容はサーバーサイドでのみ処理し、DB 保存前に必ずユーザー確認画面を経由する
- `.env*` ファイルは `.gitignore` で除外済み（`.env.example` のみコミット対象）
