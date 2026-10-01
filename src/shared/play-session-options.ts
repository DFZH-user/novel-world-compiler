import { z } from 'zod';
import { playProfiles, type PlayProfile } from './play-profile';

export type { PlayProfile } from './play-profile';

export const playSessionOptionsSchema = z.object({
  mode: z.enum(['narrator', 'character']),
  playProfile: z.enum(playProfiles).optional(),
  entryEventId: z.string().max(200).optional(),
  startingPlaceId: z.string().max(200).optional(),
  characterId: z.string().max(200).optional(),
  persona: z.object({
    name: z.string().trim().min(1, '请填写你的姓名').max(80),
    description: z.string().trim().max(1500),
    identityId: z.string().max(200).optional(),
  }),
});
export type PlaySessionOptions = z.infer<typeof playSessionOptionsSchema>;
export function selectedPlayProfile(options?: PlaySessionOptions): PlayProfile { return options?.playProfile ?? 'medium'; }
export type StartingScene = { state: 'complete' | 'partial' | 'unavailable'; context: string; locations: string[]; evidenceOrdinals: number[]; chosenLocation?: { id: string; name: string } };
export type PlayableEntryChoice = { eventId: string; title: string; ordinal: number; prepared?: boolean };
export type PlaySessionPreview = {
  startingScene?: StartingScene;
  projectId: string; projectName: string; entryEventId: string; entryTitle: string; entryOrdinal: number;
  worldEntryCount: number; worldTokenBudget: number; narratorChars: number; narratorEstimatedTokens: number; playProfile: PlayProfile;
  ruleKinshipPairCount: number;
  availablePlaces: Array<{ id: string; name: string }>;
  characters: Array<{ identityId: string; name: string; sourceChars: number; runtimeChars: number; runtimeEstimatedTokens: number; personaDescription: string }>;
};
