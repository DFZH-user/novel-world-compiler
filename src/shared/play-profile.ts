export const playProfiles = ['low', 'medium', 'high'] as const;
export type PlayProfile = typeof playProfiles[number];

export function playProfileSettings(profile: PlayProfile) {
  if (profile === 'low') return {
    descriptionChars: 500, personalityChars: 300, exampleChars: 100, scenarioChars: 180,
    worldTokenBudget: 512,
  };
  if (profile === 'high') return {
    descriptionChars: 1450, personalityChars: 750, exampleChars: 350, scenarioChars: 400,
    worldTokenBudget: 2048,
  };
  return {
    descriptionChars: 850, personalityChars: 450, exampleChars: 200, scenarioChars: 250,
    worldTokenBudget: 1024,
  };
}
