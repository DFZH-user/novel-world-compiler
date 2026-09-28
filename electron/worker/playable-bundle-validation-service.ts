import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { embeddedWorldInfoEntry, worldInfoMatchesContext, type WorldInfoSourceEntry } from './world-info-semantics';
import type {
  PlayableBundleFileRecord,
  PlayableBundleManifest,
  PlayableBundleValidationFile,
  PlayableBundleValidationIssue,
  PlayableBundleValidationReport,
  TavernCharacterBook,
} from '../../src/shared/contracts';
import {
  playableBundleManifestSchema,
  sillyTavernPlaceWorldInfoExportSchema,
  sillyTavernWorldInfoExportSchema,
  tavernCardV2Schema,
  tavernCharacterBookSchema,
} from '../../src/shared/contracts';
import { buildPlayableRuntimePolicy } from './playable-epistemic-policy';
import type { ProjectStore } from './project-store';

type ProjectRow = { id: string; revisionId: string | null };
type ParsedAsset = { record: PlayableBundleFileRecord; value: unknown };

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compilerExtension(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(value).novel_world_compiler);
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isSafeManifestPath(value: string): boolean {
  const segments = value.split('/');
  return value !== 'manifest.json'
    && !value.includes('\\')
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== '..'
    && !value.startsWith('../')
    && segments.every((segment) => segment.length > 0
      && !/[<>:"|?*\u0000-\u001f]/u.test(segment)
      && !/[. ]$/u.test(segment)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment));
}

function entryPointShape(value: unknown): boolean {
  const root = asRecord(value);
  const project = asRecord(root.project);
  const event = asRecord(root.event);
  const fingerprints = asRecord(root.source_fingerprints);
  return root.format === 'novel-world-entry-point'
    && typeof root.spec_version === 'string'
    && Number.isInteger(root.schema_version)
    && typeof project.id === 'string'
    && typeof project.name === 'string'
    && typeof project.revision_id === 'string'
    && typeof event.id === 'string'
    && typeof event.title === 'string'
    && Number.isInteger(event.narrative_ordinal)
    && ['character_cards', 'relationship_world_info', 'place_world_info', 'character_book', 'bundle']
      .every((key) => typeof fingerprints[key] === 'string');
}

export class PlayableBundleValidationService {
  constructor(private readonly store: ProjectStore) {}

  async validate(packageDirectory: string): Promise<PlayableBundleValidationReport> {
    const root = path.resolve(packageDirectory);
    const issues: PlayableBundleValidationIssue[] = [];
    const files: PlayableBundleValidationFile[] = [];
    const parsedAssets: ParsedAsset[] = [];
    const addIssue = (severity: 'error' | 'warning', code: string, message: string, filePath?: string) => {
      issues.push({ severity, code, message, ...(filePath ? { path: filePath } : {}) });
    };

    let rootReal: string;
    try {
      rootReal = await fs.realpath(root);
      if (!(await fs.stat(rootReal)).isDirectory()) throw new Error('not-directory');
    } catch {
      addIssue('error', 'bundle-directory-missing', '所选路径不是可读取的整合包文件夹。');
      return this.report(root, null, files, issues, false, 0, 0);
    }

    let rawManifest: string;
    try {
      rawManifest = await fs.readFile(path.join(rootReal, 'manifest.json'), 'utf8');
    } catch {
      addIssue('error', 'manifest-missing', '整合包根目录缺少 manifest.json。', 'manifest.json');
      return this.report(root, null, files, issues, false, 0, 0);
    }

    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(rawManifest);
    } catch {
      addIssue('error', 'manifest-invalid-json', 'manifest.json 不是有效 JSON。', 'manifest.json');
      return this.report(root, null, files, issues, false, 0, 0);
    }
    const parsedManifest = playableBundleManifestSchema.safeParse(manifestValue);
    if (!parsedManifest.success) {
      const first = parsedManifest.error.issues[0];
      addIssue('error', 'manifest-invalid-schema', `manifest.json 不符合整合包契约：${first?.path.join('.') || 'root'} ${first?.message || ''}`.trim(), 'manifest.json');
      return this.report(root, null, files, issues, false, 0, 0);
    }
    const manifest = parsedManifest.data as PlayableBundleManifest;
    const currentProjectMatch = this.checkCurrentProject(manifest, addIssue);
    const seenPaths = new Set<string>();

    for (const record of manifest.files) {
      const file: PlayableBundleValidationFile = {
        path: record.path,
        kind: record.kind,
        status: 'ok',
        expectedChecksum: record.checksum,
        expectedBytes: record.bytes,
      };
      files.push(file);
      const pathKey = record.path.toLocaleLowerCase('en-US');
      if (seenPaths.has(pathKey)) {
        file.status = 'unsafe-path';
        addIssue('error', 'duplicate-file-path', '清单包含重复文件路径。', record.path);
        continue;
      }
      seenPaths.add(pathKey);
      if (!isSafeManifestPath(record.path)) {
        file.status = 'unsafe-path';
        addIssue('error', 'unsafe-file-path', '清单文件路径不是规范的包内 POSIX 相对路径。', record.path);
        continue;
      }

      const lexicalTarget = path.resolve(rootReal, ...record.path.split('/'));
      if (!isContained(rootReal, lexicalTarget)) {
        file.status = 'unsafe-path';
        addIssue('error', 'path-traversal', '清单文件路径越过整合包根目录。', record.path);
        continue;
      }
      let targetReal: string;
      try {
        targetReal = await fs.realpath(lexicalTarget);
        if (!isContained(rootReal, targetReal) || !(await fs.stat(targetReal)).isFile()) {
          file.status = 'unsafe-path';
          addIssue('error', 'symlink-escape', '文件或符号链接的实际位置不在整合包内。', record.path);
          continue;
        }
      } catch {
        file.status = 'missing';
        addIssue('error', 'managed-file-missing', '清单记录的文件不存在或不可读取。', record.path);
        continue;
      }

      const content = await fs.readFile(targetReal);
      file.actualBytes = content.byteLength;
      file.actualChecksum = sha256(content);
      if (file.actualChecksum !== record.checksum) {
        file.status = 'checksum-mismatch';
        addIssue('error', 'checksum-mismatch', '文件 SHA-256 与清单不一致，内容可能已损坏或被修改。', record.path);
      }
      if (file.actualBytes !== record.bytes) {
        if (file.status === 'ok') file.status = 'size-mismatch';
        addIssue('error', 'size-mismatch', '文件字节数与清单不一致。', record.path);
      }

      let value: unknown;
      try {
        value = JSON.parse(content.toString('utf8'));
      } catch {
        if (file.status === 'ok') file.status = 'invalid-json';
        addIssue('error', 'asset-invalid-json', '文件不是有效 JSON。', record.path);
        continue;
      }
      const schemaError = this.schemaError(record.kind, value, manifest.spec_version);
      if (schemaError) {
        if (file.status === 'ok') file.status = 'invalid-schema';
        addIssue('error', 'asset-invalid-schema', schemaError, record.path);
        continue;
      }
      parsedAssets.push({ record, value });
    }

    const characterCount = parsedAssets.filter((asset) => asset.record.kind === 'character-card').length;
    const characterBookAsset = parsedAssets.find((asset) => asset.record.kind === 'character-book');
    const characterBook = characterBookAsset?.value as TavernCharacterBook | undefined;
    const characterBookEntryCount = characterBook?.entries.length ?? 0;
    this.checkKindCounts(manifest, parsedAssets, addIssue);
    this.checkCrossFileConsistency(manifest, parsedAssets, addIssue);
    return this.report(root, manifest, files, issues, currentProjectMatch, characterCount, characterBookEntryCount);
  }

  private checkCurrentProject(
    manifest: PlayableBundleManifest,
    addIssue: (severity: 'error' | 'warning', code: string, message: string, path?: string) => void,
  ): boolean {
    const { db, projectId } = this.store.get();
    const project = db.prepare(`SELECT id, active_revision_id AS revisionId FROM projects WHERE id = ?`)
      .get(projectId) as ProjectRow | undefined;
    const matches = project?.id === manifest.project.id && project.revisionId === manifest.project.revision_id;
    if (!matches) addIssue('warning', 'current-project-mismatch', '整合包结构有效，但它不属于当前打开工程的当前修订。', 'manifest.json');
    return matches;
  }

  private schemaError(kind: PlayableBundleFileRecord['kind'], value: unknown, specVersion: PlayableBundleManifest['spec_version']): string | null {
    if (kind === 'character-card') {
      const parsed = tavernCardV2Schema.safeParse(value);
      if (parsed.success) {
        const embedded = parsed.data.data.character_book;
        if (specVersion === '1.0') return embedded ? null : '1.0 整合包角色卡缺少内嵌 data.character_book。';
        return embedded ? '2.0 整合包角色卡不得内嵌共享世界书。' : null;
      }
      const first = parsed.error.issues[0];
      return `不符合 ${kind} 契约：${first?.path.join('.') || 'root'} ${first?.message || ''}`.trim();
    }
    const schema = kind === 'character-book' ? tavernCharacterBookSchema
      : kind === 'relationship-world-info' ? sillyTavernWorldInfoExportSchema
        : kind === 'place-world-info' ? sillyTavernPlaceWorldInfoExportSchema
          : null;
    if (!schema) return entryPointShape(value) ? null : '进入点文件缺少必要字段。';
    const parsed = schema.safeParse(value);
    if (parsed.success) return null;
    const first = parsed.error.issues[0];
    return `不符合 ${kind} 契约：${first?.path.join('.') || 'root'} ${first?.message || ''}`.trim();
  }

  private checkKindCounts(
    manifest: PlayableBundleManifest,
    assets: ParsedAsset[],
    addIssue: (severity: 'error' | 'warning', code: string, message: string, path?: string) => void,
  ): void {
    const count = (kind: PlayableBundleFileRecord['kind']) => assets.filter((asset) => asset.record.kind === kind).length;
    if (count('character-card') !== manifest.character_count) {
      addIssue('error', 'character-count-mismatch', '有效角色卡数量与清单声明不一致。', 'manifest.json');
    }
    for (const kind of ['character-book', 'relationship-world-info', 'place-world-info', 'entry-point'] as const) {
      if (count(kind) !== 1) addIssue('error', `${kind}-count`, `整合包必须且只能包含一个 ${kind} 文件。`, 'manifest.json');
    }
  }

  private checkCrossFileConsistency(
    manifest: PlayableBundleManifest,
    assets: ParsedAsset[],
    addIssue: (severity: 'error' | 'warning', code: string, message: string, path?: string) => void,
  ): void {
    const byKind = (kind: PlayableBundleFileRecord['kind']) => assets.filter((asset) => asset.record.kind === kind);
    const bookAsset = byKind('character-book')[0];
    const book = bookAsset?.value as TavernCharacterBook | undefined;
    if (book) {
      if (book.entries.length !== manifest.character_book_entry_count) {
        addIssue('error', 'character-book-entry-count-mismatch', 'character book 条目数与清单声明不一致。', bookAsset.record.path);
      }
      const bookCompiler = compilerExtension(book.extensions);
      if (bookCompiler.project_id !== manifest.project.id || bookCompiler.revision_id !== manifest.project.revision_id
        || bookCompiler.entry_event_id !== manifest.entry_point.event_id
        || bookCompiler.entry_ordinal !== manifest.entry_point.narrative_ordinal
        || bookCompiler.schema_version !== manifest.schema_version
        || bookCompiler.graph_source_fingerprint !== manifest.source_fingerprints.relationship_world_info
        || bookCompiler.map_source_fingerprint !== manifest.source_fingerprints.place_world_info) {
        addIssue('error', 'character-book-context-mismatch', '共享 character book 的工程、修订、进入点或世界书来源与清单不一致。', bookAsset.record.path);
      }
      if (bookCompiler.source_fingerprint !== manifest.source_fingerprints.character_book) {
        addIssue('error', 'character-book-fingerprint-mismatch', 'character book 来源指纹与清单不一致。', bookAsset.record.path);
      }
      const sourceCopy = structuredClone(book) as TavernCharacterBook;
      delete compilerExtension(sourceCopy.extensions).source_fingerprint;
      if (sha256(JSON.stringify(sourceCopy)) !== manifest.source_fingerprints.character_book) {
        addIssue('error', 'character-book-source-corrupt', 'character book 内容无法复算出声明的来源指纹。', bookAsset.record.path);
      }
    }

    for (const cardAsset of byKind('character-card')) {
      const card = asRecord(cardAsset.value);
      const data = asRecord(card.data);
      const embedded = data.character_book;
      if (manifest.spec_version === '1.0' && book && JSON.stringify(embedded) !== JSON.stringify(book)) {
        addIssue('error', 'embedded-character-book-mismatch', '角色卡内嵌 character_book 与独立文件不一致。', cardAsset.record.path);
      }
      if (manifest.spec_version === '2.0' && embedded !== undefined) {
        addIssue('error', 'unexpected-embedded-character-book', '2.0 角色卡不得内嵌共享世界书。', cardAsset.record.path);
      }
      const extension = compilerExtension(asRecord(data.extensions));
      if (extension.revision_id !== manifest.project.revision_id
        || extension.entry_event_id !== manifest.entry_point.event_id
        || extension.identity_id !== cardAsset.record.identityId
        || data.name !== cardAsset.record.identityName
        || extension.schema_version !== manifest.schema_version) {
        addIssue('error', 'card-context-mismatch', '角色卡的人物、修订或进入事件与清单不一致。', cardAsset.record.path);
      }
      if (extension.playable_bundle_source_fingerprint !== manifest.source_fingerprints.bundle
        || (manifest.spec_version === '1.0' && extension.character_book_source_fingerprint !== manifest.source_fingerprints.character_book)) {
        addIssue('error', 'card-bundle-fingerprint-mismatch', '角色卡的整合包来源指纹与清单不一致。', cardAsset.record.path);
      }
      const expectedPolicy = buildPlayableRuntimePolicy({
        entryEventId: manifest.entry_point.event_id,
        entryEventTitle: manifest.entry_point.title,
        entryOrdinal: manifest.entry_point.narrative_ordinal,
      });
      const runtimePolicy = asRecord(extension.runtime_policy);
      const expectedPolicyFingerprint = sha256(JSON.stringify(expectedPolicy));
      if (runtimePolicy.version !== expectedPolicy.metadata.version
        || runtimePolicy.point_in_time_context_policy_version !== expectedPolicy.metadata.point_in_time_context_policy_version
        || runtimePolicy.prompt_policy_version !== expectedPolicy.metadata.prompt_policy_version
        || runtimePolicy.output_gate_policy_version !== expectedPolicy.metadata.output_gate_policy_version
        || runtimePolicy.prompt_enforcement !== expectedPolicy.metadata.prompt_enforcement
        || runtimePolicy.output_gate_enforcement !== expectedPolicy.metadata.output_gate_enforcement
        || runtimePolicy.entry_event_id !== expectedPolicy.metadata.entry_event_id
        || runtimePolicy.entry_ordinal !== expectedPolicy.metadata.entry_ordinal) {
        addIssue('error', 'runtime-policy-context-mismatch', '角色卡缺少当前进入点对应的认知边界策略，或策略版本/执行范围不一致。', cardAsset.record.path);
      }
      if (runtimePolicy.policy_fingerprint !== expectedPolicyFingerprint) {
        addIssue('error', 'runtime-policy-fingerprint-mismatch', '角色卡认知边界策略指纹无法复算。', cardAsset.record.path);
      }
      if (typeof data.post_history_instructions !== 'string'
        || !data.post_history_instructions.endsWith(expectedPolicy.instructions)) {
        addIssue('error', 'runtime-policy-instructions-missing', '角色卡没有在 post_history_instructions 末尾保留认知边界指令。', cardAsset.record.path);
      }
    }

    const relationship = byKind('relationship-world-info')[0];
    const relationshipCompiler = compilerExtension(asRecord(relationship?.value).extensions);
    if (relationship && relationshipCompiler.graph_source_fingerprint !== manifest.source_fingerprints.relationship_world_info) {
      addIssue('error', 'relationship-fingerprint-mismatch', '人物关系世界书来源指纹与清单不一致。', relationship.record.path);
    }
    const place = byKind('place-world-info')[0];
    const placeCompiler = compilerExtension(asRecord(place?.value).extensions);
    if (place && placeCompiler.map_source_fingerprint !== manifest.source_fingerprints.place_world_info) {
      addIssue('error', 'place-fingerprint-mismatch', '地点世界书来源指纹与清单不一致。', place.record.path);
    }

    for (const asset of [relationship, place]) {
      if (!asset) continue;
      const extension = compilerExtension(asRecord(asset.value).extensions);
      if (!worldInfoMatchesContext(extension, { projectId: manifest.project.id, revisionId: manifest.project.revision_id,
        entryOrdinal: manifest.entry_point.narrative_ordinal, schemaVersion: manifest.schema_version })) {
        addIssue('error', 'world-info-context-mismatch', '世界书的工程、修订、段落进入点或 schema 与清单不一致。', asset.record.path);
      }
    }
    if (book && relationship && place) {
      const expected: TavernCharacterBook['entries'] = [];
      for (const [asset, kind] of [[relationship, 'relationship'], [place, 'place']] as const) {
        const entries = asRecord(asRecord(asset.value).entries) as Record<string, WorldInfoSourceEntry>;
        for (const source of Object.values(entries)) expected.push(embeddedWorldInfoEntry(source, kind, expected.length));
      }
      if (!isDeepStrictEqual(book.entries, expected)) {
        addIssue('error', 'world-info-book-mismatch', 'character book 条目与关系/地点世界书的内容、激活规则或来源不一致。', bookAsset.record.path);
      }
    }

    const entry = byKind('entry-point')[0];
    if (entry) {
      const value = asRecord(entry.value);
      const project = asRecord(value.project);
      const event = asRecord(value.event);
      const fingerprints = asRecord(value.source_fingerprints);
      const consistent = value.spec_version === manifest.spec_version
        && value.schema_version === manifest.schema_version
        && project.id === manifest.project.id
        && project.name === manifest.project.name
        && project.revision_id === manifest.project.revision_id
        && event.id === manifest.entry_point.event_id
        && event.title === manifest.entry_point.title
        && event.narrative_ordinal === manifest.entry_point.narrative_ordinal
        && Object.entries(manifest.source_fingerprints).every(([key, fingerprint]) => fingerprints[key] === fingerprint);
      if (!consistent) addIssue('error', 'entry-point-mismatch', '进入点元数据与 manifest.json 不一致。', entry.record.path);
    }
  }

  private report(
    packageDirectory: string,
    manifest: PlayableBundleManifest | null,
    files: PlayableBundleValidationFile[],
    issues: PlayableBundleValidationIssue[],
    currentProjectMatch: boolean,
    characterCount: number,
    characterBookEntryCount: number,
  ): PlayableBundleValidationReport {
    const valid = !issues.some((issue) => issue.severity === 'error');
    return {
      checkedAt: new Date().toISOString(),
      packageDirectory,
      valid,
      sillyTavernCompatible: valid,
      compatibilityProfile: 'SillyTavern 1.18 / Character Card V2',
      currentProjectMatch,
      manifest,
      fileCount: files.length,
      validFileCount: files.filter((file) => file.status === 'ok').length,
      characterCount,
      characterBookEntryCount,
      files,
      issues,
    };
  }
}
