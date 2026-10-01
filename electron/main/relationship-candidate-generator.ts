import type {
  RelationshipScanCandidate,
  RelationshipScanOutput,
  RelationshipScanWorkItem,
} from '../../src/shared/contracts';

const MAX_CANDIDATES_PER_PARAGRAPH = 40;
const MAX_COOCCURRENCE_DISTANCE = 160;

const RELATION_RULES: Array<{ type: string; pattern: RegExp }> = [
  { type: '父子/父女', pattern: /父亲|父皇|父王|爹爹|爹|爸爸/u },
  { type: '母子/母女', pattern: /母亲|母后|娘亲|娘|妈妈/u },
  { type: '兄弟', pattern: /兄长|哥哥|弟弟|兄弟/u },
  { type: '姐妹', pattern: /姐姐|妹妹|姐妹/u },
  { type: '夫妻', pattern: /丈夫|妻子|夫君|夫人|夫妻/u },
  { type: '师徒', pattern: /师父|师傅|徒弟|弟子|师徒/u },
  { type: '恋人', pattern: /恋人|爱人|情侣|未婚夫|未婚妻/u },
  { type: '朋友', pattern: /朋友|好友|挚友/u },
  { type: '同盟', pattern: /盟友|同盟|结盟/u },
  { type: '同伴', pattern: /同伴|队友|同行/u },
  { type: '敌对', pattern: /敌人|仇敌|仇人|宿敌|死敌/u },
];

type Mention = { identityId: string; start: number; end: number };

function uniqueTerms(item: RelationshipScanWorkItem): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const character of item.characters) {
    for (const raw of [character.name, ...character.aliases]) {
      const term = raw.normalize('NFKC').trim();
      if (term.length < 2) continue;
      const existing = owners.get(term) ?? new Set<string>();
      existing.add(character.identityId);
      owners.set(term, existing);
    }
  }
  return new Map([...owners.entries()]
    .filter(([, identityIds]) => identityIds.size === 1)
    .map(([term, identityIds]) => [term, [...identityIds][0]]));
}

function mentionsIn(text: string, terms: Map<string, string>): Mention[] {
  const matches: Mention[] = [];
  for (const [term, identityId] of terms) {
    let start = text.indexOf(term);
    while (start >= 0) {
      matches.push({ identityId, start, end: start + term.length });
      start = text.indexOf(term, start + term.length);
    }
  }
  const accepted: Mention[] = [];
  for (const mention of matches.sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start)) {
    const overlaps = accepted.some((existing) => mention.start < existing.end && existing.start < mention.end);
    if (!overlaps) accepted.push(mention);
  }
  return accepted.sort((left, right) => left.start - right.start || left.end - right.end);
}

function sentenceQuote(text: string, left: Mention, right: Mention): string {
  const startAt = Math.min(left.start, right.start);
  const endAt = Math.max(left.end, right.end);
  const before = text.slice(0, startAt);
  const boundary = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('\n'));
  const start = boundary < 0 ? 0 : boundary + 1;
  const remainder = text.slice(endAt);
  const match = remainder.search(/[。！？!?；;\n]/u);
  const end = match < 0 ? text.length : endAt + match + 1;
  return text.slice(start, end).trim() || text;
}

function relationshipType(text: string, left: Mention, right: Mention, allMentions: Mention[]): string | null {
  const [first, second] = left.start <= right.start ? [left, right] : [right, left];
  const between = text.slice(first.end, second.start);
  if (/[。！？!?；;\n]/u.test(between)) return null;
  const before = text.slice(0, first.start);
  const sentenceStart = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'),
    before.lastIndexOf('；'), before.lastIndexOf('\n')) + 1;
  const after = text.slice(second.end);
  const nextBoundary = after.search(/[。！？!?；;\n]/u);
  const sentenceEnd = nextBoundary < 0 ? text.length : second.end + nextBoundary;
  // When a third named person appears in the same sentence, a kinship word may
  // refer to that person instead of this pair. Keep it as a reviewable cooccurrence.
  if (allMentions.some(mention => mention.identityId !== first.identityId
    && mention.identityId !== second.identityId
    && mention.start >= sentenceStart && mention.end <= sentenceEnd)) return null;

  const window = text.slice(Math.max(sentenceStart, first.start - 20), Math.min(sentenceEnd, second.end + 20));
  const rule = RELATION_RULES.find(item => item.pattern.test(window));
  if (!rule) return null;
  if (!['父子/父女', '母子/母女', '兄弟', '姐妹', '夫妻'].includes(rule.type)) return rule.type;

  const connector = /[和与跟是乃为叫称的]/u;
  const betweenMatch = between.match(rule.pattern);
  const explicitBetween = Boolean(betweenMatch && betweenMatch.index! <= 8
    && connector.test(between.slice(0, betweenMatch.index)));
  const afterMatch = after.slice(0, 12).match(rule.pattern);
  const explicitAfter = Boolean(afterMatch && afterMatch.index! <= 4
    && between.length <= 12 && connector.test(between));
  return explicitBetween || explicitAfter ? rule.type : null;
}

function pairKey(leftIdentityId: string, rightIdentityId: string): [string, string] {
  return leftIdentityId.localeCompare(rightIdentityId) <= 0
    ? [leftIdentityId, rightIdentityId]
    : [rightIdentityId, leftIdentityId];
}

function closestMentions(left: Mention[], right: Mention[]): [Mention, Mention] {
  let best: [Mention, Mention] = [left[0], right[0]];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const leftMention of left) {
    for (const rightMention of right) {
      const distance = Math.max(0, Math.max(leftMention.start, rightMention.start) - Math.min(leftMention.end, rightMention.end));
      if (distance < bestDistance) {
        best = [leftMention, rightMention];
        bestDistance = distance;
      }
    }
  }
  return best;
}

export function generateLocalRelationshipCandidates(item: RelationshipScanWorkItem): RelationshipScanOutput {
  const terms = uniqueTerms(item);
  const candidates: RelationshipScanCandidate[] = [];

  for (const paragraph of item.paragraphs.filter((row) => row.role === 'core')) {
    const mentions = mentionsIn(paragraph.text, terms);
    const mentionsByIdentity = new Map<string, Mention[]>();
    for (const mention of mentions) {
      mentionsByIdentity.set(mention.identityId, [...(mentionsByIdentity.get(mention.identityId) ?? []), mention]);
    }
    const identities = [...mentionsByIdentity.keys()];
    const seen = new Set<string>();
    let paragraphCandidateCount = 0;

    for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
        if (paragraphCandidateCount >= MAX_CANDIDATES_PER_PARAGRAPH) break;
        const [leftMention, rightMention] = closestMentions(
          mentionsByIdentity.get(identities[leftIndex])!,
          mentionsByIdentity.get(identities[rightIndex])!,
        );
        const distance = Math.max(0, Math.max(leftMention.start, rightMention.start) - Math.min(leftMention.end, rightMention.end));
        const proposedType = distance <= 80 ? relationshipType(paragraph.text, leftMention, rightMention, mentions) : null;
        if (!proposedType && distance > MAX_COOCCURRENCE_DISTANCE) continue;
        const [sourceIdentityId, targetIdentityId] = pairKey(leftMention.identityId, rightMention.identityId);
        const key = `${sourceIdentityId}:${targetIdentityId}:${proposedType ?? 'cooccurrence'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          sourceIdentityId,
          targetIdentityId,
          method: proposedType ? 'rule' : 'cooccurrence',
          proposedType,
          confidence: proposedType ? 0.78 : 0.35,
          evidence: [{
            paragraphId: paragraph.paragraphId,
            exactQuote: sentenceQuote(paragraph.text, leftMention, rightMention),
            role: 'clue',
          }],
        });
        paragraphCandidateCount += 1;
      }
      if (paragraphCandidateCount >= MAX_CANDIDATES_PER_PARAGRAPH) break;
    }
  }

  return { candidates };
}
