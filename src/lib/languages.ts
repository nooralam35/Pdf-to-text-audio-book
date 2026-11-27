import type { LanguageCode, LanguageOption, OcrScriptMode } from '../types';

export const LANGUAGES: LanguageOption[] = [
  {
    code: 'orig',
    name: 'Original Book',
    nativeName: 'Same as PDF Language',
    speechLang: 'hi-IN',
    canvasFont: '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    speechLang: 'hi-IN',
    canvasFont: '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-hi',
  },
  {
    code: 'sa',
    name: 'Sanskrit',
    nativeName: 'संस्कृतम्',
    speechLang: 'sa-IN',
    canvasFont: '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-sa',
  },
  {
    code: 'mr',
    name: 'Marathi',
    nativeName: 'मराठी',
    speechLang: 'mr-IN',
    canvasFont: '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-mr',
  },
  {
    code: 'ur',
    name: 'Urdu',
    nativeName: 'اردو',
    speechLang: 'ur-PK',
    canvasFont: '"Noto Nastaliq Urdu", "Plus Jakarta Sans", serif',
    cssClass: 'lang-ur',
    rtl: true,
  },
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    speechLang: 'ar-SA',
    canvasFont: '"Noto Sans Arabic", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-ar',
    rtl: true,
  },
  {
    code: 'fa',
    name: 'Persian (Farsi)',
    nativeName: 'فارسی',
    speechLang: 'fa-IR',
    canvasFont: '"Noto Sans Arabic", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-fa',
    rtl: true,
  },
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    speechLang: 'en-US',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'hinglish',
    name: 'Hinglish',
    nativeName: 'Hinglish (Roman Hindi)',
    speechLang: 'hi-IN',
    canvasFont: '"Plus Jakarta Sans", "Noto Sans Devanagari", sans-serif',
    cssClass: '',
  },
  {
    code: 'bn',
    name: 'Bengali',
    nativeName: 'বাংলা',
    speechLang: 'bn-IN',
    canvasFont: '"Noto Sans Bengali", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-bn',
  },
  {
    code: 'ta',
    name: 'Tamil',
    nativeName: 'தமிழ்',
    speechLang: 'ta-IN',
    canvasFont: '"Noto Sans Tamil", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-ta',
  },
  {
    code: 'te',
    name: 'Telugu',
    nativeName: 'తెలుగు',
    speechLang: 'te-IN',
    canvasFont: '"Noto Sans Telugu", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-te',
  },
  {
    code: 'gu',
    name: 'Gujarati',
    nativeName: 'ગુજરાતી',
    speechLang: 'gu-IN',
    canvasFont: '"Noto Sans Gujarati", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-gu',
  },
  {
    code: 'pa',
    name: 'Punjabi',
    nativeName: 'ਪੰਜਾਬੀ',
    speechLang: 'pa-IN',
    canvasFont: '"Noto Sans Gurmukhi", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-pa',
  },
  {
    code: 'kn',
    name: 'Kannada',
    nativeName: 'ಕನ್ನಡ',
    speechLang: 'kn-IN',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-kn',
  },
  {
    code: 'ml',
    name: 'Malayalam',
    nativeName: 'മലയാളം',
    speechLang: 'ml-IN',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-ml',
  },
  {
    code: 'or',
    name: 'Odia',
    nativeName: 'ଓଡ଼ିଆ',
    speechLang: 'or-IN',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-or',
  },
  {
    code: 'ne',
    name: 'Nepali',
    nativeName: 'नेपाली',
    speechLang: 'ne-NP',
    canvasFont: '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-ne',
  },
  {
    code: 'zh',
    name: 'Chinese',
    nativeName: '中文',
    speechLang: 'zh-CN',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-zh',
  },
  {
    code: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    speechLang: 'ja-JP',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-ja',
  },
  {
    code: 'ko',
    name: 'Korean',
    nativeName: '한국어',
    speechLang: 'ko-KR',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-ko',
  },
  {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    speechLang: 'ru-RU',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    speechLang: 'es-ES',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    speechLang: 'fr-FR',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    speechLang: 'de-DE',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    speechLang: 'pt-BR',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'it',
    name: 'Italian',
    nativeName: 'Italiano',
    speechLang: 'it-IT',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'tr',
    name: 'Turkish',
    nativeName: 'Türkçe',
    speechLang: 'tr-TR',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'id',
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    speechLang: 'id-ID',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'th',
    name: 'Thai',
    nativeName: 'ไทย',
    speechLang: 'th-TH',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-th',
  },
  {
    code: 'vi',
    name: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    speechLang: 'vi-VN',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'he',
    name: 'Hebrew',
    nativeName: 'עברית',
    speechLang: 'he-IL',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-he',
    rtl: true,
  },
  {
    code: 'uk',
    name: 'Ukrainian',
    nativeName: 'Українська',
    speechLang: 'uk-UA',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
];

export const OCR_SCRIPT_OPTIONS: Array<{
  id: OcrScriptMode;
  label: string;
  shortLabel: string;
  tesseractLangs: string;
}> = [
  {
    id: 'auto',
    label: 'Auto Detect (Any World Language)',
    shortLabel: 'Auto Script',
    tesseractLangs: 'hin+urd+ara+eng',
  },
  {
    id: 'devanagari',
    label: 'Hindi / Sanskrit / Marathi / Nepali',
    shortLabel: 'Devanagari',
    tesseractLangs: 'hin+san+mar+eng',
  },
  {
    id: 'persoarabic',
    label: 'Urdu / Arabic / Persian',
    shortLabel: 'Urdu / Arabic',
    tesseractLangs: 'urd+ara+fas+eng',
  },
  {
    id: 'bengali',
    label: 'Bengali (বাংলা)',
    shortLabel: 'Bengali',
    tesseractLangs: 'ben+eng',
  },
  {
    id: 'tamil',
    label: 'Tamil (தமிழ்)',
    shortLabel: 'Tamil',
    tesseractLangs: 'tam+eng',
  },
  {
    id: 'telugu',
    label: 'Telugu (తెలుగు)',
    shortLabel: 'Telugu',
    tesseractLangs: 'tel+eng',
  },
  {
    id: 'gujarati',
    label: 'Gujarati (ગુજરાતી)',
    shortLabel: 'Gujarati',
    tesseractLangs: 'guj+eng',
  },
  {
    id: 'gurmukhi',
    label: 'Punjabi (ਪੰਜਾਬੀ)',
    shortLabel: 'Punjabi',
    tesseractLangs: 'pan+eng',
  },
  {
    id: 'cjk',
    label: 'Chinese / Japanese / Korean',
    shortLabel: 'CJK',
    tesseractLangs: 'chi_sim+jpn+kor+eng',
  },
  {
    id: 'cyrillic',
    label: 'Russian / Ukrainian (Cyrillic)',
    shortLabel: 'Cyrillic',
    tesseractLangs: 'rus+ukr+eng',
  },
  {
    id: 'latin',
    label: 'English / European',
    shortLabel: 'Latin',
    tesseractLangs: 'eng',
  },
];

export function getLanguageOption(code: LanguageCode): LanguageOption {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[1];
}

export function isTextPredominantlyRtl(text: string): boolean {
  if (!text) return false;
  const rtlMatches = text.match(
    /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
  );
  const ltrMatches = text.match(
    /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0900-\u0D7F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g
  );
  const rtlCount = rtlMatches?.length ?? 0;
  const ltrCount = ltrMatches?.length ?? 0;
  return rtlCount > 4 && rtlCount >= ltrCount * 0.45;
}

export function hasNonLatinScript(text: string): boolean {
  return /[\u0370-\u03FF\u0400-\u052F\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u077F\u08A0-\u08FF\u0900-\u0D7F\u0D80-\u0EFF\u1000-\u109F\u10A0-\u10FF\u1200-\u137F\u1780-\u17FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/u.test(
    text
  );
}

export function detectTextLanguageCode(text: string, hintLang?: string): LanguageCode {
  if (hintLang) {
    const h = hintLang.toLowerCase();
    if (h.includes('sanskrit') || h === 'sa') return 'sa';
    if (h.includes('marathi') || h === 'mr') return 'mr';
    if (h.includes('nepali') || h === 'ne') return 'ne';
    if (h.includes('hindi') || h === 'hi') return 'hi';
    if (h.includes('urdu') || h === 'ur') return 'ur';
    if (h.includes('persian') || h.includes('farsi') || h === 'fa') return 'fa';
    if (h.includes('arabic') || h === 'ar') return 'ar';
    if (h.includes('hebrew') || h === 'he') return 'he';
    if (h.includes('bengali') || h.includes('bangla') || h === 'bn') return 'bn';
    if (h.includes('tamil') || h === 'ta') return 'ta';
    if (h.includes('telugu') || h === 'te') return 'te';
    if (h.includes('gujarati') || h === 'gu') return 'gu';
    if (h.includes('punjabi') || h.includes('gurmukhi') || h === 'pa') return 'pa';
    if (h.includes('kannada') || h === 'kn') return 'kn';
    if (h.includes('malayalam') || h === 'ml') return 'ml';
    if (h.includes('odia') || h.includes('oriya') || h === 'or') return 'or';
    if (h.includes('chinese') || h.includes('mandarin') || h === 'zh') return 'zh';
    if (h.includes('japanese') || h === 'ja') return 'ja';
    if (h.includes('korean') || h === 'ko') return 'ko';
    if (h.includes('ukrainian') || h === 'uk') return 'uk';
    if (h.includes('russian') || h === 'ru') return 'ru';
    if (h.includes('spanish') || h === 'es') return 'es';
    if (h.includes('french') || h === 'fr') return 'fr';
    if (h.includes('german') || h === 'de') return 'de';
    if (h.includes('portuguese') || h === 'pt') return 'pt';
    if (h.includes('italian') || h === 'it') return 'it';
    if (h.includes('turkish') || h === 'tr') return 'tr';
    if (h.includes('indonesian') || h === 'id') return 'id';
    if (h.includes('thai') || h === 'th') return 'th';
    if (h.includes('vietnamese') || h === 'vi') return 'vi';
  }

  const sample = text.slice(0, 1500);
  const counts: Array<{ code: LanguageCode; count: number }> = [
    { code: 'hi', count: (sample.match(/[\u0900-\u097F]/g) ?? []).length },
    {
      code: 'ar',
      count: (sample.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) ?? []).length,
    },
    { code: 'he', count: (sample.match(/[\u0590-\u05FF]/g) ?? []).length },
    { code: 'bn', count: (sample.match(/[\u0980-\u09FF]/g) ?? []).length },
    { code: 'ta', count: (sample.match(/[\u0B80-\u0BFF]/g) ?? []).length },
    { code: 'te', count: (sample.match(/[\u0C00-\u0C7F]/g) ?? []).length },
    { code: 'gu', count: (sample.match(/[\u0A80-\u0AFF]/g) ?? []).length },
    { code: 'pa', count: (sample.match(/[\u0A00-\u0A7F]/g) ?? []).length },
    { code: 'kn', count: (sample.match(/[\u0C80-\u0CFF]/g) ?? []).length },
    { code: 'ml', count: (sample.match(/[\u0D00-\u0D7F]/g) ?? []).length },
    { code: 'or', count: (sample.match(/[\u0B00-\u0B7F]/g) ?? []).length },
    { code: 'th', count: (sample.match(/[\u0E00-\u0E7F]/g) ?? []).length },
    { code: 'ru', count: (sample.match(/[\u0400-\u04FF]/g) ?? []).length },
    { code: 'ja', count: (sample.match(/[\u3040-\u30FF]/g) ?? []).length },
    { code: 'ko', count: (sample.match(/[\uAC00-\uD7AF]/g) ?? []).length },
    { code: 'zh', count: (sample.match(/[\u4E00-\u9FFF]/g) ?? []).length },
  ];

  // Japanese uses Kana + Kanji together; boost Japanese if Kana is present alongside Han characters
  const jaItem = counts.find((c) => c.code === 'ja')!;
  const zhItem = counts.find((c) => c.code === 'zh')!;
  if (jaItem.count >= 4) {
    jaItem.count += zhItem.count;
  }

  counts.sort((a, b) => b.count - a.count);
  const top = counts[0];

  if (top && top.count >= 6) {
    if (top.code === 'hi') {
      if (/[।]{2}|॥|ः\s|तत्|भवति|अस्ति|श्लोक|इति/.test(sample)) return 'sa';
      if (/आहे|नाही|आणि|त्यामुळे|मराठी|ळ/.test(sample)) return 'mr';
      if (/छैन|हुन्छ|गर्नुहोस्|नेपाली|रहेको/.test(sample)) return 'ne';
      return 'hi';
    }
    if (top.code === 'ar') {
      // Urdu-specific characters (ٹ ڈ ڑ ں ھ ے)
      if (/[\u0679\u0688\u0691\u06BA\u06BE\u06D2]/.test(sample)) return 'ur';
      // Persian-specific characters (پ چ ژ گ ی ک without Urdu retroflexes)
      if (/[\u067E\u0686\u0698\u06AF\u06CC\u06A9]/.test(sample)) return 'fa';
      return 'ar';
    }
    if (top.code === 'ru') {
      if (/[іїєґІЇЄҐ]/.test(sample)) return 'uk';
      return 'ru';
    }
    return top.code;
  }

  return 'en';
}

export const PRELOADED_OBS_BOOK_URL =
  '/assets/aistudio/OBS_ADVANCED_BOOK_6_x_9_in.docx_d1da3c2c.pdf';
export const PRELOADED_OBS_BOOK_ID = 'preloaded-obs-superuser-guidebook';
