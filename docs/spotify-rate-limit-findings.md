# Spotify API 限流問題調查報告

**調查日期**：2026-09-05
**調查基準版本**：`7a7ae7c` (`feature/save-remote-lyrics`)
**症狀**：Spotify 正在播放，但畫面顯示 `No Song Found`

---

## 結論

Spotify Web API 回傳 **HTTP 429（限流）**。程式碼本身沒有錯誤，但**輪詢頻率過高**導致持續觸發限流，且**缺乏退避機制**使其無法自行恢復。

限流綁定 **Client ID（整個 app）**，不是綁裝置——所有用戶端共用同一份配額。

---

## 診斷依據

錯誤訊息來自 Spotify SDK 的回應驗證器
`node_modules/@spotify/web-api-ts-sdk/dist/mjs/responsevalidation/DefaultResponseValidator.js`：

```js
switch (response.status) {
    case 401: throw new Error("Bad or expired token...");
    case 403: throw new Error("Bad OAuth request...");
    case 429: throw new Error("The app has exceeded its rate limits.");
    default:  /* Unrecognised response code: XXX */
}
```

`"The app has exceeded its rate limits."` 在整個 SDK 中**只有這一個來源**，對應狀態碼 429，可以確定即為限流，無其他可能。

同時反證：若為認證問題會顯示 401/403 的訊息。經查 OAuth callback 頁
`https://aponela556-cloud.github.io/displaylyric-oauth/` 存活（HTTP 200），
其 `REDIRECT_URI` 與原始碼完全一致，`spotifyAuthModel.ts` 自發布後未再變更——**OAuth 流程正常**。

---

## 問題清單

### 🔴 嚴重：導致無法自行恢復

#### 1. 收到 429 後不退避，繼續全速請求

`src/model/spotifyModel.ts:126`

```js
} catch {
    this.playbackAvailable = false;
    return song_placeholder;
}
```

所有錯誤一視同仁處理。被限流後輪詢迴圈照常每秒繼續，持續把自己壓在限流狀態。

**實測影響**：停止使用 10 小時後重新開啟，仍在一至兩分鐘內再次觸發限流。等待無法解決問題。

**建議**：對 429 讀取 `Retry-After` 標頭並暫停輪詢，或採指數退避。
（註：SDK 目前只 throw 訊息字串，未暴露標頭，可能需自訂 `ResponseValidator`。）

#### 2. `catch` 完全吞掉錯誤，無任何日誌

同 `src/model/spotifyModel.ts:126`，另有 `spotifyModel.ts:227`。

沒有 `console.error`，畫面僅顯示 `No Song`。401 / 403 / 429 三種完全不同的問題**外觀完全相同**，無法區分。

**建議**：至少加上 `console.error`，理想上將錯誤摘要顯示於畫面既有的
`player-message` 診斷列（`index.html:74`）。

---

### 🟠 主要：流量浪費，限流的直接原因

#### 3. 輪詢間隔過密

`src/presenter/pollingPresenter.ts:8`

```js
private readonly API_INTERVAL_MS = 1000;   // 每秒一輪
```

#### 4. 每輪呼叫兩支 API

`src/presenter/spotifyPresenter.ts:26-27`

```js
this.currentSong = await spotifyModel.fetchCurrentTrack();   // getPlaybackState
this.nextSong    = await spotifyModel.fetchNextTrack();      // getUsersQueue
```

**合計每分鐘 120 個請求。**

`getUsersQueue()` 用於預抓下一首歌詞快取，但播放佇列數分鐘至數十分鐘才變動一次，
卻以最高頻率輪詢——此半數流量幾乎全屬浪費。

#### 5. 網路輪詢的唯一用途是漂移校正，而絕大多數無作用

`src/model/spotifyModel.ts:190`

```js
if (drift > 0.5) {      // 漂移超過 0.5 秒才校正
```

進度條、歌詞同步、眼鏡畫面**全部由 `pollingPresenter.ts:57` 的本地迴圈驅動**
（`QUICK_INTERVAL_MS = 10`，純本地計算，零網路成本）：

```js
const delta = (now - this.lastFrameTime) / 1000;
if (song.isPlaying && song.progressSeconds < song.durationSeconds) {
    song.progressSeconds += delta;
}
```

網路輪詢僅負責校正漂移，而本地時鐘漂移速率約為每分鐘零點幾秒。
**每秒詢問一次，其中絕大多數請求不會觸發任何動作。**

#### 6. 暫停播放時仍全速輪詢

暫停時進度不前進，不可能產生漂移，仍照常每秒兩支請求。

---

### 🟡 次要：生命週期管理缺失

#### 7. `stopPolling()` 是死程式碼

`src/presenter/pollingPresenter.ts:24`

已定義但**專案中無任何呼叫處**。僅 `Main.ts:18` 呼叫 `startPolling()`，
啟動後永不停止。

#### 8. 未處理任何生命週期事件

搜尋 `src/` 找不到 `visibilitychange`、`pagehide`、`beforeunload`。

App 切換至背景時輪詢不會暫停，持續消耗配額。
因此「關閉程式」若僅是切至背景，並不會停止流量。

---

## 建議修正

| 項目 | 現況 | 建議 |
|---|---|---|
| `getPlaybackState` | 1 秒 | 5–10 秒 |
| `getUsersQueue` | 1 秒 | 30 秒，或僅在換歌時呼叫 |
| 暫停播放時 | 全速 | 大幅降頻或暫停 |
| 429 處理 | 無 | 退避 + 暫停輪詢 |
| 錯誤日誌 | 無 | `console.error` + 畫面顯示 |
| 切至背景 | 持續輪詢 | `visibilitychange` 時停止 |

前三項即可將流量由 **約 120 req/min 降至約 10 req/min**（約 1/12），
且使用者體驗不受影響——進度與歌詞本來就由本地迴圈計算。

---

## Spotify 官方限流規則

以下取自官方文件，區分「官方明載」與「社群回報」。

### 官方明載

**計算方式**（[Rate Limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)）

> "Spotify's API rate limit is calculated based on the number of calls that your
> app makes to Spotify in a rolling 30 second window."

採**滾動 30 秒視窗**，非固定週期重置。官方**未公布**具體請求數上限。

**超限回應**

> "The header of the 429 response will normally include a `Retry-After` header
> with a value in seconds."

恢復方式為等待 `Retry-After` 指定的秒數。

**配額模式**（[Quota Modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)）

| | Development Mode | Extended Quota Mode |
|---|---|---|
| 速率上限 | 較低（新 app 預設） | "much higher than apps in development mode" |
| 使用者數 | 最多 **5 位**已授權使用者 | 無限制 |
| 前提 | App 擁有者須為 **Premium 帳號** | — |
| 申請資格 | — | 2025-05-15 起**僅接受組織申請，需 250k+ MAU** |

⚠️ **Extended Quota 對個人專案實質上已不可申請。**
這代表本專案只能維持在 Development Mode，**配額無法藉由申請提高**，
唯一可行的方向是降低請求量。

### 社群回報（非官方）

`Retry-After` 的實際值遠比「30 秒視窗」直覺所暗示的長：

- 多筆回報落在 **6 至 24 小時**
- 有案例約 **21 小時**
- `spotipy` issue #766 中出現 **3600 秒（1 小時）**

**這與本次觀察一致**：09-04 傍晚仍正常，密集測試後觸發限流，
停用約 10 小時後重啟仍為 429。

**重要澄清**：30 秒滾動視窗是**判定是否超限**的依據，
**不是懲罰時長**。實際封鎖期由 `Retry-After` 決定，可能長達數小時至一日。
因此「等一下再試」並非可靠的恢復策略。

---

## 補充：測試環境注意事項

- 限流綁定 **Client ID**，非綁裝置。手機 App、模擬器、瀏覽器分頁若同時開啟，
  請求量會累加。
- 本專案目前無法讀取 `Retry-After`（SDK 未暴露，見問題 #2），
  因此無從得知尚需等待多久。
- 刪除並重建 Dashboard 上的 app 可取得新的 Client ID 與全新配額，
  代價是需重新註冊 redirect URI、重新輸入憑證並重新授權所有裝置。
  由於 Extended Quota 已不可申請，此舉不會造成配額等級損失。
- **輪詢頻率未修正前，重置配額後仍會在數分鐘內再次觸發。**
