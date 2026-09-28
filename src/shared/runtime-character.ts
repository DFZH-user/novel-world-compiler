import type { TavernCardV2 } from './contracts';

export type RuntimeCharacterDetail = { topic: string; content: string };
/** Keep whole claims, including ambiguity alternatives; topics only control retrieval. */
export function runtimeCharacterDetails(source: TavernCardV2, compact: TavernCardV2): RuntimeCharacterDetail[] {
  const compactText = [compact.data.description, compact.data.personality, compact.data.scenario, compact.data.mes_example].join('\n');
  const result: RuntimeCharacterDetail[] = [];
  const seen = new Set<string>();
  for (const [fallback, text] of [['人物资料', source.data.description], ['性格', source.data.personality],
    ['场景', source.data.scenario], ['说话方式', source.data.mes_example]]) {
    let category = fallback;
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim().replace(/\{\{char\}\}/giu, source.data.name);
      if (!line) continue;
      const heading = /^【([^】]+)】$/u.exec(line);
      if (heading) { category = heading[1]; continue; }
      if (seen.has(line) || compactText.includes(line)) continue;
      seen.add(line);
      const inline = /^【([^】]+)】/u.exec(line);
      const statement = line.replace(/^【[^】]+】/u, '');
      const topic = /^([^：:]{2,32})[：:]/u.exec(statement)?.[1] ?? inline?.[1] ?? category;
      result.push({ topic, content: `【${inline?.[1] ?? category}】${statement}` });
    }
  }
  return result;
}

export type RuntimeCharacter = {
  details: RuntimeCharacterDetail[];
  identityId: string;
  name: string;
  card: TavernCardV2;
  sourceChars: number;
  runtimeChars: number;
  omittedLines: number;
};

/** Select complete, deduplicated statements within each field; never cut a claim midway. */
function selectStatements(text: string, budget: number): { text: string; omitted: number } {
  const sections = new Map<string, string[]>();
  const seen = new Set<string>();
  let heading = '';
  for (const line of text.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
    if (/^【[^】]+】$/u.test(line)) { heading = line; continue; }
    const key = line.replace(/\s+/gu, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const group = sections.get(heading) ?? [];
    group.push(line); sections.set(heading, group);
  }
  // Give each category a chance, rather than letting a long ability section consume everything.
  const result: string[] = [];
  let used = 0, kept = 0;
  const groups = [...sections.entries()];
  const longest = Math.max(0, ...groups.map(([, lines]) => lines.length));
  for (let index = 0; index < longest; index += 1) {
    for (const [label, lines] of groups) {
      const line = lines[index];
      if (!line) continue;
      const value = `${label}${line}`;
      if (value.length > 500 || used + value.length + 1 > budget) continue;
      result.push(value); used += value.length + 1; kept += 1;
    }
  }
  return { text: result.join('\n'), omitted: seen.size - kept };
}

export function compactRuntimeCharacter(identityId: string, source: TavernCardV2): RuntimeCharacter {
  const characterText = (text: string) => text.replace(/\{\{char\}\}/giu, source.data.name);
  const description = selectStatements(characterText(source.data.description), 1600);
  const personality = selectStatements(characterText(source.data.personality), 1100);
  const examples = selectStatements(characterText(source.data.mes_example), 500);
  const scenario = selectStatements(characterText(source.data.scenario), 500);
  const card: TavernCardV2 = {
    ...source,
    data: {
      ...source.data,
      description: description.text || `人物：${source.data.name}。当前资料不足的部分保持未知。`,
      personality: personality.text,
      scenario: scenario.text,
      first_mes: `*${source.data.name}的故事继续。你可以描述自己的身份和第一个行动。*`,
      mes_example: examples.text,
      character_book: undefined,
      system_prompt: '你只扮演当前指定人物，不担任全局旁白。仅依据已揭示资料表现人物的性格、目标、能力和认知；缺失内容保持未知，不将不确定项擅自选定。玩家的行动、心理和台词由玩家决定。',
      post_history_instructions: '',
      alternate_greetings: [],
      creator_notes: '离线派生的精简运行卡。完整资料和原文证据保留在工程中；按完整语句选取资料，未选入的内容不等于不存在。',
      character_version: 'runtime-character.v1',
      extensions: { ...source.data.extensions, novel_world_runtime: { identity_id: identityId, policy: 'complete-statements.v1' } },
    },
  };
  const fields = (value: TavernCardV2) => [value.data.description, value.data.personality, value.data.scenario,
    value.data.mes_example, value.data.system_prompt, value.data.post_history_instructions].join('\n');
  return { identityId, name: source.data.name, card, details: runtimeCharacterDetails(source, card), sourceChars: fields(source).length,
    runtimeChars: fields(card).length, omittedLines: description.omitted + personality.omitted + scenario.omitted + examples.omitted };
}
