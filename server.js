// 投資合伙戶口管理系統 — 獨立站 v3.2.0
// Node.js + Express + SQLite（內置 node:sqlite，唔使裝原生模組）
// 啟動：npm install 之後 npm start，預設 http://localhost:3004
// 首次啟動如果資料庫係空，會自動匯入 data/seed.csv（198 筆，由你 2026-11-02 嗰個 CSV 轉做 UTF-8）。
// 管理密碼：config.json 入面 adminPassword（預設 partnership-2026，請即刻改），
// 亦可以用環境變數 ADMIN_PASSWORD 覆蓋。所有 /api/*（除咗 /api/health）
// 都要帶 X-Admin-Password 頭，唔啱就 401。
"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { parseCsvBuffer, VALID_ACTIONS } = require("./scripts/import-csv");

const VERSION = fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").trim();
const PORT = process.env.PORT || 3004;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "partnership.db");
const CONFIG_PATH = path.join(ROOT, "config.json");
const SEED_PATH = path.join(DATA_DIR, "seed.csv");
fs.mkdirSync(DATA_DIR, { recursive: true });

let config = { adminPassword: "partnership-2026", monthlyDeposit: 500, startDate: "2018-03-01", port: 3004 };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))); } catch (e) { console.warn("讀唔到 config.json，用預設值。"); }
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || config.adminPassword;

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch (e) {
  console.error("啟動失敗：需要 Node.js 22 或以上（建議 Node 24 LTS），因為要用內置 node:sqlite。");
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, code TEXT NOT NULL DEFAULT 'CASH',
  currency TEXT NOT NULL DEFAULT 'HKD', action TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0, qty REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
  partner TEXT NOT NULL DEFAULT 'NONE', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS partners (
  key TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY, price REAL NOT NULL DEFAULT 0,
  prev_close REAL NOT NULL DEFAULT 0, change_pct REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  dps REAL, high52 REAL NOT NULL DEFAULT 0, low52 REAL NOT NULL DEFAULT 0,
  quote_dps REAL NOT NULL DEFAULT 0, quote_yield REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_partner ON transactions(partner);
CREATE INDEX IF NOT EXISTS idx_tx_code ON transactions(code);
`);
// 舊資料庫升級：補返 stocks 表新欄位
for (const col of ["prev_close REAL NOT NULL DEFAULT 0", "change_pct REAL NOT NULL DEFAULT 0", "updated_at TEXT NOT NULL DEFAULT ''", "dps REAL", "high52 REAL NOT NULL DEFAULT 0", "low52 REAL NOT NULL DEFAULT 0", "quote_dps REAL NOT NULL DEFAULT 0", "quote_yield REAL NOT NULL DEFAULT 0"]) {
  try { db.exec(`ALTER TABLE stocks ADD COLUMN ${col}`); } catch (e) { /* 已經有就唔理 */ }
}

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}
if (!db.prepare("SELECT value FROM settings WHERE key='seeded'").get()) {
  setSetting("monthlyDeposit", config.monthlyDeposit);
  setSetting("startDate", config.startDate);
}
// 預設合夥人：A 樂、B 暉、C 源、D 啤、E 英（由 CSV 存入備註逐一核實，100% 一致）
const DEFAULT_PARTNERS = [["A", "樂", 1], ["B", "暉", 2], ["C", "源", 3], ["D", "啤", 4], ["E", "英", 5]];
for (const [k, name, sort] of DEFAULT_PARTNERS) {
  db.prepare("INSERT OR IGNORE INTO partners(key, name, sort) VALUES(?, ?, ?)").run(k, name, sort);
}
db.prepare("INSERT OR IGNORE INTO stocks(code, price) VALUES('00003.HK', 0)").run();

function makeId() { return "tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9); }
function txKey(t) { return [t.date, t.code, t.action, t.price, t.qty, t.fee, t.partner, t.note].join("|"); }
function insertTx(t) {
  const id = t.id || makeId();
  db.prepare(`INSERT OR IGNORE INTO transactions
    (id, date, code, currency, action, price, qty, fee, amount, partner, note, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, t.date, t.code, t.currency || "HKD", t.action, t.price || 0, t.qty || 0, t.fee || 0, t.amount || 0, t.partner || "NONE", t.note || "", new Date().toISOString());
  return db.prepare("SELECT changes() AS c").get().c === 1;
}
function seedIfEmpty() {
  const n = db.prepare("SELECT COUNT(*) AS c FROM transactions").get().c;
  if (n > 0 || !fs.existsSync(SEED_PATH)) return { seeded: false, count: n };
  const { imported, errors } = parseCsvBuffer(fs.readFileSync(SEED_PATH));
  let added = 0;
  const seen = new Set(db.prepare("SELECT date, code, action, price, qty, fee, partner, note FROM transactions").all().map(txKey));
  for (const t of imported) {
    if (seen.has(txKey(t))) continue;
    if (insertTx(t)) { added++; seen.add(txKey(t)); }
    if (t.code !== "CASH" && t.code !== "MANUAL") db.prepare("INSERT OR IGNORE INTO stocks(code, price) VALUES(?, 0)").run(t.code);
  }
  if (errors.length) console.warn("種子 CSV 有 " + errors.length + " 行跳過（頭 5 行）：" + errors.slice(0, 5).join("；"));
  console.log(`種子數據已匯入 ${added} 筆交易（來源 data/seed.csv，198 行）。`);
  return { seeded: true, count: added };
}
seedIfEmpty();

// ---------- 計算（伺服器做唯一真相，修好 v2.26 嘅計錯數） ----------
// 本金 = DEPOSIT 總和（唔係買貨成本）。總盈虧 = 總資產 − 本金。
// 合夥人「實際存入」= DEPOSIT 總和（唔係淨結餘）。持股比例 = 實際存入 ÷ 總本金。
// 盈虧分佈 = 持股比例 × 總盈虧。
function computeState() {
  const txs = db.prepare("SELECT * FROM transactions ORDER BY date ASC, created_at ASC").all();
  const partners = db.prepare("SELECT * FROM partners ORDER BY sort ASC").all();
  const stocks = db.prepare("SELECT * FROM stocks").all();
  const prices = Object.fromEntries(stocks.map((s) => [s.code, s.price || 0]));
  const monthlyDeposit = parseFloat(getSetting("monthlyDeposit", "500")) || 0;
  const startDate = getSetting("startDate", "2018-03-01") || "2018-03-01";

  let cash = 0, principal = 0, totalDividend = 0, totalInterest = 0;
  let buyCost = 0, buyQty = 0, buyFees = 0, feeRows = 0, sellProceeds = 0;
  const holdings = {}, bought = {};
  const deposits = {};
  partners.forEach((p) => { deposits[p.key] = 0; });
  for (const tx of txs) {
    const amt = tx.amount || 0, fee = tx.fee || 0;
    if (tx.action === "DEPOSIT") { cash += amt; principal += amt; deposits[tx.partner] = (deposits[tx.partner] || 0) + amt; }
    else if (tx.action === "INTEREST") { cash += amt; totalInterest += amt; }
    else if (tx.action === "DIVIDEND") { cash += amt; totalDividend += amt; }
    else if (tx.action === "BUY") { cash -= tx.price * tx.qty + fee; buyCost += tx.price * tx.qty; buyQty += tx.qty; buyFees += fee; holdings[tx.code] = (holdings[tx.code] || 0) + tx.qty; bought[tx.code] = (bought[tx.code] || 0) + tx.qty; }
    else if (tx.action === "SELL") { cash += tx.price * tx.qty - fee; sellProceeds += tx.price * tx.qty; buyFees += fee; holdings[tx.code] = (holdings[tx.code] || 0) - tx.qty; }
    else if (tx.action === "FEE") { cash -= amt; feeRows += amt; }
    else if (tx.action === "RED_STOCK") { holdings[tx.code] = (holdings[tx.code] || 0) + tx.qty; }
  }
  const holdingRows = Object.keys(holdings).filter((c) => holdings[c] !== 0).map((code) => {
    const shares = holdings[code];
    const avgCost = bought[code] ? buyCostFor(code, txs) / bought[code] : 0;
    const price = prices[code] || 0;
    const stock = stocks.find((s) => s.code === code) || {};
    return { code, shares, avgCost, price, value: shares * price, unrealised: shares * price - shares * avgCost, prevClose: stock.prev_close || 0, changePct: stock.change_pct || 0, updatedAt: stock.updated_at || "" };
  });
  function buyCostFor(code, all) {
    return all.filter((t) => t.code === code && t.action === "BUY").reduce((s, t) => s + t.price * t.qty, 0);
  }
  const stockValue = holdingRows.reduce((s, r) => s + r.value, 0);
  const totalAssets = cash + stockValue;
  const totalProfit = totalAssets - principal;
  const years = Math.max(0, (new Date() - new Date(startDate + "T00:00:00")) / (365.25 * 86400000));
  const totalReturnPct = principal > 0 ? (totalProfit / principal) * 100 : 0;
  const cagrPct = principal > 0 && years > 0 && totalAssets > 0 ? (Math.pow(totalAssets / principal, 1 / years) - 1) * 100 : 0;

  const start = new Date(startDate + "T00:00:00");
  const now = new Date();
  const months = Math.max(0, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()));
  const expectedPerPartner = monthlyDeposit * months;
  const partnerRows = partners.map((p) => {
    const actual = deposits[p.key] || 0;
    const sharePct = principal > 0 ? (actual / principal) * 100 : 0;
    return { key: p.key, name: p.name || p.key, expected: expectedPerPartner, actual, diff: actual - expectedPerPartner, sharePct, pnlShare: (totalProfit * sharePct) / 100 };
  });
  // ---------- 監察（高息股資料為主） ----------
  // 買賣建議公式（同 Muse 版 v3.2.0 一致，只供參考，唔係投資建議）：
  // 52 週位置 = (現價 − 52 週低) ÷ (52 週高 − 52 週低) × 100%，夾在 0–100%
  // 息率 = 每股股息 ÷ 現價 × 100%；每股股息優先次序：手動輸入 → 帳目近 12 個月股息 ÷ 現持股數 → 報價渠道
  // 判斷次序：現價 ≤0 → 未有判斷；位置 ≥85% → 持有就減持、未持有就觀望；
  // 息率 ≥5% 且（無 52 週數據或位置 ≤50%）→ 買入；息率 <3% 且位置 ≥70% → 觀望；
  // 其餘有持股 → 持有，無持股 → 觀望。
  // 注意：位置標籤 ≥80% 已叫「高位」，但訊號要 ≥85% 先觸發，兩者門檻唔同。
  const maxTxDate = txs.reduce((m, t) => (t.date > m ? t.date : m), "2018-03-01");
  // 帳目近 12 個月：以帳目最新日期為準（唔係今日，因為 CSV 入面有 2026-12-02 嗰筆），
  // 咁 00003.HK 計出嚟係 (6831.40 + 3552.12) ÷ 29851 = 0.3478，同 Muse 版一致。
  const oneYearAgo = new Date(new Date(maxTxDate + "T00:00:00").getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const monitor = stocks.map((s) => {
    const price = s.price || 0;
    const held = (holdings[s.code] || 0) > 0;
    let dps = null, dpsSource = "";
    if (s.dps && s.dps > 0) { dps = s.dps; dpsSource = "手動輸入"; }
    else {
      const div12 = txs.filter((t) => t.code === s.code && t.action === "DIVIDEND" && t.date >= oneYearAgo).reduce((sum, t) => sum + (t.amount || 0), 0);
      const shares = holdings[s.code] || 0;
      if (div12 > 0 && shares > 0) { dps = div12 / shares; dpsSource = "帳目近 12 個月估算"; }
      else if (s.quote_dps > 0) { dps = s.quote_dps; dpsSource = "報價渠道"; }
    }
    const yieldPct = dps && price > 0 ? (dps / price) * 100 : (s.quote_yield > 0 ? s.quote_yield : null);
    const high52 = s.high52 || 0, low52 = s.low52 || 0;
    const positionPct = price > 0 && high52 > low52 ? Math.max(0, Math.min(100, ((price - low52) / (high52 - low52)) * 100)) : null;
    const positionLabel = positionPct === null ? "未有 52 週數據" : positionPct >= 80 ? "高位" : positionPct >= 60 ? "偏高" : positionPct >= 40 ? "中位" : positionPct >= 20 ? "偏低" : "低位";
    let signal = "watch", signalLabel = "觀望", signalText = "未有明顯訊號：繼續觀望";
    if (price <= 0) { signal = "none"; signalLabel = "未有判斷"; signalText = "未有報價，未能判斷"; }
    else if (positionPct !== null && positionPct >= 85) {
      if (held) { signal = "reduce"; signalLabel = "減持"; signalText = "已處高位：可考慮減持鎖定利潤"; }
      else { signal = "watch"; signalLabel = "觀望"; signalText = "已處高位：唔追買，繼續觀望"; }
    } else if (yieldPct !== null && yieldPct >= 5 && (positionPct === null || positionPct <= 50)) {
      signal = "buy"; signalLabel = "買入";
      signalText = held ? "息率高、位置未算高：可考慮加注收息" : "息率高、位置未算高：可分批買入收息";
    } else if (yieldPct !== null && yieldPct < 3 && positionPct !== null && positionPct >= 70) {
      signal = "watch"; signalLabel = "觀望"; signalText = "息率偏低又近高位：繼續觀望";
    } else if (held) { signal = "hold"; signalLabel = "持有"; signalText = "未有明顯訊號：繼續持有收息"; }
    return { code: s.code, price, prevClose: s.prev_close || 0, changePct: s.change_pct || 0, updatedAt: s.updated_at || "", held, dps, dpsSource, yieldPct, high52, low52, positionPct, positionLabel, signal, signalLabel, signalText };
  });
  return {
    cash, principal, totalAssets, totalProfit, totalDividend, totalInterest,
    buyCost, buyQty, buyFees, feeRows, sellProceeds, stockValue,
    holdings: holdingRows, partners: partnerRows, monitor,
    months, monthlyDeposit, startDate, years, totalReturnPct, cagrPct,
    txCount: txs.length,
  };
}

// ---------- 自動更新股價（Yahoo Finance，唔使手動輸入） ----------
// 來源：query1 / query2.finance.yahoo.com/v8/finance/chart/<代號>，免 API key。
// 港股代號要加 .HK，例如 0003.HK、0700.HK。Yahoo 報價有約 15 分鐘延遲，收市後係收市價。
// Yahoo 港股代號係 4 位（0003.HK），但你個 CSV 用 5 位（00003.HK），要轉返先攞到價。
function yahooSymbol(code) {
  const s = String(code || "").trim().toUpperCase();
  const m = s.match(/^0*(\d{1,4})\.HK$/);
  if (m) return m[1].padStart(4, "0") + ".HK";
  return s;
}
async function fetchQuoteV7(code) {
  // Yahoo v7：攞 52 週高低同股息（唔攞價，價錢行騰訊），每隻股一日最多攞一次 52 週
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const res = await fetch(`https://${host}/v7/finance/quote?symbols=${encodeURIComponent(yahooSymbol(code))}`, {
        headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const q = (await res.json())?.quoteResponse?.result?.[0];
      if (!q) continue;
      return {
        price: Number(q.regularMarketPrice || 0),
        prevClose: Number(q.regularMarketPreviousClose || 0),
        changePct: Number(q.regularMarketChangePercent || 0),
        high52: Number(q.fiftyTwoWeekHigh || 0),
        low52: Number(q.fiftyTwoWeekLow || 0),
        quoteDps: Number(q.dividendRate || q.trailingAnnualDividendRate || 0),
        quoteYield: Number(q.dividendYield || q.trailingAnnualDividendYield || 0),
      };
    } catch (e) { /* 試下一個 */ }
  }
  return null;
}
async function fetchQuoteTencent(code) {
  // 港股先用騰訊報價（qt.gtimg.cn，免 key，唔似 Yahoo 咁易限速）
  // 格式：v_hk00003="...~名稱~00003~現價~上一收~今開~成交量~..."
  const digits = String(code || "").toUpperCase().replace(/\.HK$/, "").replace(/^0+/, "").padStart(5, "0");
  if (!digits) return null;
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=hk${digits}`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/="([^"]*)"/);
    if (!m) return null;
    const parts = m[1].split("~");
    const price = parseFloat(parts[3]), prev = parseFloat(parts[4]);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price, prevClose: Number.isFinite(prev) ? prev : 0, changePct: prev > 0 ? ((price - prev) / prev) * 100 : 0 };
  } catch (e) { return null; }
}
async function fetchQuote(code) {
  // 價錢：騰訊先，唔得先 Yahoo v7；52 週＋股息：Yahoo v7（失敗就留返舊數，唔會清零）
  const upper = code.toUpperCase();
  const t = await fetchQuoteTencent(code);
  const y = await fetchQuoteV7(code);
  const price = t?.price || y?.price || 0;
  if (!price) return { code: upper, ok: false, error: "騰訊同 Yahoo 都攞唔到價" };
  const prev = t?.prevClose || y?.prevClose || 0;
  const pct = prev > 0 ? ((price - prev) / prev) * 100 : (y?.changePct || 0);
  return { code: upper, price, prevClose: prev, changePct: pct, high52: y?.high52 || 0, low52: y?.low52 || 0, quoteDps: y?.quoteDps || 0, quoteYield: y?.quoteYield || 0, currency: "HKD" };
}
async function refreshPrices() {
  const rows = db.prepare("SELECT * FROM stocks ORDER BY code").all();
  const results = [];
  const now = new Date().toISOString();
  for (const s of rows) {
    const q = await fetchQuote(s.code);
    if (q.price) {
      // 52 週／股息只喺 Yahoo 攞到新數嗰陣先更新，攞唔到就留返舊數
      const high52 = q.high52 > 0 ? q.high52 : s.high52;
      const low52 = q.low52 > 0 ? q.low52 : s.low52;
      const quoteDps = q.quoteDps > 0 ? q.quoteDps : s.quote_dps;
      const quoteYield = q.quoteYield > 0 ? q.quoteYield : s.quote_yield;
      db.prepare("UPDATE stocks SET price = ?, prev_close = ?, change_pct = ?, updated_at = ?, high52 = ?, low52 = ?, quote_dps = ?, quote_yield = ? WHERE code = ?")
        .run(q.price, q.prevClose, q.changePct, now, high52, low52, quoteDps, quoteYield, s.code);
      results.push({ ...q, ok: true, updatedAt: now });
    } else {
      results.push({ ...q, ok: false });
    }
    await new Promise((r) => setTimeout(r, 500)); // 隔開少少，免限速
  }
  return results;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.get("/api/health", (req, res) => res.json({ ok: true, app: "partnership-account-standalone", version: VERSION }));
app.get("/health", (req, res) => res.json({ ok: true, app: "partnership-account-standalone", version: VERSION }));

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  if (req.headers["x-admin-password"] === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: "需要管理密碼（X-Admin-Password）" });
}
app.use("/api", (req, res, next) => (req.path === "/health" ? next() : requireAdmin(req, res, next)));

app.get("/api/state", (req, res) => {
  const s = computeState();
  res.json({ version: VERSION, ...s, stocks: db.prepare("SELECT * FROM stocks ORDER BY code").all(), settings: { monthlyDeposit: parseFloat(getSetting("monthlyDeposit", "500")), startDate: getSetting("startDate", "2018-03-01") } });
});
app.get("/api/transactions", (req, res) => {
  const { action, partner, code, limit = 500, offset = 0 } = req.query;
  const where = [], args = [];
  if (action) { where.push("action = ?"); args.push(action); }
  if (partner) { where.push("partner = ?"); args.push(partner); }
  if (code) { where.push("code = ?"); args.push(code); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = db.prepare(`SELECT * FROM transactions ${w} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`).all(...args, Number(limit), Number(offset));
  const total = db.prepare(`SELECT COUNT(*) AS c FROM transactions ${w}`).get(...args).c;
  res.json({ total, rows });
});
function validTxBody(b) {
  if (!b || !b.date || !VALID_ACTIONS.includes((b.action || "").toUpperCase())) return "日期或動作無效";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return "日期格式要 YYYY-MM-DD";
  return null;
}
app.post("/api/transactions", (req, res) => {
  const err = validTxBody(req.body);
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const price = parseFloat(b.price) || 0, qty = parseFloat(b.qty) || 0, fee = parseFloat(b.fee) || 0;
  let amount = parseFloat(b.amount);
  if (!Number.isFinite(amount)) {
    if (b.action === "BUY" || b.action === "SELL") amount = price * qty;
    else if (b.action === "DEPOSIT" || b.action === "INTEREST") amount = price;
    else if (b.action === "DIVIDEND") amount = qty > 0 ? price * qty : price;
    else if (b.action === "FEE") amount = fee;
    else amount = 0;
  }
  const t = { id: makeId(), date: b.date, code: (b.code || "CASH").toUpperCase(), currency: (b.currency || "HKD").toUpperCase(), action: b.action.toUpperCase(), price, qty, fee, amount, partner: (b.partner || "NONE").toUpperCase(), note: b.note || "" };
  insertTx(t);
  if (t.code !== "CASH" && t.code !== "MANUAL") db.prepare("INSERT OR IGNORE INTO stocks(code, price) VALUES(?, 0)").run(t.code);
  res.json({ ok: true, tx: t });
});
app.put("/api/transactions/:id", (req, res) => {
  const err = validTxBody(req.body);
  if (err) return res.status(400).json({ error: err });
  const old = db.prepare("SELECT * FROM transactions WHERE id = ?").get(req.params.id);
  if (!old) return res.status(404).json({ error: "搵唔到呢筆交易" });
  const b = req.body;
  const price = parseFloat(b.price) || 0, qty = parseFloat(b.qty) || 0, fee = parseFloat(b.fee) || 0;
  let amount = parseFloat(b.amount);
  if (!Number.isFinite(amount)) amount = b.action === "BUY" || b.action === "SELL" ? price * qty : b.action === "FEE" ? fee : price;
  db.prepare("UPDATE transactions SET date=?, code=?, currency=?, action=?, price=?, qty=?, fee=?, amount=?, partner=?, note=? WHERE id=?")
    .run(b.date, (b.code || "CASH").toUpperCase(), (b.currency || "HKD").toUpperCase(), b.action.toUpperCase(), price, qty, fee, amount, (b.partner || "NONE").toUpperCase(), b.note || "", req.params.id);
  res.json({ ok: true });
});
app.delete("/api/transactions/:id", (req, res) => {
  db.prepare("DELETE FROM transactions WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/transactions/delete-many", (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  let n = 0;
  for (const id of ids) n += db.prepare("DELETE FROM transactions WHERE id = ?").run(id).changes;
  res.json({ ok: true, deleted: n });
});
app.post("/api/import/csv", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "請上傳 CSV 檔案" });
  const { encoding, imported, skipped, errors } = parseCsvBuffer(req.file.buffer);
  let added = 0, duplicates = 0;
  const seen = new Set(db.prepare("SELECT date, code, action, price, qty, fee, partner, note FROM transactions").all().map(txKey));
  for (const t of imported) {
    if (seen.has(txKey(t))) { duplicates++; continue; }
    if (insertTx(t)) { added++; seen.add(txKey(t)); }
    if (t.code !== "CASH" && t.code !== "MANUAL") db.prepare("INSERT OR IGNORE INTO stocks(code, price) VALUES(?, 0)").run(t.code);
  }
  res.json({ ok: true, encoding, imported: added, duplicates, skipped, errors: errors.slice(0, 20) });
});
app.get("/api/export/csv", (req, res) => {
  const rows = db.prepare("SELECT * FROM transactions ORDER BY date ASC").all();
  const head = "Date,Code,Currency,Price,Quantity,Action,FEE,Partner,Note";
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const body = rows.map((r) => [r.date, r.code, r.currency, r.price, r.qty, r.action, r.fee, r.partner, r.note].map(esc).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="partnership-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("\uFEFF" + head + "\r\n" + body);
});
app.get("/api/backup", (req, res) => {
  res.json({ version: VERSION, exportedAt: new Date().toISOString(), settings: { monthlyDeposit: getSetting("monthlyDeposit", "500"), startDate: getSetting("startDate", "2018-03-01") }, partners: db.prepare("SELECT * FROM partners ORDER BY sort").all(), stocks: db.prepare("SELECT * FROM stocks").all(), transactions: db.prepare("SELECT * FROM transactions ORDER BY date ASC").all() });
});
app.post("/api/backup/restore", (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.transactions)) return res.status(400).json({ error: "備份檔格式錯誤：冇 transactions" });
  let added = 0, duplicates = 0;
  const seen = new Set(db.prepare("SELECT date, code, action, price, qty, fee, partner, note FROM transactions").all().map(txKey));
  for (const t of b.transactions) {
    if (!t.date || !VALID_ACTIONS.includes((t.action || "").toUpperCase())) continue;
    const tx = { id: t.id || makeId(), date: t.date, code: (t.code || "CASH").toUpperCase(), currency: t.currency || "HKD", action: t.action.toUpperCase(), price: t.price || 0, qty: t.qty || 0, fee: t.fee || 0, amount: t.amount || 0, partner: (t.partner || "NONE").toUpperCase(), note: t.note || "" };
    if (seen.has(txKey(tx))) { duplicates++; continue; }
    if (insertTx(tx)) { added++; seen.add(txKey(tx)); }
  }
  if (b.settings) { if (b.settings.monthlyDeposit) setSetting("monthlyDeposit", b.settings.monthlyDeposit); if (b.settings.startDate) setSetting("startDate", b.settings.startDate); }
  res.json({ ok: true, imported: added, duplicates });
});
app.post("/api/prices", (req, res) => {
  const prices = req.body.prices || req.body;
  let updated = 0;
  for (const [code, price] of Object.entries(prices)) {
    const p = parseFloat(price);
    if (!code || !Number.isFinite(p)) continue;
    db.prepare("INSERT INTO stocks(code, price) VALUES(?, ?) ON CONFLICT(code) DO UPDATE SET price = excluded.price").run(code.toUpperCase(), p);
    updated++;
  }
  res.json({ ok: true, updated });
});
// 自動更新全部股票股價（Yahoo），監察股票同持股一齊更新
app.post("/api/prices/refresh", async (req, res) => {
  const results = await refreshPrices();
  const ok = results.filter((r) => r.ok).length;
  res.json({ ok: ok > 0, updated: ok, total: results.length, results });
});
app.get("/api/partners", (req, res) => res.json(db.prepare("SELECT * FROM partners ORDER BY sort").all()));
app.post("/api/partners", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "請輸入合夥人名稱" });
  const key = (req.body.key || name.charAt(0).toUpperCase()).toUpperCase();
  const max = db.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM partners").get().m;
  db.prepare("INSERT INTO partners(key, name, sort) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name").run(key, name, max + 1);
  res.json({ ok: true, key });
});
app.put("/api/partners/:key", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "請輸入新名稱" });
  db.prepare("UPDATE partners SET name = ? WHERE key = ?").run(name, req.params.key.toUpperCase());
  res.json({ ok: true });
});
app.delete("/api/partners/:key", (req, res) => {
  const n = db.prepare("SELECT COUNT(*) AS c FROM partners").get().c;
  if (n <= 1) return res.status(400).json({ error: "至少要留一位合夥人" });
  db.prepare("DELETE FROM partners WHERE key = ?").run(req.params.key.toUpperCase());
  res.json({ ok: true });
});
app.post("/api/stocks", (req, res) => {
  const code = (req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "請輸入股票代號" });
  db.prepare("INSERT OR IGNORE INTO stocks(code, price) VALUES(?, 0)").run(code);
  res.json({ ok: true });
});
app.put("/api/stocks/:code", (req, res) => {
  // 手動設定每股股息（dps，傳 null 清除）同 52 週高低
  const code = req.params.code.toUpperCase();
  const b = req.body || {};
  if (b.dps !== undefined) db.prepare("UPDATE stocks SET dps = ? WHERE code = ?").run(b.dps === null ? null : parseFloat(b.dps) || 0, code);
  if (b.high52 !== undefined) db.prepare("UPDATE stocks SET high52 = ? WHERE code = ?").run(parseFloat(b.high52) || 0, code);
  if (b.low52 !== undefined) db.prepare("UPDATE stocks SET low52 = ? WHERE code = ?").run(parseFloat(b.low52) || 0, code);
  res.json({ ok: true });
});
app.delete("/api/stocks/:code", (req, res) => {
  db.prepare("DELETE FROM stocks WHERE code = ?").run(req.params.code.toUpperCase());
  res.json({ ok: true });
});
app.post("/api/settings", (req, res) => {
  if (req.body.monthlyDeposit !== undefined) setSetting("monthlyDeposit", req.body.monthlyDeposit);
  if (req.body.startDate) setSetting("startDate", req.body.startDate);
  res.json({ ok: true });
});
app.post("/api/reset", (req, res) => {
  db.prepare("DELETE FROM transactions").run();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`投資合伙戶口管理系統 v${VERSION} 運行中：http://localhost:${PORT}（資料庫 data/partnership.db）`);
  // 啟動嗰陣自動更新一次股價，之後每 30 分鐘更新一次（唔使手動輸入）
  refreshPrices().then((r) => console.log("股價自動更新：" + r.filter((x) => x.ok).length + "/" + r.length + " 隻成功")).catch((e) => console.warn("股價自動更新失敗：" + e.message));
  setInterval(() => { refreshPrices().catch(() => {}); }, 30 * 60 * 1000).unref();
});
