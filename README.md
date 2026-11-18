# 投資合伙戶口管理系統 v3.2.2

獨立站（Node.js + Express + SQLite），由單檔 v2.26 升級而成，修好晒 v2.26 嘅計數 bug，資料由瀏覽器 localStorage 改做伺服器資料庫 `data/partnership.db`，幾個人用同一部伺服器就見到同一份數。

## 版本

**v3.2.2**（2026-11-18）

## 快速開始（本地）

```bash
npm install
npm start
# 開 http://localhost:3004
# 管理密碼預設 partnership-2026，請即刻喺 config.json 改咗佢
```

首次啟動如果資料庫係空，會自動匯入 `data/seed.csv`（198 筆交易，2018-03-09 至 2026-12-02，由你 2026-11-02 嗰個 CSV 轉做 UTF-8）。

## 種子數據核對（匯入後應該係咁）

| 項目 | 數值 |
|---|---|
| 交易總數 | 198 筆 |
| DEPOSIT 82 筆 | HK$263,762.90（A 樂 52,662.90、B 暉 53,000、C 源 52,000、D 啤 52,100、E 英 54,000） |
| DIVIDEND 18 筆 | HK$40,503.41 |
| INTEREST 17 筆 | HK$147.22 |
| BUY 27 筆 | 29,000 股，成本 HK$249,786.05，手費 HK$2,064.55 |
| RED_STOCK 4 筆 | +851 股 |
| FEE 50 筆 | HK$1,659.04 |
| 持股 | 00003.HK 29,851 股，平均買入價 HK$8.6133 |
| 銀行現金結餘 | **HK$50,903.89**（未計現價，伺服器啟動會自動向 Yahoo 更新） |
| 投入本金 | HK$263,762.90 |

股價唔使再手動輸入：伺服器啟動嗰陣自動更新一次，之後每 30 分鐘更新一次，總覽亦有「立即更新股價」掣。價錢先用騰訊報價，唔得先用 Yahoo；52 週高低同股息用 Yahoo v7，攞唔到就留返舊數。報價約 15 分鐘延遲，收市後係收市價。

## 功能

- 總覽：現金、持股總市值、總資產、投入本金、總盈虧、累計股息、總回報率、CAGR
- 合夥人餘額表：應存（每月 HK$500 × 由 2018-03-01 起計月數）、實際存入（DEPOSIT 總和）、差額、盈虧分佈（持股比例 × 總盈虧）、持股比例
- 持股表：股數、平均買入價、目前股價、升跌、市值、未實現盈虧
- 監察分頁：每隻股一張卡，每股股息、息率、52 週高低、52 週位置、買賣建議（公式見 CHANGELOG v3.2.0，只供參考）
- 交易記錄：新增／編輯／刪除／批量刪除、按動作／合夥人篩選
- CSV 匯入：伺服器自動試 UTF-8 → Big5 → GBK，接受兩種欄位順序（按欄名），日期接受 DD-MM-YYYY 同 YYYY-MM-DD，重複交易自動跳過
- JSON 備份／還原、CSV 匯出
- 股息計算器、DRIP 複利計算（每年明細）
- 後台：合夥人管理、股票管理、每月應存／起始日期設定

## v2.26 修好咗嘅 bug（v3.0.0）

1. 新增／編輯交易表單喺 HTML 入面根本唔存在，撳掣會報錯 — 而家有完整表單。
2. 投入本金同總盈虧計錯：`totalPrincipal` 先計做 0，總盈虧 = 總資產 − 0 — 而家本金 = DEPOSIT 總和，總盈虧 = 總資產 − 本金。
3. 合夥人「實際存入」用淨結餘，唔係存入總和 — 而家用 DEPOSIT 總和；持股比例唔再係平均分，用實際存入 ÷ 總本金。
4. 批次更新股價格式唔啱（`00003.HK,6.5` 更新唔到）— 而家接受 `00003.HK:6.5` 同 `00003.HK,6.5`。
5. DRIP 複利讀錯格（讀上面嗰組，唔係下面嗰組）— 而家讀 `divShares2` 等。
6. CSV 範例股息行金額落錯欄 — 而家 DIVIDEND 金額 = Price 欄（Quantity 係 0 嗰陣），FEE 金額 = FEE 欄，範例已更正。
7. 對帳報表會成個換走、隱藏掣撳唔返 — 而家對帳係獨立表格，顯示／隱藏掣喺標題。
8. 合夥人改名傳少參數 — 而家用 `prompt()` 問新名。
9. 複利總回報率只計股價，唔計股息 — 而家再投資唔重複計，拎現金就加返股息。
10. 資料只喺瀏覽器 localStorage，幾個人見到唔同數 — 而家係伺服器 SQLite，同一部伺服器就係同一份數。

## 設定

`config.json`：

```json
{ "adminPassword": "partnership-2026", "monthlyDeposit": 500, "port": 3004, "startDate": "2018-03-01" }
```

- `adminPassword`：管理密碼，所有 `/api/*`（除咗 `/api/health`）都要帶 `X-Admin-Password` 頭。亦可以用環境變數 `ADMIN_PASSWORD` 覆蓋。**上線前一定要改。**
- `monthlyDeposit`：每月應存，預設 500。
- `startDate`：起始日期，預設 2018-03-01。
- `port`：預設 3004（3000 照片站、3001 考試站、3002 投資站、3003 游泳站，唔撞）。

## API（要管理密碼）

- `GET /api/health` — `{ ok, app, version }`，唔使密碼
- `GET /api/state` — 總覽、合夥人、持股、監察（唔再回傳對帳）
- `GET /api/transactions` — 交易列表（`?action=&partner=&code=&limit=&offset=`）
- `POST /api/transactions`、`PUT /api/transactions/:id`、`DELETE /api/transactions/:id`、`POST /api/transactions/delete-many`
- `POST /api/import/csv`（multipart `file`）、`GET /api/export/csv`
- `GET /api/backup`、`POST /api/backup/restore`
- `POST /api/prices`（`{ prices: { "00003.HK": 6.5 } }`）
- `GET/POST /api/partners`、`PUT/DELETE /api/partners/:key`
- `POST /api/stocks`、`DELETE /api/stocks/:code`
- `POST /api/settings`、`POST /api/reset`

## 部署去 VPS（Ubuntu 24.04，DigitalOcean 新加坡）

```bash
# 1. 上傳成個資料夾去伺服器（唔好用 GitHub 推 data/partnership.db 同 data/seed.csv，.gitignore 已經排除咗佢哋 — seed.csv 入面係真實合夥人存款數字）
#    用 WinSCP 上傳去 /home/loklok/partnership；seed.csv 第一次要單獨用 WinSCP 上傳，或者部署後喺網頁匯入你原本嗰個 CSV
#    GitHub 只推程式碼：git add 時會自動跳過 data/*.db 同 data/*.csv，記得用私人倉，唔好用公開倉
# 2. 裝 Node 24
# 3. 安裝同啟動
cd /home/loklok/partnership
npm install
npm start
# 4. 用 pm2 長開
npm install -g pm2
pm2 start server.js --name partnership
pm2 save
pm2 startup
```

之後用 Nginx 反向代理去 `http://localhost:3004`，再加 HTTPS。**唔好直接將呢個站公開上網唔設密碼**：佢入面係真實合夥人存款數字，管理密碼一定要改，理想係再加 Nginx basic auth 或者只喺內網／VPN 用。

## 備份

- 備份成個 `data/` 資料夾，或者喺網頁撳「匯出 JSON 備份」。
- 還原：放返 `data/partnership.db`，或者喺網頁匯入 JSON 備份（重複交易會自動跳過）。
- 升級：覆蓋程式碼（唔好覆蓋 `data/partnership.db` 同 `config.json`），再 `pm2 restart partnership`。

## 注意

- 股價自動更新（騰訊先、Yahoo 後備；啟動一次＋每 30 分鐘一次＋手動掣），約 15 分鐘延遲。
- 呢個系統係記帳工具，監察欄嘅買賣建議按固定規則計，只供參考，唔係投資建議，唔保證回報。
- 2026-12-02 嗰筆 FEE HK$60 日期喺今日（2026-11-18）之後，係你 CSV 原本就有嘅，系統照原樣匯入，冇改過。
