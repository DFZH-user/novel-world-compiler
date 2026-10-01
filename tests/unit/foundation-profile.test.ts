import { describe, expect, it } from 'vitest';
import { factPolicyForPromptVersion, normalizeFoundationProfile, sampleEvenly } from '../../src/shared/foundation-profile';
import { isSafeApiBaseUrl } from '../../src/shared/api-base-url';

describe('foundation analysis policies', () => {
  it('recognizes the three profiles and preserves the legacy profile', () => {
    expect(['low', 'medium', 'high', 'foundation-v1'].map(normalizeFoundationProfile)).toEqual(['low', 'medium', 'high', 'foundation-v1']);
    expect(() => normalizeFoundationProfile('unknown')).toThrow(/未知/);
    expect(factPolicyForPromptVersion('character_facts.v3.low')).toEqual({ context: 'none', maxDirectParagraphs: 800 });
    expect(factPolicyForPromptVersion('character_facts.v3.medium')).toEqual({ context: 'short', maxDirectParagraphs: null });
    expect(factPolicyForPromptVersion('character_facts.v3.high')).toEqual({ context: 'full', maxDirectParagraphs: null });
  });

  it('samples the beginning, end and intervening positions deterministically', () => {
    expect(sampleEvenly(Array.from({ length: 1000 }, (_, index) => index), 5)).toEqual([0, 250, 500, 749, 999]);
  });
});

describe('API base URL protection', () => {
  it('accepts TLS endpoints and local HTTP hosts only', () => {
    expect(isSafeApiBaseUrl('https://api.example.com/v1')).toBe(true);
    expect(isSafeApiBaseUrl('http://localhost:8080/v1')).toBe(true);
    expect(isSafeApiBaseUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isSafeApiBaseUrl('http://[::1]:8080/v1')).toBe(true);
    expect(isSafeApiBaseUrl('http://example.com/?localhost')).toBe(false);
    expect(isSafeApiBaseUrl('http://localhost.example.com/v1')).toBe(false);
    expect(isSafeApiBaseUrl('ftp://localhost/v1')).toBe(false);
  });
});
