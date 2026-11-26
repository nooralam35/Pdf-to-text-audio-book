export type GeminiPrebuiltVoiceName = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

export type NeuralVoiceGender = 'Female' | 'Male';

export type NeuralVoiceCategory = 'Teacher' | 'Expressive' | 'Natural' | 'Calm' | 'Deep';

export type NeuralTtsModelTier = 'flash' | 'lite';

export type SentenceProsodyKind =
  | 'heading'
  | 'question'
  | 'exclamation'
  | 'list'
  | 'caption'
  | 'narration';

export type AiVoiceProfileId =
  | 'female-teacher'
  | 'male-teacher'
  | 'female-expressive'
  | 'male-expressive'
  | 'female-natural'
  | 'male-natural'
  | 'female-calm'
  | 'male-deep';

export interface AiVoiceProfile {
  id: AiVoiceProfileId;
  /** Gemini neural prebuilt voice sent to /api/tts */
  voiceName: GeminiPrebuiltVoiceName;
  /** Flagship expressive model ('flash' -> gemini-3.8-flash-tts) or fast lite neural model ('lite' -> gemini-3.8-flash-lite-tts) */
  modelTier: NeuralTtsModelTier;
  name: string;
  gender: NeuralVoiceGender;
  category: NeuralVoiceCategory;
  /** Concise gender & delivery label shown in dropdown */
  tagline: string;
  description: string;
  /** Expressive vocal direction passed to Gemini Neural TTS speechMetadata.style */
  style: string;
  /** Subtle acoustic timbre multiplier used only when free HD fallback is active */
  fallbackPitch: number;
  fallbackRate: number;
}

export const AI_VOICE_PROFILES: AiVoiceProfile[] = [
  {
    id: 'female-teacher',
    voiceName: 'Kore',
    modelTier: 'flash',
    name: 'Meera',
    gender: 'Female',
    category: 'Teacher',
    tagline: 'Female · Teacher',
    description:
      'Experienced educator with natural vocal rise-and-fall, thoughtful pauses, and engaging rhythm',
    style:
      'Warm, experienced female teacher explaining a book aloud to a student: expressive vocal rise and fall (intonation), unhurried conversational rhythm, gentle emphasis on key concepts, natural micro-pauses at punctuation, never flat or monotonous',
    fallbackPitch: 1.0,
    fallbackRate: 1.0,
  },
  {
    id: 'male-teacher',
    voiceName: 'Charon',
    modelTier: 'flash',
    name: 'Aarav',
    gender: 'Male',
    category: 'Teacher',
    tagline: 'Male · Teacher',
    description:
      'Seasoned professor with rich modulation, clear pauses, and motivating classroom cadence',
    style:
      'Seasoned, encouraging male professor teaching with natural storytelling rhythm: expressive pitch variation, warm authoritative clarity, deliberate pauses before key ideas, lively human intonation, never flat or robotic',
    fallbackPitch: 0.9,
    fallbackRate: 0.98,
  },
  {
    id: 'female-expressive',
    voiceName: 'Zephyr',
    modelTier: 'flash',
    name: 'Zephyr',
    gender: 'Female',
    category: 'Expressive',
    tagline: 'Female · Expressive',
    description: 'Vibrant storyteller with lively intonation, warmth, and emotional phrasing',
    style:
      'Expressive, vibrant female mentor and storyteller with rich vocal inflection, dynamic rise and fall, warm curiosity, and natural conversational cadence',
    fallbackPitch: 1.1,
    fallbackRate: 1.03,
  },
  {
    id: 'male-expressive',
    voiceName: 'Puck',
    modelTier: 'flash',
    name: 'Puck',
    gender: 'Male',
    category: 'Expressive',
    tagline: 'Male · Expressive',
    description: 'Energetic, charismatic mentor voice with vivid emphasis and natural flow',
    style:
      'Charismatic, enthusiastic male mentor explaining concepts with vivid emphasis, natural conversational rise and fall, upbeat warmth, and human breathing rhythm',
    fallbackPitch: 0.98,
    fallbackRate: 1.04,
  },
  {
    id: 'female-natural',
    voiceName: 'Kore',
    modelTier: 'flash',
    name: 'Kore',
    gender: 'Female',
    category: 'Natural',
    tagline: 'Female · Natural',
    description: 'Balanced, warm conversational voice with organic cadence for long reading',
    style:
      'Natural, warm, conversational female educator and audiobook narrator with gentle vocal rise and fall, organic phrasing pauses, and relaxed human rhythm',
    fallbackPitch: 1.0,
    fallbackRate: 1.0,
  },
  {
    id: 'male-natural',
    voiceName: 'Fenrir',
    modelTier: 'flash',
    name: 'Fenrir',
    gender: 'Male',
    category: 'Natural',
    tagline: 'Male · Natural',
    description: 'Articulate, conversational narrator with natural pauses and crisp diction',
    style:
      'Natural, articulate male educator and narrator with expressive intonation, warm conversational cadence, crisp diction, and natural breathing rhythm',
    fallbackPitch: 0.92,
    fallbackRate: 1.0,
  },
  {
    id: 'female-calm',
    voiceName: 'Zephyr',
    modelTier: 'lite',
    name: 'Aria',
    gender: 'Female',
    category: 'Calm',
    tagline: 'Female · Calm',
    description: 'Gentle, soothing mentor voice with melodic cadence for evening listening',
    style:
      'Soft, soothing, warm female mentor with gentle melodic rise and fall, unhurried evening storytelling cadence, and comforting pauses',
    fallbackPitch: 1.06,
    fallbackRate: 0.95,
  },
  {
    id: 'male-deep',
    voiceName: 'Charon',
    modelTier: 'flash',
    name: 'Charon',
    gender: 'Male',
    category: 'Deep',
    tagline: 'Male · Deep',
    description: 'Resonant lecture and documentary baritone with deliberate rhetorical cadence',
    style:
      'Deep, resonant male lecturer and documentary narrator with thoughtful vocal modulation, deliberate rhetorical pauses, and compelling rhythm',
    fallbackPitch: 0.84,
    fallbackRate: 0.95,
  },
];

const LEGACY_VOICE_MAP: Record<string, AiVoiceProfileId> = {
  Kore: 'female-teacher',
  Zephyr: 'female-calm',
  Fenrir: 'male-natural',
  Puck: 'male-expressive',
  Charon: 'male-teacher',
};

export function getAiVoiceProfile(id: string | null | undefined): AiVoiceProfile {
  if (!id) return AI_VOICE_PROFILES[0];
  const mappedId = LEGACY_VOICE_MAP[id] ?? id;
  return AI_VOICE_PROFILES.find((v) => v.id === mappedId) ?? AI_VOICE_PROFILES[0];
}

export function detectSentenceProsody(
  text: string,
  blockKind?: string
): SentenceProsodyKind {
  const trimmed = text.trim();
  if (blockKind === 'heading') return 'heading';
  if (blockKind === 'caption') return 'caption';
  if (blockKind === 'list') return 'list';
  if (/[?؟]["'”’)\]]*$/.test(trimmed)) return 'question';
  if (/[!]["'”’)\]]*$/.test(trimmed)) return 'exclamation';
  if (/^(\d+[.)]|[-•▪*]|\([a-z0-9]+\))\s+/i.test(trimmed)) return 'list';
  if (trimmed.length <= 64 && !/[.।۔,]$/.test(trimmed)) return 'heading';
  return 'narration';
}

export type VoiceStylePreference = 'teacher' | 'narrator' | 'energetic';

export interface VoiceStylePreferenceOption {
  id: VoiceStylePreference;
  label: string;
  description: string;
  styleDirective: string;
}

export const VOICE_STYLE_PREFERENCES: VoiceStylePreferenceOption[] = [
  {
    id: 'teacher',
    label: 'Teacher',
    description: 'Warm, experienced educator cadence with natural rise-and-fall and clear pauses',
    styleDirective:
      'Deliver like an experienced, patient teacher explaining ideas clearly to a student with natural pitch modulation and thoughtful pauses',
  },
  {
    id: 'narrator',
    label: 'Narrator',
    description: 'Smooth, composed audiobook storytelling with refined pacing and studio warmth',
    styleDirective:
      'Deliver like a polished literary audiobook narrator with smooth flowing cadence, poised studio warmth, and rich storytelling depth',
  },
  {
    id: 'energetic',
    label: 'Energetic',
    description: 'Upbeat, charismatic delivery with lively emphasis and dynamic inflection',
    styleDirective:
      'Deliver with bright, enthusiastic, charismatic energy, vivid vocal emphasis, and lively conversational momentum',
  },
];

export function getVoiceStylePreferenceOption(
  pref: VoiceStylePreference | string | null | undefined
): VoiceStylePreferenceOption {
  return (
    VOICE_STYLE_PREFERENCES.find((o) => o.id === pref) ?? VOICE_STYLE_PREFERENCES[0]
  );
}

export function getPreferredVoiceProfileForStyle(
  pref: VoiceStylePreference,
  currentProfileId?: AiVoiceProfileId
): AiVoiceProfileId {
  const isMale = currentProfileId ? getAiVoiceProfile(currentProfileId).gender === 'Male' : false;
  if (pref === 'teacher') return isMale ? 'male-teacher' : 'female-teacher';
  if (pref === 'narrator') return isMale ? 'male-natural' : 'female-natural';
  return isMale ? 'male-expressive' : 'female-expressive';
}

export function getVoiceStylePreferenceFromProfile(
  profileId: AiVoiceProfileId
): VoiceStylePreference {
  const profile = getAiVoiceProfile(profileId);
  if (profile.category === 'Teacher') return 'teacher';
  if (profile.category === 'Expressive') return 'energetic';
  return 'narrator';
}

