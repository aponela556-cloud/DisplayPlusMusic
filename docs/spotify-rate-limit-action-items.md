# Spotify 限流問題 — 待評估事項

**建立日期**：2026-09-05
**關聯文件**：[spotify-rate-limit-findings.md](./spotify-rate-limit-findings.md)
**狀態**：全部待決定，尚未實作

前一份文件記錄「問題是什麼」，本文件整理「需要做哪些決定」。
每項列出選項與取捨，供實作前評估。

---

## A. 輪詢間隔要設多少

**背景**：目前 `pollingPresenter.ts:8` 為 `API_INTERVAL_MS = 1000`，
每輪呼叫兩支 API，合計約 120 req/min。

**關鍵前提**：進度、歌詞、眼鏡畫面**已由 `pollQuick()` 的本地迴圈驅動**
（10ms，零網路成本）。網路輪詢**僅用於漂移校正**，且門檻為 `drift > 0.5`。

| 選項 | 流量 | 取捨 |
|---|---|---|
| 維持 1 秒 | 120 req/min | 現況，必定再次限流 |
| 3 秒 | 40 req/min | 保守，仍偏高 |
| **5 秒** | **24 req/min** | 建議起點，漂移最多累積約 0.1 秒 |
| 10 秒 | 12 req/min | 更省，換歌偵測延遲較明顯 |

**待確認**：換歌時的偵測延遲可接受到什麼程度？
間隔拉長後，使用者在手機切歌到眼鏡畫面更新之間會有可見延遲。
若在意，可考慮「偵測到 `is_playing` 或曲目變化時短暫提高頻率」的自適應做法。

---

## B. 429 退避如何實作

**背景**：`spotifyModel.ts:126` 的 `catch` 對所有錯誤一視同仁，被限流後仍全速重試。

**技術限制**：SDK 的 `DefaultResponseValidator` 只 `throw new Error(訊息字串)`，
**未暴露 HTTP 狀態碼與 `Retry-After` 標頭**。

| 選項 | 說明 | 取捨 |
|---|---|---|
| 比對錯誤訊息字串 | 判斷 `message === "The app has exceeded its rate limits."` | 實作最快，但依賴 SDK 內部字串，升級可能失效 |
| **自訂 `ResponseValidator`** | 實作 SDK 的驗證器介面，保留 `status` 與 `Retry-After` | 較穩健；專案已有自訂 `EvenHubSpotifyDeserializer` 的前例 |
| 攔截 fetch | 在更底層包裝 | 侵入性最高 |

**待確認**：退避策略要多積極？
建議至少「收到 429 即暫停輪詢 N 秒」，N 取 `Retry-After` 或預設 30–60 秒。
需注意退避期間畫面該顯示什麼（維持上一首？顯示提示？）。

---

## C. 錯誤日誌要保留到什麼程度

**背景**：目前完全沒有日誌，導致 401 / 403 / 429 三種問題在畫面上無法區分。
本次調查是靠臨時加入診斷才定位（見附錄）。

| 選項 | 取捨 |
|---|---|
| 僅 `console.error` | 最低成本；但 Even App 內不易查看 console |
| **同時寫入 `player-message`** | 使用者可直接看到；需考慮訊息是否過於技術性 |
| 加開關（debug 模式才顯示） | 最完整；需要 UI 與設定儲存 |

**待確認**：`player-message`（`index.html:74`）目前用於功能性提示
（如 `Saved ... lyrics to Library.`）。錯誤訊息與功能訊息共用同一列是否恰當？
兩者可能互相覆蓋。

---

## D. 背景與生命週期處理

**背景**：`src/` 中找不到任何 `visibilitychange` / `pagehide` / `beforeunload`。
App 切至背景時輪詢不會停止。

**待確認**：
1. Even App 將 webview 切至背景時，是否會自行凍結 timer？
   **需實機驗證**——若會凍結則此項優先度降低，若不會則屬持續漏流量。
2. 從背景返回前景時，除了恢復輪詢，是否需要立即強制同步一次以修正漂移？

---

## E. `stopPolling()` 死程式碼處置

**背景**：`pollingPresenter.ts:24` 已定義但專案中無任何呼叫處。

**待確認**：是配合 D 項接上生命週期事件，還是判定不需要而移除？
兩者皆可，但不宜維持現狀（存在但永不執行的程式碼會誤導後續維護者）。

---

## F. `getUsersQueue()` 的呼叫時機

**背景**：`spotifyPresenter.ts:27` 每秒呼叫一次，用於預抓下一首歌詞快取。
播放佇列實際數分鐘才變動一次。

| 選項 | 取捨 |
|---|---|
| 固定 30 秒 | 實作簡單 |
| **僅在偵測到換歌時** | 流量最省，且語意正確（換歌才需要知道新的下一首） |
| 移除預抓功能 | 最省，但換歌瞬間可能有歌詞延遲 |

**待確認**：預抓下一首歌詞帶來的體驗提升，是否值得這份流量？
若換歌時即時抓取的延遲可接受，這支 API 或許可完全移除。

---

## G. 是否需要請求量監控

**背景**：本次問題累積數日才顯現，過程中無任何量化資訊可佐證。

**待評估**：是否在 debug 模式下記錄「每分鐘請求數」與「最近一次 429 時間」？
有助於日後驗證修正是否有效，以及及早發現回歸。

---

## H. Spotify Dashboard 的配額模式

**待確認**（非程式碼問題，但影響容錯空間）：
目前這個 app 在 Spotify Developer Dashboard 上是
**Development Mode** 還是 **Extended Quota Mode**？

- Development Mode 配額較低，容錯空間小
- 若考慮刪除重建 app 以重置配額，**新建者一律從 Development Mode 開始**；
  若原本已具 Extended Quota Mode 將會失去

---

## 附錄：本次使用的診斷程式碼

以下修改**僅存在於測試機工作區，未提交**。列於此處供實作時參考，
或需要重現診斷時直接套用。

在 `src/model/spotifyModel.ts` 加入輔助函式：

```ts
function showDiag(message: string): void {
    try {
        const el = document.getElementById('player-message');
        if (el) el.textContent = message;
    } catch { /* ignore */ }
}
```

並在四個分支各加標記：

```ts
// 1) catch 區塊（原本為空的 `catch {`）
} catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error('[DIAG] getPlaybackState threw:', e);
    showDiag(`[1] API exception - ${detail}`);
    this.playbackAvailable = false;
    return song_placeholder;
}

// 2) 無活躍裝置
console.warn('[DIAG] no active device, raw result:', result);
showDiag(`[2] no active device - result=${...}`);

// 3) 有裝置但無曲目
console.warn('[DIAG] device active but item empty:', result);
showDiag(`[3] device but no item - device=${result.device.name ?? '?'} playing=${result.is_playing}`);

// 4) 成功路徑
showDiag(`[OK] ${song.title} - ${song.artist}`);
```

**判讀方式**：

| 畫面顯示 | 意義 |
|---|---|
| `[1] ... rate limits` | HTTP 429，限流 |
| `[1] ... Bad or expired token` | HTTP 401，需重新授權 |
| `[1] ... Bad OAuth request` | HTTP 403，權限或 scope 問題 |
| `[2] no active device` | 認證正常，Spotify 無活躍裝置 |
| `[3] device but no item` | 私密工作階段或廣告播放中 |
| `[OK] 歌名 - 演出者` | 一切正常 |

唯一的行為改動是將空的 `catch {` 改為 `catch (e) {` 以取出錯誤內容；
原有的回傳與狀態設定邏輯未更動。
