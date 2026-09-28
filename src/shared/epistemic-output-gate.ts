import { z } from 'zod';

const stanceSchema = z.enum(['known', 'believed', 'doubted', 'forbidden']);

export const outputClaimRuleSchema = z.object({
  claimId: z.string().min(1),
  stance: stanceSchema,
  surfaceForms: z.array(z.string().min(1)).min(1),
  requiredInAnswer: z.boolean().default(false),
});

export const epistemicOutputGateInputSchema = z.object({
  text: z.string(),
  claims: z.array(outputClaimRuleSchema),
  forbiddenMetaTerms: z.array(z.string().min(1)).default(['入口', '上下文', '标签', '数据库', '提示词', '测试']),
});

export type OutputClaimRule = z.input<typeof outputClaimRuleSchema>;
export type EpistemicOutputGateInput = z.input<typeof epistemicOutputGateInputSchema>;

export interface EpistemicOutputViolation {
  code: 'belief_without_prior_uncertainty' | 'known_fact_demoted' | 'required_claim_missing' | 'forbidden_claim' | 'forbidden_meta_term';
  claimId: string | null;
  surface: string;
  offset: number;
  message: string;
}

export interface EpistemicOutputGateResult {
  allowed: boolean;
  action: 'allow' | 'block';
  policyVersion: 'epistemic-output-gate.v1';
  violations: EpistemicOutputViolation[];
}

const clauseBoundary = /[，,；;。！？!?：:\n]/u;
const uncertaintyMarker = /(?:我(?:推测|怀疑|猜测)|可能|或许|尚未|未证实|没证实|没有确证|拿不准|不确定|不能确定|只是(?:我的)?(?:推断|猜测|怀疑))/u;

function clausePrefix(text: string, offset: number): string {
  let start = offset - 1;
  while (start >= 0 && !clauseBoundary.test(text[start])) start -= 1;
  return text.slice(start + 1, offset);
}

function occurrences(text: string, surface: string) {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= text.length - surface.length) {
    const found = text.indexOf(surface, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + Math.max(1, surface.length);
  }
  return offsets;
}

export function evaluateEpistemicOutput(inputValue: EpistemicOutputGateInput): EpistemicOutputGateResult {
  const input = epistemicOutputGateInputSchema.parse(inputValue);
  const violations: EpistemicOutputViolation[] = [];
  for (const term of input.forbiddenMetaTerms) {
    for (const offset of occurrences(input.text, term)) {
      violations.push({
        code: 'forbidden_meta_term', claimId: null, surface: term, offset,
        message: `回答包含禁止的幕后措辞：${term}`,
      });
    }
  }
  for (const claim of input.claims) {
    const hits = claim.surfaceForms.flatMap((surface) => occurrences(input.text, surface).map((offset) => ({ surface, offset })));
    if (claim.requiredInAnswer && hits.length === 0) {
      violations.push({
        code: 'required_claim_missing', claimId: claim.claimId, surface: claim.surfaceForms[0], offset: -1,
        message: `回答缺少必须表达的命题：${claim.claimId}`,
      });
      continue;
    }
    for (const hit of hits) {
      if (claim.stance === 'forbidden') {
        violations.push({
          code: 'forbidden_claim', claimId: claim.claimId, surface: hit.surface, offset: hit.offset,
          message: '回答包含当前进入点不可使用的未来或越界命题',
        });
        continue;
      }
      const prefix = clausePrefix(input.text, hit.offset);
      const uncertain = uncertaintyMarker.test(prefix);
      if ((claim.stance === 'believed' || claim.stance === 'doubted') && !uncertain) {
        violations.push({
          code: 'belief_without_prior_uncertainty', claimId: claim.claimId, surface: hit.surface, offset: hit.offset,
          message: `${claim.stance === 'believed' ? '角色信念' : '角色存疑'}在同一分句中没有先写不确定标记`,
        });
      }
      if (claim.stance === 'known' && uncertain) {
        violations.push({
          code: 'known_fact_demoted', claimId: claim.claimId, surface: hit.surface, offset: hit.offset,
          message: '角色已知在同一分句中被降级为推测或怀疑',
        });
      }
    }
  }
  return {
    allowed: violations.length === 0,
    action: violations.length === 0 ? 'allow' : 'block',
    policyVersion: 'epistemic-output-gate.v1',
    violations,
  };
}
