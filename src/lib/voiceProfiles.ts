export type AiVoiceProfileId = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

export interface AiVoiceProfile {
  id: AiVoiceProfileId;
  name: string;
  tagline: string;
  description: string;
  style: string;
  /** Subtle acoustic timbre multiplier used when free MP3 fallback is active */
  fallbackPitch: number;
  fallbackRate: number;
}

export const AI_VOICE_PROFILES: AiVoiceProfile[] = [
  {
    id: 'Kore',
    name: 'Kore',
    tagline: 'Warm',
    description: 'Balanced, clear studio narrator for technical books',
    style: 'Warm, clear, steady technical audiobook narrator',
    fallbackPitch: 1.0,
    fallbackRate: 1.0,
  },
  {
    id: 'Puck',
    name: 'Puck',
    tagline: 'Bright',
    description: 'Lively, upbeat conversational delivery',
    style: 'Bright, energetic, friendly instructional narrator',
    fallbackPitch: 1.12,
    fallbackRate: 1.04,
  },
  {
    id: 'Charon',
    name: 'Charon',
    tagline: 'Deep',
    description: 'Rich, calm baritone documentary voice',
    style: 'Deep, calm, authoritative documentary audiobook narrator',
    fallbackPitch: 0.85,
    fallbackRate: 0.96,
  },
  {
    id: 'Fenrir',
    name: 'Fenrir',
    tagline: 'Crisp',
    description: 'Expressive, articulate studio host',
    style: 'Expressive, crisp, engaging studio narrator with clear emphasis',
    fallbackPitch: 0.93,
    fallbackRate: 1.02,
  },
  {
    id: 'Zephyr',
    name: 'Zephyr',
    tagline: 'Soft',
    description: 'Smooth, gentle relaxed reading tone',
    style: 'Soft, gentle, soothing late-night audiobook storyteller',
    fallbackPitch: 1.07,
    fallbackRate: 0.95,
  },
];

export function getAiVoiceProfile(id: string | null | undefined): AiVoiceProfile {
  return AI_VOICE_PROFILES.find((v) => v.id === id) ?? AI_VOICE_PROFILES[0];
}
