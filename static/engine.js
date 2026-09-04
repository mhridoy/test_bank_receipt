/* Field extraction + file naming, running entirely in the browser.
   This is a port of receipt_renamer/parse.py + naming.py (kept in the repo as
   the optional desktop fallback); when you add a bank rule, add it in both. */

export const CURRENCIES = "SAR|USD|EUR|AED|QAR|KWD|BHD|OMR|GBP|JOD|EGP|TRY|INR|CNY";

const BANK_PATTERNS = [
  ["Riyad Bank",            /riyad\s*bank|riyadbank\.com|بنك\s*الرياض/i],
  ["Bank Aljazira",         /al\s*jazira|aljazira|bajksa|الجزيرة/i],
  ["Al Rajhi Bank",         /al\s*rajhi|alrajhi|الراجحي/i],
  ["Saudi National Bank",   /saudi\s*national\s*bank|national\s*commercial\s*bank|\bsnb\b|\bncb\b|الأهلي/i],
  ["Alinma Bank",           /alinma|الإنماء/i],
  ["Bank Albilad",          /al\s*bilad|albilad|البلاد/i],
  ["Arab National Bank",    /arab\s*national\s*bank|\banb\b|العربي\s*الوطني/i],
  ["SABB",                  /\bsabb\b|saudi\s*british/i],
  ["Saudi Investment Bank", /saudi\s*investment\s*bank|\bsaib\b/i],
  ["Banque Saudi Fransi",   /saudi\s*fransi|\bbsf\b|الفرنسي/i],
  ["Gulf International Bank", /gulf\s*international|\bgib\b/i],
  ["Emirates NBD",          /emirates\s*nbd/i],
  ["First Abu Dhabi Bank",  /first\s*abu\s*dhabi|\bfab\b/i],
  ["QNB",                   /\bqnb\b|qatar\s*national/i],
  ["HSBC",                  /\bhsbc\b/i],
  ["Standard Chartered",    /standard\s*chartered/i],
  ["Citibank",              /\bciti\s*bank\b|citibank/i],
];

/* view: "line" = spacing-repaired single line, "raw" = original lines, "flat" = no spaces */
const RECEIVER_RULES = [
  ["line", /\bTO\s*:\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s*(?:,|;|\bREF\b|$)/i],
  ["line", /\bBeneficiary\s+(?:Name\s*[:\-]?\s*)?([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s+Beneficiary\s+Account/i],
  ["line", /\bBeneficiary\s+Name\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s{2,}/i],
  ["line", /\b(?:Payee|Pay\s+to|Credit\s+to)\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s*(?:,|$)/i],
  ["raw",  /(?:المستفيد|اسم\s*المستفيد)\s*[:\-]?\s*(.+)/],
];

const SENDER_RULES = [
  ["raw",  /Account\s*Name\s*\n\s*(.+)/i],
  ["line", /\bAccount\s*Name\s*[:\-]\s*([^\n,]{3,70})/i],
  ["line", /\b(?:From|Debit)\s+Account\s+Name\s*[:\-]?\s*([^\n,]{3,70})/i],
  ["raw",  /^(.{6,70})\s*\n\s*The operation has completed/im],
  ["raw",  /(?:اسم\s*(?:صاحب\s*)?الحساب)\s*[:\-]?\s*(.+)/],
  ["raw",  /^\s*([؀-ۿ][^\n]{5,70})\s*$/m],
];

const RECEIVER_BANK_RULES = [
  ["line", /\bTo\s+((?:Saudi|Bank|Al|Arab|National|Riyad|Emirates)[A-Za-z ]{2,30}?Bank)\b/i],
  ["line", /\bBeneficiary\s+Bank\s*[:\-]?\s*([A-Za-z][A-Za-z .'\-]{3,40})/i],
  ["line", /SAR\s*-\s*([A-Z][A-Z ]{3,40}BANK)/],
];

const INVOICE_RULES = [
  ["line", /\b(?:invoice|inv|bill)\b\s*(?:no\.?|number|#)?\s*[:.\-]?\s*(\d[A-Z0-9/\-]{2,20}|[A-Z]{1,4}[\-/]?\d[A-Z0-9/\-]{1,18})/i],
  ["raw",  /(?:رقم\s*الفاتورة|فاتورة)\s*[:\-]?\s*([0-9/\-]{3,20})/],
  ["line", /\bds\s*0*(\d{5,})\b/i],           // Riyad Bank narration tail: ",ds 07260019"
];

const REFERENCE_RULES = [
  ["raw",  /Reference\s*(?:No\.?|Number)?\s*[:\-]?\s*([A-Z0-9]{6,25})\b/i],
  ["flat", /REF[:\-]?([A-Z0-9]{8,25}?)(?=,|;|Currency|Amount|Date|$)/i],
  ["flat", /Reference(?:No|Number)?[:\-]?([A-Z0-9]{6,25}?)(?=Currency|Amount|Date|Time|Status|$)/i],
  ["line", /\bREF\s*[:\-]?\s*([A-Z0-9]{8,25})\b/i],
];

const FEE_WORDS = /fee|fees|comission|commission|charge|charges|vat|tax|رسوم|عمولة/i;

const LABEL_WORDS = new Set(["account type", "account number", "account name", "current account",
  "branch", "amount", "date", "description", "currency", "narration", "cheque no",
  "transaction details", "iban", "detail", "processing date", "status", "beneficiary"]);

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

/* OCR frequently drops the spaces inside a line - put the obvious ones back. */
export function deglue(text) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/[ \t]{2,}/g, " ");
}

function views(text) {
  return {
    raw: text,
    line: deglue(text.replace(/\n/g, " \n ")).replace(/\s+/g, " "),
    flat: text.replace(/\s+/g, ""),
  };
}

function firstMatch(rules, v) {
  for (const [view, pattern] of rules) {
    const m = v[view].match(pattern);
    if (m && m[1]) {
      const value = m[1].trim().replace(/^[.,:;\-،\s]+|[.,:;\-،\s]+$/g, "");
      if (value && !LABEL_WORDS.has(value.toLowerCase())) return value;
    }
  }
  return "";
}

/* Drop OCR noise tokens that slipped into a mostly upper-case company name. */
function cleanParty(value) {
  let tokens = value.split(/\s+/).filter(Boolean);
  const upper = tokens.filter((t) => /^[A-Z]+$/.test(t)).length;
  if (upper >= 2) tokens = tokens.filter((t) => !(/[a-z]/.test(t) && /^[A-Za-z]+$/.test(t)));
  return tokens.join(" ").trim();
}

function findBank(v) {
  for (const [canon, pattern] of BANK_PATTERNS) if (pattern.test(v.line)) return canon;
  const m = v.line.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+Bank)\b/);
  return m ? m[1] : "";
}

/* The debited total and the transfer amount before fees, ignoring fee lines. */
function findAmounts(v) {
  const text = v.line;
  const found = [];
  const patterns = [
    new RegExp(`(${CURRENCIES})\\s*(-?[\\d,]+\\.\\d{2})\\b`, "gi"),
    new RegExp(`(-?[\\d,]+\\.\\d{2})\\s*(${CURRENCIES})\\b`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const isCur = new RegExp(`^(?:${CURRENCIES})$`, "i").test(m[1]);
      const currency = isCur ? m[1] : m[2];
      const raw = isCur ? m[2] : m[1];
      if (FEE_WORDS.test(text.slice(Math.max(0, m.index - 22), m.index))) continue;
      const value = Math.abs(parseFloat(raw.replace(/,/g, "")));
      if (value > 0) found.push([value, currency.toUpperCase()]);
    }
  }
  if (!found.length) return { amount: "", amount_net: "", currency: "" };
  const values = [...new Set(found.map((f) => f[0]))].sort((a, b) => b - a);
  return {
    amount: values[0].toFixed(2),
    amount_net: values[values.length - 1].toFixed(2),
    currency: found[0][1],
  };
}

function iso(y, m, d) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function findDate(v) {
  let m = v.line.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
  if (m) return iso(m[3], m[2], m[1]);
  m = v.line.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return iso(m[1], m[2], m[3]);
  m = v.line.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(20\d{2})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  return "";
}

export function aliasKey(text) {
  return String(text || "").replace(/[^0-9A-Za-z؀-ۿ]/g, "").toUpperCase();
}

export function applyAliases(fields, aliases) {
  for (const [field, book] of [["receiver", aliases.receiver || {}],
                               ["sender", aliases.sender || {}],
                               ["bank", aliases.bank || {}]]) {
    const lookup = {};
    for (const [k, val] of Object.entries(book)) lookup[aliasKey(k)] = val;
    if (field === "bank") {
      const clean = lookup[aliasKey(fields.bank_name)];
      if (clean) fields.bank_name = clean;
    } else {
      const clean = lookup[aliasKey(fields[`${field}_name`])];
      if (clean) { fields[`${field}_name`] = clean; fields[`${field}_name_en`] = clean; }
    }
  }
}

export function parseText(text, aliases = {}) {
  const v = views(text || "");
  const fields = {
    bank_name: findBank(v),
    sender_name: cleanParty(firstMatch(SENDER_RULES, v)),
    receiver_name: cleanParty(firstMatch(RECEIVER_RULES, v)),
    receiver_bank: firstMatch(RECEIVER_BANK_RULES, v),
    invoice_number: firstMatch(INVOICE_RULES, v),
    reference_number: firstMatch(REFERENCE_RULES, v),
    transaction_date: findDate(v),
    ...findAmounts(v),
  };
  fields.sender_name_en = fields.sender_name;
  fields.receiver_name_en = fields.receiver_name;
  applyAliases(fields, aliases);

  const missing = ["bank_name", "receiver_name", "amount"].filter((k) => !fields[k]);
  fields.confidence = missing.length === 0 ? "high" : (missing.length === 1 ? "medium" : "low");
  fields.missing = missing;
  return fields;
}

/* ── naming ─────────────────────────────────────────────────────────── */

const LEGAL_SUFFIXES = new Set(["company", "co", "coltd", "ltd", "llc", "wll", "est",
  "establishment", "corp", "corporation", "inc", "plc", "jsc", "sa", "sarl", "trading"]);

const KNOWN_ACRONYMS = new Set(["LLC", "WLL", "JSC", "PLC", "KSA", "UAE", "SAR", "USD", "EUR",
  "SNB", "NCB", "ANB", "GIB", "QNB", "NBD", "FAB", "SABB", "HSBC", "SAIB", "IBAN", "VAT"]);

const BANK_ALIASES = [
  [/riyad/i, "RiyadBank"], [/jazira|jazeera/i, "AlJaziraBank"], [/rajhi/i, "AlRajhiBank"],
  [/\bsnb\b|saudi national|national commercial|\bncb\b|الأهلي/i, "SaudiNationalBank"],
  [/samba/i, "SambaBank"], [/\bsabb\b|british/i, "SABB"], [/alinma|inma/i, "AlinmaBank"],
  [/albilad|bilad/i, "BankAlbilad"], [/arab national|\banb\b/i, "ArabNationalBank"],
  [/saudi investment|\bsaib\b/i, "SaudiInvestmentBank"],
  [/gulf international|\bgib\b/i, "GulfInternationalBank"], [/emirates nbd/i, "EmiratesNBD"],
  [/\bfab\b|first abu dhabi/i, "FirstAbuDhabiBank"], [/\bqnb\b/i, "QNB"], [/\bhsbc\b/i, "HSBC"],
  [/standard chartered/i, "StandardChartered"], [/citi/i, "Citibank"],
];

const WINDOWS_RESERVED = new Set(["CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

export function camel(text, stripLegal = false) {
  if (!text) return "";
  const normalised = String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "");
  let words = normalised.split(/[^0-9A-Za-z؀-ۿ]+/).filter(Boolean);
  if (stripLegal) {
    while (words.length && LEGAL_SUFFIXES.has(words[words.length - 1].toLowerCase().replace(/\./g, "")))
      words.pop();
  }
  return words.map((w) => {
    if (KNOWN_ACRONYMS.has(w.toUpperCase()) || /^\d+$/.test(w)) return /^[A-Za-z]+$/.test(w) ? w.toUpperCase() : w;
    if (/^[\x00-\x7F]+$/.test(w)) return w[0].toUpperCase() + w.slice(1).toLowerCase();
    return w;
  }).join("");
}

export function canonicalBank(name) {
  if (!name) return "";
  for (const [pattern, canon] of BANK_ALIASES) if (pattern.test(name)) return canon;
  return camel(name);
}

export function cleanAmount(value) {
  if (!value) return "";
  const s = String(value).replace(/[^\d.,\-]/g, "").replace(/,/g, "");
  const num = parseFloat(s);
  return Number.isFinite(num) ? Math.abs(num).toFixed(2) : "";
}

export function cleanRef(value) {
  return value ? String(value).replace(/[^0-9A-Za-z\-]/g, "") : "";
}

export function cleanInvoice(value) {
  if (!value) return "";
  const s = String(value).trim();
  const digits = s.match(/\d{4,}/g) || [];
  if (digits.length === 1 && !/[A-Za-z]{3,}/.test(s)) return digits[0].replace(/^0+/, "") || digits[0];
  return s.replace(/[^0-9A-Za-z\-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function invoiceFromName(filename) {
  const stem = filename.replace(/\.[^.]*$/, "");
  const m = stem.match(/(?:inv|invoice|bill|fatura|فاتورة)[^0-9]{0,6}(\d{4,})/i);
  if (m) return m[1];
  const nums = stem.match(/\d{5,}/g);
  return nums ? nums[nums.length - 1] : "";
}

export function sanitize(name, maxLen = 150) {
  let out = name.replace(/[<>:"/\\|?*]/g, "").replace(/[\x00-\x1f]/g, "");
  out = out.replace(/_{2,}/g, "_").replace(/^[\s._\-]+|[\s._\-]+$/g, "");
  if (!out) out = "unnamed_receipt";
  if (WINDOWS_RESERVED.has(out.split("_")[0].toUpperCase())) out = "_" + out;
  return out.slice(0, maxLen).replace(/[\s._\-]+$/g, "");
}

export function buildName(fields, template, original, stripLegal = true, invoiceFallback = true) {
  let invoice = cleanInvoice(fields.invoice_number);
  if (!invoice && invoiceFallback) invoice = invoiceFromName(original);

  const values = {
    bank: canonicalBank(fields.bank_name || ""),
    receiver_bank: canonicalBank(fields.receiver_bank || ""),
    sender: camel(fields.sender_name_en || fields.sender_name || "", stripLegal),
    receiver: camel(fields.receiver_name_en || fields.receiver_name || "", stripLegal),
    amount: cleanAmount(fields.amount),
    amount_net: cleanAmount(fields.amount_net),
    currency: (fields.currency || "").toUpperCase().slice(0, 4),
    invoice,
    ref: cleanRef(fields.reference_number),
    date: (fields.transaction_date || "").slice(0, 10),
    orig: original.replace(/\.[^.]*$/, ""),
  };
  if (!values.amount) values.currency = "";

  const rendered = template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
  return sanitize(rendered) + ".pdf";
}
