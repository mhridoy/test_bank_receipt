/* Arabic handling: normalise what the PDF gives us, and turn a company name into
   something usable in a file name.

   Arabic omits short vowels, so a letter-by-letter transliteration alone reads
   badly ("wjd almany llmqawlat"). A dictionary of the words that actually turn up
   on Saudi receipts fixes the common cases; anything unknown falls back to the
   letter map. Whatever it produces is only a first guess - one "Fix name" and the
   app remembers the proper spelling for that beneficiary forever. */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Presentation forms (ﺷﺮﻛﺔ) -> real letters (شركة), then strip harakat. */
export function normaliseArabic(text) {
  return String(text || "").normalize("NFKC").replace(DIACRITICS, "");
}

export const hasArabic = (text) => /[؀-ۿ]/.test(String(text || ""));

/* Words that mean "company" and friends - dropped from a file name. */
const LEGAL_WORDS = new Set(["شركة", "شركه", "مؤسسة", "مؤسسه", "مصنع", "مجموعة", "ذمم"]);

const WORDS = {
  "آرث": "Arth", "ألميدين": "Almedin", "الميدين": "Almedin",
  "وجد": "Wajd", "الأماني": "Alamani", "الاماني": "Alamani", "للمقاولات": "Contracting",
  "المقاولات": "Contracting", "للخدمات": "Services", "الخدمات": "Services",
  "البيئية": "Environmental", "التجارية": "Trading", "للتجارة": "Trading",
  "الخليجية": "Gulf", "الفيصل": "Alfaisal", "ريسايكل": "Recycle", "سولوشنز": "Solutions",
  "ليان": "Layan", "محمد": "Mohammed", "الكنعاني": "Alkanaani", "مها": "Maha",
  "صقر": "Saqr", "المطيري": "Almutairi", "بايونير": "Pioneer", "ميتال": "Metal",
  "كورنرز": "Corners", "طبيب": "Tabeeb", "العربية": "Arabia", "الوطنية": "National",
  "السعودية": "Saudi", "المحدودة": "Ltd", "للمقاولات العامة": "General Contracting",
  "للنقل": "Transport", "للصناعة": "Industry", "الصناعية": "Industrial",
  "للمعدات": "Equipment", "للتشغيل": "Operation", "والصيانة": "Maintenance",
  "الحديثة": "Modern", "المتحدة": "United", "الدولية": "International",
  "إم": "M", "ام": "M", "إس": "S", "اس": "S", "بضاعة": "Goods", "شراء": "Purchase",
};

const LETTERS = {
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ب": "b", "ت": "t", "ث": "th", "ج": "j",
  "ح": "h", "خ": "kh", "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh",
  "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh", "ف": "f", "ق": "q",
  "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "ة": "a", "و": "u", "ي": "i",
  "ى": "a", "ء": "", "ئ": "i", "ؤ": "u", "پ": "p", "چ": "ch", "ژ": "zh", "ڤ": "v", "گ": "g",
};

function transliterateWord(word) {
  if (WORDS[word]) return WORDS[word];
  let out = "";
  let rest = word;
  if (rest.startsWith("ال") && rest.length > 3) { out = "Al"; rest = rest.slice(2); }
  for (const char of rest) out += LETTERS[char] ?? (/[0-9A-Za-z]/.test(char) ? char : "");
  out = out.replace(/(.)\1{2,}/g, "$1$1");
  if (!out) return "";
  return out[0].toUpperCase() + out.slice(1);
}

/** "شركة وجد الأماني للمقاولات" -> "Wajd Alamani Contracting" */
export function transliterate(text, dropLegal = true) {
  const cleaned = normaliseArabic(text).replace(/[^\p{L}\p{N}\s'&.-]/gu, " ");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const out = [];
  for (const word of words) {
    if (dropLegal && LEGAL_WORDS.has(word)) continue;
    if (!/[؀-ۿ]/.test(word)) { out.push(word); continue; }   // already Latin
    const latin = transliterateWord(word);
    if (latin) out.push(latin);
  }
  // "إم إم إس" transliterates to "M M S" - three initials are one word.
  const merged = [];
  for (const word of out) {
    const previous = merged[merged.length - 1];
    if (word.length === 1 && previous && previous.length <= 3 && /^[A-Z]+$/.test(previous)) {
      merged[merged.length - 1] = previous + word.toUpperCase();
    } else {
      merged.push(word);
    }
  }
  return merged.join(" ").replace(/\s{2,}/g, " ").trim();
}
