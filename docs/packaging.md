# 打包與發布規則

## 版本

- 每個正式打包都必須使用新的版本號；一般修正使用下一個 patch 版本（例如 `2.6.2` → `2.6.3`）。
- `package.json` 與 `app.json` 的 `version` 必須完全一致。
- 在完成版本變更、測試與合併至 `main` 後才打包，讓檔名中的 Git 短雜湊可追溯至正式原始碼。

## 輸出位置與檔名

正式套件輸出至：

```text
C:\Users\Shawn\OneDrive - 胖蔬商行\Coding\EVENG2Packages\DisplayLyricMusic\<版本>\DisplayLyricMusic-<版本>-<Git短雜湊>.ehpk
```

例如：

```text
C:\Users\Shawn\OneDrive - 胖蔬商行\Coding\EVENG2Packages\DisplayLyricMusic\2.6.3\DisplayLyricMusic-2.6.3-abc1234.ehpk
```

Git 短雜湊為當前 `HEAD` 的前七碼，用於辨識同一版本下的確切原始碼。正式套件不得覆寫同名檔案。

## 指令

在 `DisplayLyricMusic` 目錄執行：

```powershell
npm test
npm run pack
```

`npm run pack` 會驗證版本一致性、建置單檔 HTML、建立 `out.ehpk`，再複製至正式輸出位置並輸出 SHA-256 雜湊。僅需本機測試或除錯時，可使用 `npm run pack:local`，其只會產生專案根目錄的 `out.ehpk`，不會發布檔案。
