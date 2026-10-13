// The voices bundled with the extension. All are Kokoro voices (Apache-2.0).

export interface Voice {
  id: string;
  name: string;
  accent: 'American' | 'British';
  gender: 'Female' | 'Male';
}

export const VOICES: Voice[] = [
  { id: 'af_heart', name: 'Heart', accent: 'American', gender: 'Female' },
  { id: 'af_bella', name: 'Bella', accent: 'American', gender: 'Female' },
  { id: 'af_nicole', name: 'Nicole', accent: 'American', gender: 'Female' },
  { id: 'af_aoede', name: 'Aoede', accent: 'American', gender: 'Female' },
  { id: 'af_kore', name: 'Kore', accent: 'American', gender: 'Female' },
  { id: 'af_sarah', name: 'Sarah', accent: 'American', gender: 'Female' },
  { id: 'af_nova', name: 'Nova', accent: 'American', gender: 'Female' },
  { id: 'am_michael', name: 'Michael', accent: 'American', gender: 'Male' },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'American', gender: 'Male' },
  { id: 'am_puck', name: 'Puck', accent: 'American', gender: 'Male' },
  { id: 'am_echo', name: 'Echo', accent: 'American', gender: 'Male' },
  { id: 'bf_emma', name: 'Emma', accent: 'British', gender: 'Female' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'British', gender: 'Female' },
  { id: 'bm_george', name: 'George', accent: 'British', gender: 'Male' },
  { id: 'bm_fable', name: 'Fable', accent: 'British', gender: 'Male' },
];

export const DEFAULT_VOICE = 'af_heart';

export function voiceById(id: string): Voice {
  return VOICES.find((v) => v.id === id) ?? VOICES[0];
}
