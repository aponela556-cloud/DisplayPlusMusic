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

**退避時長不可低估**：官方文件僅說明「等待 `Retry-After` 指定秒數」，
未給出範圍。社群回報的實際值多落在 **6 至 24 小時**（有案例約 21 小時），
`spotipy` issue #766 中亦出現 3600 秒。

⚠️ 30 秒滾動視窗是**判定是否超限**的依據，**不是懲罰時長**。
因此固定短退避（如 30–60 秒）無效，退避期間仍會持續碰壁。

**待確認**：
1. 取得 `Retry-After` 後，若值為數小時，程式該如何表現？
   持續重試顯然不合理，但完全停止輪詢後又該由什麼觸發恢復
   （使用者手動重試？定時低頻探測？）
2. 退避期間畫面該顯示什麼？維持上一首、顯示明確提示、
   或告知預計恢復時間（若能取得 `Retry-After`）。
3. 是否需將退避狀態持久化？若封鎖期長達數小時，
   使用者中途重啟 app 會讓退避計時歸零並立即再次觸發。

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

**已查證，非待決事項**——查官方 [Quota Modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
文件後，此項已無選擇空間：

Extended Quota Mode 自 **2025-05-15** 起**僅接受組織申請，且需 250k+ MAU**。
個人專案實質上無法申請。

**結論**：本專案只能維持 Development Mode
（最多 5 位授權使用者、擁有者須為 Premium、速率上限為預設值）。
**配額無法藉由申請提高，降低請求量是唯一可行方向。**

這使 A、B、F 三項從「最佳化」升級為**必要修正**。

**附帶影響**：刪除重建 app 可取得全新配額且不會造成等級損失
（因為本來就不可能是 Extended），但代價是重新註冊 redirect URI、
重新輸入憑證、重新授權所有裝置，且**頻率未修正前數分鐘內即會再次觸發**。

---

## I. OAuth callback 頁是完整 app，且版本會落後主線

**背景**：`https://aponela556-cloud.github.io/displaylyric-oauth/` 並非單純的轉址頁，
而是一份完整的 app 建置產物（323KB）。

**設計意圖（合理）**：授權完成後 webview 會停在 callback 頁上。
若該頁只是空白轉址頁，使用者將無法接續操作；做成完整 app 可讓
token 交換完成後直接繼續使用，配合 `removeCodeFromUrl()` 清除網址中的
`?code=`，體驗無縫。

**問題**：該建置發布於 **2026-09-02 22:12**（對應 `5e8a89b`），此後未再更新。
實測其內容：

| 功能 | 加入時間 | 已發布的 callback 頁 |
|---|---|---|
| `refresh-local-lyrics`（舊版 Refresh 按鈕） | 09-02 前 | ✅ 有 |
| `open-lrc-import`（Import LRC） | 09-03 | ❌ 無 |
| `open-local-lyrics-library`（Open Library） | 09-04 | ❌ 無 |
| `save-current-lyrics`（Save Lyrics） | 09-05 | ❌ 無 |

**實際影響**：使用者完成授權後若停留在該頁，等同於在使用三天前的舊版。
這會造成「明明已經切換到新分支、dev server 也確認送出新版，
但畫面就是舊的」這類極難排查的困惑——本次調查即在此耗費不少時間。

**辨識方式**：

| 網址 | 版本 |
|---|---|
| `192.168.50.95:5173` | dev server，最新 |
| `aponela556-cloud.github.io/displaylyric-oauth/` | 09-02 建置 |

或看按鈕：有 `Refresh` 為舊版，有 `Open Library` 為新版。

**待評估**：

| 選項 | 取捨 |
|---|---|
| 每次發版同步重建 callback 頁 | 維持現有體驗，但增加發布步驟且極易遺漏 |
| 改為輕量 callback 頁 + 導回來源（見 J） | 一勞永逸，但需調整授權流程 |
| CI 自動同步發布 | 可靠，但需建置流程投入 |

---

## J. 授權完成後應導回原始來源

**背景**：目前 callback 頁完成 token 交換後**留在原地**，
使用者就此停留在 github.io 的版本上。

**額外問題**：該頁與主 app 共用同一份程式碼，因此
`Main.ts` 的 `startPolling()` 也會執行——**它會以每秒 2 支 API 的頻率
持續輪詢 Spotify**。

這使它成為一個容易被忽略的流量來源：

- 它是**瀏覽器分頁**而非「app」，關閉 app 時不會聯想到它
- 授權流程會自動導向此頁，使用者可能授權後就將分頁擱置
- 它從 GitHub Pages 載入，**關閉本機 dev server 完全不影響它**

在排查 A–B 項的限流問題時，這個來源會讓「已關閉所有用戶端」的判斷失準。

**建議方向**：以 `state` 參數攜帶原始來源位址，callback 頁交換完 token 後
導回該位址。如此可同時解決三個問題：

1. 使用者回到正確（最新）的版本
2. callback 頁不再需要與主線同步（I 項消失）
3. 不再多出一個持續輪詢的用戶端

**待確認**：Even Hub 的 webview 是否允許導回區網位址
（如 `http://192.168.50.95:5173`）？需確認 `app.json` 白名單與
webview 的導向限制。若不允許，可能需改採其他回傳機制。

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
