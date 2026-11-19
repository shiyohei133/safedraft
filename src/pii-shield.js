/**
 * SafeDraft — PII Shield
 *
 * A deterministic, AI-free personal-data shield. It detects common kinds of
 * personally identifiable information (PII) with regular expressions and
 * small dictionary rules, replaces them with stable placeholders such as
 * [EMAIL_1], and restores the originals after the AI has processed the
 * masked text.
 *
 * Design rules:
 *  - No AI, no network, no randomness: the same input always produces the
 *    same output, so the behaviour is unit-testable and auditable.
 *  - The placeholder -> original mapping is kept only in memory by the
 *    caller. It is never persisted or sent anywhere by this module.
 *  - Detection is heuristic. It is a risk-reduction layer, not a guarantee;
 *    see README.md ("Limitations") for an honest discussion.
 */

export const ENTITY_TYPES = Object.freeze({
  EMAIL: "EMAIL",
  URL: "URL",
  CREDIT_CARD: "CREDIT_CARD",
  POSTAL_CODE: "POSTAL_CODE",
  DATE: "DATE",
  PHONE: "PHONE",
  MONEY: "MONEY",
  ADDRESS: "ADDRESS",
  NAME: "NAME",
  ID_NUMBER: "ID_NUMBER",
});

/** Lower number = wins when two candidates start at the same position. */
const PRIORITY = Object.freeze({
  EMAIL: 1,
  URL: 2,
  CREDIT_CARD: 3,
  POSTAL_CODE: 4,
  DATE: 5,
  PHONE: 6,
  MONEY: 7,
  ADDRESS: 8,
  NAME: 9,
  ID_NUMBER: 10,
});

/* ------------------------------------------------------------------ */
/* Dictionaries                                                        */
/* ------------------------------------------------------------------ */

/** Common Japanese family names (heuristic dictionary for name spotting). */
const JA_SURNAMES = [
  "佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "山本", "中村", "小林", "加藤",
  "吉田", "山田", "佐々木", "山口", "松本", "井上", "木村", "林", "斎藤", "斉藤",
  "清水", "山崎", "森", "池田", "橋本", "阿部", "石川", "山下", "中島", "石井",
  "小川", "前田", "岡田", "長谷川", "藤田", "後藤", "近藤", "村上", "遠藤", "青木",
  "坂本", "福田", "太田", "西村", "藤井", "金子", "岡本", "藤原", "中野", "三浦",
  "原田", "小野", "田村", "竹内", "中山", "和田", "石田", "森田", "内田", "柴田",
  "酒井", "原", "宮崎", "横山", "高木", "藤本", "村田", "武田", "上田", "杉山",
  "安藤", "小島", "大野", "千葉", "久保", "松井", "岩崎", "桜井", "野口", "松尾",
  "菊地", "野村", "新井", "渡部", "今井", "河野", "小山", "高田", "丸山", "今村",
  "大塚",
  // Variant / old-form spellings of common surnames (same readings,
  // different glyphs — a dictionary keyed on the modern form misses them).
  "齋藤", "齊藤", "渡邊", "渡邉", "髙橋", "濱田", "濱崎", "廣瀬",
];

/** Common English given names (used for "Firstname Lastname" spotting). */
const EN_FIRST_NAMES = [
  "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
  "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph",
  "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Daniel", "Lisa", "Matthew",
  "Nancy", "Donald", "Betty", "Mark", "Margaret", "Steven", "Sandra", "Paul",
  "Ashley", "Andrew", "Kimberly", "Joshua", "Emily", "Kenneth", "Michelle",
  "Kevin", "Dorothy", "Brian", "Amanda", "Timothy", "Deborah", "Ronald",
  "Stephanie", "Anthony", "Rebecca", "George", "Laura", "Edward", "Sharon",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Luhn check for card-like digit sequences. */
export function luhnValid(digits) {
  const s = String(digits).replace(/\D/g, "");
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97 check (ISO 13616): rearranged, letters→numbers, mod 97 == 1. */
export function ibanValid(iban) {
  const s = String(iban).replace(/\s/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits =
      ch >= "0" && ch <= "9" ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

const KANJI = "\\u4e00-\\u9fa5";
const KANJI_KANA = `${KANJI}\\u3041-\\u3096\\u30a1-\\u30f6`;

/**
 * Length-preserving width normalization for DETECTION ONLY: full-width
 * ASCII-range characters (０-９, Ａ-Ｚ, ＠, ．, － … U+FF01–FF5E) are folded
 * to their half-width forms, and halfwidth katakana (ｱ–ﾝ, U+FF61–FF9F)
 * are folded to fullwidth katakana. Every character maps to exactly one UTF-16
 * code unit, so spans found in the normalized text index the original
 * text correctly. Japanese text typed with an IME very often contains
 * full-width digits and symbols, and those must not slip past the shield.
 */
/** Halfwidth katakana/punctuation (U+FF61–FF9D) → fullwidth equivalents. */
const HALFWIDTH_KANA =
  "。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソ" +
  "タチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン";

export function normalizeWidth(text) {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/[\uFF61-\uFF9F]/g, (ch) => {
      const code = ch.charCodeAt(0);
      // Voiced/semi-voiced marks become combining marks (still 1 code unit,
      // so the mapping stays length-preserving).
      if (code === 0xff9e) return "゙";
      if (code === 0xff9f) return "゚";
      return HALFWIDTH_KANA[code - 0xff61];
    });
}

/**
 * Run a global regex (must have the /d flag) over `matchText` (the
 * width-normalized text) and push candidate spans into `out`. Span values
 * are sliced from `origText` so entities always carry the user's original
 * characters. If `group` is set, the span of that capture group is used
 * instead of the whole match.
 */
function collect(out, matchText, origText, regex, type, group = 0) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(matchText)) !== null) {
    const span = group === 0 ? m.indices[0] : m.indices[group];
    if (!span) continue;
    const [start, end] = span;
    if (end > start) {
      out.push({ start, end, type, value: origText.slice(start, end) });
    }
    if (m[0].length === 0) regex.lastIndex++;
  }
}

/* ------------------------------------------------------------------ */
/* Detectors — each returns candidate spans (may overlap)              */
/* ------------------------------------------------------------------ */

function detectAll(text) {
  const out = [];
  // Detection runs on a width-normalized copy (full-width digits/symbols
  // folded to half-width); spans index both copies identically, and entity
  // values are always sliced from the ORIGINAL text.
  const norm = normalizeWidth(text);

  // Email addresses. Part lengths are bounded (RFC 5321: local part ≤ 64)
  // so a long token without "@" cannot cause quadratic backtracking.
  collect(out, norm, text, /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,24}/gd, "EMAIL");

  // URLs (trailing sentence punctuation is trimmed afterwards).
  {
    const re = /(?:https?:\/\/|www\.)[^\s<>"'）」』]+/gd;
    let m;
    while ((m = re.exec(norm)) !== null) {
      let [start, end] = m.indices[0];
      while (end > start && ".,;:!?、。)）]".includes(norm[end - 1])) end--;
      if (end > start) out.push({ start, end, type: "URL", value: text.slice(start, end) });
    }
  }

  // Credit cards: 4-4-4-4 grouped format (card-shaped, masked regardless of
  // Luhn), and long contiguous digit runs that pass the Luhn check.
  collect(out, norm, text, /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/gd, "CREDIT_CARD");
  {
    const re = /\b\d{13,19}\b/gd;
    let m;
    while ((m = re.exec(norm)) !== null) {
      if (luhnValid(m[0])) {
        const [start, end] = m.indices[0];
        out.push({ start, end, type: "CREDIT_CARD", value: text.slice(start, end) });
      }
    }
  }

  // Japanese postal code with the 〒 mark.
  collect(out, norm, text, /〒\s?\d{3}-\d{4}/gd, "POSTAL_CODE");
  // Bare postal code without 〒. The lookahead refuses a match when more
  // digit groups follow, so a phone number like 090-1234-5678 is never
  // truncated into a "postal code" — the PHONE candidate wins instead.
  collect(out, norm, text, /(?<![\d-])\d{3}-\d{4}(?![- ]?\d)/gd, "POSTAL_CODE");

  // US ZIP codes: ZIP+4 anywhere, and 5-digit ZIP after a state code
  // ("Mountain View, CA 94043"). A bare 5-digit run alone is too ambiguous
  // (quantities, years) to mask safely.
  collect(out, norm, text, /\b\d{5}-\d{4}\b/gd, "POSTAL_CODE");
  collect(out, norm, text, /\b[A-Z]{2}\s+(\d{5}(?:-\d{4})?)\b/gd, "POSTAL_CODE", 1);
  // UK postcodes ("SW1A 1AA") and Canadian postal codes ("K1A 0B1").
  collect(out, norm, text, /\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b/gd, "POSTAL_CODE");
  collect(out, norm, text, /\b[A-Z]\d[A-Z]\s\d[A-Z]\d\b/gd, "POSTAL_CODE");
  // German PLZ: 5 digits directly before a capitalized city name
  // ("10115 Berlin") — the city anchor keeps bare numbers safe.
  collect(out, norm, text, /\b(\d{5})(?=\s+[A-ZÄÖÜ][a-zäöüß]+)/gd, "POSTAL_CODE", 1);

  // Dates (Japanese, ISO-ish, US/EU numeric, and month-name forms).
  const MONTH =
    "January|February|March|April|May|June|July|August|September|October|" +
    "November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|" +
    "Aug\\.?|Sep\\.?|Sept\\.?|Oct\\.?|Nov\\.?|Dec\\.?";
  collect(
    out, norm, text,
    new RegExp(
      `\\d{4}年\\d{1,2}月\\d{1,2}日|\\b\\d{4}\\/\\d{1,2}\\/\\d{1,2}\\b|\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b|` +
        `\\b\\d{1,2}\\/\\d{1,2}\\/\\d{4}\\b|\\b\\d{1,2}\\.\\d{1,2}\\.\\d{4}\\b|` +
        `\\b(?:${MONTH})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b|` +
        `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH}),?\\s+\\d{4}\\b`,
      "gd",
    ),
    "DATE",
  );

  // Phone numbers: international JP, JP hyphenated, JP contiguous, US forms.
  // Japanese users separate digit groups with many different characters:
  // ASCII hyphen, full-width hyphen (folded to "-" by normalizeWidth),
  // middle dots (・ U+30FB, ･ U+FF65), the long-vowel mark (ー U+30FC,
  // ｰ U+FF70), minus signs (− U+2212) and assorted Unicode dashes.
  // All of them must be accepted as group separators or real-world input
  // typed on a Japanese IME leaks through.
  const PHONE_SEP = "[-・･ーｰ−‐‑–—―]";
  const phoneJoin = `(?:\\s*${PHONE_SEP}\\s*|\\s+)`;
  collect(
    out, norm, text,
    new RegExp(`\\(?\\+81\\)?${phoneJoin}?\\d{1,4}${phoneJoin}?\\d{1,4}${phoneJoin}?\\d{4}`, "gd"),
    "PHONE",
  );
  collect(
    out, norm, text,
    new RegExp(`0\\d{1,4}${phoneJoin}\\d{1,4}${phoneJoin}\\d{4}`, "gd"),
    "PHONE",
  );
  // Toll-free (0120/0800), Navi Dial (0570) and 0180 numbers use a 3-3
  // grouping instead of the usual 4-digit tail.
  collect(
    out, norm, text,
    new RegExp(`(?:0120|0800|0570|0180)${phoneJoin}\\d{3}${phoneJoin}\\d{3}`, "gd"),
    "PHONE",
  );
  collect(
    out, norm, text,
    new RegExp(`(?:0120|0800)${phoneJoin}\\d{6}`, "gd"),
    "PHONE",
  );
  // Parenthesized area/exchange codes: "03(1234)5678" and "(03) 1234-5678"
  // are both standard Japanese notations (full-width parens are folded to
  // half-width by normalizeWidth).
  collect(out, norm, text, new RegExp(`0\\d{1,4}\\(\\d{1,4}\\)\\d{4}`, "gd"), "PHONE");
  collect(
    out, norm, text,
    new RegExp(`\\(0\\d{1,4}\\)\\s?\\d{1,4}${phoneJoin}\\d{4}`, "gd"),
    "PHONE",
  );
  collect(out, norm, text, /\b0\d{9,10}\b/gd, "PHONE");
  collect(out, norm, text, /\(\d{3}\)\s?\d{3}[- ]\d{4}/gd, "PHONE");
  collect(out, norm, text, /\b\d{3}[- ]\d{3}[- ]\d{4}\b/gd, "PHONE");
  // US/Canada with the +1 country code — the prefix must be inside the
  // masked span, not left visible next to the placeholder.
  collect(out, norm, text, /\+1[- ]?\(\d{3}\)\s?\d{3}[- ]\d{4}/gd, "PHONE");
  collect(out, norm, text, /\+1[- ]\d{3}[- ]\d{3}[- ]\d{4}/gd, "PHONE");
  // Generic international format: +<country> followed by 2–5 short
  // groups (+44 20 7946 0958, +33 1 42 68 53 00, +61 2 9374 4000 …).
  // The leading "+" keeps this from touching ordinary number runs.
  collect(out, norm, text, /(?<!\d)\+\d{1,3}(?:[- ]\d{1,4}){2,5}(?!\d)/gd, "PHONE");

  // Money amounts (a currency marker is always required).
  collect(
    out, norm, text,
    /(?:¥|￥)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?円|\$\s?\d[\d,]*(?:\.\d{1,2})?|\bUSD\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d+)?\s?(?:ドル|ユーロ|ポンド)/gd,
    "MONEY",
  );

  // Japanese addresses: prefecture … city/ward … block numbers.
  // Block-number endings seen in the wild: hyphenated (1-2-3),
  // 丁目・番・号 (1丁目2番3号), 番・号 (2番3号) and 番地 forms
  // (123番地 / 123番地の4 / 123番地4号) — the last is the standard form
  // for 郡 (county) towns and rural addresses.
  const ADDR_TAIL =
    `\\d+(?:-\\d+){1,2}|\\d+丁目\\d+番\\d+号|\\d+番\\d+号|` +
    `\\d+番地の\\d+|\\d+番地\\d+号?|\\d+番地`;
  // Optional trailing parts of a full address: building name
  // (…ビル / …マンション / …タワー …), floor (5階 / 5F) and room number
  // (502号室). Each part is anchored by its suffix, so ordinary sentences
  // are not swallowed.
  const ADDR_SUFFIX =
    `(?:\\s?[${KANJI_KANA}A-Za-z0-9・]{2,16}?(?:ビルディング|マンション|レジデンス|ビル|ハイツ|コーポ|タワー))?` +
    `(?:\\s?\\d{1,3}(?:階|F))?(?:\\s?\\d{1,4}号室)?`;
  collect(
    out, norm, text,
    new RegExp(
      `(?:北海道|[${KANJI}]{2,4}県|東京都|大阪府|京都府)` +
        `[${KANJI_KANA}]{1,10}?(?:区|市|町|村)` +
        `[${KANJI_KANA}\\d]{0,14}?(?:${ADDR_TAIL})${ADDR_SUFFIX}`,
      "gd",
    ),
    "ADDRESS",
  );
  // P.O. box (私書箱) — masked on its own so it is also caught when it
  // follows a street address or stands alone.
  collect(out, norm, text, /私書箱\s?第?\d+号/gd, "ADDRESS");
  // Designated cities (政令指定都市) are routinely written WITHOUT the
  // prefecture — "横浜市西区…" instead of "神奈川県横浜市西区…". A closed
  // list of the 20 designated cities keeps this from over-matching
  // ordinary city mentions: a block-number ending is still required.
  const DESIGNATED_CITIES =
    "札幌市|仙台市|さいたま市|千葉市|横浜市|川崎市|相模原市|新潟市|静岡市|浜松市|" +
    "名古屋市|京都市|大阪市|堺市|神戸市|岡山市|広島市|北九州市|福岡市|熊本市";
  collect(
    out, norm, text,
    new RegExp(
      `(?:${DESIGNATED_CITIES})` +
        `[${KANJI_KANA}]{1,10}?(?:区)?` +
        `[${KANJI_KANA}\\d]{0,14}?(?:${ADDR_TAIL})${ADDR_SUFFIX}`,
      "gd",
    ),
    "ADDRESS",
  );

  // English street addresses: "1600 Amphitheatre Parkway" style / number + street + suffix.
  // An optional unit designator (Apt 4B / Suite 500 / Unit 12) is part of
  // the address and is masked with it.
  collect(
    out, norm, text,
    /\b\d{1,5}\s+(?:[A-Z][A-Za-z]+\s+){1,3}?(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Lane|Ln\.|Drive|Dr\.|Court|Ct\.|Parkway|Pkwy\.)(?:,?\s+(?:Apt\.?|Suite|Ste\.?|Unit)\s+[A-Za-z0-9-]+)?\b/gd,
    "ADDRESS",
  );
  // US P.O. Box.
  collect(out, norm, text, /\b[Pp]\.?[Oo]\.?\s+[Bb]ox\s+\d+\b/gd, "ADDRESS");
  // German street addresses: "Musterstraße 12" (street name first,
  // house number after; German street nouns are capitalized).
  collect(
    out, norm, text,
    /\b[A-ZÄÖÜ][a-zäöüß]+(?:straße|strasse|str\.|weg|platz|allee|gasse|ring|damm|ufer)\s+\d+[a-z]?\b/gd,
    "ADDRESS",
  );

  /* ---- Names (Japanese) ---- */
  const surnameAlt = [...new Set(JA_SURNAMES)]
    .sort((a, b) => b.length - a.length)
    .join("|");
  // Family name + given name directly followed by an honorific. A space
  // between family and given name ("田中 太郎 様") and a parenthesized
  // reading ("田中太郎（タナカタロウ）様") are both common in real mail.
  collect(
    out, norm, text,
    new RegExp(
      `(?:${surnameAlt})\\s?[${KANJI_KANA}]{1,3}` +
        `(?=(?:\\s*[（(][^）)]{1,16}[）)])?\\s*(?:さん|様|氏|君|ちゃん|先生|殿))`,
      "gd",
    ),
    "NAME",
  );
  // Surname alone + honorific ("田中様、いつもお世話に…") — in context a
  // bare surname still identifies the person.
  collect(
    out, norm, text,
    new RegExp(
      `(?:${surnameAlt})(?=\\s*(?:様|さん|氏|殿|先生))`,
      "gd",
    ),
    "NAME",
  );
  // Family name + given name (2–3 chars) followed by a subject/topic
  // particle — catches plain sentences like 「田中太郎が担当します」 that
  // carry no honorific. Candidates ending in geographic suffixes are
  // rejected so place words such as 「中山間部」 are not masked.
  {
    const re = new RegExp(
      `(?:${surnameAlt})\\s?[${KANJI_KANA}]{2,3}(?=[がは])`,
      "gd",
    );
    let m;
    while ((m = re.exec(norm)) !== null) {
      const [start, end] = m.indices[0];
      const value = text.slice(start, end);
      if (/[部市区町村川山島湖]$/.test(value)) continue;
      out.push({ start, end, type: "NAME", value });
    }
  }
  // "<name>と申します" — the classic self-introduction. The character class
  // stops at particles (の/は/が…) so a preceding company name such as
  // 「…商事の田中太郎と申します」 yields just the person's name.
  collect(
    out, norm, text,
    new RegExp(
      `(?:(?![のはがをにへと、。])[${KANJI_KANA}]){2,7}(?=と申します)`,
      "gd",
    ),
    "NAME",
  );
  // "私は〜です" / "名前は〜です".
  collect(
    out, norm, text,
    new RegExp(`(?:私の名前は|私は|わたしは|僕は|名前は|氏名は)([${KANJI_KANA}]{2,8}?)(?:です|と申します)`, "gd"),
    "NAME",
    1,
  );
  // Labelled names: 氏名：〜 / 担当者: 〜 etc.
  collect(
    out, norm, text,
    new RegExp(
      `(?:氏名|お名前|名前|担当者|ご担当者|申込者|契約者|代表者)[:：]\\s*([^\\s、。（）]{2,8})`,
      "gd",
    ),
    "NAME",
    1,
  );
  // Katakana names: "タナカ・タロウ" (middle-dot form) and before honorifics.
  collect(out, norm, text, /[ァ-ヶ]{2,}(?:・[ァ-ヶ]{1,})+/gd, "NAME");
  collect(out, norm, text, /[ァ-ヶー]{2,6}(?:\s[ァ-ヶー]{1,6})?(?=\s*(?:さん|様|氏))/gd, "NAME");

  /* ---- Names (English) ---- */
  collect(
    out, norm, text,
    /\b(?:Mr\.|Mrs\.|Ms\.|Miss|Dr\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gd,
    "NAME",
    1,
  );
  collect(
    out, norm, text,
    /\bMy name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gd,
    "NAME",
    1,
  );
  collect(
    out, norm, text,
    /\bDear\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gd,
    "NAME",
    1,
  );
  collect(
    out, norm, text,
    /(?:Best regards|Sincerely|Regards|Warm regards),?\s*\n\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gd,
    "NAME",
    1,
  );
  {
    const firstAlt = EN_FIRST_NAMES.join("|");
    collect(
      out, norm, text,
      new RegExp(`\\b(?:${firstAlt})\\s+[A-Z][a-z]+\\b`, "gd"),
      "NAME",
    );
  }

  /* ---- ID-like numbers ---- */
  // Labelled IDs: ID: XXXX / 会員番号：XXXX / 注文番号 XXXX …
  // "No" must be a standalone abbreviation — followed by ".", ":" or a
  // space — otherwise ordinary words like "November" lose their tail
  // ("No" + "vember") to this detector.
  collect(
    out, norm, text,
    /(?:マイナンバー|個人番号|口座番号|会員番号|顧客番号|注文番号|伝票番号|番号|\bID\b|\bNo(?:\.|:|(?=\s)))[:：\s]*([A-Za-z0-9][A-Za-z0-9-]{3,20})/gd,
    "ID_NUMBER",
    1,
  );
  // US Social Security numbers (3-2-4 grouping).
  collect(out, norm, text, /\b\d{3}-\d{2}-\d{4}\b/gd, "ID_NUMBER");
  // IBANs, validated with the mod-97 check so random letter/digit strings
  // are not masked. An IBAN candidate starts before any card-shaped digit
  // group inside it, so it wins the overlap resolution over CREDIT_CARD.
  {
    const re = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,6}(?:\s?[A-Z0-9]{1,3})?\b/gd;
    let m;
    while ((m = re.exec(norm)) !== null) {
      if (ibanValid(m[0])) {
        const [start, end] = m.indices[0];
        out.push({ start, end, type: "ID_NUMBER", value: text.slice(start, end) });
      }
    }
  }
  // Long bare digit runs (12+) that are not valid cards — e.g. My Number.
  collect(out, norm, text, /\b\d{12,}\b/gd, "ID_NUMBER");

  return out;
}

/* ------------------------------------------------------------------ */
/* Overlap resolution                                                  */
/* ------------------------------------------------------------------ */

function resolveOverlaps(candidates) {
  const sorted = [...candidates].sort(
    (a, b) =>
      a.start - b.start ||
      PRIORITY[a.type] - PRIORITY[b.type] ||
      (b.end - b.start) - (a.end - a.start),
  );
  const accepted = [];
  let cursor = -1;
  for (const c of sorted) {
    if (c.start >= cursor) {
      accepted.push(c);
      cursor = c.end;
    }
  }
  return accepted;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Mask all detected PII in `text`.
 *
 * @returns {{
 *   maskedText: string,
 *   entities: Array<{id:number, type:string, placeholder:string,
 *                    original:string, start:number, end:number}>,
 *   maskedSpans: Array<{start:number, end:number, type:string, placeholder:string}>
 * }} `entities` spans refer to the ORIGINAL text; `maskedSpans` spans refer
 *    to the MASKED text (for highlighting).
 */
/**
 * Placeholder bracket styles, in preference order. If the user's own text
 * already contains something that looks like a placeholder (e.g. a literal
 * "[EMAIL_1]"), mask() switches to the next style so that restore() can
 * never rewrite the user's literal text by accident.
 */
const PLACEHOLDER_STYLES = [
  ["[", "]"],
  ["⟦", "⟧"],
  ["«", "»"],
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickPlaceholderStyle(text) {
  for (const [open, close] of PLACEHOLDER_STYLES) {
    const probe = new RegExp(
      `${escapeRegExp(open)}[A-Z][A-Z_]*_\\d+${escapeRegExp(close)}`,
    );
    if (!probe.test(text)) return [open, close];
  }
  return ["[PII-", "]"];
}

export function mask(text) {
  if (!text) return { maskedText: "", entities: [], maskedSpans: [] };
  const accepted = resolveOverlaps(detectAll(text));
  const [pOpen, pClose] = pickPlaceholderStyle(text);
  const counters = new Map();
  const entities = [];
  const maskedSpans = [];
  let out = "";
  let pos = 0;
  let maskedPos = 0;
  for (const span of accepted) {
    const n = (counters.get(span.type) ?? 0) + 1;
    counters.set(span.type, n);
    const placeholder = `${pOpen}${span.type}_${n}${pClose}`;
    out += text.slice(pos, span.start);
    maskedPos += span.start - pos;
    const mStart = maskedPos;
    out += placeholder;
    maskedPos += placeholder.length;
    maskedSpans.push({ start: mStart, end: maskedPos, type: span.type, placeholder });
    entities.push({
      id: entities.length + 1,
      type: span.type,
      placeholder,
      original: span.value,
      start: span.start,
      end: span.end,
    });
    pos = span.end;
  }
  out += text.slice(pos);
  return { maskedText: out, entities, maskedSpans };
}

/**
 * Restore placeholders in `text` (typically AI output) back to the originals
 * recorded by mask(). Every occurrence of each placeholder is replaced.
 */
export function restore(text, entities) {
  if (!text) return "";
  let out = text;
  for (const e of entities) {
    out = out.split(e.placeholder).join(e.original);
  }
  return out;
}

/** Convenience: detect only (spans in original-text coordinates). */
export function detect(text) {
  if (!text) return [];
  return resolveOverlaps(detectAll(text)).map((s, i) => ({
    id: i + 1,
    type: s.type,
    original: s.value,
    start: s.start,
    end: s.end,
  }));
}

/**
 * Return the originals that still appear verbatim inside a masked text.
 * Used by tests (and available to the UI) as a leak check.
 */
export function findLeaks(maskedText, entities) {
  return entities.filter((e) => e.original && maskedText.includes(e.original));
}

/* ------------------------------------------------------------------ */
/* AI-output accident handling                                         */
/* ------------------------------------------------------------------ */

/** Bracket characters a model might substitute for [ ]. */
const OPEN_BRACKETS = "\\[\\uFF3B\\u27E6\\u00AB\\u3010";
const CLOSE_BRACKETS = "\\]\\uFF3D\\u27E7\\u00BB\\u3011";

/**
 * Repair placeholders that a model almost-but-not-quite preserved:
 * different brackets (［ ］, ⟦ ⟧, « », 【 】), stray spaces inside the
 * brackets, lower-cased type names, "_" turned into "-", or the brackets
 * dropped entirely. Only tokens whose canonical form is ABSENT are
 * repaired, so text that already contains the exact placeholder is never
 * rewritten. Returns the (possibly) updated text and the placeholders
 * that were repaired.
 */
export function repairPlaceholders(text, entities) {
  if (!text || !entities || entities.length === 0) {
    return { text: text ?? "", repaired: [] };
  }
  let out = text;
  const repaired = [];
  for (const e of entities) {
    if (out.includes(e.placeholder)) continue;
    const inner = e.placeholder.slice(1, -1);
    const innerRe = escapeRegExp(inner).replace(/_/g, "[_\\-\\s]?");
    const bracketed = new RegExp(
      `[${OPEN_BRACKETS}]\\s*${innerRe}\\s*[${CLOSE_BRACKETS}]`,
      "gi",
    );
    if (bracketed.test(out)) {
      out = out.replace(bracketed, e.placeholder);
      repaired.push(e.placeholder);
      continue;
    }
    const bare = new RegExp(`\\b${innerRe}\\b`, "gi");
    if (bare.test(out)) {
      out = out.replace(bare, e.placeholder);
      repaired.push(e.placeholder);
    }
  }
  return { text: out, repaired };
}

/**
 * Audit a model output against the placeholders it was given:
 *  - missing:    entities whose placeholder never appears (dropped/altered)
 *  - duplicated: placeholders appearing more than once (restore() will
 *                substitute the original at every position)
 *  - unknown:    placeholder-shaped tokens that were never issued
 *                (hallucinated markers — they survive restore() untouched)
 */
export function analyzeAiOutput(text, entities) {
  const missing = [];
  const duplicated = [];
  for (const e of entities) {
    const count = text.split(e.placeholder).length - 1;
    if (count === 0) missing.push(e);
    else if (count > 1) duplicated.push({ placeholder: e.placeholder, count });
  }
  const known = new Set(entities.map((e) => e.placeholder));
  const tokenRe = new RegExp(
    `[${OPEN_BRACKETS}][A-Z][A-Z_]*_\\d+[${CLOSE_BRACKETS}]`,
    "g",
  );
  const unknown = [
    ...new Set(
      [...text.matchAll(tokenRe)]
        .map((m) => m[0])
        .filter((t) => !known.has(t)),
    ),
  ];
  return { missing, unknown, duplicated };
}

/** Count entities by type: { EMAIL: 2, PHONE: 1, ... } */
export function summarize(entities) {
  const counts = {};
  for (const e of entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}
