import { describe, expect, it } from 'vitest';
import { evaluateEpistemicOutput } from '../../src/shared/epistemic-output-gate';

const claims = [
  { claimId: 'trap', stance: 'known' as const, surfaceForms: ['诱骗我的陷阱'], requiredInAnswer: true },
  { claimId: 'origin', stance: 'believed' as const, surfaceForms: ['山地部族'] },
  { claimId: 'purpose', stance: 'believed' as const, surfaceForms: ['火祭'] },
];

describe('epistemic output gate', () => {
  it('allows a response whose known fact and beliefs keep their declared stance', () => {
    const result = evaluateEpistemicOutput({
      text: '那声“快去护卫”是诱骗我的陷阱，这点我清楚。我推测他们属于山地部族，我怀疑他们想把我留作火祭。',
      claims,
    });
    expect(result).toEqual({ allowed: true, action: 'allow', policyVersion: 'epistemic-output-gate.v1', violations: [] });
  });

  it('blocks the real v3 failure where only the second belief is qualified', () => {
    const result = evaluateEpistemicOutput({
      text: '左侧那声“快去护卫”，我已知是诱骗我的陷阱。他们属于山地部族，我怀疑是要留下我作火祭。',
      claims,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({ code: 'belief_without_prior_uncertainty', claimId: 'origin' }));
  });

  it('blocks a known fact that is demoted to a suspicion', () => {
    const result = evaluateEpistemicOutput({
      text: '我怀疑那声喊话是诱骗我的陷阱。',
      claims: [claims[0]],
    });
    expect(result.violations).toContainEqual(expect.objectContaining({ code: 'known_fact_demoted', claimId: 'trap' }));
  });

  it('blocks missing required claims and backstage language', () => {
    const result = evaluateEpistemicOutput({
      text: '入口之后的上下文我不知道。',
      claims: [claims[0]],
    });
    expect(result.action).toBe('block');
    expect(result.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      'forbidden_meta_term', 'required_claim_missing',
    ]));
  });

  it('blocks a future claim even when it is phrased confidently', () => {
    const result = evaluateEpistemicOutput({
      text: '后来他成为了最终的新帝。',
      claims: [{ claimId: 'future-title', stance: 'forbidden', surfaceForms: ['最终的新帝'] }],
    });
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'forbidden_claim', claimId: 'future-title', surface: '最终的新帝',
    }));
  });
});
