export type GeminiPrebuiltVoiceName = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

export type NeuralVoiceGender = 'Female' | 'Male';

export type NeuralVoiceCategory = 'Natural' | 'Expressive' | 'Calm' | 'Deep';

export type AiVoiceProfileId =
  | 'female-natural'
  | 'female-expressive'
  | 'female-calm'
  | 'male-natural'
  | 'male-expressive'
  | 'male-deep';

export interface AiVoiceProfile {
  id: AiVoiceProfileId;
  /** Gemini neural prebuilt voice sent to /api/tts */
  voiceName: GeminiPrebuiltVoiceName;
  name: string;
  gender: NeuralVoiceGender;
  category: NeuralVoiceCategory;
  /** Concise gender & delivery label shown in dropdown */
  tagline: string;
  description: string;
  /** Detailed vocal direction passed to Gemini TTS speechMetadata.style */
  style: string;
  /** Subtle acoustic timbre multiplier used when free HD fallback is active */
  fallbackPitch: number;
  fallbackRate: number;
}

export const AI_VOICE_PROFILES: AiVoiceProfile[] = [
  {
    id: 'female-natural',
    voiceName: 'Kore',
    name: 'Kore',
    gender: 'Female',
    category: 'Natural',
    tagline: 'Female · Natural',
    description: 'Balanced, clear studio narrator ideal for books and technical guides',
    style: 'Natural, clear, warm female audiobook narrator with steady pacing',
    fallbackPitch: 1.0,
    fallbackRate: 1.0,
  },
  {
    id: 'female-expressive',
    voiceName: 'Zephyr',
    name: 'Zephyr',
    gender: 'Female',
    category: 'Expressive',
    tagline: 'Female · Expressive',
    description: 'Rich, emotive storytelling with lively intonation and emphasis',
    style: 'Expressive, vibrant, engaging female storyteller with dynamic vocal inflection',
    fallbackPitch: 1.12,
    fallbackRate: 1.04,
  },
  {
    id: 'female-calm',
    voiceName: 'Zephyr',
    name: 'Aria',
    gender: 'Female',
    category: 'Calm',
    tagline: 'Female · Calm',
    description: 'Smooth, gentle relaxed cadence for long evening listening',
    style: 'Soft, soothing, calm female late-night audiobook narrator',
    fallbackPitch: 1.07,
    fallbackRate: 0.94,
  },
  {
    id: 'male-natural',
    voiceName: 'Fenrir',
    name: 'Fenrir',
    gender: 'Male',
    category: 'Natural',
    tagline: 'Male · Natural',
    description: 'Articulate, conversational narrator with crisp pronunciation',
    style: 'Natural, articulate, balanced male audiobook narrator with crisp diction',
    fallbackPitch: 0.91,
    fallbackRate: 1.0,
  },
  {
    id: 'male-expressive',
    voiceName: 'Puck',
    name: 'Puck',
    gender: 'Male',
    category: 'Expressive',
    tagline: 'Male · Expressive',
    description: 'Energetic, charismatic studio voice with vivid emphasis',
    style: 'Expressive, bright, charismatic male audiobook narrator with lively warmth',
    fallbackPitch: 0.98,
    fallbackRate: 1.05,
  },
  {
    id: 'male-deep',
    voiceName: 'Charon',
    name: 'Charon',
    gender: 'Male',
    category: 'Deep',
    tagline: 'Male · Deep',
    description: 'Rich, authoritative documentary baritone voice',
    style: 'Deep, calm, authoritative male documentary audiobook baritone',
    fallbackPitch: 0.83,
    fallbackRate: 0.95,
  },
];

const LEGACY_VOICE_MAP: Record<string, AiVoiceProfileId> = {
  Kore: 'female-natural',
  Zephyr: 'female-calm',
  Fenrir: 'male-natural',
  Puck: 'male-expressive',
  Charon: 'male-deep',
};

export function getAiVoiceProfile(id: string | null | undefined): AiVoiceProfile {
  if (!id) return AI_VOICE_PROFILES[0];
  const mappedId = LEGACY_VOICE_MAP[id] ?? id;
  return AI_VOICE_PROFILES.find((v) => v.id === mappedId) ?? AI_VOICE_PROFILES[0];
}
