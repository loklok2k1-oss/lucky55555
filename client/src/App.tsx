import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setFailureNoticeText } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import { api, type ApiResponse } from "./api";
import type { Actions } from "../../server/src/actions";

// 表單輸入嘅限制（長度／上下限）直接由 server action 嘅 request schema 派生，
// 頁面同 server 唔會唔一致。
const FIELDS = actionFields<typeof Actions>();

// 冇自己處理錯誤嘅儲存動作失敗嗰陣，底部通知用返中文，唔好出英文預設句。
setFailureNoticeText(() => "操作失敗，請再試一次");

type State = ApiResponse<typeof api, "getState">;
type Tx = ApiResponse<typeof api, "listTransactions">["transactions"][number];
type TxDraft = {
  date: string;
  code: string;
  currency: string;
  action: Tx["action"];
  price: number;
  qty: number;
  fee: number;
  partner: string;
  note: string;
};

const ACTION_LABEL: Record<string, string> = {
  BUY: "買入",
  SELL: "賣出",
  DIVIDEND: "股息",
  RED_STOCK: "紅股",
  INTEREST: "利息",
  DEPOSIT: "存入",
  FEE: "費用",
};
const ACTION_LIST = ["DEPOSIT", "BUY", "SELL", "DIVIDEND", "RED_STOCK", "INTEREST", "FEE"] as const;

function fmt(n: number, digits = 2): string {
  return n.toLocaleString("zh-HK", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtInt(n: number): string {
  return n.toLocaleString("zh-HK", { maximumFractionDigits: 0 });
}
function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmt(n)}%`;
}
function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function fmtTime(ms: number): string {
  if (!ms) return "未更新";
  return new Date(ms).toLocaleString("zh-HK", {
    timeZone: "Asia/Macau",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function partnerLabel(state: State, key: string): string {
  if (key === "NONE") return "—";
  const p = state.partners.find((x) => x.key === key);
  return p ? `${p.key} ${p.name}` : key;
}

// ---------- CSV 解析（跟獨立站 import-csv.js 睇齊） ----------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normDate(raw: string): string | null {
  const d = (raw || "").trim();
  let m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = d.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = d.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function parseCsvText(text: string): { rows: TxDraft[]; errors: string[] } {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [], errors: ["CSV 少於兩行"] };
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.replace(/﻿/g, "").trim());
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    idx[h] = i;
  });
  const missing = ["Date", "Code", "Action"].filter((c) => idx[c] === undefined);
  if (missing.length > 0) return { rows: [], errors: [`CSV 缺少欄位：${missing.join(", ")}`] };
  const rows: TxDraft[] = [];
  const errors: string[] = [];
  lines.slice(1).forEach((line, i) => {
    const cells = splitCsvLine(line);
    const get = (name: string) => cells[idx[name] ?? -1] ?? "";
    const date = normDate(get("Date"));
    const actionRaw = get("Action").trim().toUpperCase().replace(/\s+/g, "_");
    if (!date) {
      errors.push(`第 ${i + 2} 行：日期無效`);
      return;
    }
    if (!ACTION_LIST.includes(actionRaw as (typeof ACTION_LIST)[number])) {
      errors.push(`第 ${i + 2} 行：動作無效「${actionRaw}」`);
      return;
    }
    rows.push({
      date,
      code: (get("Code") || "CASH").toUpperCase(),
      currency: (get("Currency") || "HKD").toUpperCase(),
      action: actionRaw as TxDraft["action"],
      price: parseFloat(get("Price")) || 0,
      qty: parseFloat(get("Quantity")) || 0,
      fee: parseFloat(get("FEE")) || 0,
      partner: (get("Partner") || "NONE").toUpperCase(),
      note: get("Note"),
    });
  });
  return { rows, errors };
}

async function readCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // 先試 UTF-8（有 replacement 字元即唔啱），再試 GBK、Big5（原檔係 GBK）。
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  for (const enc of ["gbk", "big5"]) {
    try {
      const t = new TextDecoder(enc as "gbk").decode(buf);
      if (!t.includes("�")) return t;
    } catch {
      // 瀏覽器唔支援呢個編碼就跳過
    }
  }
  return new TextDecoder("gbk").decode(buf);
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function SectionTitle({ children }: { children: string }) {
  return <h2 className="serif text-lg font-bold text-[var(--text)]">{children}</h2>;
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm text-[var(--dim)]">{label}</span>
      <span className={`num text-base font-medium ${accent ? "text-[var(--accent)]" : "text-[var(--text)]"}`}>
        {value}
      </span>
    </div>
  );
}

// ---------- 總覽 ----------

function Overview({ state }: { state: State }) {
  const queryClient = useQueryClient();
  const [refreshMsg, setRefreshMsg] = useState("");
  const refreshMutation = useMutation({
    mutationFn: () => api.refreshPrices({}),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setRefreshMsg(
        res.failed.length > 0
          ? `已更新 ${res.updated} 隻；攞唔到價：${res.failed.join("、")}（保留上次價錢）`
          : `股價已更新（${res.updated} 隻）`,
      );
    },
    onError: () => setRefreshMsg("更新失敗，請再試"),
  });
  const refreshRef = useRef(refreshMutation);
  refreshRef.current = refreshMutation;
  // 開頁時如果啲價超過 15 分鐘舊（或者從未更新），自動更新一次。
  useEffect(() => {
    if (Date.now() - state.quotesUpdatedAt > 15 * 60 * 1000) {
      refreshRef.current.mutate();
    }
    // 只喺首次載入檢查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const profitColor = state.totalProfit >= 0 ? "text-[var(--accent)]" : "text-[var(--loss)]";
  const noPrice = state.holdings.length > 0 && state.holdings.every((h) => h.price === 0);

  return (
    <section aria-label="總覽" className="mt-5">
      <p className="text-sm text-[var(--dim)]">
        總資產（現金 ＋ 持股市值）· {state.txCount} 筆交易 · 起始 {state.startDate}
      </p>
      <p className={`num mt-1 text-4xl font-bold ${profitColor}`}>
        HK${fmt(state.totalAssets)}
      </p>
      <p className="num mt-1 text-sm text-[var(--dim)]">
        總盈虧 <span className={profitColor}>HK${fmt(state.totalProfit)}（{fmtPct(state.totalReturnPct)}）</span>
        {" · "}年化 {fmtPct(state.cagrPct)}（{fmt(state.years, 1)} 年）
      </p>

      <div className="mt-4 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        <StatRow label="銀行現金" value={`HK$${fmt(state.cash)}`} accent />
        <StatRow label="持股總市值" value={`HK$${fmt(state.stockValue)}`} />
        <StatRow label="投入本金（存入總額）" value={`HK$${fmt(state.principal)}`} />
        <StatRow label="累計股息" value={`HK$${fmt(state.totalDividend)}`} />
        <StatRow label="累計利息" value={`HK$${fmt(state.totalInterest)}`} />
      </div>

      {noPrice && (
        <p className="mt-3 text-sm text-[var(--amber)]">
          股價未更新到：持股市值暫時計 HK$0，總盈虧未反映股價。撳下面「立即更新」再試。
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <p className="text-sm text-[var(--dim)]">
          股價自動更新 · 最後更新：{fmtTime(state.quotesUpdatedAt)}
          {refreshMutation.isPending ? " · 更新緊…" : ""}
        </p>
        <button
          type="button"
          onClick={() => {
            setRefreshMsg("");
            refreshMutation.mutate();
          }}
          disabled={refreshMutation.isPending}
          className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:text-black"
        >
          立即更新股價
        </button>
      </div>
      {refreshMsg && <p className="mt-1.5 text-sm text-[var(--dim)]">{refreshMsg}</p>}

      <div className="mt-6">
        <SectionTitle>持股</SectionTitle>
        {state.holdings.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">暫時冇持股記錄。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                  <th className="py-2 pr-2 font-medium">股票</th>
                  <th className="py-2 pr-2 text-right font-medium">股數</th>
                  <th className="py-2 pr-2 text-right font-medium">平均買入價</th>
                  <th className="py-2 pr-2 text-right font-medium">現價</th>
                  <th className="py-2 pr-2 text-right font-medium">今日升跌</th>
                  <th className="py-2 pr-2 text-right font-medium">市值</th>
                  <th className="py-2 text-right font-medium">未實現盈虧</th>
                </tr>
              </thead>
              <tbody>
                {state.holdings.map((h) => (
                  <tr key={h.code} className="border-b border-[var(--border)]">
                    <td className="num py-2 pr-2 font-medium text-[var(--text)]">{h.code}</td>
                    <td className="num py-2 pr-2 text-right text-[var(--text)]">{fmtInt(h.shares)}</td>
                    <td className="num py-2 pr-2 text-right text-[var(--text)]">{fmt(h.avgCost, 4)}</td>
                    <td className="num py-2 pr-2 text-right text-[var(--text)]">{h.price > 0 ? fmt(h.price) : "—"}</td>
                    <td className={`num py-2 pr-2 text-right ${h.changePct === null ? "text-[var(--dim)]" : h.changePct >= 0 ? "text-[var(--accent)]" : "text-[var(--loss)]"}`}>
                      {h.changePct === null ? "—" : `${fmtPct(h.changePct)}`}
                      {h.changePct !== null && (
                        <span className="block text-xs">
                          {h.dayChangeValue >= 0 ? "+" : ""}HK${fmt(h.dayChangeValue, 0)}
                        </span>
                      )}
                    </td>
                    <td className="num py-2 pr-2 text-right text-[var(--text)]">HK${fmt(h.value)}</td>
                    <td className={`num py-2 text-right ${h.unrealised >= 0 ? "text-[var(--accent)]" : "text-[var(--loss)]"}`}>
                      HK${fmt(h.unrealised)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </section>
  );
}

// ---------- 監察（高息股資料 + 52 週位置 + 買賣建議） ----------

type MonitorRow = State["monitor"][number];

const SIGNAL_LABEL: Record<MonitorRow["signal"], string> = {
  buy: "買入訊號",
  reduce: "減持訊號",
  hold: "持有",
  watch: "觀望",
  none: "未有判斷",
};
const SIGNAL_CLS: Record<MonitorRow["signal"], string> = {
  buy: "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]",
  reduce: "border-[var(--loss)] text-[var(--loss)]",
  hold: "border-[var(--border)] text-[var(--dim)]",
  watch: "border-[var(--amber)] text-[var(--amber)]",
  none: "border-[var(--border)] text-[var(--dim)]",
};
const DPS_SOURCE_LABEL: Record<string, string> = {
  manual: "手動輸入",
  auto: "自動抓取",
  ledger: "帳戶派息",
  channel: "報價渠道",
};
const DIV_TREND_CLS: Record<string, string> = {
  up: "text-[var(--accent)]",
  down: "text-[var(--loss)]",
  flat: "text-[var(--amber)]",
};

// 每股股息顯示：細數保留多啲位，大數唔好一串零（0.35、5.24、24.198）。
function fmtDps(n: number): string {
  return String(parseFloat(n.toFixed(4)));
}
const TREND_CLS: Record<string, string> = {
  up: "text-[var(--accent)]",
  down: "text-[var(--loss)]",
  sideways: "text-[var(--amber)]",
};

function MonitorCard({ row, showFormulas }: { row: MonitorRow; showFormulas: boolean }) {
  const queryClient = useQueryClient();
  const [editingDps, setEditingDps] = useState(false);
  const [dpsInput, setDpsInput] = useState("");
  const [editingLot, setEditingLot] = useState(false);
  const [lotInput, setLotInput] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });
  const removeMut = useMutation({
    mutationFn: (c: string) => api.removeWatchlist({ code: c }),
    onSuccess: invalidate,
  });
  const dpsMut = useMutation({
    mutationFn: (dps: number | null) => api.setStockDps({ code: row.code, dps }),
    onSuccess: () => {
      setEditingDps(false);
      invalidate();
    },
  });
  const lotMut = useMutation({
    mutationFn: (lotSize: number | null) => api.setStockLotSize({ code: row.code, lotSize }),
    onSuccess: () => {
      setEditingLot(false);
      invalidate();
    },
  });

  return (
    <article className="border-b border-[var(--border)] py-4" aria-label={`監察 ${row.code}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 text-base font-bold text-[var(--text)]">
          <span className="num">{row.code}</span>
          {row.name ? (
            <span className="ml-2 truncate text-sm font-normal text-[var(--dim)]">{row.name}</span>
          ) : null}
          {row.heldShares > 0 && (
            <span className="ml-2 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
              持有 {fmtInt(row.heldShares)} 股
            </span>
          )}
        </p>
        <p className="num shrink-0 text-lg font-bold text-[var(--text)]">
          {row.price > 0 ? fmt(row.price) : "—"}
          {row.changePct !== null && (
            <span className={`ml-2 text-sm font-medium ${row.changePct >= 0 ? "text-[var(--accent)]" : "text-[var(--loss)]"}`}>
              {fmtPct(row.changePct)}
            </span>
          )}
        </p>
      </div>

      {/* 52 週位置：現價係咪高位 */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-[var(--dim)]">現價位置（52 週）</span>
          <span className={`font-bold ${row.positionPct !== null && row.positionPct >= 80 ? "text-[var(--loss)]" : row.positionPct !== null && row.positionPct <= 20 ? "text-[var(--accent)]" : "text-[var(--text)]"}`}>
            {row.positionLabel}
            {row.positionPct !== null ? ` · ${fmt(row.positionPct, 0)}%` : ""}
          </span>
        </div>
        {row.positionPct !== null ? (
          <>
            <div
              className="relative mt-1.5 h-2 rounded-full bg-[var(--border)]"
              role="img"
              aria-label={`現價位於 52 週波幅 ${fmt(row.positionPct, 0)}% 位置，${row.positionLabel}`}
            >
              <div
                className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded bg-[var(--accent)]"
                style={{ left: `${row.positionPct}%` }}
              />
            </div>
            {showFormulas && (
              <div className="num mt-1 flex justify-between text-xs text-[var(--dim)]">
                <span>低 {row.week52Low !== null ? fmt(row.week52Low) : "—"}</span>
                <span>高 {row.week52High !== null ? fmt(row.week52High) : "—"}</span>
              </div>
            )}
          </>
        ) : (
          showFormulas && (
            <p className="mt-1 text-xs text-[var(--dim)]">
              暫時未有 52 週波幅數據（報價渠道未提供），位置判斷要等有數據先有。
            </p>
          )
        )}
      </div>

      {/* 高息股資料 */}
      <div className="mt-2 grid grid-cols-2 gap-x-4">
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-sm text-[var(--dim)]">息率</span>
          <span className={`num text-base font-bold ${row.yieldPct !== null && row.yieldPct >= 5 ? "text-[var(--accent)]" : "text-[var(--text)]"}`}>
            {row.yieldPct !== null ? `${fmt(row.yieldPct)}%` : "—"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-sm text-[var(--dim)]">派息比率</span>
          <span className="num text-base font-medium text-[var(--text)]">
            {row.payoutRatio !== null ? `${fmt(row.payoutRatio, 0)}%` : "—"}
          </span>
        </div>
        {showFormulas && (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="text-sm text-[var(--dim)]">每股股息</span>
            <span className="num text-base font-medium text-[var(--text)]">
              {row.dps !== null ? `HK$${fmt(row.dps, 4)}` : "—"}
            </span>
          </div>
        )}
        {showFormulas && (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="text-sm text-[var(--dim)]">每股盈利 EPS</span>
            <span className="num text-base font-medium text-[var(--text)]">
              {row.eps !== null ? `HK$${fmt(row.eps, 4)}` : "—"}
            </span>
          </div>
        )}
      </div>
      {showFormulas && (
        <p className="text-xs text-[var(--dim)]">
          {row.dps !== null && row.dpsSource
            ? `每股股息來源：${DPS_SOURCE_LABEL[row.dpsSource] ?? row.dpsSource}`
            : "未有股息數據：可以喺下面手動輸入每年每股股息，息率同建議即刻有得計"}
          {row.heldShares > 0 && row.avgCost > 0
            ? ` · 平均成本 ${fmt(row.avgCost, 4)}${row.unrealisedPct !== null ? `（現價 ${fmtPct(row.unrealisedPct)}）` : ""}`
            : ""}
          {row.asOf ? ` · 報價 ${row.asOf}` : ""}
        </p>
      )}

      {/* 五年派息趨勢：每年 DPS（常駐重點）＋升／平／跌徽章 */}
      <div className="mt-1">
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-sm text-[var(--dim)]">派息趨勢（5 年）</span>
          {row.divTrend ? (
            <span className={`text-base font-bold ${DIV_TREND_CLS[row.divTrend] ?? "text-[var(--text)]"}`}>
              {row.divTrendLabel}
            </span>
          ) : (
            <span className="text-base text-[var(--dim)]">—</span>
          )}
        </div>
        {row.divYears.length > 0 ? (
          <p className="num text-sm text-[var(--text)]">
            {row.divYears.map((y) => fmtDps(y.dps)).join(" → ")}
            <span className="ml-2 text-xs text-[var(--dim)]">
              （{row.divYears[0]?.year}–{row.divYears[row.divYears.length - 1]?.year} 每年每股派息 HK$）
            </span>
          </p>
        ) : (
          showFormulas && (
            <p className="text-xs text-[var(--dim)]">
              未有自動派息數據：更新股價嗰陣會去 Yahoo 抓派息歷史（每日最多一次）；抓唔到會保留上次成功嘅數。
            </p>
          )
        )}
        {showFormulas && row.autoTtmDps !== null && (
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            自動 TTM DPS（過去 12 個月派息總和）：HK${fmt(row.autoTtmDps, 4)}
            {row.dpsSource === "auto" ? "，而家採用緊呢個數" : ""}
          </p>
        )}
      </div>

      {/* 每手股數／一手價錢 + 趨勢（公式數值行只喺顯示公式時出現，趨勢標籤常駐） */}
      <div className="mt-1 grid grid-cols-2 gap-x-4">
        {showFormulas && (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="text-sm text-[var(--dim)]">每手</span>
            <span className="num text-base font-medium text-[var(--text)]">
              {fmtInt(row.lotSize)} 股
            </span>
          </div>
        )}
        {showFormulas && (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="text-sm text-[var(--dim)]">一手價錢</span>
            <span className="num text-base font-medium text-[var(--text)]">
              {row.lotValue !== null ? `HK$${fmt(row.lotValue, 0)}` : "—"}
            </span>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="text-sm text-[var(--dim)]">趨勢</span>
          <span className={`text-base font-bold ${row.trend ? (TREND_CLS[row.trend] ?? "text-[var(--text)]") : "text-[var(--dim)]"}`}>
            {row.trendLabel}
          </span>
        </div>
        {showFormulas && (
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="text-sm text-[var(--dim)]">MA20／MA50</span>
            <span className="num text-base font-medium text-[var(--text)]">
              {row.ma20 !== null && row.ma50 !== null ? `${fmt(row.ma20)}／${fmt(row.ma50)}` : "—"}
            </span>
          </div>
        )}
      </div>
      {showFormulas && (
        <p className="text-xs text-[var(--dim)]">
          一手價錢 = 現價 × 每手股數（唔計手續費）{row.lotSizeManual ? "；每手股數係手動設定" : ""}
          {row.trend
            ? "；趨勢按現價對 20 日線／50 日線嘅固定規則，每日計一次"
            : "；未有趨勢數據：要等日線數據攞到先計到，唔會估"}
        </p>
      )}

      {/* 買賣建議 */}
      <div className={`mt-3 rounded-[var(--radius)] border px-3 py-2 ${SIGNAL_CLS[row.signal]}`}>
        <p className="text-sm font-bold">{SIGNAL_LABEL[row.signal]}</p>
        <p className="mt-0.5 text-sm text-[var(--text)]">{row.suggestion}</p>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {editingDps ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = parseFloat(dpsInput);
              dpsMut.mutate(Number.isFinite(v) && v > 0 ? v : null);
            }}
          >
            <label htmlFor={`dps-${row.code}`} className="text-sm text-[var(--dim)]">
              每年每股股息 HK$
            </label>
            <input
              id={`dps-${row.code}`}
              aria-label={`${row.code} 每年每股股息`}
              {...FIELDS.setStockDps.dps}
              type="number"
              step="0.001"
              value={dpsInput}
              onChange={(e) => setDpsInput(e.target.value)}
              placeholder={row.dps !== null ? String(row.dps) : "0.46"}
              className="num w-28 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-base text-[var(--text)]"
            />
            <button
              type="submit"
              disabled={dpsMut.isPending}
              className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:text-black"
            >
              儲存
            </button>
            <button
              type="button"
              onClick={() => dpsMut.mutate(null)}
              disabled={dpsMut.isPending}
              className="py-1.5 text-sm text-[var(--loss)]"
            >
              清除手動值
            </button>
            <button
              type="button"
              onClick={() => setEditingDps(false)}
              className="py-1.5 text-sm text-[var(--dim)]"
            >
              取消
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDpsInput(row.dps !== null ? String(row.dps) : "");
              setEditingDps(true);
            }}
            className="py-1 text-sm text-[var(--accent)]"
          >
            {row.dpsSource === "manual" ? "修改每股股息" : "手動輸入每股股息"}
          </button>
        )}
        {editingLot ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = parseInt(lotInput, 10);
              lotMut.mutate(Number.isFinite(v) && v > 0 ? v : null);
            }}
          >
            <label htmlFor={`lot-${row.code}`} className="text-sm text-[var(--dim)]">
              每手股數
            </label>
            <input
              id={`lot-${row.code}`}
              aria-label={`${row.code} 每手股數`}
              {...FIELDS.setStockLotSize.lotSize}
              type="number"
              step="1"
              value={lotInput}
              onChange={(e) => setLotInput(e.target.value)}
              placeholder={String(row.lotSize)}
              className="num w-24 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-base text-[var(--text)]"
            />
            <button
              type="submit"
              disabled={lotMut.isPending}
              className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:text-black"
            >
              儲存
            </button>
            <button
              type="button"
              onClick={() => lotMut.mutate(null)}
              disabled={lotMut.isPending}
              className="py-1.5 text-sm text-[var(--loss)]"
            >
              回復預設
            </button>
            <button
              type="button"
              onClick={() => setEditingLot(false)}
              className="py-1.5 text-sm text-[var(--dim)]"
            >
              取消
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setLotInput(String(row.lotSize));
              setEditingLot(true);
            }}
            className="py-1 text-sm text-[var(--accent)]"
          >
            修改每手股數
          </button>
        )}
        {row.watched && (
          <button
            type="button"
            onClick={() => removeMut.mutate(row.code)}
            aria-label={`移除監察 ${row.code}`}
            className="py-1 text-sm text-[var(--loss)]"
          >
            移除監察
          </button>
        )}
      </div>
    </article>
  );
}

// 公式顯示偏好：預設隱藏（版面乾淨），用戶撳過就記喺 localStorage，
// 下次開返監察頁沿用返同一個狀態。
const FORMULA_PREF_KEY = "monitor-show-formulas";
function loadFormulaPref(): boolean {
  try {
    return window.localStorage.getItem(FORMULA_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function Monitor({ state }: { state: State }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [msg, setMsg] = useState("");
  const [showFormulas, setShowFormulas] = useState<boolean>(loadFormulaPref);
  useEffect(() => {
    try {
      window.localStorage.setItem(FORMULA_PREF_KEY, showFormulas ? "1" : "0");
    } catch {
      // localStorage 用唔到就唔記，唔影響功能
    }
  }, [showFormulas]);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["state"] });
  const addMut = useMutation({
    mutationFn: (c: string) => api.addWatchlist({ code: c }),
    onSuccess: (res) => {
      setCode("");
      setCodeError("");
      setMsg(res.quoted ? "已加入監察，即時攞到價" : "已加入監察；暫時攞唔到價，會喺下次更新再試");
      invalidate();
    },
    onError: () => setMsg("加入失敗，請再試"),
  });
  const refreshMutation = useMutation({
    mutationFn: () => api.refreshPrices({}),
    onSuccess: (res) => {
      invalidate();
      setMsg(
        res.failed.length > 0
          ? `已更新 ${res.updated} 隻；攞唔到價：${res.failed.join("、")}（保留上次價錢）`
          : `股價已更新（${res.updated} 隻）`,
      );
    },
    onError: () => setMsg("更新失敗，請再試"),
  });

  return (
    <section aria-label="監察股票" className="mt-5">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>監察股票（高息為主）</SectionTitle>
        <button
          type="button"
          onClick={() => setShowFormulas((v) => !v)}
          aria-pressed={showFormulas}
          aria-label={showFormulas ? "隱藏公式" : "顯示公式"}
          className={`shrink-0 rounded-[var(--radius)] border px-3 py-1.5 text-sm font-medium ${
            showFormulas
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--border)] text-[var(--text)]"
          }`}
        >
          {showFormulas ? "隱藏公式" : "顯示公式"}
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">
        持股同監察清單嘅股票都會列喺呢欄：睇息率、現價係咪 52 週高位，同跟規則出嘅買賣建議。
      </p>
      {showFormulas && (
        <>
          <p className="mt-1 text-xs text-[var(--dim)]">
            建議點嚟：固定規則——52 週位置 ≥85% 當高位（持有就諗減持、未持有就唔追）；息率 ≥5% 而且位置 ≤50% 出買入訊號；息率 &lt;3% 又位置 ≥70% 就觀望。只按上面數據機械計，唔係預測，亦唔係投資建議。
          </p>
          <p className="mt-1 text-xs text-[var(--dim)]">
            趨勢點計：MA20 ＝ 最近 20 個收市價平均，MA50 ＝ 最近 50 個收市價平均，數據嚟自 Yahoo 半年日線（range=6mo、interval=1d），每日計一次。上升軌要四個條件齊晒：日線最後收市價 ＞ MA20 ＞ MA50，而且 MA20 同 MA50 都高過 5 個交易日前嘅同口徑均線；下降軌完全相反（收市價 ＜ MA20 ＜ MA50，兩線都低過 5 日前）；其餘一律橫行／整固。公式用嘅係日線最後收市價，唔係即時現價，日內升穿／跌穿唔會即刻改判；少過 55 個收市價就唔計，顯示「未有趨勢數據」。趨勢只供參考，唔會改變上面嘅買賣建議。
          </p>
          <p className="mt-1 text-xs text-[var(--dim)]">
            派息點嚟：更新股價嗰陣順手去 Yahoo 抓 5 年半派息歷史（v8 chart 加 events=div），每日每隻最多成功抓一次，抓唔到保留上次成功嘅數。TTM DPS ＝ 過去 12 個月派息總和；每年 DPS 按除息日嘅曆年分組，顯示最近 5 年；派息趨勢比較最近兩個完整曆年（今年未完唔攞嚟比），變幅 ±3% 內當平穩。每股股息採用次序：手動輸入 ＞ 自動抓取（TTM）＞ 帳戶派息（近 12 個月帳目股息 ÷ 持股數）＞ 報價渠道。派息比率 ＝ 採用中嘅每股股息 ÷ 每股盈利 EPS（Yahoo trailing EPS）；EPS 攞唔到或者 ≤0 就唔計，顯示「—」。
          </p>
        </>
      )}

      {/* 購買股票結餘：現金扣起合夥人多存嘅差額之後，剩低可買股嘅錢 */}
      <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-[var(--text)]">購買股票結餘</span>
          <span className="num text-xl font-bold text-[var(--accent)]">
            HK${fmt(state.buyBalance.balance)}
          </span>
        </div>
        {showFormulas && (
          <>
            <p className="num mt-1 text-sm text-[var(--text)]">
              現金結餘 HK${fmt(state.buyBalance.cash)} − 合夥人差額總和 HK${fmt(state.buyBalance.totalDiff)} ＝ HK${fmt(state.buyBalance.balance)}
            </p>
            <p className="mt-1 text-xs text-[var(--dim)]">
              差額 = 實際存入 − 應存（正數 = 多存咗，要扣起；負數 = 未存夠，照實計）。分項：
              {state.buyBalance.parts
                .map((p) => `${p.name} ${p.diff >= 0 ? "+" : "−"}${fmt(Math.abs(p.diff))}`)
                .join("、")}
              。
            </p>
          </>
        )}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const c = code.trim().toUpperCase();
          if (!c) {
            setCodeError("請先輸入股票代號（例如 00981.HK）");
            return;
          }
          setCodeError("");
          setMsg("");
          addMut.mutate(c);
        }}
      >
        <input
          aria-label="要加入監察嘅股票代號，例如 00981.HK"
          {...FIELDS.addWatchlist.code}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="00981.HK"
          className="num min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
        />
        <button
          type="submit"
          disabled={addMut.isPending}
          className="shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-white disabled:opacity-50 dark:text-black"
        >
          加入監察
        </button>
      </form>
      {codeError && <p className="mt-1.5 text-sm text-[var(--loss)]">{codeError}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="text-sm text-[var(--dim)]">最後更新：{fmtTime(state.quotesUpdatedAt)}</p>
        <button
          type="button"
          onClick={() => {
            setMsg("");
            refreshMutation.mutate();
          }}
          disabled={refreshMutation.isPending}
          className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)] disabled:opacity-50"
        >
          {refreshMutation.isPending ? "更新緊…" : "立即更新股價"}
        </button>
      </div>
      {msg && <p className="mt-1.5 text-sm text-[var(--dim)]">{msg}</p>}

      {state.monitor.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--dim)]">暫時冇持股，亦冇監察中嘅股票。喺上面輸入代號加入監察。</p>
      ) : (
        <div className="mt-1">
          {state.monitor.map((row) => (
            <MonitorCard key={row.code} row={row} showFormulas={showFormulas} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- 合夥人 ----------

function Partners({ state }: { state: State }) {
  return (
    <section aria-label="合夥人餘額" className="mt-8">
      <SectionTitle>合夥人餘額</SectionTitle>
      <p className="mt-1 text-sm text-[var(--dim)]">
        每月應存 HK${fmt(state.monthlyDeposit, 0)} × {state.months} 個月（由 {state.startDate} 起計）；
        持股比例按實際存入佔總本金計，盈虧按比例分佈。
      </p>
      <div className="mt-3 space-y-4">
        {state.partners.map((p) => (
          <div key={p.key} className="border-b border-[var(--border)] pb-3">
            <div className="flex items-baseline justify-between">
              <p className="text-base font-bold text-[var(--text)]">
                {p.key} {p.name}
              </p>
              <p className="num text-sm text-[var(--dim)]">佔 {fmt(p.sharePct)}%</p>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-4">
              <StatRow label="應存" value={`HK$${fmt(p.expected)}`} />
              <StatRow label="實際存入" value={`HK$${fmt(p.actual)}`} />
              <div className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="text-sm text-[var(--dim)]">差額</span>
                <span className={`num text-base font-medium ${p.diff >= 0 ? "text-[var(--accent)]" : "text-[var(--loss)]"}`}>
                  {p.diff >= 0 ? "+" : ""}HK${fmt(p.diff)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="text-sm text-[var(--dim)]">盈虧分佈</span>
                <span className={`num text-base font-medium ${p.pnlShare >= 0 ? "text-[var(--accent)]" : "text-[var(--loss)]"}`}>
                  {p.pnlShare >= 0 ? "+" : ""}HK${fmt(p.pnlShare)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- 交易記錄 ----------

const emptyDraft = (): TxDraft => ({
  date: todayStr(),
  code: "CASH",
  currency: "HKD",
  action: "DEPOSIT",
  price: 0,
  qty: 0,
  fee: 0,
  partner: "NONE",
  note: "",
});

function TxForm({
  state,
  initial,
  editingId,
  onDone,
}: {
  state: State;
  initial: TxDraft;
  editingId: number | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TxDraft>(initial);
  const [msg, setMsg] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      if (editingId !== null) return api.updateTransaction({ ...draft, id: editingId });
      return api.createTransaction(draft);
    },
    onSuccess: (res) => {
      if (!res.ok) {
        setMsg("呢筆交易已經存在（重複），冇再入。");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["tx"] });
      onDone();
    },
    onError: () => setMsg("儲存失敗，請再試"),
  });

  const set = <K extends keyof TxDraft>(k: K, v: TxDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const numField = (
    label: string,
    key: "price" | "qty" | "fee",
    step = "0.01",
  ) => (
    <div>
      <label htmlFor={`txf-${key}`} className="text-sm text-[var(--dim)]">{label}</label>
      <input
        id={`txf-${key}`}
        aria-label={label}
        type="number"
        step={step}
        min="0"
        value={draft[key] || ""}
        onChange={(e) => set(key, parseFloat(e.target.value) || 0)}
        className="num mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
      />
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setMsg("");
        save.mutate();
      }}
      className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <p className="font-medium text-[var(--text)]">{editingId !== null ? "編輯交易" : "新增交易"}</p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="txf-date" className="text-sm text-[var(--dim)]">日期</label>
          <input
            id="txf-date"
            aria-label="日期"
            type="date"
            required
            value={draft.date}
            onChange={(e) => set("date", e.target.value)}
            className="num mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
          />
        </div>
        <div>
          <label htmlFor="txf-action" className="text-sm text-[var(--dim)]">動作</label>
          <select
            id="txf-action"
            aria-label="動作"
            value={draft.action}
            onChange={(e) => set("action", e.target.value as TxDraft["action"])}
            className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
          >
            {ACTION_LIST.map((a) => (
              <option key={a} value={a}>{ACTION_LABEL[a]} ({a})</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="txf-code" className="text-sm text-[var(--dim)]">代號（股票／CASH）</label>
          <input
            id="txf-code"
            aria-label="代號（股票／CASH）"
            {...FIELDS.createTransaction.code}
            value={draft.code}
            onChange={(e) => set("code", e.target.value.toUpperCase())}
            className="num mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
          />
        </div>
        <div>
          <label htmlFor="txf-partner" className="text-sm text-[var(--dim)]">合夥人</label>
          <select
            id="txf-partner"
            aria-label="合夥人"
            value={draft.partner}
            onChange={(e) => set("partner", e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
          >
            <option value="NONE">—（NONE）</option>
            {state.partners.map((p) => (
              <option key={p.key} value={p.key}>{p.key} {p.name}</option>
            ))}
          </select>
        </div>
        {numField("價格／金額 (Price)", "price")}
        {numField("數量 (Quantity)", "qty", "1")}
        {numField("手費 (FEE)", "fee")}
        <div>
          <label htmlFor="txf-note" className="text-sm text-[var(--dim)]">備註</label>
          <input
            id="txf-note"
            aria-label="備註"
            {...FIELDS.createTransaction.note}
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-[var(--dim)]">
        金額按動作自動計：存入／利息＝價格；股息＝價格（數量 0 時）；買入／賣出＝價格×數量；費用＝手費欄；紅股只加股數。
      </p>
      {msg && <p className="mt-2 text-sm text-[var(--loss)]">{msg}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-white disabled:opacity-50 dark:text-black"
        >
          {editingId !== null ? "儲存修改" : "新增"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-[var(--text)]"
        >
          取消
        </button>
      </div>
    </form>
  );
}

function Transactions({ state }: { state: State }) {
  const queryClient = useQueryClient();
  const [filterAction, setFilterAction] = useState("");
  const [filterPartner, setFilterPartner] = useState("");
  const [filterCode, setFilterCode] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Tx | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [ioMsg, setIoMsg] = useState("");
  const csvRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);

  const txQuery = useQuery({
    queryKey: ["tx", { filterAction, filterPartner, filterCode }],
    queryFn: () =>
      api.listTransactions({
        limit: 2000,
        ...(filterAction ? { action: filterAction } : {}),
        ...(filterPartner ? { partner: filterPartner } : {}),
        ...(filterCode ? { code: filterCode } : {}),
      }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["state"] });
    queryClient.invalidateQueries({ queryKey: ["tx"] });
  };
  const delOne = useMutation({
    mutationFn: (id: number) => api.deleteTransaction({ id }),
    onSuccess: () => {
      setConfirmDeleteId(null);
      invalidate();
    },
  });
  const delMany = useMutation({
    mutationFn: (ids: number[]) => api.deleteManyTransactions({ ids }),
    onSuccess: () => {
      setSelected(new Set());
      setConfirmBulk(false);
      invalidate();
    },
  });
  const importMut = useMutation({
    mutationFn: (rows: TxDraft[]) => api.importTransactions({ transactions: rows }),
    onSuccess: (res) => {
      setIoMsg(`匯入完成：新增 ${res.added} 筆，跳過重複 ${res.skipped} 筆`);
      invalidate();
    },
    onError: () => setIoMsg("匯入失敗，請再試"),
  });
  const restoreMut = useMutation({
    mutationFn: (args: Parameters<typeof api.restoreBackup>[0]) => api.restoreBackup(args),
    onSuccess: (res) => {
      setIoMsg(`還原完成：新增 ${res.added} 筆，跳過重複 ${res.skipped} 筆`);
      invalidate();
    },
    onError: () => setIoMsg("還原失敗：檔案格式唔啱"),
  });

  const onCsvFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await readCsvFile(file);
      const { rows, errors } = parseCsvText(text);
      if (rows.length === 0) {
        setIoMsg(`冇可匯入嘅行。${errors.slice(0, 3).join("；")}`);
        return;
      }
      setIoMsg("");
      importMut.mutate(rows);
      if (errors.length > 0) setIoMsg(`有 ${errors.length} 行跳過：${errors.slice(0, 3).join("；")}`);
    } catch {
      setIoMsg("讀唔到個 CSV 檔");
    }
  };

  const exportCsv = async () => {
    const all = await api.listTransactions({ limit: 2000 });
    const sorted = [...all.transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const lines = [
      "Date,Code,Currency,Price,Quantity,Action,FEE,Partner,Note",
      ...sorted.map((t) =>
        [
          `${t.date.slice(8, 10)}-${t.date.slice(5, 7)}-${t.date.slice(0, 4)}`,
          t.code,
          t.currency,
          t.price || "",
          t.qty,
          t.action,
          t.fee,
          t.partner,
          t.note,
        ]
          .map(csvEscape)
          .join(","),
      ),
    ];
    download("partnership-transactions.csv", lines.join("\n"), "text/csv;charset=utf-8");
  };

  const exportJson = async () => {
    const backup = await api.exportBackup({});
    download("partnership-backup.json", JSON.stringify(backup, null, 2), "application/json");
  };

  const onJsonFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as {
        transactions?: TxDraft[];
        partners?: Array<{ key: string; name: string; sort: number }>;
        stocks?: Array<{ code: string; price: number; dps?: number | null; lotSize?: number | null }>;
        watchlist?: string[];
        trends?: Array<{ code: string; trend: string; ma20: number | null; ma50: number | null; day: string }>;
        dividends?: Array<{ code: string; ttmDps: number | null; yearly: Array<{ year: number; dps: number }>; trend: string; eps: number | null; day: string }>;
        settings?: { monthlyDeposit: number; startDate: string };
      };
      if (!Array.isArray(data.transactions)) {
        setIoMsg("還原失敗：備份檔冇 transactions");
        return;
      }
      setIoMsg("");
      restoreMut.mutate({
        replaceAll: false,
        transactions: data.transactions,
        partners: data.partners ?? [],
        stocks: data.stocks ?? [],
        watchlist: data.watchlist ?? [],
        trends: data.trends ?? [],
        dividends: data.dividends ?? [],
        ...(data.settings ? { settings: data.settings } : {}),
      });
    } catch {
      setIoMsg("還原失敗：唔係有效 JSON");
    }
  };

  const toggleSelect = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const codes = useMemo(() => {
    const set = new Set<string>(["CASH", ...state.stocks.map((s) => s.code)]);
    return [...set].sort();
  }, [state.stocks]);

  return (
    <section aria-label="交易記錄" className="mt-8">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>交易記錄</SectionTitle>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setShowForm((v) => !v);
          }}
          className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white dark:text-black"
        >
          ＋ 新增交易
        </button>
      </div>

      {(showForm || editing) && (
        <TxForm
          key={editing ? `edit-${editing.id}` : "new"}
          state={state}
          editingId={editing?.id ?? null}
          initial={
            editing
              ? {
                  date: editing.date,
                  code: editing.code,
                  currency: editing.currency,
                  action: editing.action,
                  price: editing.price,
                  qty: editing.qty,
                  fee: editing.fee,
                  partner: editing.partner,
                  note: editing.note,
                }
              : emptyDraft()
          }
          onDone={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div>
          <label htmlFor="flt-action" className="text-xs text-[var(--dim)]">動作</label>
          <select
            id="flt-action"
            aria-label="按動作篩選"
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text)]"
          >
            <option value="">全部</option>
            {ACTION_LIST.map((a) => (
              <option key={a} value={a}>{ACTION_LABEL[a]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="flt-partner" className="text-xs text-[var(--dim)]">合夥人</label>
          <select
            id="flt-partner"
            aria-label="按合夥人篩選"
            value={filterPartner}
            onChange={(e) => setFilterPartner(e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text)]"
          >
            <option value="">全部</option>
            <option value="NONE">—（NONE）</option>
            {state.partners.map((p) => (
              <option key={p.key} value={p.key}>{p.key} {p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="flt-code" className="text-xs text-[var(--dim)]">代號</label>
          <select
            id="flt-code"
            aria-label="按代號篩選"
            value={filterCode}
            onChange={(e) => setFilterCode(e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text)]"
          >
            <option value="">全部</option>
            {codes.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {selected.size > 0 &&
        (confirmBulk ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--loss)] p-3">
            <span className="text-sm text-[var(--text)]">真係刪除已揀嘅 {selected.size} 筆？</span>
            <button
              type="button"
              onClick={() => delMany.mutate([...selected])}
              className="rounded-[var(--radius)] bg-[var(--loss)] px-3 py-1.5 text-sm font-medium text-white"
            >
              確認刪除
            </button>
            <button
              type="button"
              onClick={() => setConfirmBulk(false)}
              className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm text-[var(--dim)]">已揀 {selected.size} 筆</span>
            <button
              type="button"
              onClick={() => setConfirmBulk(true)}
              className="rounded-[var(--radius)] border border-[var(--loss)] px-3 py-1.5 text-sm text-[var(--loss)]"
            >
              批量刪除
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
            >
              清除選擇
            </button>
          </div>
        ))}

      {txQuery.isPending ? (
        <p className="mt-4 text-sm text-[var(--dim)]">載入緊…</p>
      ) : txQuery.isError ? (
        <p className="mt-4 text-sm text-[var(--loss)]">載入交易失敗。</p>
      ) : (
        <>
          <p className="mt-3 text-sm text-[var(--dim)]">共 {txQuery.data.total} 筆（最新喺最上）</p>
          <ul className="mt-1 divide-y divide-[var(--border)]">
            {txQuery.data.transactions.map((t) => (
              <li key={t.id} className="py-2.5">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    aria-label={`揀選 ${t.date} ${ACTION_LABEL[t.action] ?? t.action} 交易`}
                    checked={selected.has(t.id)}
                    onChange={() => toggleSelect(t.id)}
                    className="mt-1.5 h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-[var(--text)]">
                        <span className="num">{t.date}</span> · {ACTION_LABEL[t.action] ?? t.action}
                        <span className="num text-[var(--dim)]"> · {t.code}</span>
                      </p>
                      <p className="num shrink-0 text-sm font-medium text-[var(--text)]">
                        {t.action === "RED_STOCK"
                          ? `+${fmtInt(t.qty)} 股`
                          : t.action === "BUY" || t.action === "SELL"
                            ? `HK$${fmt(t.price * t.qty)}`
                            : `HK$${fmt(t.amount)}`}
                      </p>
                    </div>
                    <p className="num mt-0.5 text-xs text-[var(--dim)]">
                      {t.qty > 0 && t.action !== "RED_STOCK" ? `${fmtInt(t.qty)} 股 × ${fmt(t.price, 4)}` : ""}
                      {t.fee > 0 ? ` · 手費 ${fmt(t.fee)}` : ""}
                      {t.partner !== "NONE" ? ` · ${partnerLabel(state, t.partner)}` : ""}
                      {t.note ? ` · ${t.note}` : ""}
                    </p>
                    {confirmDeleteId === t.id ? (
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="text-sm text-[var(--loss)]">真係刪除呢筆？</span>
                        <button
                          type="button"
                          onClick={() => delOne.mutate(t.id)}
                          className="rounded bg-[var(--loss)] px-2.5 py-1 text-sm font-medium text-white"
                        >
                          確認刪除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--text)]"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="mt-1 flex gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(t);
                            setShowForm(false);
                          }}
                          className="py-1 text-sm text-[var(--accent)]"
                        >
                          編輯
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(t.id)}
                          className="py-1 text-sm text-[var(--loss)]"
                        >
                          刪除
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {txQuery.data.transactions.length === 0 && (
            <p className="py-4 text-sm text-[var(--dim)]">冇符合條件嘅交易。</p>
          )}
        </>
      )}

      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <p className="text-sm font-medium text-[var(--text)]">匯入 ／ 匯出（同獨立站同步用）</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => csvRef.current?.click()}
            className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
          >
            匯入 CSV
          </button>
          <button
            type="button"
            onClick={() => void exportCsv()}
            className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
          >
            匯出 CSV
          </button>
          <button
            type="button"
            onClick={() => void exportJson()}
            className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
          >
            匯出 JSON 備份
          </button>
          <button
            type="button"
            onClick={() => jsonRef.current?.click()}
            className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
          >
            還原 JSON 備份
          </button>
        </div>
        <input ref={csvRef} type="file" accept=".csv,text/csv" aria-label="選擇要匯入嘅 CSV 檔" className="hidden" onChange={(e) => void onCsvFile(e)} />
        <input ref={jsonRef} type="file" accept=".json,application/json" aria-label="選擇要還原嘅 JSON 備份檔" className="hidden" onChange={(e) => void onJsonFile(e)} />
        <p className="mt-1.5 text-xs text-[var(--dim)]">
          CSV 接受 UTF-8／Big5／GBK，欄位按欄名認（Date, Code, Currency, Price, Quantity, Action, FEE, Partner, Note），重複交易會自動跳過。還原 JSON 係合併模式，唔會刪走現有交易。
        </p>
        {ioMsg && <p className="mt-2 text-sm text-[var(--text)]">{ioMsg}</p>}
      </div>
    </section>
  );
}

// ---------- 股息／DRIP 計算器 ----------

function Calculator({ state }: { state: State }) {
  const holding = state.holdings[0];
  const [shares, setShares] = useState(holding ? String(holding.shares) : "29851");
  const [perShare, setPerShare] = useState("0.23");
  const [taxPct, setTaxPct] = useState("0");
  const [price, setPrice] = useState(holding && holding.price > 0 ? String(holding.price) : "6.5");
  const [years, setYears] = useState("10");
  const [growthPct, setGrowthPct] = useState("0");
  const [reinvest, setReinvest] = useState(true);

  const sh = parseFloat(shares) || 0;
  const dps = parseFloat(perShare) || 0;
  const tax = (parseFloat(taxPct) || 0) / 100;
  const gross = sh * dps;
  const net = gross * (1 - tax);

  const drip = useMemo(() => {
    const yrs = Math.max(0, Math.min(50, Math.floor(parseFloat(years) || 0)));
    const p0 = parseFloat(price) || 0;
    const g = (parseFloat(growthPct) || 0) / 100;
    let s = sh;
    let cashDiv = 0;
    const rows: Array<{ year: number; shares: number; price: number; dividend: number }> = [];
    for (let y = 1; y <= yrs; y++) {
      const p = p0 * Math.pow(1 + g, y - 1);
      const d = s * dps * (1 - tax);
      rows.push({ year: y, shares: s, price: p, dividend: d });
      if (reinvest && p > 0) s += d / p;
      else cashDiv += d;
    }
    const endPrice = p0 * Math.pow(1 + g, Math.max(0, yrs - 1 || 0));
    const finalValue = s * (yrs > 0 ? endPrice : p0) + (reinvest ? 0 : cashDiv);
    const startValue = sh * p0;
    const totalReturnPct = startValue > 0 ? ((finalValue - startValue) / startValue) * 100 : 0;
    return { rows, endShares: s, finalValue, totalReturnPct, cashDiv };
  }, [shares, perShare, taxPct, price, years, growthPct, reinvest, sh, dps, tax]);

  const field = (
    label: string,
    id: string,
    value: string,
    onChange: (v: string) => void,
    step = "0.01",
  ) => (
    <div>
      <label htmlFor={id} className="text-sm text-[var(--dim)]">{label}</label>
      <input
        id={id}
        aria-label={label}
        type="number"
        step={step}
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="num mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
      />
    </div>
  );

  return (
    <section aria-label="股息計算器" className="mt-8">
      <SectionTitle>股息 ／ DRIP 複利計算器</SectionTitle>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {field("持有股數", "calc-shares", shares, setShares, "1")}
        {field("每股股息 (HK$)", "calc-dps", perShare, setPerShare)}
        {field("股息稅 (%)", "calc-tax", taxPct, setTaxPct)}
        {field("目前股價 (HK$)", "calc-price", price, setPrice)}
        {field("年期（年）", "calc-years", years, setYears, "1")}
        {field("每年股價增長 (%)", "calc-growth", growthPct, setGrowthPct)}
      </div>
      <div className="mt-3 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        <StatRow label="單次毛股息" value={`HK$${fmt(gross)}`} />
        <StatRow label="單次稅後股息" value={`HK$${fmt(net)}`} accent />
      </div>
      <label className="mt-3 flex min-h-9 items-center gap-2 text-base text-[var(--text)]">
        <input
          type="checkbox"
          aria-label="股息再投資（DRIP）"
          checked={reinvest}
          onChange={(e) => setReinvest(e.target.checked)}
          className="h-5 w-5"
        />
        股息再投資（DRIP）；唔剔就拎現金，總回報會加返累計股息
      </label>
      {drip.rows.length > 0 && (
        <>
          <div className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
            <StatRow label="期末股數" value={fmt(drip.endShares, 2)} />
            <StatRow label="期末總值（持股＋現金股息）" value={`HK$${fmt(drip.finalValue)}`} accent />
            <StatRow label="總回報率（計埋股息）" value={fmtPct(drip.totalReturnPct)} />
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[440px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                  <th className="py-2 pr-2 font-medium">年份</th>
                  <th className="py-2 pr-2 text-right font-medium">股數</th>
                  <th className="py-2 pr-2 text-right font-medium">股價</th>
                  <th className="py-2 text-right font-medium">該年稅後股息</th>
                </tr>
              </thead>
              <tbody>
                {drip.rows.map((r) => (
                  <tr key={r.year} className="border-b border-[var(--border)]">
                    <td className="num py-1.5 pr-2 text-[var(--text)]">第 {r.year} 年</td>
                    <td className="num py-1.5 pr-2 text-right text-[var(--text)]">{fmt(r.shares, 2)}</td>
                    <td className="num py-1.5 pr-2 text-right text-[var(--text)]">{fmt(r.price)}</td>
                    <td className="num py-1.5 text-right text-[var(--text)]">HK${fmt(r.dividend)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ---------- 後台 ----------

function Admin({ state }: { state: State }) {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [partnerError, setPartnerError] = useState("");
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [monthly, setMonthly] = useState(String(state.monthlyDeposit));
  const [startDate, setStartDate] = useState(state.startDate);
  const [confirmReset, setConfirmReset] = useState(false);
  const [msg, setMsg] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["state"] });
    queryClient.invalidateQueries({ queryKey: ["tx"] });
  };
  const partnerMut = useMutation({
    mutationFn: (args: { key: string; name: string; sort?: number }) => api.upsertPartner(args),
    onSuccess: () => {
      setMsg("合夥人已儲存");
      setPartnerError("");
      setNewKey("");
      setNewName("");
      setRenameKey(null);
      invalidate();
    },
    onError: () => setMsg("儲存失敗"),
  });
  const delPartnerMut = useMutation({
    mutationFn: (key: string) => api.deletePartner({ key }),
    onSuccess: invalidate,
  });
  const delStockMut = useMutation({
    mutationFn: (code: string) => api.deleteStock({ code }),
    onSuccess: invalidate,
  });
  const settingsMut = useMutation({
    mutationFn: () =>
      api.updateSettings({ monthlyDeposit: parseFloat(monthly) || 0, startDate }),
    onSuccess: () => {
      setMsg("設定已儲存");
      invalidate();
    },
    onError: () => setMsg("設定儲存失敗（日期要 YYYY-MM-DD）"),
  });
  const resetMut = useMutation({
    mutationFn: () => api.resetAll({}),
    onSuccess: () => {
      setConfirmReset(false);
      setMsg("已清空所有交易");
      invalidate();
    },
  });

  const inputCls =
    "num mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]";

  return (
    <section aria-label="後台管理" className="mt-8">
      <SectionTitle>後台</SectionTitle>

      <p className="mt-4 text-sm font-medium text-[var(--text)]">合夥人</p>
      <ul className="mt-1 divide-y divide-[var(--border)]">
        {state.partners.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-2 py-2">
            <span className="text-base text-[var(--text)]">
              {p.key} {p.name}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setRenameKey(p.key);
                  setRenameName(p.name);
                }}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
              >
                改名
              </button>
              <button
                type="button"
                onClick={() => delPartnerMut.mutate(p.key)}
                className="rounded border border-[var(--loss)] px-3 py-1.5 text-sm text-[var(--loss)]"
              >
                刪除
              </button>
            </span>
          </li>
        ))}
      </ul>
      {renameKey && (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const p = state.partners.find((x) => x.key === renameKey);
            partnerMut.mutate({ key: renameKey, name: renameName, ...(p ? { sort: state.partners.indexOf(p) + 1 } : {}) });
          }}
        >
          <div className="flex-1">
            <label htmlFor="rename-input" className="text-sm text-[var(--dim)]">
              {renameKey} 嘅新名
            </label>
            <input id="rename-input" aria-label="合夥人新名" {...FIELDS.upsertPartner.name} value={renameName} onChange={(e) => setRenameName(e.target.value)} className={inputCls} />
          </div>
          <button type="submit" className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-white dark:text-black">
            儲存
          </button>
          <button
            type="button"
            onClick={() => setRenameKey(null)}
            className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-[var(--text)]"
          >
            取消
          </button>
        </form>
      )}
      <form
        className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newKey.trim()) {
            setPartnerError("請先輸入新合夥人代號（例如 F）");
            return;
          }
          setPartnerError("");
          partnerMut.mutate({ key: newKey.trim(), name: newName.trim() });
        }}
      >
        <div>
          <label htmlFor="new-partner-key" className="text-sm text-[var(--dim)]">新合夥人代號</label>
          <input id="new-partner-key" aria-label="新合夥人代號" {...FIELDS.upsertPartner.key} value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} placeholder="F" className={inputCls} />
        </div>
        <div>
          <label htmlFor="new-partner-name" className="text-sm text-[var(--dim)]">名</label>
          <input id="new-partner-name" aria-label="新合夥人名" {...FIELDS.upsertPartner.name} value={newName} onChange={(e) => setNewName(e.target.value)} className={inputCls} />
        </div>
        <button type="submit" className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-white dark:text-black">
          新增
        </button>
      </form>
      {partnerError && <p className="mt-1.5 text-sm text-[var(--loss)]">{partnerError}</p>}

      <p className="mt-6 text-sm font-medium text-[var(--text)]">股票（股價自動更新，唔使手動入）</p>
      <ul className="mt-1 divide-y divide-[var(--border)]">
        {state.stocks.map((s) => (
          <li key={s.code} className="flex items-center justify-between gap-2 py-2">
            <span className="num text-base text-[var(--text)]">
              {s.code} · 現價 {s.price > 0 ? fmt(s.price) : "未更新"}
            </span>
            <button
              type="button"
              onClick={() => delStockMut.mutate(s.code)}
              className="rounded border border-[var(--loss)] px-3 py-1.5 text-sm text-[var(--loss)]"
            >
              刪除
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-sm font-medium text-[var(--text)]">設定</p>
      <form
        className="mt-2 grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          settingsMut.mutate();
        }}
      >
        <div>
          <label htmlFor="set-monthly" className="text-sm text-[var(--dim)]">每月應存 (HK$)</label>
          <input id="set-monthly" aria-label="每月應存 (HK$)" {...FIELDS.updateSettings.monthlyDeposit} type="number" step="1" value={monthly} onChange={(e) => setMonthly(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="set-start" className="text-sm text-[var(--dim)]">起始日期</label>
          <input id="set-start" aria-label="起始日期" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
        </div>
        <button type="submit" className="col-span-2 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 font-medium text-white dark:text-black">
          儲存設定
        </button>
      </form>

      <div className="mt-6 border-t border-[var(--border)] pt-4">
        <p className="text-sm font-medium text-[var(--loss)]">危險操作</p>
        {confirmReset ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-sm text-[var(--text)]">真係清空全部 {state.txCount} 筆交易？合夥人同設定會保留。</span>
            <button
              type="button"
              onClick={() => resetMut.mutate()}
              className="rounded-[var(--radius)] bg-[var(--loss)] px-3 py-2 text-sm font-medium text-white"
            >
              確認清空
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="mt-2 rounded-[var(--radius)] border border-[var(--loss)] px-3 py-2 text-sm text-[var(--loss)]"
          >
            重置：清空所有交易
          </button>
        )}
      </div>
      {msg && <p className="mt-3 text-sm text-[var(--dim)]">{msg}</p>}
    </section>
  );
}

// ---------- 主畫面 ----------

type Tab = "overview" | "monitor" | "tx" | "calc" | "admin";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "總覽" },
  { key: "monitor", label: "監察" },
  { key: "tx", label: "交易" },
  { key: "calc", label: "計算器" },
  { key: "admin", label: "後台" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const stateQuery = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });
  const state = stateQuery.data;

  return (
    <div className="min-h-screen bg-[var(--bg)] font-sans">
      <nav
        aria-label="主要分頁"
        className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)] pt-safe"
      >
        <div className="mx-auto flex max-w-3xl gap-1 px-4">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={`flex-1 border-b-2 py-3 text-base ${
                tab === t.key
                  ? "border-[var(--accent)] font-bold text-[var(--accent)]"
                  : "border-transparent text-[var(--dim)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-4 pb-10">
        {stateQuery.isPending && <p className="py-12 text-center text-[var(--dim)]">載入緊…</p>}
        {stateQuery.isError && (
          <div className="py-12 text-center">
            <p className="text-[var(--loss)]">載入失敗。</p>
            <button
              type="button"
              onClick={() => void stateQuery.refetch()}
              className="mt-3 rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-[var(--text)]"
            >
              再試
            </button>
          </div>
        )}
        {state && state.txCount === 0 && (
          <p className="mt-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text)]">
            而家未有任何交易記錄。可以喺「交易」分頁新增，或者匯入 CSV／還原 JSON 備份嚟入返 198 筆 v3.0.0 數據。
          </p>
        )}
        {state && tab === "overview" && (
          <>
            <Overview state={state} />
            <Partners state={state} />
          </>
        )}
        {state && tab === "monitor" && <Monitor state={state} />}
        {state && tab === "tx" && <Transactions state={state} />}
        {state && tab === "calc" && <Calculator state={state} />}
        {state && tab === "admin" && <Admin key={`${state.monthlyDeposit}-${state.startDate}`} state={state} />}

        <footer className="mt-10 border-t border-[var(--border)] pt-3 text-xs text-[var(--dim)]">
          投資合伙戶口管理系統 v3.3.0（Muse 版）· 股價自動更新（每 30 分鐘一次，亦可即時更新）· 記帳工具；監察欄嘅買賣建議按固定規則計，只供參考，唔係投資建議
        </footer>
      </main>
    </div>
  );
}
