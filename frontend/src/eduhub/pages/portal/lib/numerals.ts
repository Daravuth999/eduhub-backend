/** Khmer numerals — used when the UI language is set to ខ្មែរ. */
const EN_TO_KH: Record<string, string> = {
  "0": "០",
  "1": "១",
  "2": "២",
  "3": "៣",
  "4": "៤",
  "5": "៥",
  "6": "៦",
  "7": "៧",
  "8": "៨",
  "9": "៩",
};

export function toKhmerNumerals(input: string | number): string {
  const s = String(input);
  let out = "";
  for (const ch of s) out += EN_TO_KH[ch] ?? ch;
  return out;
}

export function localiseNumber(value: string | number, lang: "en" | "km") {
  return lang === "km" ? toKhmerNumerals(value) : String(value);
}
