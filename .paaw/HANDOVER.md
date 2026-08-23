# HANDOVER — 交接文件

> 生成時間：2026-08-22T01:54:06.640Z
> 這份文件是給下一位工程師（或 AI agent）的最小接手上下文。

## 1. 這是什麼專案？

# Project Overview

> 由 PAAW AI-Native IDE 自動生成。點擊「Initialize」掃描專案，或手動填寫。

**Name**: (auto-detect)
**Path**: (project root)

## 技術棧

(待補充)

## 啟動方式

(待補充)

## 專案結構

(待補充)


## 2. Coding Standards

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


## 3. 最近變更

### Git 歷史（最近 15 筆）
```
ff850fd init: PAAW Gateway — standalone DevOps management platform
```

## 4. 進行中的工作

_(沒有進行中的 task)_

## 5. 怎麼跑起來

```bash
npm run dev    # node --watch src/server.mjs
npm run start    # node src/server.mjs
```

## 6. Release 歷史（最近 5 筆）

_(尚未有 release 記錄)_

## 7. 接手指引

1. 讀完 1–3 節建立全貌
2. `git log` 看最近改動方向
3. 檢查第 5 節進行中 task，跟 EM 確認優先序
4. 有問題問 Handover AI 助理（它讀得到這份知識庫）