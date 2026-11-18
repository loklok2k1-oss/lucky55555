// 投資合伙戶口管理系統 v3.2.2 — 前端
// 所有數字由伺服器 /api/state 計好返嚟，呢度只負責顯示，唔再喺瀏覽器計本金盈虧。
"use strict";
let PW = sessionStorage.getItem("pw") || "";
let state = null, txs = [], editingTxId = null;
const selectedTxIds = new Set();
const $ = (id) => document.getElementById(id);
// 公式一鍵隱藏：預設收起（localStorage 記住選擇，下次開返都係同一個狀態）
let showFormula = localStorage.getItem("partnership-show-formula") === "1";
function applyFormulaVisibility() {
  const tab = $("tab-monitor");
  if (tab) tab.classList.toggle("hide-formula", !showFormula);
  const btn = $("formulaToggleBtn");
  if (btn) btn.textContent = showFormula ? "隱藏公式" : "顯示公式";
}
function toggleFormula() {
  showFormula = !showFormula;
  localStorage.setItem("partnership-show-formula", showFormula ? "1" : "0");
  applyFormulaVisibility();
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "X-Admin-Password": PW, ...(opts.headers || {}) } });
  if (res.status === 401) { logout(); throw new Error("密碼唔啱"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("請求失敗：" + res.status));
  return data;
}
function fmtMoney(v) { return "HK$ " + (parseFloat(v || 0)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function showAlert(msg, type) {
  const el = $("alert"); el.textContent = msg; el.className = "alert " + (type || "success"); el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 6000);
}
async function doLogin() {
  PW = $("loginPw").value;
  try {
    await api("/api/state");
    sessionStorage.setItem("pw", PW);
    $("loginBox").style.display = "none"; $("app").style.display = "block";
    $("txDate").value = new Date().toISOString().slice(0, 10);
    await refresh();
  } catch (e) { $("loginErr").textContent = "登入失敗：管理密碼唔啱。預設係 partnership-2026，請檢查 config.json。"; }
}
function logout() { sessionStorage.removeItem("pw"); PW = ""; location.reload(); }
$("loginPw").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
  $("tab-" + btn.dataset.tab).classList.add("active"); btn.classList.add("active");
}));

async function refresh() {
  state = await api("/api/state");
  $("cBal").textContent = fmtMoney(state.cash);
  $("sVal").textContent = fmtMoney(state.stockValue);
  $("tAst").textContent = fmtMoney(state.totalAssets);
  $("tPri").textContent = fmtMoney(state.principal);
  const pnl = $("tPnl"); pnl.textContent = fmtMoney(state.totalProfit); pnl.className = "val " + (state.totalProfit >= 0 ? "pos" : "neg");
  $("tDiv").textContent = fmtMoney(state.totalDividend);
  $("tRet").textContent = state.totalReturnPct.toFixed(2) + "%";
  $("tCagr").textContent = state.cagrPct.toFixed(2) + "%";
  $("partnerBalanceTableBody").innerHTML = state.partners.map((p) =>
    `<tr><td><strong>${p.name}</strong> (${p.key})</td><td class="amt">${fmtMoney(p.expected)}</td><td class="amt">${fmtMoney(p.actual)}</td><td class="amt ${p.diff >= 0 ? "pos" : "neg"}">${fmtMoney(p.diff)}</td><td class="amt">${fmtMoney(p.pnlShare)}</td><td>${p.sharePct.toFixed(2)}%</td></tr>`).join("");
  $("holdingBody").innerHTML = state.holdings.length ? state.holdings.map((h) =>
    `<tr><td><strong>${h.code}</strong></td><td class="amt">${h.shares.toLocaleString()}</td><td class="amt">HK$ ${h.avgCost.toFixed(4)}</td><td class="amt">HK$ ${h.price.toFixed(2)}</td><td class="amt ${h.changePct >= 0 ? "pos" : "neg"}">${h.changePct >= 0 ? "+" : ""}${h.changePct.toFixed(2)}%</td><td class="amt">${fmtMoney(h.value)}</td><td class="amt ${h.unrealised >= 0 ? "pos" : "neg"}">${fmtMoney(h.unrealised)}</td></tr>`).join("")
    : `<tr><td colspan="7">暫時冇持股（請先匯入 CSV 或新增 BUY 交易）</td></tr>`;
  const latest = state.stocks.map((s) => s.updated_at).filter(Boolean).sort().pop();
  const updTxt = latest ? "上次更新：" + new Date(latest).toLocaleString("zh-HK", { hour12: false }) : "未更新過";
  document.querySelectorAll(".price-updated-at").forEach((el) => { el.textContent = updTxt; });
  // 購買股票結餘 = 現金結餘 − 合夥人差額總和（由實時數據計，唔寫死），連算式同每人分項一齊顯示
  const bb = state.buyBalance;
  $("buyBalanceBox").innerHTML = bb
    ? `<div style="font-size:15px"><strong>購買股票結餘：${fmtMoney(bb.balance)}</strong></div>
      <div style="font-size:13px;color:#374151">現金結餘 ${fmtMoney(bb.cash)} − 合夥人差額總和 ${fmtMoney(bb.totalDiff)}</div>
      <div style="font-size:12px;color:#6b7280">${bb.items.map((i) => `${i.name} ${i.diff >= 0 ? "+" : ""}${fmtMoney(i.diff)}`).join("　")}</div>`
    : "";
  const sigColor = { buy: "#059669", hold: "#2563eb", reduce: "#dc2626", watch: "#6b7280", none: "#6b7280" };
  $("monitorCards").innerHTML = (state.monitor || []).length ? state.monitor.map((m) => `
    <div class="card" style="text-align:left;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <strong style="font-size:16px">${m.code}</strong><span>${m.held ? "持倉" : "監察"}</span>
        <span style="background:${sigColor[m.signal] || "#6b7280"};color:#fff;padding:2px 10px;border-radius:12px;font-size:13px">${m.signalLabel}</span>
      </div>
      <div style="font-size:13px;margin-top:8px">現價 HK$ ${m.price.toFixed(2)}（${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(2)}%）　上一收 HK$ ${m.prevClose.toFixed(2)}</div>
      <div style="font-size:13px">每股股息 ${m.dps !== null ? "HK$ " + m.dps.toFixed(4) + "（" + m.dpsSource + "）" : "—"}　息率 ${m.yieldPct !== null ? m.yieldPct.toFixed(2) + "%" : "—"}</div>
      <div style="font-size:13px">趨勢：<strong>${m.trendLabel || "未有趨勢數據"}</strong><span class="formula-detail">　MA20 ${m.ma20 ? m.ma20.toFixed(2) : "—"}　MA50 ${m.ma50 ? m.ma50.toFixed(2) : "—"}</span></div>
      <div class="formula-detail" style="font-size:13px">每手 ${m.lotSize.toLocaleString()} 股，一手 ${fmtMoney(m.lotValue)}（現價 HK$ ${m.price.toFixed(2)} × ${m.lotSize.toLocaleString()} 股，唔計手續費）${m.lotSizeManual ? "（手動）" : ""}</div>
      <div style="font-size:13px"><span class="formula-detail">52 週 ${m.high52 > 0 ? "HK$ " + m.low52.toFixed(2) + " – " + m.high52.toFixed(2) + (m.manual52 ? "（手動）" : "") : "未有 52 週數據"}　</span>位置 ${m.positionPct !== null ? m.positionPct.toFixed(1) + "%（" + m.positionLabel + "）" : "—"}</div>
      ${m.positionPct !== null ? `<div style="background:#e5e7eb;border-radius:4px;height:8px;margin:6px 0"><div style="background:${sigColor[m.signal]};width:${m.positionPct}%;height:8px;border-radius:4px"></div></div>` : ""}
      <div style="font-size:13px">${m.signalText}</div>
      <div style="font-size:12px;color:#6b7280">更新：${m.updatedAt ? new Date(m.updatedAt).toLocaleString("zh-HK", { hour12: false }) : "-"}</div>
      <div class="controls" style="margin-top:8px">
        <input type="number" id="lot-${m.code}" placeholder="手動每手股數" step="1" min="1" style="width:150px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px" value="${m.lotSizeManual ? m.lotSize : ""}">
        <button class="btn btn-sm btn-outline" onclick="setLotSize('${m.code}')">設定每手股數</button>
        <button class="btn btn-sm btn-outline" onclick="clearLotSize('${m.code}')">回復預設</button>
      </div>
      <div class="controls" style="margin-top:8px">
        <input type="number" id="dps-${m.code}" placeholder="手動每股股息" step="0.0001" min="0" style="width:150px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px">
        <button class="btn btn-sm btn-outline" onclick="setDps('${m.code}')">設定股息</button>
        <button class="btn btn-sm btn-outline" onclick="clearDps('${m.code}')">清除手動股息</button>
      </div>
      <div class="controls" style="margin-top:8px">
        <input type="number" id="h52-${m.code}" placeholder="手動 52 週高" step="0.0001" min="0" style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px" value="${m.manual52 && m.high52 > 0 ? m.high52 : ""}">
        <input type="number" id="l52-${m.code}" placeholder="手動 52 週低" step="0.0001" min="0" style="width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px" value="${m.manual52 && m.low52 > 0 ? m.low52 : ""}">
        <button class="btn btn-sm btn-outline" onclick="setWeek52('${m.code}')">設定 52 週</button>
        <button class="btn btn-sm btn-outline" onclick="clearWeek52('${m.code}')">清除 52 週</button>
      </div>
    </div>`).join("") : "未有監察股票";
  applyFormulaVisibility();
  $("stockCodesDisplay").textContent = state.stocks.map((s) => s.code).join(", ") || "-";
  $("setMonthly").value = state.settings.monthlyDeposit;
  $("setStart").value = state.settings.startDate;
  const partners = state.partners;
  $("txPartner").innerHTML = `<option value="NONE">NONE（戶口整體）</option>` + partners.map((p) => `<option value="${p.key}">${p.name} (${p.key})</option>`).join("");
  $("filterPartner").innerHTML = `<option value="">全部合夥人</option>` + partners.map((p) => `<option value="${p.key}">${p.name} (${p.key})</option>`).join("");
  $("partnerList").innerHTML = partners.map((p) =>
    `<div class="partner-row"><strong>${p.name}</strong> (${p.key}) <button class="btn btn-sm btn-outline" onclick="renamePartner('${p.key}')">重命名</button> <button class="btn btn-sm btn-danger" onclick="removePartner('${p.key}')">刪除</button></div>`).join("");
  $("stockList").innerHTML = state.stocks.map((s) =>
    `<div class="partner-row"><strong>${s.code}</strong> 價格: HK$ ${(s.price || 0).toFixed(2)} <button class="btn btn-sm btn-danger" onclick="removeStock('${s.code}')">刪除</button></div>`).join("");
  await loadTx();
}
async function setDps(code) {
  const v = parseFloat(document.getElementById("dps-" + code).value);
  if (!Number.isFinite(v) || v <= 0) { showAlert("請輸入每股股息", "error"); return; }
  await api("/api/stocks/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dps: v }) });
  showAlert(code + " 每股股息已設定為 HK$ " + v); await refresh();
}
async function clearDps(code) {
  await api("/api/stocks/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dps: null }) });
  showAlert(code + " 手動股息已清除"); await refresh();
}
async function setLotSize(code) {
  const v = parseInt(document.getElementById("lot-" + code).value, 10);
  if (!Number.isFinite(v) || v <= 0) { showAlert("請輸入每手股數（正整數）", "error"); return; }
  await api("/api/stocks/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lotSize: v }) });
  showAlert(code + " 每手股數已設定為 " + v + " 股"); await refresh();
}
async function clearLotSize(code) {
  await api("/api/stocks/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lotSize: null }) });
  showAlert(code + " 每手股數已回復預設"); await refresh();
}
async function setWeek52(code) {
  const h = parseFloat(document.getElementById("h52-" + code).value);
  const l = parseFloat(document.getElementById("l52-" + code).value);
  if (!Number.isFinite(h) || !Number.isFinite(l) || h <= l || l <= 0) { showAlert("請輸入 52 週高同低，高要大過低", "error"); return; }
  await api("/api/stocks/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ high52: h, low52: l }) });
  showAlert(code + " 52 週已設定為 HK$ " + l.toFixed(2) + " – " + h.toFixed(2) + "（手動，自動更新唔會覆蓋）"); await refresh();
}
async function clearWeek52(code) {
  await api("/api/stocks/" + code, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ high52: 0, low52: 0 }) });
  showAlert(code + " 手動 52 週已清除，恢復自動更新"); await refresh();
}
async function loadTx() {
  const q = new URLSearchParams({ limit: 500 });
  if ($("filterAction").value) q.set("action", $("filterAction").value);
  if ($("filterPartner").value) q.set("partner", $("filterPartner").value);
  const data = await api("/api/transactions?" + q.toString());
  txs = data.rows;
  $("txCount").textContent = data.total + " 筆交易";
  $("txBody").innerHTML = txs.map((tx) =>
    `<tr><td><input type="checkbox" class="txCheckbox" value="${tx.id}" ${selectedTxIds.has(tx.id) ? "checked" : ""} onchange="toggleTxSel(this)"></td><td>${tx.date}</td><td>${tx.code}</td><td>${tx.action}</td><td class="amt">${tx.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td><td class="amt">${fmtMoney(tx.fee)}</td><td class="amt">${fmtMoney(tx.amount)}</td><td>${tx.partner}</td><td>${tx.note || ""}</td><td><button class="btn btn-sm btn-outline" onclick="editTransaction('${tx.id}')">編輯</button> <button class="btn btn-sm btn-danger" onclick="deleteTx('${tx.id}')">刪除</button></td></tr>`).join("");
}
function toggleTxSel(cb) { cb.checked ? selectedTxIds.add(cb.value) : selectedTxIds.delete(cb.value); }
function toggleSelectAll() { const c = $("selectAllCb").checked; document.querySelectorAll(".txCheckbox").forEach((x) => { x.checked = c; c ? selectedTxIds.add(x.value) : selectedTxIds.delete(x.value); }); }
function selectAllTx() { $("selectAllCb").checked = true; document.querySelectorAll(".txCheckbox").forEach((x) => selectedTxIds.add(x.value)); }
async function deleteSelectedTx() {
  if (!selectedTxIds.size) return;
  if (!confirm("確定刪除 " + selectedTxIds.size + " 筆交易嗎？")) return;
  const r = await api("/api/transactions/delete-many", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selectedTxIds] }) });
  selectedTxIds.clear(); $("selectAllCb").checked = false;
  showAlert("已刪除 " + r.deleted + " 筆交易"); await refresh();
}
async function deleteTx(id) { if (!confirm("確定刪除這筆交易嗎？")) return; await api("/api/transactions/" + id, { method: "DELETE" }); showAlert("交易已刪除"); await refresh(); }

function txForm() {
  return { date: $("txDate").value, code: $("txCode").value.trim().toUpperCase() || "CASH", action: $("txAction").value, price: parseFloat($("txPrice").value) || 0, qty: parseFloat($("txQty").value) || 0, fee: parseFloat($("txFee").value) || 0, partner: $("txPartner").value, note: $("txNote").value.trim() };
}
async function saveTransaction() {
  const b = txForm();
  if (!b.date) { showAlert("請選擇日期", "error"); return; }
  try {
    if (editingTxId) { await api("/api/transactions/" + editingTxId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); showAlert("交易已更新"); }
    else { await api("/api/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); showAlert("交易已新增"); }
    cancelEdit(); await refresh();
  } catch (e) { showAlert(e.message, "error"); }
}
function editTransaction(id) {
  const tx = txs.find((t) => t.id === id); if (!tx) return;
  $("txDate").value = tx.date; $("txCode").value = tx.code; $("txAction").value = tx.action;
  $("txPrice").value = tx.price; $("txQty").value = tx.qty; $("txFee").value = tx.fee;
  $("txPartner").value = tx.partner; $("txNote").value = tx.note || "";
  editingTxId = id; $("btnCancelEdit").style.display = "inline-block"; $("btnSaveTx").textContent = "更新交易";
}
function cancelEdit() {
  editingTxId = null; $("txDate").value = new Date().toISOString().slice(0, 10); $("txCode").value = "00003.HK";
  $("txAction").value = "BUY"; $("txPrice").value = ""; $("txQty").value = ""; $("txFee").value = "0"; $("txNote").value = "";
  $("btnCancelEdit").style.display = "none"; $("btnSaveTx").textContent = "新增交易";
}
async function refreshPrices() {
  showAlert("更新緊股價…");
  try {
    const r = await api("/api/prices/refresh", { method: "POST" });
    const failed = r.results.filter((x) => !x.ok).map((x) => x.code).join("、");
    const msg = `股價已更新：${r.updated}/${r.total} 隻成功；52 週數據：${r.week52Ok}/${r.total} 隻成功` + (r.week52Missing && r.week52Missing.length ? `；失敗：${r.week52Missing.join("、")}` : "") + (failed ? `；股價失敗：${failed}` : "") + (r.trendTotal ? `；趨勢：${r.trendOk}/${r.trendTotal} 隻有數據` : "");
    showAlert(msg);
    document.querySelectorAll(".refresh-result").forEach((el) => { el.textContent = msg; });
    await refresh();
  } catch (e) { showAlert("更新股價失敗：" + e.message, "error"); }
}
async function addWatchStock() {
  const code = $("watchCode").value.trim().toUpperCase(); if (!code) return;
  try {
    await api("/api/stocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    $("watchCode").value = "";
    await refreshPrices();
  } catch (e) { showAlert(e.message, "error"); }
}
async function bulkUpdatePrices() {
  const input = $("quickPriceInput").value.trim();
  if (!input) { showAlert("請輸入股票代號與價格，例如 00003.HK:6.5", "error"); return; }
  const prices = {};
  for (const m of input.matchAll(/([A-Za-z0-9.]+)\s*[:,]\s*([\d.]+)/g)) prices[m[1].toUpperCase()] = parseFloat(m[2]);
  if (!Object.keys(prices).length) { showAlert("格式唔啱，請用 00003.HK:6.5", "error"); return; }
  const r = await api("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prices }) });
  showAlert("已更新 " + r.updated + " 隻股票價格"); await refresh();
}
async function addPartner() {
  const name = $("newPartnerName").value.trim(); if (!name) { showAlert("請輸入合夥人名稱", "error"); return; }
  await api("/api/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, key: $("newPartnerKey").value.trim() || undefined }) });
  $("newPartnerName").value = ""; $("newPartnerKey").value = ""; showAlert("合夥人已新增"); await refresh();
}
async function renamePartner(key) {
  const name = prompt("新名稱：", ""); if (name === null || !name.trim()) return;
  await api("/api/partners/" + key, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
  showAlert("合夥人已改名"); await refresh();
}
async function removePartner(key) { if (!confirm("確定刪除合夥人 " + key + " 嗎？佢嘅交易唔會一齊刪走。")) return; await api("/api/partners/" + key, { method: "DELETE" }); showAlert("合夥人已刪除"); await refresh(); }
async function addStock() {
  const code = $("newStockCode").value.trim().toUpperCase(); if (!code) { showAlert("請輸入股票代號", "error"); return; }
  try {
    await api("/api/stocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    $("newStockCode").value = ""; showAlert("股票已新增"); await refresh();
  } catch (e) { showAlert(e.message, "error"); }
}
async function removeStock(code) { await api("/api/stocks/" + code, { method: "DELETE" }); showAlert("股票已刪除"); await refresh(); }
async function saveSettings() {
  await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthlyDeposit: parseFloat($("setMonthly").value) || 0, startDate: $("setStart").value }) });
  showAlert("設定已儲存"); await refresh();
}
async function resetAllData() {
  if (!confirm("確定重置所有交易資料嗎？此操作無法復原，請先匯出 JSON 備份。")) return;
  await api("/api/reset", { method: "POST" }); showAlert("所有交易已重置"); await refresh();
}
function download(url, filename) { const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); }
async function exportJSON() {
  const data = await api("/api/backup");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  download(URL.createObjectURL(blob), "投資戶口備份_" + new Date().toISOString().slice(0, 10) + ".json");
}
async function exportCSV() { const res = await fetch("/api/export/csv", { headers: { "X-Admin-Password": PW } }); const blob = await res.blob(); download(URL.createObjectURL(blob), "partnership-export-" + new Date().toISOString().slice(0, 10) + ".csv"); }
$("jsonFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const data = JSON.parse(await f.text()); const r = await api("/api/backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); showAlert(`JSON 已還原：新增 ${r.imported} 筆，重複 ${r.duplicates} 筆`); await refresh(); }
  catch (err) { showAlert("JSON 還原失敗：" + err.message, "error"); }
  e.target.value = "";
});
$("csvFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try { const r = await api("/api/import/csv", { method: "POST", body: fd }); showAlert(`已匯入 ${r.imported} 筆（編碼 ${r.encoding}），重複 ${r.duplicates} 筆，跳過 ${r.skipped} 筆` + (r.errors.length ? "；錯誤：" + r.errors.slice(0, 3).join("；") : ""), r.errors.length ? "error" : "success"); await refresh(); }
  catch (err) { showAlert("匯入失敗：" + err.message, "error"); }
  e.target.value = "";
});

// 股息計算器（純前端，唔使入資料庫）
function calculateDividend() {
  const shares = parseFloat($("divShares").value) || 0, perShare = parseFloat($("divPerShare").value) || 0;
  const freq = parseInt($("divFrequency").value) || 1, tax = parseFloat($("divTaxRate").value) || 0;
  if (shares <= 0 || perShare <= 0) { showAlert("請輸入持股數同每股股息", "error"); return; }
  const per = shares * perShare, gross = per * freq, t = gross * tax / 100;
  $("resPerPayment").textContent = fmtMoney(per); $("resGross").textContent = fmtMoney(gross);
  $("resNet").textContent = fmtMoney(gross - t); $("resTax").textContent = fmtMoney(t);
  $("dividendResult").style.display = "block";
}
function clearDividend() { $("divShares").value = ""; $("divPerShare").value = ""; $("divTaxRate").value = "0"; $("dividendResult").style.display = "none"; }
function calculateCompoundDividend() {
  // 修正 v2.26 嘅 bug：呢度一定要讀 divShares2 / divPerShare2 / divFrequency2 / divTaxRate2，唔係上面嗰組。
  const init = parseFloat($("divShares2").value) || 0, perShare = parseFloat($("divPerShare2").value) || 0;
  const freq = parseInt($("divFrequency2").value) || 1, tax = parseFloat($("divTaxRate2").value) || 0;
  const years = parseFloat($("compYears").value) || 0, price = parseFloat($("compPrice").value) || 0;
  const reinvest = parseInt($("compReinvest").value) || 0;
  if (init <= 0 || perShare <= 0 || years <= 0) { showAlert("請輸入持股數、每股股息同年數", "error"); return; }
  if (reinvest === 1 && price <= 0) { showAlert("再投資要輸入目前股價", "error"); return; }
  let cur = init, totalGross = 0, totalTax = 0; const rows = [];
  for (let y = 1; y <= years; y++) {
    const start = cur; let yg = 0, yt = 0, yn = 0;
    for (let p = 0; p < freq; p++) {
      const pay = cur * perShare, tx = pay * tax / 100, net = pay - tx;
      yg += pay; yt += tx; yn += net;
      if (reinvest === 1 && price > 0) cur += net / price;
    }
    totalGross += yg; totalTax += yt;
    rows.push({ year: y, start, end: cur, added: cur - start, gross: yg, tax: yt, net: yn });
  }
  const totalNet = totalGross - totalTax;
  const finalValue = cur * price, initialValue = init * price;
  // 再投資嗰陣股息已經變咗股份、計咗入 finalValue，唔可以再加一次；
  // 拎現金嗰陣股息係另外收到嘅現金，要加返。
  const endValue = reinvest === 1 ? finalValue : finalValue + totalNet;
  const totalReturn = initialValue > 0 ? ((endValue - initialValue) / initialValue) * 100 : 0;
  const cagr = initialValue > 0 && years > 0 && endValue > 0 ? (Math.pow(endValue / initialValue, 1 / years) - 1) * 100 : 0;
  $("resCompFinalShares").textContent = cur.toLocaleString(undefined, { maximumFractionDigits: 2 });
  $("resCompGross").textContent = fmtMoney(totalGross); $("resCompNet").textContent = fmtMoney(totalNet);
  $("resCompFinalValue").textContent = fmtMoney(finalValue);
  $("resCompROI").textContent = totalReturn.toFixed(2) + "%"; $("resCompCAGR").textContent = cagr.toFixed(2) + "%";
  $("compoundYearlyBody").innerHTML = rows.map((d) => `<tr><td>${d.year}</td><td class="amt">${d.start.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="amt">${d.end.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="amt">${d.added.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="amt">${fmtMoney(d.gross)}</td><td class="amt">${fmtMoney(d.tax)}</td><td class="amt">${fmtMoney(d.net)}</td></tr>`).join("");
  $("compoundResult").style.display = "block";
}
function clearCompoundDividend() { $("compYears").value = "10"; $("compPrice").value = ""; $("compReinvest").value = "1"; $("compoundResult").style.display = "none"; }

if (PW) doLogin();
