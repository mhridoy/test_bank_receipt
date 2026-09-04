/* Field extraction + file naming, running entirely in the browser.
   This is a port of receipt_renamer/parse.py + naming.py (kept in the repo as
   the optional desktop fallback); when you add a bank rule, add it in both. */

import { normaliseArabic, transliterate, hasArabic } from "./arabic.js";

export const CURRENCIES = "SAR|USD|EUR|AED|QAR|KWD|BHD|OMR|GBP|JOD|EGP|TRY|INR|CNY";

/* Saudi banks often print the riyal sign instead of a currency code:
   ⃂ (U+20C2), ﷼ (U+FDFC) or ر.س - and the figure may carry a minus sign. */
const CURRENCY_SYMBOLS = "⃂|﷼|ر\\.?س|SR";

/* A party name may be Arabic, Latin, or Arabic glued straight onto its label. */
const NAME_CHARS = "A-Za-z؀-ۿﭐ-﷿ﹰ-ﻼ0-9 &.'\\-";

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
  // SNB: "Beneficiary Nameشركة وجد الأماني للمقاولات" - the label is glued to an
  // Arabic name, and it sits on its own line.
  ["raw", new RegExp(`^\\s*Beneficiary\\s*Name\\s*[:\\-]?\\s*([${NAME_CHARS}]{3,70}?)\\s*$`, "im")],
  // The narration line, in either reading order - a right-to-left page can put
  // the reference before the name.
  ["line", new RegExp(`(?:Outgoing|Incoming)\\s+(?:internal\\s+transfer|Local\\s+Transfer|transfer)\\s+([${NAME_CHARS}]{3,70}?)\\s*Ref\\.`, "i")],
  ["line", new RegExp(`Ref\\.\\s*\\d+\\s+([${NAME_CHARS}]{3,70}?)\\s+(?:Outgoing|Incoming)\\s+(?:internal|Local)`, "i")],
  ["line", /\bTO\s*:\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s*(?:,|;|\bREF\b|$)/i],
  ["line", /\bBeneficiary\s+(?:Name\s*[:\-]?\s*)?([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s+Beneficiary\s+Account/i],
  ["line", /\bBeneficiary\s*Name\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)(?=\s+(?:Amount|Reference|Ref\b|Invoice|Bill|IBAN|Account|Bank|Date|Purpose|Currency|Status|$))/i],
  ["line", /\bBeneficiary\s+Name\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s{2,}/i],
  ["line", /\b(?:Payee|Pay\s+to|Credit\s+to)\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s*(?:,|$)/i],
  ["raw",  /(?:المستفيد|اسم\s*المستفيد)\s*[:\-]?\s*(.+)/],
];

/* Identifiers a bank prints for the person being paid. They are not account
   numbers, but they are just as stable - and on an internal transfer they may be
   the only thing that identifies the beneficiary. */
const BENEFICIARY_ID_RULES = [
  ["line", /\bBEN\s*ID\s*[:\-]?\s*(\d{6,15})/i],
  ["line", /\bREM\s*ID\s*[:\-]?\s*(\d{6,15})/i],
  ["line", /\bBeneficiary\s*(?:ID|Number|No)\s*[:\-]?\s*(\d{6,15})/i],
];

/* The account the money went to, as printed inside an internal-transfer line:
   "Outgoing internal transfer 18800000543403  شراء بضاعةBEN ID:7053930587" */
const INTERNAL_TRANSFER_ACCOUNT_RULES = [
  ["line", /Outgoing\s+internal\s+transfer\s+(?:BB\s*:[^0-9]{0,20})?(\d{10,18})\b/i],
  ["line", /\bBB\s*:\s*[A-Za-z ]{0,20}(\d{10,18})\b/i],
];

const SENDER_RULES = [
  ["raw",  /Account\s*Name\s*\n\s*(.+)/i],
  ["line", /\bAccount\s*Name\s*[:\-]\s*([^\n,]{3,70})/i],
  ["line", /\b(?:From|Debit)\s+Account\s+Name\s*[:\-]?\s*([^\n,]{3,70})/i],
  ["raw",  /^(.{6,70})\s*\n\s*The operation has completed/im],
  ["raw",  /(?:اسم\s*(?:صاحب\s*)?الحساب)\s*[:\-]?\s*(.+)/],
  ["raw",  /^\s*([؀-ۿ][^\n]{5,70})\s*$/m],
];

const REMITTER_RULES = [
  ["raw", new RegExp(`^\\s*(?:Remitter|Sender|Ordering\\s*Customer|Payer)\\s*(?:Name)?\\s*[:\\-]?\\s*([${NAME_CHARS}]{3,70}?)\\s*$`, "im")],
  ["line", new RegExp(`\\b(?:Received\\s+from|Credited\\s+by|Transfer\\s+from|from)\\s+([${NAME_CHARS}]{4,70}?)\\s*(?:,|Ref\\.|Amount|$)`, "i")],
  ["raw", /(?:المرسل|اسم\s*المرسل|من)\s*[:\-]?\s*(.+)/],
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

/* Account numbers are the strongest identifier on a receipt: the beneficiary's
   name may be spelled three different ways, but the IBAN never changes. */

/* No leading \b: OCR often glues the label to the number ("BeneficiaryAccountSA04…"),
   so the scan checks the preceding character itself instead. */
const IBAN_TOKEN = /([A-Z]{2}\d{12,30})\b/g;
const PLAIN_ACCOUNT_TOKEN = /(\d{9,24})\b/g;

/* Words that say whose account a number is. Transfers inside one bank print a
   plain account number and no IBAN at all, so both shapes have to be recognised. */
const BENEFICIARY_CONTEXT =
  /beneficiary|payee|credit(?:ed)?\s*(?:to|account)|to\s*account|recipient|receiver|in\s*favou?r|المستفيد|حسابالمستفيد|الى/i;
const OWN_ACCOUNT_CONTEXT =
  /\biban\b|account\s*(?:number|no|#)|from\s*account|debit(?:ed)?\s*account|source\s*account|your\s*account|رقمالحساب|الآيبان|حسابك/i;

/* Long digit strings that are not accounts: phone numbers, registers, boxes,
   references, cheque numbers, VAT numbers, timestamps. */
const NOT_AN_ACCOUNT =
  /tel|phone|fax|mobile|p\.?o\.?\s*box|box|c\.?r\.?|commercialregister|register|vat|tax|ref(?:erence)?|cheque|check|invoice|bill|order|ticket|otp|zip|postal|ben\s*id|rem\s*id|beneficiary\s*id|هاتف|جوال|سجل|ضريب|مرجع/i;
/** OCR mixes up letters and digits inside numbers - repair them in numeric fields. */
export function fixDigits(value) {
  return String(value || "")
    .replace(/[Oo]/g, "0").replace(/[lI|]/g, "1")
    .replace(/[Ss]/g, "5").replace(/[Bb]/g, "8").replace(/[Zz]/g, "2");
}

/** IBAN check digits (ISO 13616 mod-97). Catches an OCR slip in an account
    number before it is learned as a company's identity. */
export function validIban(iban) {
  const value = String(iban || "").toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(value)) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function normaliseAccount(value) {
  if (!value) return "";
  const cleaned = String(value).replace(/[\s\-]+/g, "").toUpperCase();
  const iban = cleaned.match(/^([A-Z]{2})(\d[\dA-Z]{10,30})$/);
  if (iban) return iban[1] + fixDigits(iban[2]).replace(/[^0-9]/g, "");
  return cleaned.replace(/[^0-9]/g, "");
}

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
    tight: text.replace(/\s+/g, " "),      // spacing untouched: keeps IBANs whole
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

/** Which bank issued this receipt?

    A receipt names other banks too - the beneficiary's bank, the correspondent -
    so a plain "first match wins" picks the wrong one. The issuer is the bank in
    the footer (its legal small print) or, failing that, the one named most often. */
function findBank(v) {
  const text = v.line;
  const footerFrom = Math.floor(text.length * 0.62);
  let best = null;

  for (const [canon, pattern] of BANK_PATTERNS) {
    const global = new RegExp(pattern.source, "gi");
    const hits = [...text.matchAll(global)].map((m) => m.index);
    if (!hits.length) continue;
    const inFooter = hits.some((i) => i >= footerFrom);
    const score = (inFooter ? 100 : 0) + hits.length;
    if (!best || score > best.score) best = { canon, score, first: hits[0] };
  }
  if (best) return best.canon;

  const m = text.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+Bank)\b/);
  return m ? m[1] : "";
}

/* Which way the money went. Outgoing is the common case, but a statement of an
   incoming payment names the payer, not the payee, as the other company. */
function findDirection(v) {
  const text = v.line;
  if (/\b(incoming|credit(?:ed)?\s+transfer|deposit|received\s+from|inward)\b|وارد|إيداع/i.test(text)
      && !/\boutgoing\b/i.test(text)) return "in";
  if (/\b(outgoing|outward|debit(?:ed)?|transfer\s+to|payment\s+to)\b|صادر|تحويل\s*صادر/i.test(text)) return "out";
  return /-\s?[\d,]+\.\d{2}/.test(text) ? "out" : "out";
}

/* A party name that trails into the bank's own name: "Sahat Altasheed Al Rajhi Bank" */
function trimBankSuffix(name) {
  if (!name) return name;
  for (const [, pattern] of BANK_PATTERNS) {
    const trailing = new RegExp(`\\s+(?:${pattern.source})[A-Za-z ]*$`, "i");
    const trimmed = name.replace(trailing, "").trim();
    if (trimmed && trimmed.length >= 4 && trimmed !== name) return trimmed;
  }
  return name.replace(/\s+bank$/i, "").trim();
}

/* The debited total and the transfer amount before fees, ignoring fee lines. */
function findAmounts(v) {
  const text = v.line;
  const found = [];
  const patterns = [
    new RegExp(`(${CURRENCIES})\\s*(-?[\\d,]+\\.\\d{2})\\b`, "gi"),
    new RegExp(`(-?[\\d,]+\\.\\d{2})\\s*(${CURRENCIES})\\b`, "gi"),
  ];

  // Riyal sign instead of a code: "⃂ -224777.39". The sign also tells us this is
  // the figure that moved, not the running balance printed next to it.
  const symbolPattern = new RegExp(`(?:${CURRENCY_SYMBOLS})\\s*(-?[\\d,]+\\.\\d{2})`, "gi");
  for (const m of text.matchAll(symbolPattern)) {
    const value = Math.abs(parseFloat(m[1].replace(/,/g, "")));
    if (value > 0) found.push([value, "SAR", true]);
  }
  const symbolled = found.length;
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

/** Work out which account number belongs to the beneficiary and which is ours.

    A receipt may print an IBAN, a plain account number, or both - a transfer
    inside the same bank usually has no IBAN. Each candidate is judged by the words
    printed just before it ("Beneficiary Account", "IBAN", "Account Number"), by
    whether it passes the IBAN checksum, and by where it sits on the page: the
    beneficiary's number is the one inside the narration, further down. */
function findAccounts(v) {
  const candidates = [];
  const seen = new Set();

  const consider = (text, value, index, kind) => {
    if (seen.has(value)) return;
    const previous = text[index - 1] || " ";
    if (/\d/.test(previous)) return;                          // middle of a longer number
    if (kind === "iban" && /[A-Z]/.test(previous)) return;     // middle of a word in caps
    const before = text.slice(Math.max(0, index - 55), index);
    const tail = before.slice(-28);
    if (NOT_AN_ACCOUNT.test(tail)) return;
    if (/[\d,]\.\d?$/.test(before.trimEnd())) return;         // part of an amount
    seen.add(value);
    candidates.push({
      value, index, kind,
      valid: kind === "iban" ? validIban(value) : value.length >= 9,
      beneficiary: BENEFICIARY_CONTEXT.test(tail),
      own: OWN_ACCOUNT_CONTEXT.test(tail),
    });
  };

  // `tight` keeps an IBAN in one piece; `flat` survives OCR that dropped spaces.
  for (const text of [v.tight, v.flat]) {
    for (const m of text.matchAll(IBAN_TOKEN)) consider(text, m[1], m.index, "iban");
  }
  const ibanDigits = candidates.filter((c) => c.kind === "iban").map((c) => c.value.slice(2));
  for (const text of [v.tight, v.flat]) {
    for (const m of text.matchAll(PLAIN_ACCOUNT_TOKEN)) {
      if (ibanDigits.some((d) => d.includes(m[1]))) continue;   // the tail of an IBAN
      consider(text, m[1], m.index, "plain");
    }
  }

  const usable = candidates.filter((c) => c.valid);
  const pool = usable.length ? usable : candidates;
  if (!pool.length) return { receiver_account: "", receiver_account_valid: null,
                             receiver_accounts: [], sender_account: "" };

  const rank = (c) => (c.kind === "iban" ? 2 : 0) + (c.valid ? 1 : 0);
  const pick = (list) => list.sort((a, b) => rank(b) - rank(a))[0];

  let receiver = pick(pool.filter((c) => c.beneficiary && !c.own));
  let sender = pick(pool.filter((c) => c.own && !c.beneficiary));

  if (!receiver) {
    // No label found: the beneficiary's number is the later one on the page.
    const rest = pool.filter((c) => c !== sender);
    receiver = rest.length ? rest[rest.length - 1] : null;
  }
  if (!sender) sender = pool.find((c) => c !== receiver) || null;

  // every candidate on the beneficiary's side, so both an IBAN and a plain
  // account number for the same company can be remembered together
  const receiverAll = receiver
    ? [...new Set(pool.filter((c) => c.beneficiary || c === receiver)
                      .map((c) => normaliseAccount(c.value)))]
    : [];

  return {
    receiver_account: normaliseAccount(receiver?.value || ""),
    receiver_account_kind: receiver?.kind || "",
    receiver_account_valid: receiver ? receiver.valid : null,
    receiver_accounts: receiverAll,
    sender_account: normaliseAccount(sender?.value || ""),
  };
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
  const v = views(normaliseArabic(text || ""));
  const fields = {
    bank_name: findBank(v),
    direction: findDirection(v),
    sender_name: cleanParty(firstMatch(REMITTER_RULES, v)) || cleanParty(firstMatch(SENDER_RULES, v)),
    receiver_name: trimBankSuffix(cleanParty(firstMatch(RECEIVER_RULES, v))),
    receiver_bank: firstMatch(RECEIVER_BANK_RULES, v),
    invoice_number: firstMatch(INVOICE_RULES, v),
    reference_number: firstMatch(REFERENCE_RULES, v),
    transaction_date: findDate(v),
    ...findAmounts(v),
  };
  Object.assign(fields, findAccounts(v));

  fields.beneficiary_id = firstMatch(BENEFICIARY_ID_RULES, v);
  if (!fields.receiver_account) {
    const internal = firstMatch(INTERNAL_TRANSFER_ACCOUNT_RULES, v);
    if (internal) {
      fields.receiver_account = internal;
      fields.receiver_account_kind = "plain";
      fields.receiver_account_valid = true;
      fields.receiver_accounts = [internal];
    }
  }
  // The beneficiary id is a learning key in its own right, kept apart from real
  // account numbers so the two can never be confused.
  if (fields.beneficiary_id) {
    fields.receiver_accounts = [...new Set([...(fields.receiver_accounts || []),
                                            `BENID:${fields.beneficiary_id}`])];
    if (!fields.receiver_account) fields.receiver_account = `BENID:${fields.beneficiary_id}`;
  }
  // An Arabic name goes into the file name in Latin letters; the printed form is
  // kept so a correction can be matched against it later.
  fields.sender_name_en = hasArabic(fields.sender_name)
    ? transliterate(fields.sender_name) : fields.sender_name;
  fields.receiver_name_en = hasArabic(fields.receiver_name)
    ? transliterate(fields.receiver_name) : fields.receiver_name;
  applyAliases(fields, aliases);

  // The company that matters for the file name is the other side of the payment:
  // the beneficiary when money went out, the payer when money came in.
  const counterparty = fields.direction === "in"
    ? (fields.sender_name_en || fields.sender_name || fields.receiver_name_en || fields.receiver_name)
    : (fields.receiver_name_en || fields.receiver_name || fields.sender_name_en || fields.sender_name);
  fields.party_name = counterparty || "";

  const partyKey = fields.direction === "in" ? "sender_name" : "receiver_name";
  const missing = ["bank_name", partyKey, "amount"].filter((k) => !fields[k]);
  fields.confidence = missing.length === 0 ? "high" : (missing.length === 1 ? "medium" : "low");
  fields.missing = missing;
  return fields;
}

/** Two receipts for the same bank, beneficiary, amount and day are almost
    certainly the same payment filed twice - worth flagging before renaming. */
export function duplicateKey(fields) {
  const receiver = aliasKey(fields.receiver_name_en || fields.receiver_name || "");
  if (!fields.amount || !receiver) return "";
  return [canonicalBank(fields.bank_name || ""), receiver, fields.amount,
          (fields.transaction_date || "").slice(0, 10)].join("|");
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
  // "MMS Recycle" is initials plus a word: keep the initials shouting.
  const mixedCase = /[a-z]/.test(normalised) && /[A-Z]/.test(normalised);
  let words = normalised.split(/[^0-9A-Za-z؀-ۿ]+/).filter(Boolean);
  if (stripLegal) {
    while (words.length && LEGAL_SUFFIXES.has(words[words.length - 1].toLowerCase().replace(/\./g, "")))
      words.pop();
  }
  return words.map((w) => {
    if (KNOWN_ACRONYMS.has(w.toUpperCase()) || /^\d+$/.test(w)) return /^[A-Za-z]+$/.test(w) ? w.toUpperCase() : w;
    if (mixedCase && w.length <= 4 && /^[A-Z]+$/.test(w)) return w;
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
  const digits = s.match(/\d{3,}/g) || [];
  if (digits.length === 1 && !/[A-Za-z]{3,}/.test(s)) return digits[0];   // keep 00570 as printed
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

/** "Wajd Alamani Contracting Establishment" -> "Wajd Alamani".
    Long legal names make unreadable file names; the first words identify a
    supplier just as well. 0 keeps the whole name. */
export function shortenName(name, words = 2) {
  if (!name || !words) return name || "";
  const parts = String(name).trim().split(/\s+/);
  return parts.slice(0, words).join(" ");
}

export function buildName(fields, template, original, stripLegal = true,
                          invoiceFallback = true, nameWords = 2) {
  let invoice = cleanInvoice(fields.invoice_number);
  if (!invoice && invoiceFallback) invoice = invoiceFromName(original);

  const party = fields.party_name
    || (fields.direction === "in" ? (fields.sender_name_en || fields.sender_name)
                                  : (fields.receiver_name_en || fields.receiver_name)) || "";

  const values = {
    bank: canonicalBank(fields.bank_name || ""),
    receiver_bank: canonicalBank(fields.receiver_bank || ""),
    sender: camel(shortenName(fields.sender_name_en || fields.sender_name || "", nameWords), stripLegal),
    receiver: camel(shortenName(fields.receiver_name_en || fields.receiver_name || "", nameWords), stripLegal),
    party: camel(shortenName(party, nameWords), stripLegal),
    amount: cleanAmount(fields.amount),
    amount_net: cleanAmount(fields.amount_net),
    currency: (fields.currency || "").toUpperCase().slice(0, 4),
    invoice,
    inv: invoice ? `INV_${invoice}` : "",
    ref: cleanRef(fields.reference_number),
    ben_id: fields.beneficiary_id || "",
    date: (fields.transaction_date || "").slice(0, 10),
    orig: original.replace(/\.[^.]*$/, ""),
  };
  if (!values.amount) values.currency = "";

  const rendered = template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
  return sanitize(rendered) + ".pdf";
}
