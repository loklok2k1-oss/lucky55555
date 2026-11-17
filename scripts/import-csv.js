// CSV 解析：共用，server.js 同 scripts/seed.js 都用佢。
// 接受兩種欄位順序（按欄名，唔按位置）：
//   A) Date,Code,Currency,Price,Quantity,Action,FEE,Partner,Note  （你 2026-11-02 嗰個檔）
//   B) Date,Code,Action,Price,Quantity,FEE,Currency,Note,Partner  （v2.26 範本）
// 日期接受 DD-MM-YYYY、YYYY-MM-DD、DD/MM/YYYY。
// 金額按動作計（呢個係 v2.26 錯得最多嘅地方，呢度一次過講清楚）：
//   DEPOSIT / INTEREST：金額 = Price 欄
//   DIVIDEND：Quantity > 0 就 Price × Quantity，否則 = Price 欄（你個檔係後者，總股息就係 Price）
//   BUY / SELL：金額 = Price × Quantity，手費 = FEE 欄
//   FEE：金額 = FEE 欄（Price 欄係 0，唔可以用 Price）
//   RED_STOCK：金額 0，股數 += Quantity
"use strict";
const iconv = require("iconv-lite");

const VALID_ACTIONS = ["BUY", "SELL", "DIVIDEND", "RED_STOCK", "INTEREST", "DEPOSIT", "FEE"];

function decodeBuffer(buf) {
  // 先試 UTF-8（嚴格，見到 replacement 字元即係唔啱），再試 Big5，最後 GBK。
  // 你嗰個檔實測：UTF-8 有 565 個 replacement、Big5 有 206 個、GBK 0 個，所以係 GBK。
  let text = buf.toString("utf8");
  if (!text.includes("\uFFFD")) return { text, encoding: "UTF-8" };
  const cands = [];
  for (const enc of ["big5", "gbk"]) {
    const t = iconv.decode(buf, enc);
    cands.push({ text: t, encoding: enc.toUpperCase(), bad: (t.match(/\uFFFD/g) || []).length });
  }
  cands.sort((a, b) => a.bad - b.bad);
  return cands[0];
}

function splitCsvLine(line) {
  // 支援引號內有逗號，例如備註 "買入，含手續費"
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normDate(raw) {
  const d = (raw || "").trim();
  if (!d) return null;
  let m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = d.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = d.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function normAction(raw) {
  let a = (raw || "").trim().toUpperCase().replace(/\s+/g, "_");
  if (a === "RED_STOCK") return a;
  return a;
}

function rowToTx(row) {
  const date = normDate(row.Date);
  if (!date) return { error: "缺少或無效日期" };
  const action = normAction(row.Action);
  if (!VALID_ACTIONS.includes(action)) return { error: `動作無效："${row.Action}"` };
  const code = (row.Code || "CASH").trim().toUpperCase() || "CASH";
  const currency = (row.Currency || "HKD").trim().toUpperCase() || "HKD";
  const price = parseFloat(row.Price) || 0;
  const qty = parseFloat(row.Quantity) || 0;
  const fee = parseFloat(row.FEE) || 0;
  const partner = (row.Partner || "NONE").trim().toUpperCase() || "NONE";
  const note = (row.Note || "").trim();
  let amount = 0;
  if (action === "BUY" || action === "SELL") amount = price * qty;
  else if (action === "DEPOSIT" || action === "INTEREST") amount = price;
  else if (action === "DIVIDEND") amount = qty > 0 ? price * qty : price;
  else if (action === "FEE") amount = fee;
  else if (action === "RED_STOCK") amount = 0;
  return { tx: { date, code, currency, action, price, qty, fee, amount, partner, note } };
}

// 輸入：Buffer（檔案內容）。輸出：{ encoding, imported: [tx...], skipped, errors: [字串] }
function parseCsvBuffer(buf) {
  const { text, encoding } = decodeBuffer(buf);
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { encoding, imported: [], skipped: 0, errors: ["CSV 檔案格式錯誤：少於兩行"] };
  const header = splitCsvLine(lines[0]).map((h) => h.replace(/\uFEFF/g, "").trim());
  const missing = ["Date", "Code", "Action"].filter((c) => !header.includes(c));
  if (missing.length) return { encoding, imported: [], skipped: 0, errors: [`CSV 缺少欄位：${missing.join(", ")}`] };
  const imported = [];
  const errors = [];
  let skipped = 0;
  lines.slice(1).forEach((line, idx) => {
    const rowNum = idx + 2;
    const cols = splitCsvLine(line);
    if (cols.length < 3) { skipped++; return; }
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] || ""; });
    const r = rowToTx(row);
    if (r.error) { errors.push(`第 ${rowNum} 行：${r.error}`); skipped++; return; }
    imported.push(r.tx);
  });
  return { encoding, imported, skipped, errors };
}

module.exports = { parseCsvBuffer, rowToTx, VALID_ACTIONS, decodeBuffer };
