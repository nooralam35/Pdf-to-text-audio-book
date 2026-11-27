import type { LanguageCode, LanguageOption, OcrScriptMode } from '../types';

export const LANGUAGES: LanguageOption[] = [
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
    code: 'hinglish',
    name: 'Hinglish',
    nativeName: 'Hinglish (Roman Hindi)',
    speechLang: 'hi-IN',
    canvasFont: '"Plus Jakarta Sans", "Noto Sans Devanagari", sans-serif',
    cssClass: '',
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
    code: 'en',
    name: 'English',
    nativeName: 'English',
    speechLang: 'en-US',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
  {
    code: 'orig',
    name: 'Original Book',
    nativeName: 'Same as PDF Script',
    speechLang: 'hi-IN',
    canvasFont: '"Noto Sans Devanagari", "Plus Jakarta Sans", sans-serif',
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
    label: 'Auto Detect (All Scripts)',
    shortLabel: 'Auto Script',
    tesseractLangs: 'hin+urd+ara+eng',
  },
  {
    id: 'devanagari',
    label: 'Hindi / Sanskrit / Marathi',
    shortLabel: 'Hi / Sa / Mr',
    tesseractLangs: 'hin+san+mar+eng',
  },
  {
    id: 'persoarabic',
    label: 'Urdu / Arabic',
    shortLabel: 'Urdu / Arabic',
    tesseractLangs: 'urd+ara+eng',
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
    id: 'latin',
    label: 'English / European',
    shortLabel: 'English',
    tesseractLangs: 'eng',
  },
];

export function getLanguageOption(code: LanguageCode): LanguageOption {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

export function isTextPredominantlyRtl(text: string): boolean {
  if (!text) return false;
  const rtlMatches = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g);
  const ltrMatches = text.match(/[A-Za-z\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B80-\u0BFF\u0C00-\u0C7F]/g);
  const rtlCount = rtlMatches?.length ?? 0;
  const ltrCount = ltrMatches?.length ?? 0;
  return rtlCount > 4 && rtlCount >= ltrCount * 0.45;
}

export function hasNonLatinScript(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF]/u.test(
    text
  );
}

export function detectTextLanguageCode(text: string, hintLang?: string): LanguageCode {
  if (hintLang) {
    const h = hintLang.toLowerCase();
    if (h.includes('sanskrit') || h === 'sa') return 'sa';
    if (h.includes('marathi') || h === 'mr') return 'mr';
    if (h.includes('hindi') || h === 'hi') return 'hi';
    if (h.includes('urdu') || h === 'ur') return 'ur';
    if (h.includes('arabic') || h === 'ar') return 'ar';
    if (h.includes('bengali') || h === 'bn') return 'bn';
    if (h.includes('tamil') || h === 'ta') return 'ta';
    if (h.includes('telugu') || h === 'te') return 'te';
    if (h.includes('gujarati') || h === 'gu') return 'gu';
    if (h.includes('punjabi') || h === 'pa') return 'pa';
    if (h.includes('spanish') || h === 'es') return 'es';
    if (h.includes('french') || h === 'fr') return 'fr';
    if (h.includes('german') || h === 'de') return 'de';
  }

  const sample = text.slice(0, 1500);
  const devCount = (sample.match(/[\u0900-\u097F]/g) ?? []).length;
  const arabicCount = (sample.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
  const benCount = (sample.match(/[\u0980-\u09FF]/g) ?? []).length;
  const tamCount = (sample.match(/[\u0B80-\u0BFF]/g) ?? []).length;
  const telCount = (sample.match(/[\u0C00-\u0C7F]/g) ?? []).length;
  const gujCount = (sample.match(/[\u0A80-\u0AFF]/g) ?? []).length;
  const gurCount = (sample.match(/[\u0A00-\u0A7F]/g) ?? []).length;

  const maxIndic = Math.max(devCount, arabicCount, benCount, tamCount, telCount, gujCount, gurCount);
  if (maxIndic >= 6) {
    if (devCount === maxIndic) {
      if (/[।]{2}|॥|ः\s|तत्|भवति|अस्ति|श्लोक|इति/.test(sample)) return 'sa';
      if (/आहे|नाही|आणि|त्यामुळे|मराठी|ळ/.test(sample)) return 'mr';
      return 'hi';
    }
    if (arabicCount === maxIndic) {
      // Urdu-specific characters (پ ٹ چ ڈ ڑ ژ گ ں ہ ھ ی ے)
      if (/[\u0679\u067E\u0686\u0688\u0691\u0698\u06AF\u06BA\u06BE\u06C1\u06D2]/.test(sample)) {
        return 'ur';
      }
      return 'ar';
    }
    if (benCount === maxIndic) return 'bn';
    if (tamCount === maxIndic) return 'ta';
    if (telCount === maxIndic) return 'te';
    if (gujCount === maxIndic) return 'gu';
    if (gurCount === maxIndic) return 'pa';
  }

  return 'en';
}

export const PRELOADED_OBS_BOOK_URL =
  '/assets/aistudio/OBS_ADVANCED_BOOK_6_x_9_in.docx_d1da3c2c.pdf';
export const PRELOADED_OBS_BOOK_ID = 'preloaded-obs-superuser-guidebook';
