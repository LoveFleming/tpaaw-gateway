# Coding Standards

> 本專案的 Coding 規範。AI 在寫碼時必須遵守。

## 通用原則

1. 改完碼一定要 commit + push，不留 uncommitted local change
2. 新字串必須用 t() + 加 locale key（如適用）
3. 永遠處理 IME composition（useRef，不要用 useState）

## 規範子目錄

將各語言/框架的規範放在 `standards/` 子目錄：

- `standards/typescript.md` — TypeScript 規範
- `standards/react.md` — React 規範
- `standards/naming.md` — 命名規範
- `standards/git-commit.md` — Commit message 規範

> 可透過 Coding IDE 的 Standards Editor 編輯，或點「Import」匯入範本。
