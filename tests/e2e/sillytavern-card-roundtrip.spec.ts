import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { withIsolatedSillyTavern } from './helpers/isolated-sillytavern';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function importCard(baseUrl: string, format: 'json' | 'png', contents: string | Uint8Array, name: string): Promise<string> {
  const form = new FormData();
  form.append('file_type', format);
  form.append('preserved_name', name);
  form.append('avatar', new Blob([typeof contents === 'string' ? contents : Uint8Array.from(contents).buffer], { type: format === 'json' ? 'application/json' : 'image/png' }), `${name}.${format}`);
  const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: form });
  const body = await response.json() as { error?: boolean; file_name?: string };
  if (!response.ok || body.error || !body.file_name) throw new Error(`SillyTavern ${format} 导入失败：${JSON.stringify(body)}`);
  return body.file_name;
}

async function exportCard(baseUrl: string, avatarUrl: string, format: 'json' | 'png'): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/characters/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar_url: avatarUrl, format }),
  });
  if (!response.ok) throw new Error(`SillyTavern ${format} 导出失败：HTTP ${response.status}`);
  return response;
}

const sourceCard = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  x_roundtrip_probe: { keep: true, nested: ['top-level', 17] },
  data: {
    name: '回环验收角色',
    description: '用于验证角色卡数据在酒馆内部 PNG 中的保留范围。',
    personality: '严谨、克制。',
    scenario: '进入事件之后，但不越过防剧透边界。',
    first_mes: '我们从已经确认的事实开始。',
    mes_example: '<START>\n{{char}}: 证据优先。',
    creator_notes: '第十批隔离兼容验收。',
    system_prompt: '不得提前泄露进入事件之后的信息。',
    post_history_instructions: '保持来源约束。',
    alternate_greetings: ['先核对进入点。'],
    tags: ['roundtrip', 'novel-world-compiler'],
    creator: 'novel-world-compiler',
    character_version: 'batch-10',
    extensions: {
      talkativeness: 0.65,
      fav: true,
      novel_world_compiler: {
        project_id: 'project-roundtrip',
        source_revision_id: 'revision-roundtrip',
        entry_point_event_id: 'event-roundtrip',
        playable_bundle_fingerprint: 'bundle-fingerprint-roundtrip',
        embedded_character_book_fingerprint: 'book-fingerprint-roundtrip',
      },
      x_unknown_extension: { keep: true, nested: { value: 23 } },
    },
    character_book: {
      name: '回环验收角色知识',
      description: '隔离回环探针',
      scan_depth: 4,
      token_budget: 768,
      recursive_scanning: false,
      extensions: {
        novel_world_compiler: { entry_point_event_id: 'event-roundtrip' },
        x_unknown_book_extension: { keep: true },
      },
      entries: [{
        id: 1,
        keys: ['回环验收角色', '进入点'],
        secondary_keys: ['证据'],
        comment: '关系与地点合并条目',
        content: '只包含进入事件之前已经确认的关系与地点信息。',
        constant: false,
        selective: true,
        insertion_order: 100,
        enabled: true,
        position: 'before_char',
        use_regex: false,
        extensions: {
          source_book: 'relationships',
          source_relation_id: 'relation-roundtrip',
          source_place_id: 'place-roundtrip',
          x_unknown_entry_extension: { keep: true, order: [3, 1, 2] },
        },
      }],
    },
  },
};

test('round-trips V2 JSON through SillyTavern internal PNG without claiming formal V3 compatibility', async () => {
  test.skip(process.env.RUN_SILLYTAVERN_CARD_ROUNDTRIP !== '1', 'Explicit local SillyTavern compatibility acceptance only');
  test.setTimeout(180_000);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillytavern-card-roundtrip-'));
  const sourceJson = JSON.stringify(sourceCard, null, 2);
  const expectedNormalizedData = structuredClone(sourceCard.data);
  expectedNormalizedData.extensions.fav = false;
  let isolatedDataRoot = '';
  try {
    const acceptance = await withIsolatedSillyTavern(tempRoot, async ({ baseUrl, dataRoot, version }) => {
      isolatedDataRoot = dataRoot;
      const importedName = await importCard(baseUrl, 'json', sourceJson, 'roundtrip-v2-source');
      const avatarUrl = `${importedName}.png`;
      const internalResponse = await fetch(`${baseUrl}/api/characters/get`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar_url: avatarUrl }),
      });
      expect(internalResponse.ok).toBe(true);
      const internalCard = await internalResponse.json() as typeof sourceCard;

      const jsonExport = await (await exportCard(baseUrl, avatarUrl, 'json')).json() as typeof sourceCard;
      const pngBytes = new Uint8Array(await (await exportCard(baseUrl, avatarUrl, 'png')).arrayBuffer());
      const reimportedName = await importCard(baseUrl, 'png', pngBytes, 'roundtrip-png-reimport');
      const reexportedJson = await (await exportCard(baseUrl, `${reimportedName}.png`, 'json')).json() as typeof sourceCard;

      for (const card of [internalCard, jsonExport, reexportedJson]) {
        expect(card.data).toEqual(expectedNormalizedData);
        expect(card.x_roundtrip_probe).toEqual(sourceCard.x_roundtrip_probe);
      }
      expect(jsonExport.spec).toBe('chara_card_v3');
      expect(jsonExport.spec_version).toBe('3.0');
      expect('group_only_greetings' in jsonExport.data).toBe(false);
      expect(reexportedJson.spec).toBe('chara_card_v3');
      expect(reexportedJson.spec_version).toBe('3.0');
      expect(pngBytes.byteLength).toBeGreaterThan(1_000);

      return {
        checkedAt: new Date().toISOString(),
        sillyTavernVersion: version,
        isolatedDataRoot: dataRoot,
        endpoints: ['/api/characters/import', '/api/characters/get', '/api/characters/export'],
        source: { format: 'Character Card V2 JSON', spec: sourceCard.spec, specVersion: sourceCard.spec_version, sha256: sha256(sourceJson) },
        observed: {
          internalReadSpec: internalCard.spec,
          internalReadSpecVersion: internalCard.spec_version,
          jsonReExportSpec: jsonExport.spec,
          jsonReExportSpecVersion: jsonExport.spec_version,
          v3RequiredGroupOnlyGreetingsPresent: 'group_only_greetings' in jsonExport.data,
          pngBytes: pngBytes.byteLength,
          pngSha256: sha256(pngBytes),
          pngReimportJsonSpec: reexportedJson.spec,
          pngReimportJsonSpecVersion: reexportedJson.spec_version,
        },
        preservation: {
          characterDataExceptDocumentedPrivateFields: true,
          privateFavoriteNormalizedFalse: true,
          unknownTopLevelField: true,
          unknownDataExtension: true,
          embeddedCharacterBook: true,
          unknownBookExtension: true,
          unknownEntryExtension: true,
          entryPointAndSourceFingerprints: true,
        },
        observedNormalizations: ['fav forced to false', 'chat removed on export', 'create_date and legacy top-level fields may be added'],
        compatibilityMatrix: {
          characterCardV2JsonImport: 'supported',
          sillyTavernInternalPngRoundTrip: 'semantic-data-preserved',
          jsonReExportAfterImport: 'semantic-data-preserved-but-spec-relabelled-v3',
          formalCharacterCardV3: 'not-conformant-missing-required-group-only-greetings',
        },
        productPolicy: {
          authoritativeFormat: 'Character Card V2 JSON',
          pngStatus: 'optional-derived-candidate',
          v3Status: 'not-supported',
        },
      };
    });

    await expect(fs.access(isolatedDataRoot)).rejects.toThrow();
    await fs.mkdir(path.resolve('verification-results'), { recursive: true });
    await fs.writeFile(
      path.resolve('verification-results', 'sillytavern-character-card-roundtrip-result.json'),
      JSON.stringify(acceptance.result, null, 2) + '\n',
      'utf8',
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
