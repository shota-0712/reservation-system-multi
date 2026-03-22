# GitHub Actions シークレット設定

このファイルは、GitHub Actions で設定が必要なシークレット（環境変数）の一覧です。
GitHub リポジトリ → Settings → Secrets and variables → Actions で設定してください。

---

## 必須シークレット

### GCP関連
| シークレット名 | 説明 | 例 |
|---|---|---|
| `GCP_PROJECT_ID` | Google Cloud プロジェクトID | `my-project-123456` |
| `GCP_SA_KEY` | サービスアカウントのJSONキー（全文） | `{"type": "service_account", ...}` |
| `SERVICE_NAME` | Cloud Runサービス名（サイトタイトルにも使用） | `salon` → タイトル: `alon-予約サイト` |

### Google APIs
| シークレット名 | 説明 | 例 |
|---|---|---|
| `GOOGLE_SHEET_ID` | スプレッドシートのID | `1ABC...xyz` |
| `GOOGLE_DRIVE_FOLDER_ID` | 画像保存用フォルダID | `1ABC...xyz` |

### LINE
| シークレット名 | 説明 | 例 |
|---|---|---|
| `LINE_ACCESS_TOKEN` | LINE Messaging APIのアクセストークン | `xxx...` |
| `ADMIN_LINE_ID` | 管理者のLINE UserID（カンマ区切りで複数可） | `Uxxxxx,Uyyyyy` |
| `LIFF_ID` | LINE LIFFアプリのID | `1234567890-abcdefgh` |

### セキュリティ
| シークレット名 | 説明 | 例 |
|---|---|---|
| `SCHEDULER_SECRET` | Cloud Schedulerからのリクエスト認証用シークレット | `your-random-secret-string` |

---

## オプションシークレット（テーマカラー）

| シークレット名 | 説明 | デフォルト値 |
|---|---|---|
| `THEME_COLOR` | メインカラー（16進数） | `#9b1c2c` |
| `THEME_COLOR_LIGHT` | ホバー時カラー | `#b92b3d` |
| `THEME_COLOR_DARK` | ダークカラー | `#7a1522` |

---

## 注意事項

- `SALON_INFO` と `PRECAUTIONS` はスプレッドシートのsettingsシートから取得
- `GOOGLE_CALENDAR_ID` は施術者ごとにスプシから取得
- サイトタイトルは `SERVICE_NAME-予約サイト` の形式で自動生成
