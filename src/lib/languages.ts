import type { LanguageCode, LanguageOption } from '../types';

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
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    speechLang: 'ar-SA',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: 'lang-ar',
    rtl: true,
  },
  {
    code: 'en',
    name: 'English (Clean Script)',
    nativeName: 'English',
    speechLang: 'en-US',
    canvasFont: '"Plus Jakarta Sans", sans-serif',
    cssClass: '',
  },
];

export function getLanguageOption(code: LanguageCode): LanguageOption {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

export const PRELOADED_OBS_BOOK_URL =
  '/assets/aistudio/OBS_ADVANCED_BOOK_6_x_9_in.docx_d1da3c2c.pdf';
export const PRELOADED_OBS_BOOK_ID = 'preloaded-obs-superuser-guidebook';
