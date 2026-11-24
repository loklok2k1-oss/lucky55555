# Data Plan

## Context provenance
- `好，幫我喺 Muse 建埋 v3.0.0 版，數據一樣係 198 筆` (verbatim build request; Muse 版要同獨立站 v3.0.0 同功能、同數據)
- `投資合伙戶口管理站 v3.0.0（2026-11-18 交付，獨立站，port 3004）：種子數據 198 筆（2018-03-09 至 2026-12-02，GBK 編碼 CSV）：00003.HK 煤氣，合夥人 A 樂、B 暉、C 源、D 啤、E 英，每月應存 HK$500，起始 2018-03-01；存入 HK$263,762.90、股息 HK$40,503.41、買貨 29,000 股成本 HK$249,786.05、紅股 +851 股，持股 29,851 股，現金 HK$50,903.89` (MEMORY.md durable record; shaped partners, settings, and verification totals)
- `雙版本並行、資料唔自動同步，靠備份匯出匯入同步` (user standing workflow in MEMORY.md; Muse 版要有 CSV 匯入／匯出同 JSON 備份／還原，方便同獨立站同步)
- `以後所有網站更新都要有版本號` (user standing rule; UI 頁尾顯示 v3.0.0)

## Tested sources
### 用戶 CSV 原檔（GBK）
**Used by**: `seedTransactions` (post-submit seed), verification totals
**Test command**: `python3 csv.DictReader on /home/hatch/workspace/user/files/CSV_______20261102A.csv decoded as GBK`
**Sample output**: 198 rows, header `Date,Code,Currency,Price,Quantity,Action,FEE,Partner,Note`, dates DD-MM-YYYY 2018-03-09 to 2026-12-02; Counter: DEPOSIT 82, FEE 50, BUY 27, DIVIDEND 18, INTEREST 17, RED_STOCK 4; partners in DEPOSIT: A 16 / B 22 / C 16 / D 18 / E 10 rows (plus NONE 116)
**Processing**: Date DD-MM-YYYY → YYYY-MM-DD; amount by action — DEPOSIT/INTEREST = Price, DIVIDEND = Price (qty=0) else Price×Qty, BUY/SELL amount = Price×Qty with fee separate, FEE amount = FEE column, RED_STOCK amount 0. Verified totals: deposits HK$263,762.90 (A 52,662.90 / B 53,000 / C 52,000 / D 52,100 / E 54,000), dividends HK$40,503.41, interest HK$147.22, BUY 29,000 shares cost HK$249,786.05 + fees HK$2,064.55, FEE rows HK$1,659.04, RED_STOCK +851 → holdings 29,851 shares, avg cost HK$8.6133, cash = 263,762.90+147.22+40,503.41−249,786.05−2,064.55−1,659.04 = HK$50,903.89 ✓

### 獨立站 v3.0.0 種子檔同程式（功能對照基準）
**Used by**: all actions (compute logic parity), client feature set
**Test command**: `python3 read of ~/workspace/your_files/partnership-account-standalone/data/seed.csv (UTF-8, 198 rows, same counters) + head of server.js / scripts/import-csv.js / README.md`
**Sample output**: seed.csv is the UTF-8 conversion of the same 198 rows; server.js computeState: principal = DEPOSIT sum, totalProfit = totalAssets − principal, partner actual = DEPOSIT sum, sharePct = actual ÷ principal, expected = monthlyDeposit × months since startDate; config monthlyDeposit 500, startDate 2018-03-01, VERSION 3.0.0; partners A 樂 / B 暉 / C 源 / D 啤 / E 英; stock 00003.HK price default 0 (user enters current price manually)
**Processing**: Port compute logic verbatim into a server action (single source of truth); Muse 版唔需要 admin password（Muse 本身已登入），其餘功能同獨立站睇齊：總覽、合夥人表、持股表、對帳表、交易 CRUD＋篩選、CSV 匯入（UTF-8→Big5→GBK 試解碼，兩種欄位順序按欄名）／匯出、JSON 備份／還原、批次改股價（接受 `00003.HK:6.5` 同 `00003.HK,6.5`）、股息＋DRIP 計算器、合夥人／股票／設定管理。股價唔自動更新，同獨立站一樣手動輸入，唔扮即時報價。

## v3.1.0 更新（2026-11-18）：股價自動更新＋多股監察
- 用戶要求（verbatim）：`不要手動輸入價格,直接更新,多個股票監察及持倉`、`同步到MUSE`——即係將獨立站 v3.1.0 嘅自動股價＋監察功能同步嚟 Muse 版。
- **報價渠道**：server action `refreshPrices` 兩條渠道，邊條先得用邊條：(1) 騰訊報價 `https://qt.gtimg.cn/q=hk<5位代號>`（plain fetch，港股專用、無 key；declared host: `qt.gtimg.cn`）——港股行先；(2) `ctx.tool.finance_ticker`（Muse 託管金融數據渠道）。代號轉換：本地帳用 5 位港股代號 `00003.HK`，渠道查詢前轉 4 位 `0003.HK`（`quoteSymbol()`）；非港股代號原樣傳入。
- **實測發現（2026-11-18 沙盒）**：finance_ticker 對美股（AAPL）準確，但港股唔可靠：`0700.HK`／`0981.HK` 解析唔到，`0003.HK` 俾嘅價 0.8 同佢自己報嘅 52 週波幅 6.4–7.76 矛盾（真價約 7.4）。所以渠道報價加咗合理性檢查：價錢跌出自己 52 週波幅（±2%）就當壞數據唔收，改用騰訊。騰訊喺 build 機 shell 直連會 timeout（同獨立站遇到嘅網絡限制一樣），但 artifact server 經平台 egress 出去係另一條路，以 action 實測結果為準；兩條都唔得嗰隻會列入 failed、保留上次價，唔會扮有價。
- **儲存形狀**：新表 `quotes`（每代號一行：price/change/change_pct/日高低/52週高低/name/market_status/as_of/updated_at/ok）＋新表 `watchlist`（監察代號）。`stocks.price` 同步鏡像最新好價，`computeState` 照舊純讀 DB。攞唔到價嗰隻保留上次價錢，quotes.ok=0，UI 明示邊隻失敗。
- **刷新政策（取代下面 v3.0.0 嘅「No scheduled refresh」）**：(1) 定時 cron 每 30 分鐘行 `refreshPrices`（space-owned，id `partnership-price-refresh`）；(2) 開頁時若 quotes 超過 15 分鐘舊，client 自動行一次；(3) 總覽有「立即更新股價」掣。畫面顯示最後更新時間（Asia/Macau）同每隻報價嘅 as_of。
- **監察清單**：`addWatchlist`／`removeWatchlist`；加入即刻攞一次價；監察表顯示現價、升跌%、今日波幅、52 週波幅、持有股數（有就顯示）。JSON 備份／還原包埋 watchlist。
- 版本號：VERSION 常數同頁尾同步升到 3.1.0（用戶常規：所有更新要有版本號）。

## v3.2.0 更新（2026-11-18）：取消現金對帳＋監察獨立成欄（高息為主）
- 用戶要求（verbatim）：`現金對帳可以取消，監察股票可以新一欄，以高息股資料為主，也加入目前是否高位的數據，買賣建議`
- **取消對帳**：總覽移除「對帳（現金點樣嚟）」段；`getState` 回應移除 `recon` 欄位（現金本身照計，總覽「銀行現金」數字不變）。
- **監察新欄**：分頁加「監察」頁（總覽／監察／交易／計算器／後台）；舊監察清單由總覽搬入去並升級做每股一卡。監察集合 = 持股 ∪ 監察清單 ∪ 已知股票代號，server 喺 `computeState` 計 `monitor` 陣列。
- **高息股資料**：每股股息來源優先序——(1) 用戶手動輸入（新欄 `stocks.dps`，新 action `setStockDps`，監察卡可改）；(2) 帳目近 12 個月 DIVIDEND 總額 ÷ 現持股數（只限有持股）；(3) 報價渠道 `dividend_rate`。息率 = 每股股息 ÷ 現價；冇每股股息就用渠道 `dividend_yield`。渠道股息欄位唔喺文件欄位表內，`fetchViaChannel` 防禦式讀取，有先用；新欄 `quotes.dividend_yield`／`dividend_rate`（migration 0004）。
- **是否高位**：現價喺 52 週波幅位置 % = (現價−52週低)÷(52週高−52週低)，標籤 高位 ≥80／偏高 ≥60／中位 ≥40／偏低 ≥20／低位 <20。騰訊報價冇 52 週數據，`fetchQuote` 改做合併：主來源缺 52 週／股息欄位時向渠道攞附加欄位填（渠道港股價唔可信、成個 reject，但佢報嘅 52 週波幅同真價吻合，只攞波幅／股息、永不混價）；寫入時今次缺嘅附加欄位保留上次好值。兩邊都冇就顯示「未有 52 週數據」，唔估。
- **買賣建議**：固定規則（UI 有寫明）：位置 ≥85% → 持有出「減持」訊號、未持有出「觀望（唔好追）」；息率 ≥5% 且位置 ≤50%（或冇位置數據）→「買入」訊號；息率 <3% 且位置 ≥70% →「觀望」；其餘持有 = 持有收息、未持有 = 觀望；冇價 = 未有判斷。全部只按已存數據機械計，UI 同頁尾都標明唔係投資建議。
- 版本號：VERSION 常數同頁尾同步升到 3.2.0。

## v3.2.1 更新（2026-11-18）：每手股數／一手價錢＋趨勢＋購買股票結餘
- 用戶要求（verbatim）：`投資合夥人戶口監察股票加入一手多少股多少錢，監察股票目前在上升還是下降軌中，戶口結餘扣除各合夥人的差額有多少`；基數確認：`現金結餘 是HK$50,903.89沒錯，監測那邊加一項購買股票結餘 HK$50,903.89 − 3,762.90 ＝ HK$47,140.99`
- **每手股數＋一手價錢**：監察卡加「每手 X 股，一手 HK$Y」，Y ＝ 現價 × 每手股數（唔計手續費）。已核實預設值（用戶提供，2026-11-18）：00003.HK／00883.HK／01579.HK／02510.HK 各 1,000 股、06181.HK 100 股；新股預設 1,000。新欄 `stocks.lot_size`（migration 0005）＋新 action `setStockLotSize` 可手動改／回復預設，手動值優先。
- **趨勢**：新表 `trends`（migration 0005）。`fetchTrend` 用 Yahoo v8 chart（`https://query1.finance.yahoo.com/v8/finance/chart/<4位代號>.HK?range=6mo&interval=1d`，declared host: `query1.finance.yahoo.com`）半年日線收市價計 MA20／MA50，斜率同 5 個交易日前比較。固定規則：現價 > MA20 > MA50 且兩線向上 → 上升軌；現價 < MA20 < MA50 且兩線向下 → 下降軌；其餘 → 橫行／整固。`refreshPrices` 順手計，每隻每日（Asia/Macau）最多成功計一次；少過 55 個收市價或攞唔到就 null，UI 顯示「未有趨勢數據」。買賣建議公式不變，唔受趨勢影響。沙盒實測（2026-11-18，Yahoo 直連通）：1579 上升軌（17.43 > MA20 15.92 > MA50 14.88，兩線向上）、2510 下降軌（11.02 < MA20 11.93 < MA50 12.94，兩線向下），同用戶俾嘅 2026-11-16 參考樣本方向一致。
- **購買股票結餘**：`computeState` 新增 `buyBalance`，由實時數據計，唔寫死：現金結餘 − Σ（每人實際存入 − 應存）。現時數據：50,903.89 − 3,762.90（樂 +662.90、暉 +1,000、源 0、啤 +100、英 +2,000）＝ 47,140.99。監察頁頂部顯示算式＋每人分項；差額負數照實計入總和。
- **備份**：JSON 備份／還原包埋 `stocks.lotSize` 同 `trends`（舊備份冇呢兩樣都還原到，欄位 optional／default）。
- 版本號：VERSION 常數同頁尾同步升到 3.2.1（Muse 版冇 package.json 版本欄／README／CHANGELOG／/api/health，六處同步嗰套係獨立站嘅；Muse 版以 actions.ts VERSION 常數＋頁尾為準）。

## v3.2.2 更新（2026-11-18）：監察頁一鍵隱藏公式
- 用戶要求（verbatim）：`監察太多公式細字，加個可一鍵隱藏`；補充設計決定：頁頂開關掣常駐、預設收起、記住選擇、唔改任何計算／趨勢邏輯／建議公式，版本升 3.2.2。
- **開關**：監察頁頂標題旁加「顯示公式／隱藏公式」掣（`aria-pressed`），永遠可見。狀態存瀏覽器 `localStorage` key `monitor-show-formulas`（"1"＝顯示），預設冇記錄＝隱藏；撳掣即時切換並寫返記錄，重開頁面沿用。
- **收起時隱藏**：(a) 頁頂公式說明——買賣建議規則段、趨勢公式段（展開版補齊四重條件、MA20＝最近 20 個收市價平均／MA50＝最近 50 個、斜率同 5 個交易日前比較、Yahoo 半年日線收市價、每日計一次、用最後收市價唔係即時現價）；(b) 每卡公式輸入數值行——52 週高低數字、每股股息格＋來源／平均成本／報價時間細字、每手格、一手價錢格、MA20／MA50 格、一手算式＋趨勢細字段；(c) 購買股票結餘卡嘅算式行＋差額分項細字（結餘金額本身常駐）。
- **收起時保留重點**：每卡現價、升跌 %、52 週位置標籤＋位置條、息率、趨勢標籤、買賣建議框；頁面保留購買股票結餘金額、加入監察、更新股價、改股息／每手／移除監察等全部操作掣。
- **冇改**：server 計算、趨勢規則、建議公式、任何數據；後端只升 VERSION 常數 3.2.1 → 3.2.2（連頁尾顯示）。

## v3.3.0 更新（2026-11-19）：自動派息（TTM DPS＋五年派息＋派息比率）
- 用戶要求（verbatim）：`加自動派息功能：伺服器更新股價嗰陣，順手去 Yahoo 抓每隻監察股嘅派息歷史，自動計出過去 12 個月派息（TTM DPS）同埋過去 5 年每年派息，監察卡顯示升／平／跌嘅派息趨勢同派息比率；手填嘅派息仍然優先，自動抓返嚟嘅數只係後備。版本升到 v3.3.0。`
- **派息來源實測（2026-11-19 沙盒）**：Yahoo v8 chart 加 `events=div`、`period1/period2` 取 5 年半——0003.HK 攞到 12 個派息事件，2021–2026 每年合計 HK$0.35（0.23＋0.12），TTM 0.35，同已知煤氣派息吻合。EPS：v7 quote／v10 quoteSummary 直連係 401，要行 crumb 流程（fc.yahoo.com 攞 cookie → query2 getcrumb → quoteSummary defaultKeyStatistics.trailingEps），實測 0003.HK trailingEps raw = 0.34，派息比率 = 0.35 ÷ 0.34 ≈ 103%，合理。crumb 喺 server process 內 cache 30 分鐘；任何一步失敗 EPS 當 null，派息比率唔計、顯示「—」，唔估。
- **儲存形狀**：新表 `dividend_history`（migration 0006）：code／ttm_dps／yearly（JSON `[{year, dps}]`，最近 5 個曆年升序）／trend（up／flat／down）／eps／day／updated_at／ok。`refreshDividends` 喺 `fetchAndStoreQuotes` 尾跟趨勢一齊行，每隻每日（Asia/Macau）最多成功抓一次；失敗只翻 ok=0，保留上次好值（同 trends 政策一致）。冇派息事件但 chart 攞到 = 成功（TTM 0）。
- **派息趨勢規則**：比較最近兩個完整曆年 DPS（今年未完唔攞嚟比），變幅 >+3% 升、<−3% 跌、其餘平穩；完整曆年得一年就用 TTM 對嗰年；再冇就 null 顯示「未有派息趨勢」。
- **優先次序**：手動 DPS > 自動 TTM DPS > 帳目派息（近 12 個月帳目股息 ÷ 持股數）> 報價渠道 dividend_rate；`dpsSource` enum 加 `auto`，卡上來源標籤：手動輸入／自動抓取／帳戶派息／報價渠道。派息比率 = 採用中嘅 DPS ÷ EPS（EPS ≤ 0 唔計）。
- **監察卡新增**：派息比率（常駐）、派息趨勢（5 年）區——每年 DPS 序列（`0.35 → 0.35 → …` 形式）＋升／平／跌徽章常駐；公式模式額外顯示 EPS、自動 TTM DPS 行；監察頁公式說明加派息一段（來源、TTM 定義、趨勢規則、優先次序、派息比率公式）。
- **備份**：JSON 備份／還原包埋 `dividends`（舊備份冇呢欄照樣還原到，欄位 optional／default）。
- **冇改**：買賣建議公式、價格趨勢計算、購買股票結餘、公式隱藏掣、監察股中文名、一手股數。
- 版本號：VERSION 常數＋頁尾升 3.3.0，新建 CHANGELOG.md 並加 v3.3.0 一條（連補返舊版本簡史）。同場做 platformVersion 28 → 29 升級：表單輸入限制改由 `actionFields`（FIELDS）由 request schema 派生（setStockDps.dps、setStockLotSize.lotSize、addWatchlist.code、createTransaction.code／note、upsertPartner.key／name、updateSettings.monthlyDeposit），刪除人手寫嘅 min；兩個空白即跳過嘅提交（加入監察、新增合夥人）改為喺欄位旁顯示原因；冇 onError 嘅 mutation 失敗通知經 `setFailureNoticeText` 改做中文。

## Long-term data behavior
- **Refresh policy**: v3.1.0 起股價自動更新（見上）；交易數據仍然只由用戶輸入／匯入增長，唔會自動改。
- **Growth**: Transactions grow by user entry/import only. Seed runs once via post-submit `seedTransactions` with dedupe key date|code|action|price|qty|fee|partner|note (INSERT OR IGNORE semantics) so re-runs never duplicate the 198 rows.
- **Ordering**: Transactions newest first in the list (date DESC); holdings by code; partners by sort A–E.
- **Time semantics**: Transaction dates are plain calendar dates (YYYY-MM-DD stored as text), no timezone conversion. Expected-deposit months computed from startDate 2018-03-01 to the viewer's current month in Asia/Macau.

## Rejected approaches
- **Tried**: Embedding the 198 rows as a client-side constant or SQL seed migration
  **Why rejected**: Seed rows belong in a one-time post-submit action against the durable DB, not in code/migrations; dedupe in the action keeps it idempotent and keeps user edits safe.
- **Tried**: Auto-fetching 00003.HK live price from Yahoo Finance
  **Why rejected**: Standalone v3.0.0 is manual-price by design and the user asked for the same v3.0.0; a live quote would silently change totals versus the standalone copy. Price stays a stored, editable value (default 0, with a clear prompt to enter it).

Imagery not needed: this is a numeric ledger/accounting tool; every surface is figures, tables, and forms — no visual subjects, and photos would add noise to a reconciliation workflow.
