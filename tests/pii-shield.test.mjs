/**
 * Unit tests for the PII Shield (src/pii-shield.js).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mask,
  restore,
  detect,
  findLeaks,
  summarize,
  luhnValid,
} from "../src/pii-shield.js";
import { SAMPLE_JA, SAMPLE_EN } from "../src/samples.js";

const types = (text) => detect(text).map((e) => e.type);
const has = (text, type) => types(text).includes(type);

/* ---------- basic detectors ---------- */

test("email is masked and restored", () => {
  const src = "連絡先は taro.tanaka@example.co.jp です。";
  const { maskedText, entities } = mask(src);
  assert.ok(has(src, "EMAIL"));
  assert.ok(maskedText.includes("[EMAIL_1]"));
  assert.ok(!maskedText.includes("taro.tanaka@example.co.jp"));
  assert.equal(restore(maskedText, entities), src);
});

test("japanese phone numbers (hyphenated, contiguous, international)", () => {
  assert.ok(has("電話は 090-1234-5678 です", "PHONE"));
  assert.ok(has("電話は 09012345678 です", "PHONE"));
  assert.ok(has("Phone: +81 90-1234-5678", "PHONE"));
  assert.ok(has("03-4578-1234 に電話", "PHONE"));
});

test("US phone numbers", () => {
  assert.ok(has("Call (555) 013-4471 today", "PHONE"));
  assert.ok(has("Call 555-013-4471 today", "PHONE"));
});

test("URL is masked, trailing punctuation excluded", () => {
  const { maskedText, entities } = mask("詳細は https://example.co.jp/orders/123 を見てください。");
  assert.equal(entities.length, 1);
  assert.equal(entities[0].type, "URL");
  assert.ok(maskedText.endsWith("を見てください。"));
});

test("credit card: grouped and Luhn-valid contiguous numbers", () => {
  assert.ok(has("Card: 4242 4242 4242 4242", "CREDIT_CARD"));
  assert.ok(has("Amex: 378282246310005", "CREDIT_CARD"));
  assert.equal(luhnValid("4242424242424242"), true);
  assert.equal(luhnValid("1234567890123"), false);
});

test("Luhn-invalid long digit run is masked as ID_NUMBER, not as a card", () => {
  const found = detect("注文番号は 1234567890123 です");
  const typesFound = found.map((e) => e.type);
  assert.ok(!typesFound.includes("CREDIT_CARD"));
  assert.ok(typesFound.includes("ID_NUMBER"));
});

test("12-digit My Number style run is masked as ID_NUMBER", () => {
  assert.ok(has("マイナンバー: 123456789012", "ID_NUMBER"));
});

test("postal code with 〒 mark", () => {
  assert.ok(has("〒150-0041 東京都…", "POSTAL_CODE"));
});

test("money amounts require a currency marker", () => {
  assert.ok(has("請求金額 150,000円 です", "MONEY"));
  assert.ok(has("価格は ¥12,800 です", "MONEY"));
  assert.ok(has("The amount was $1,250.00", "MONEY"));
  // A bare number with no currency marker is not money.
  assert.ok(!has("参加者は 150000 人でした", "MONEY"));
});

test("dates in Japanese and ISO forms", () => {
  assert.ok(has("2026年11月25日までに対応", "DATE"));
  assert.ok(has("charged on 2026/11/10", "DATE"));
  assert.ok(has("released 2026-11-19", "DATE"));
});

/* ---------- names ---------- */

test("japanese name before an honorific", () => {
  const found = detect("担当の鈴木花子様にも共有をお願いします");
  const name = found.find((e) => e.type === "NAME");
  assert.ok(name);
  assert.equal(name.original, "鈴木花子");
});

test("japanese self-introduction does not swallow the company name", () => {
  const found = detect("株式会社サンプル商事の田中太郎と申します。");
  const name = found.find((e) => e.type === "NAME");
  assert.ok(name);
  assert.equal(name.original, "田中太郎");
});

test("japanese labelled name", () => {
  const found = detect("氏名：山田一郎");
  const name = found.find((e) => e.type === "NAME");
  assert.ok(name);
  assert.equal(name.original, "山田一郎");
});

test("english names: title, introduction, dictionary pair", () => {
  assert.ok(has("Mr. Carter said so", "NAME"));
  const intro = detect("My name is John Miller and I need help");
  assert.ok(intro.some((e) => e.type === "NAME" && e.original === "John Miller"));
});

/* ---------- addresses ---------- */

test("japanese address", () => {
  const found = detect("送付先は 東京都渋谷区神南1-2-3 です");
  const addr = found.find((e) => e.type === "ADDRESS");
  assert.ok(addr);
  assert.equal(addr.original, "東京都渋谷区神南1-2-3");
});

test("english street address", () => {
  const found = detect("My billing address is 482 Maple Street, Springfield.");
  const addr = found.find((e) => e.type === "ADDRESS");
  assert.ok(addr);
  assert.equal(addr.original, "482 Maple Street");
});

/* ---------- labelled IDs ---------- */

test("labelled IDs in Japanese and English", () => {
  assert.ok(has("注文番号 NP-2026-8842 について", "ID_NUMBER"));
  assert.ok(has("Order ID: ORD-883120", "ID_NUMBER"));
  assert.ok(has("ticket No. 55213", "ID_NUMBER"));
});

/* ---------- masking mechanics ---------- */

test("placeholders are numbered per type", () => {
  const { maskedText } = mask("a@example.com と b@example.org");
  assert.ok(maskedText.includes("[EMAIL_1]"));
  assert.ok(maskedText.includes("[EMAIL_2]"));
});

test("restore replaces every occurrence of a placeholder", () => {
  const { entities } = mask("mail: a@example.com");
  assert.equal(
    restore("[EMAIL_1] / [EMAIL_1]", entities),
    "a@example.com / a@example.com",
  );
});

test("round-trip on the Japanese sample restores the original exactly", () => {
  const { maskedText, entities } = mask(SAMPLE_JA);
  assert.ok(entities.length >= 7, `expected >=7 entities, got ${entities.length}`);
  assert.equal(restore(maskedText, entities), SAMPLE_JA);
  assert.deepEqual(findLeaks(maskedText, entities), []);
});

test("round-trip on the English sample restores the original exactly", () => {
  const { maskedText, entities } = mask(SAMPLE_EN);
  assert.ok(entities.length >= 7, `expected >=7 entities, got ${entities.length}`);
  assert.equal(restore(maskedText, entities), SAMPLE_EN);
  assert.deepEqual(findLeaks(maskedText, entities), []);
});

test("an email inside a URL is covered by the URL span (no double masking)", () => {
  const found = detect("link: https://example.com/?mail=a@b.co.jp end");
  assert.equal(found.length, 1);
  assert.equal(found[0].type, "URL");
});

test("plain text without PII is left untouched", () => {
  const ja = "今日は良い天気ですね。明日は雨かもしれません。";
  const en = "The meeting is moved to next week. Please review the draft.";
  assert.deepEqual(detect(ja), []);
  assert.deepEqual(detect(en), []);
  assert.equal(mask(ja).maskedText, ja);
});

test("empty and null input are safe", () => {
  assert.equal(mask("").maskedText, "");
  assert.equal(mask(null).maskedText, "");
  assert.deepEqual(detect(""), []);
  assert.equal(restore("", []), "");
});

test("findLeaks reports values still present in a text", () => {
  const { entities } = mask("電話は 090-1234-5678 です");
  const leaks = findLeaks("電話は 090-1234-5678 です", entities);
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].type, "PHONE");
});

test("summarize counts entities by type", () => {
  const { entities } = mask("a@example.com, b@example.org, 090-1234-5678");
  assert.deepEqual(summarize(entities), { EMAIL: 2, PHONE: 1 });
});

/* ---------- regression tests from the Round-3 security review ---------- */

test("space-separated phone numbers are masked", () => {
  assert.ok(has("電話は 090 1234 5678 です", "PHONE"));
  assert.ok(has("電話は 090 - 1234 - 5678 です", "PHONE"));
});

test("full-width digits and symbols are detected (IME input)", () => {
  assert.ok(has("電話は ０９０-１２３４-５６７８ です", "PHONE"));
  const src = "メールは ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏ．ｊｐ です";
  const { maskedText, entities } = mask(src);
  assert.ok(has(src, "EMAIL"));
  // Restoration must reproduce the ORIGINAL full-width characters.
  assert.equal(restore(maskedText, entities), src);
  assert.deepEqual(findLeaks(maskedText, entities), []);
});

test("name followed by a particle is detected, place words are not", () => {
  const found = detect("田中太郎が担当します。");
  assert.ok(found.some((e) => e.type === "NAME" && e.original === "田中太郎"));
  assert.deepEqual(detect("中山間部は緑が豊かです。"), []);
  assert.deepEqual(detect("山田川が流れる谷川。"), []);
});

test("japanese address in 丁目・番・号 format", () => {
  const found = detect("送付先は 東京都渋谷区神南1丁目2番3号 です");
  const addr = found.find((e) => e.type === "ADDRESS");
  assert.ok(addr);
  assert.equal(addr.original, "東京都渋谷区神南1丁目2番3号");
});

test("placeholder collision: literal [EMAIL_1] in the input stays untouched", () => {
  const src = "参照コード [EMAIL_1] と連絡先 a@example.com";
  const { maskedText, entities } = mask(src);
  // The real email uses a different bracket style this time…
  assert.ok(maskedText.includes("⟦EMAIL_1⟧"));
  // …and the round-trip is exact: the literal text is not rewritten.
  assert.equal(restore(maskedText, entities), src);
});

/* ---------- regression tests: full-width separators & address forms ---------- */

test("phone numbers with Japanese separator characters are masked", () => {
  // Middle dot, long-vowel mark, Unicode minus, halfwidth long mark —
  // all realistic separators on a Japanese IME (independently verified leaks).
  assert.ok(has("電話は０９０・１２３４・５６７８です", "PHONE"));
  assert.ok(has("電話は０９０ー１２３４ー５６７８です", "PHONE"));
  assert.ok(has("電話は０９０−１２３４−５６７８です", "PHONE"));
  assert.ok(has("電話は０９０ｰ１２３４ｰ５６７８です", "PHONE"));
  assert.ok(has("電話は090・1234・5678です", "PHONE"));
  assert.ok(has("電話は090ー1234ー5678です", "PHONE"));
  // Round-trip keeps the original full-width characters.
  const src = "電話は０９０・１２３４・５６７８です";
  const { maskedText, entities } = mask(src);
  assert.equal(restore(maskedText, entities), src);
  assert.deepEqual(findLeaks(maskedText, entities), []);
});

test("designated city address without prefecture is masked", () => {
  const found = detect("住所は横浜市西区みなとみらい2丁目3番5号です");
  const addr = found.find((e) => e.type === "ADDRESS");
  assert.ok(addr);
  assert.equal(addr.original, "横浜市西区みなとみらい2丁目3番5号");
});

test("county town address in 番地のN format is masked", () => {
  const found = detect("住所は静岡県駿東郡長泉町下土狩123番地の4です");
  const addr = found.find((e) => e.type === "ADDRESS");
  assert.ok(addr);
  assert.equal(addr.original, "静岡県駿東郡長泉町下土狩123番地の4");
});

/* ---------- regression tests from the Round-6 review (Japanese input) ---------- */

test("halfwidth katakana names are detected, original glyphs restored", () => {
  const src = "担当はﾀﾅｶ ﾀﾛｳ様です";
  const { maskedText, entities } = mask(src);
  assert.ok(has(src, "NAME"));
  assert.ok(!maskedText.includes("ﾀﾅｶ"));
  assert.ok(!maskedText.includes("ﾀﾛｳ"));
  assert.equal(restore(maskedText, entities), src);
  assert.ok(has("担当はﾀﾅｶﾀﾛｳ様です", "NAME"));
});

test("variant/old-form surnames are detected", () => {
  assert.ok(has("齋藤一郎様にご連絡ください", "NAME"));
  assert.ok(has("渡邊花子さんが担当です", "NAME"));
  assert.ok(has("髙橋健一様", "NAME"));
  assert.ok(has("齋藤一郎が担当します", "NAME"));
});

test("names with a space between family and given name are detected", () => {
  assert.ok(has("田中 太郎 様に送ってください", "NAME"));
  assert.ok(has("田中　太郎様に送ってください", "NAME"));
  assert.ok(has("鈴木 花子さんが担当です", "NAME"));
});

test("name with a parenthesized reading before an honorific is detected", () => {
  const found = detect("田中太郎（タナカタロウ）様");
  assert.ok(found.some((e) => e.type === "NAME" && e.original === "田中太郎"));
});

test("surname alone before an honorific is detected", () => {
  const found = detect("田中様、いつもお世話になっております");
  assert.ok(found.some((e) => e.type === "NAME" && e.original === "田中"));
});

test("hiragana self-introduction opener is detected", () => {
  const found = detect("わたしは佐藤はなこです");
  assert.ok(found.some((e) => e.type === "NAME" && e.original === "佐藤はなこ"));
});

/* ---------- regression tests from the Round-7 review (contact forms) ---------- */

test("P.O. box (私書箱) is masked standalone and after an address", () => {
  assert.ok(has("送付先は私書箱123号です", "ADDRESS"));
  const found = detect("東京都千代田区霞が関1-2-3 私書箱第55号");
  assert.ok(found.some((e) => e.original === "私書箱第55号"));
});

test("building name, floor and room number are part of the address", () => {
  const found = detect("住所は東京都渋谷区神南1-2-3 サンプルビル5階 502号室です");
  const addr = found.find((e) => e.type === "ADDRESS");
  assert.ok(addr);
  assert.equal(addr.original, "東京都渋谷区神南1-2-3 サンプルビル5階 502号室");
  assert.ok(has("住所は東京都渋谷区神南1-2-3 サンプルマンション101号室です", "ADDRESS"));
});

test("international prefix in parentheses is masked", () => {
  assert.ok(has("電話は（+81）90-1234-5678です", "PHONE"));
  assert.ok(has("Phone: (+81) 90-1234-5678", "PHONE"));
});

test("toll-free and navi-dial numbers (3-3 grouping) are masked", () => {
  assert.ok(has("フリーダイヤル 0120-123-456 まで", "PHONE"));
  assert.ok(has("フリーダイヤル 0120-123456 まで", "PHONE"));
  assert.ok(has("お問い合わせ 0800-123-456 まで", "PHONE"));
  assert.ok(has("ナビダイヤル 0570-123-456 まで", "PHONE"));
});

test("parenthesized area/exchange codes are masked", () => {
  assert.ok(has("FAX 03（1234）5678", "PHONE"));
  assert.ok(has("電話 （03）1234-5678", "PHONE"));
  assert.ok(has("TEL (03) 1234-5678", "PHONE"));
});

test("bare postal code is masked and never truncates a phone number", () => {
  assert.ok(has("郵便番号は 150-0041 です", "POSTAL_CODE"));
  const found = detect("電話は 090-1234-5678 です");
  assert.equal(found.length, 1);
  assert.equal(found[0].type, "PHONE");
  assert.equal(found[0].original, "090-1234-5678");
});

/* ---------- regression tests from the Round-8 review (AI accidents) ---------- */

import { repairPlaceholders, analyzeAiOutput } from "../src/pii-shield.js";

test("repairPlaceholders fixes near-miss placeholder forms", () => {
  const { entities } = mask("連絡先は taro@example.com と 090-1234-5678 です");
  const variants = [
    "[email_1] と [phone_1]",
    "[ EMAIL_1 ] と [PHONE_1 ]",
    "［EMAIL_1］ と ［PHONE_1］",
    "⟦EMAIL_1⟧ と ⟦PHONE_1⟧",
    "[EMAIL-1] と [PHONE-1]",
    "EMAIL_1 と PHONE_1",
  ];
  for (const v of variants) {
    const { text, repaired } = repairPlaceholders(v, entities);
    assert.equal(repaired.length, 2, `variant not repaired: ${v}`);
    assert.equal(restore(text, entities), "taro@example.com と 090-1234-5678");
  }
});

test("repairPlaceholders leaves exact placeholders and prose untouched", () => {
  const { entities } = mask("連絡先は taro@example.com です");
  const exact = "宛先は [EMAIL_1] です";
  const { text, repaired } = repairPlaceholders(exact, entities);
  assert.equal(text, exact);
  assert.deepEqual(repaired, []);
});

test("analyzeAiOutput reports missing, duplicated and unknown tokens", () => {
  const { entities } = mask("連絡先は taro@example.com と 090-1234-5678 です");
  const dropped = analyzeAiOutput("[EMAIL_1] のみ", entities);
  assert.deepEqual(dropped.missing.map((e) => e.placeholder), ["[PHONE_1]"]);
  const dup = analyzeAiOutput("[EMAIL_1] と [EMAIL_1] と [PHONE_1]", entities);
  assert.deepEqual(dup.duplicated, [{ placeholder: "[EMAIL_1]", count: 2 }]);
  const hallucinated = analyzeAiOutput("[EMAIL_1] と [PHONE_1] と [EMAIL_9]", entities);
  assert.deepEqual(hallucinated.unknown, ["[EMAIL_9]"]);
  assert.deepEqual(hallucinated.missing, []);
});

/* ---------- regression tests from the Round-9 review (international) ---------- */

import { ibanValid } from "../src/pii-shield.js";

test("US ZIP codes are masked (state-anchored and ZIP+4)", () => {
  assert.ok(has("1600 Amphitheatre Parkway, Mountain View, CA 94043", "POSTAL_CODE"));
  assert.ok(has("Ship to Springfield, IL 62704-1234", "POSTAL_CODE"));
  // A bare 5-digit quantity is NOT a ZIP code.
  assert.ok(!has("We ordered 10036 units last year", "POSTAL_CODE"));
});

test("P.O. Box and unit designators are part of the address", () => {
  assert.ok(has("Mail to P.O. Box 1234, Springfield, IL 62704", "ADDRESS"));
  const apt = detect("482 Maple Street, Apt 4B, Springfield").find((e) => e.type === "ADDRESS");
  assert.equal(apt.original, "482 Maple Street, Apt 4B");
  const suite = detect("1200 Sixth Avenue, Suite 500, New York").find((e) => e.type === "ADDRESS");
  assert.equal(suite.original, "1200 Sixth Avenue, Suite 500");
});

test("international phone numbers are masked with their country code", () => {
  assert.ok(has("Call +1 (555) 013-4471 today", "PHONE"));
  assert.ok(has("Call +1-555-013-4471 today", "PHONE"));
  assert.ok(has("London office: +44 20 7946 0958", "PHONE"));
  assert.ok(has("Reach me at +33 1 42 68 53 00", "PHONE"));
  assert.ok(has("Sydney office: +61 2 9374 4000", "PHONE"));
  const found = detect("Call +1 (555) 013-4471 today");
  assert.equal(found.find((e) => e.type === "PHONE").original, "+1 (555) 013-4471");
});

test("UK and Canadian postal codes are masked", () => {
  assert.ok(has("10 Downing Street, London SW1A 1AA", "POSTAL_CODE"));
  assert.ok(has("Parliament Hill, Ottawa, ON K1A 0B1, Canada", "POSTAL_CODE"));
});

test("German street address and PLZ are masked", () => {
  const found = detect("Musterstraße 12, 10115 Berlin, Germany");
  assert.ok(found.some((e) => e.type === "ADDRESS" && e.original === "Musterstraße 12"));
  assert.ok(found.some((e) => e.type === "POSTAL_CODE" && e.original === "10115"));
});

test("western date formats are masked", () => {
  assert.ok(has("The deadline is 11/19/2026", "DATE"));
  assert.ok(has("The deadline is 19.11.2026", "DATE"));
  assert.ok(has("The deadline is November 19, 2026", "DATE"));
  assert.ok(has("The deadline is 19 November 2026", "DATE"));
});

test("'November' is not misread as a labelled ID (No + vember)", () => {
  const found = detect("The deadline is November 19, 2026");
  assert.ok(!found.some((e) => e.type === "ID_NUMBER"));
  // …while a real "No." label still works.
  assert.ok(has("ticket No. 55213", "ID_NUMBER"));
});

test("SSN is masked as ID_NUMBER", () => {
  assert.ok(has("SSN: 123-45-6789", "ID_NUMBER"));
});

test("IBAN is masked whole as ID_NUMBER, not as a credit card", () => {
  const found = detect("IBAN: DE89 3704 0044 0532 0130 00");
  assert.equal(found.length, 1);
  assert.equal(found[0].type, "ID_NUMBER");
  assert.equal(found[0].original, "DE89 3704 0044 0532 0130 00");
  assert.equal(ibanValid("DE89 3704 0044 0532 0130 00"), true);
  assert.equal(ibanValid("DE89 3704 0044 0532 0130 01"), false);
});

/* ---------- regression tests from the Round-5 technical review ---------- */

test("restore is not confused by [EMAIL_1] vs [EMAIL_10]", () => {
  const entities = [
    { placeholder: "[EMAIL_1]", original: "first@example.com" },
    { placeholder: "[EMAIL_10]", original: "tenth@example.com" },
  ];
  assert.equal(restore("[EMAIL_10]", entities), "tenth@example.com");
  assert.equal(restore("[EMAIL_1]", entities), "first@example.com");
});

test("a text that is only a phone number masks to a single placeholder", () => {
  assert.equal(mask("090-1234-5678").maskedText, "[PHONE_1]");
});

test("masking stays fast on pathological input (backtracking guard)", () => {
  const start = performance.now();
  mask("a".repeat(20000) + "@");
  mask("1234567890".repeat(2000));
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, `masking took ${elapsed.toFixed(0)}ms`);
});

test("masked spans line up with the placeholders in the masked text", () => {
  const { maskedText, maskedSpans } = mask("連絡先は a@example.com と 090-1234-5678 です");
  assert.equal(maskedSpans.length, 2);
  for (const s of maskedSpans) {
    assert.equal(maskedText.slice(s.start, s.end), s.placeholder);
  }
});
