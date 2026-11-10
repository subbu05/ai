const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const fmtUsd = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : usd.format(n));
export const fmtPrice = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : num2.format(n));
export const fmtQty = (n: number) => qtyFmt.format(n);
export const fmtCompact = (n: number) => compact.format(n);
export const fmtSigned = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${num2.format(n)}`);
export const fmtSignedUsd = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd.format(Math.abs(n))}`);
export const fmtPct = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${num2.format(n)}%`);
export const fmtTime = (ts: number) => time.format(ts);
export const fmtDateTime = (ts: number) => dateTime.format(ts);
export const tone = (n: number | undefined) => (!n ? "flat" : n > 0 ? "up" : "down");
