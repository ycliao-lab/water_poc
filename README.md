# 花蓮水線上訂購原型

網站以 GitHub Pages 發布：Settings → Pages → Source 選 `main` / `(root)`。


## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 網站原型（單頁、手機優先）。訂購、配送說明、水質證照、門市地圖與聯絡方式 |
| `apps-script/Code.gs` | Google Apps Script 後端：寫入 Google 試算表、Email 通知、LINE 推播、客人確認信 |

## 一、建立後端（約 5 分鐘）

1. 在 Google Drive 新增一份 Google 試算表，命名「花蓮水訂單」。
2. 試算表選單：**擴充功能 → Apps Script**。
3. 刪除預設的 `Code.gs` 內容，貼上 `apps-script/Code.gs`，儲存。
4. 上方函式選單選 `setup` → **執行**。第一次會要求授權（試算表、寄信、外部連線），按「允許」。
   - 若出現「Google 尚未驗證這個應用程式」：點「進階 → 前往（不安全）」。這是自己帳號建立的指令碼，屬正常提示。
   - 完成後試算表會多一張「訂單」工作表，含欄位標題、狀態下拉選單與顏色。
5. 左側 **專案設定（齒輪）→ 指令碼屬性**，視需要修改：
   - `NOTIFY_EMAILS`：新訂單通知收件人，多位以逗號分隔。留空則寄給部署者本人。
   - `SEND_CUSTOMER_EMAIL`：客人填 Email 時是否寄確認信（`true` / `false`）。
   - `LINE_CHANNEL_TOKEN`、`LINE_TO`：LINE 推播用，見第三節；未設定則略過。
6. 執行 `testOrder` 測試：試算表應出現一筆測試訂單，信箱收到通知信。
7. **部署 → 新增部署作業 → 類型選「網頁應用程式」**
   - 執行身分：**我**
   - 具有存取權的使用者：**所有人**
   - 部署後複製網址（以 `/exec` 結尾）。

> 之後修改 `Code.gs`，需到「部署 → 管理部署作業 → 編輯 → 版本選『新版本』」，網址不變。

## 二、接上網站

打開 `index.html`，修改最上方 `CONFIG`：

```js
GAS_URL: "https://script.google.com/macros/s/xxxxxxxx/exec",
LINE_OA_URL: "https://lin.ee/xxxxxx",   // 官方帳號加好友連結，沒有可先留空
```

`GAS_URL` 留空時為示範模式：可完整操作，送出後只顯示將寫入的資料，不會真的建立訂單。

## 三、LINE 推播（選用）

LINE Notify 已於 2025 年 3 月停止服務，改用 LINE 官方帳號的 Messaging API：

1. 到 LINE Official Account Manager 建立官方帳號，於設定中啟用 Messaging API。
2. 在 LINE Developers Console 該 Channel 的 **Messaging API** 分頁，發行 **Channel access token（long-lived）**，填入 `LINE_CHANNEL_TOKEN`。
3. 取得推播對象 ID 填入 `LINE_TO`：
   - 個人：Basic settings 頁面的 **Your user ID**（U 開頭），適合先推給老闆一人。
   - 店內群組：把官方帳號加入群組，以 webhook 取得群組 ID（C 開頭）。需要時可再加一段程式自動記錄。
4. 免費方案每月推播則數有上限，依目前訂單量應足夠，正式上線前請確認方案額度。

## 四、試算表使用方式

- 每筆訂單一列，「狀態」欄以下拉選單更新：新訂單 → 已確認 → 配送中 → 已完成／已取消，整列顏色會跟著變。
- 「內部備註」欄給店家自行記錄，網站不會覆寫。
- 右側每個品項各一欄數量，可直接做樞紐分析或月報。
- 價格以後端 `Code.gs` 的 `PRODUCTS` 為準（防止前端被竄改），調價時兩個檔案都要改。

## 五、已內建的防護

- 隱藏欄位擋機器人送單。
- 同一支電話 60 秒內只能送一次。
- 後端重新驗證必填欄位、電話格式、品項與配送限制，並重新計算金額。

## 六、待客戶確認

- 台東電話（現網站同時出現 089-228665 與 089-325129）
- 各品項價格、押桶費是否仍正確；「無宅配」品項的實際配送範圍
- 配送時間、運費門檻、偏遠地區規則（現網站為圖片，需文字版）
- 付款方式與匯款資訊
- 通知收件人、是否開通 LINE 官方帳號
- 網域與主機管理方式
