import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PlayableBundleExportResult,
  PlayableBundleFileRecord,
  PlayableBundleManifest,
  SillyTavernPlaceWorldInfoEntry,
  SillyTavernWorldInfoEntry,
  TavernCardV2,
  TavernCharacterBook,
  TavernCharacterBookEntry,
} from '../../src/shared/contracts';
import { PLAYABLE_BUNDLE_SPEC_VERSION } from '../../src/shared/contracts';
import { ArtifactFoundationService } from './artifact-foundation-service';
import { CharacterCardService } from './character-card-service';
import { PlaceMapExportService } from './place-map-export-service';
import { bindPlayableRuntimePolicy, buildPlayableRuntimePolicy, type PlayableRuntimePolicy } from './playable-epistemic-policy';
import type { ProjectStore } from './project-store';
import { RelationshipGraphExportService } from './relationship-graph-export-service';
import { SCHEMA_VERSION } from './schema';
import { embeddedWorldInfoEntry, worldInfoMatchesContext } from './world-info-semantics';

type ProjectRow = { id: string; name: string; revisionId: string | null };
type BundleAsset = {
  relativePath: string;
  kind: PlayableBundleFileRecord['kind'];
  value: unknown;
  identityId?: string;
  identityName?: string;
};

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function safeName(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/gu, '');
  return (normalized || 'novel-world').slice(0, 80);
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class PlayableBundleService {
  private readonly foundation: ArtifactFoundationService;
  private readonly cards: CharacterCardService;
  private readonly graphExports: RelationshipGraphExportService;
  private readonly mapExports: PlaceMapExportService;

  constructor(private readonly store: ProjectStore) {
    this.foundation = new ArtifactFoundationService(store);
    this.cards = new CharacterCardService(store);
    this.graphExports = new RelationshipGraphExportService(store);
    this.mapExports = new PlaceMapExportService(store);
  }

  async export(entryEventId: string, outputDirectory: string): Promise<PlayableBundleExportResult> {
    const dashboard = this.foundation.status(entryEventId);
    const blocked = dashboard.gates.filter((gate) => !gate.exportReady);
    if (!dashboard.refinementReady || blocked.length) {
      const labels = blocked.map((gate) => gate.title).join('、');
      throw new Error(`三类产物尚未全部达到正式导出门槛${labels ? `：${labels}` : ''}`);
    }
    if (!dashboard.entryEvent) throw new Error('请选择当前修订中已确认的进入事件');

    const { db, projectId } = this.store.get();
    const project = db.prepare(`SELECT id, name, active_revision_id AS revisionId FROM projects WHERE id = ?`)
      .get(projectId) as ProjectRow | undefined;
    if (!project?.revisionId || project.revisionId !== dashboard.revisionId) throw new Error('当前工程修订状态不一致');

    const targets = this.cards.batchStatus();
    if (!targets.length || targets.some((item) => !item.exportReady || item.entryEventId !== entryEventId)) {
      throw new Error('所有核心/重要人物角色卡必须使用当前进入点、已审阅并达到质量门槛');
    }
    const baseCards = targets.map((target) => ({
      target,
      card: this.cards.buildCard(target.identityId),
    }));
    const relationshipWorldInfo = this.graphExports.buildWorldInfo(dashboard.entryEvent.narrativeOrdinal);
    const placeWorldInfo = this.mapExports.buildWorldInfo(dashboard.entryEvent.narrativeOrdinal);
    const context = { projectId, revisionId: project.revisionId, entryOrdinal: dashboard.entryEvent.narrativeOrdinal, schemaVersion: SCHEMA_VERSION };
    if (![relationshipWorldInfo, placeWorldInfo].every((book) => worldInfoMatchesContext(book.extensions.novel_world_compiler, context))) {
      throw new Error('关系/地点世界书与当前工程修订或进入点不一致，未写入整合包');
    }
    const characterBook = this.characterBook(project, dashboard.entryEvent, relationshipWorldInfo.entries, placeWorldInfo.entries,
      relationshipWorldInfo.extensions.novel_world_compiler.graph_source_fingerprint,
      placeWorldInfo.extensions.novel_world_compiler.map_source_fingerprint,
      Math.max(relationshipWorldInfo.scan_depth, placeWorldInfo.scan_depth),
      Math.min(8192, relationshipWorldInfo.token_budget + placeWorldInfo.token_budget));
    const characterBookExtension = asRecord(characterBook.extensions.novel_world_compiler);
    const characterBookFingerprint = String(characterBookExtension.source_fingerprint);
    const runtimePolicy = buildPlayableRuntimePolicy({
      entryEventId: dashboard.entryEvent.id,
      entryEventTitle: dashboard.entryEvent.title,
      entryOrdinal: dashboard.entryEvent.narrativeOrdinal,
    });
    const runtimePolicyFingerprint = hash(JSON.stringify(runtimePolicy));
    const characterCardsFingerprint = hash(JSON.stringify(baseCards.map(({ target, card }) => ({
      identityId: target.identityId,
      contentFingerprint: hash(JSON.stringify(card)),
    }))));
    const bundleFingerprint = hash(JSON.stringify({
      format: 'novel-world-playable-bundle',
      specVersion: PLAYABLE_BUNDLE_SPEC_VERSION,
      schemaVersion: SCHEMA_VERSION,
      projectId,
      revisionId: project.revisionId,
      entryEventId,
      entryOrdinal: dashboard.entryEvent.narrativeOrdinal,
      characterCardsFingerprint,
      characterBookFingerprint,
      relationshipFingerprint: relationshipWorldInfo.extensions.novel_world_compiler.graph_source_fingerprint,
      placeFingerprint: placeWorldInfo.extensions.novel_world_compiler.map_source_fingerprint,
      runtimePolicyFingerprint,
    }));

    const outputRoot = path.resolve(outputDirectory);
    const packageDirectory = path.join(outputRoot,
      `${safeName(project.name)}-可游玩包-P${dashboard.entryEvent.narrativeOrdinal}-${bundleFingerprint.slice(0, 12)}`);
    const entryPoint = {
      format: 'novel-world-entry-point',
      spec_version: PLAYABLE_BUNDLE_SPEC_VERSION,
      schema_version: SCHEMA_VERSION,
      project: { id: project.id, name: project.name, revision_id: project.revisionId },
      event: { id: dashboard.entryEvent.id, title: dashboard.entryEvent.title, narrative_ordinal: dashboard.entryEvent.narrativeOrdinal },
      source_fingerprints: {
        character_cards: characterCardsFingerprint,
        relationship_world_info: relationshipWorldInfo.extensions.novel_world_compiler.graph_source_fingerprint,
        place_world_info: placeWorldInfo.extensions.novel_world_compiler.map_source_fingerprint,
        character_book: characterBookFingerprint,
        bundle: bundleFingerprint,
      },
    };
    const assets: BundleAsset[] = baseCards.map(({ target, card }, index) => ({
      relativePath: `characters/${String(index + 1).padStart(2, '0')}-${safeName(target.identityName)}-${hash(target.identityId).slice(0, 8)}.json`,
      kind: 'character-card',
      identityId: target.identityId,
      identityName: target.identityName,
      value: this.bindBundleMetadata(card, bundleFingerprint, runtimePolicy, runtimePolicyFingerprint),
    }));
    assets.push(
      { relativePath: 'character-book.json', kind: 'character-book', value: characterBook },
      { relativePath: 'worldbooks/relationships-world-info.json', kind: 'relationship-world-info', value: relationshipWorldInfo },
      { relativePath: 'worldbooks/places-world-info.json', kind: 'place-world-info', value: placeWorldInfo },
      { relativePath: 'entry-point.json', kind: 'entry-point', value: entryPoint },
    );
    const prepared = assets.map((asset) => {
      const content = serialize(asset.value);
      return { ...asset, content, checksum: hash(content), bytes: Buffer.byteLength(content, 'utf8') };
    });
    const files: PlayableBundleFileRecord[] = prepared.map((asset) => ({
      path: asset.relativePath,
      kind: asset.kind,
      checksum: asset.checksum,
      bytes: asset.bytes,
      ...(asset.identityId ? { identityId: asset.identityId, identityName: asset.identityName } : {}),
    }));
    const manifest: PlayableBundleManifest = {
      format: 'novel-world-playable-bundle',
      spec_version: PLAYABLE_BUNDLE_SPEC_VERSION,
      schema_version: SCHEMA_VERSION,
      project: { id: project.id, name: project.name, revision_id: project.revisionId },
      entry_point: { event_id: dashboard.entryEvent.id, title: dashboard.entryEvent.title, narrative_ordinal: dashboard.entryEvent.narrativeOrdinal },
      source_fingerprints: {
        character_cards: characterCardsFingerprint,
        relationship_world_info: relationshipWorldInfo.extensions.novel_world_compiler.graph_source_fingerprint,
        place_world_info: placeWorldInfo.extensions.novel_world_compiler.map_source_fingerprint,
        character_book: characterBookFingerprint,
        bundle: bundleFingerprint,
      },
      character_count: baseCards.length,
      character_book_entry_count: characterBook.entries.length,
      files,
    };
    const managed = new Map<string, string>([['manifest.json', serialize(manifest)]]);
    for (const asset of prepared) managed.set(asset.relativePath, asset.content);
    const reused = await this.matches(packageDirectory, managed);
    if (!reused) {
      await fs.mkdir(packageDirectory, { recursive: true });
      for (const [relativePath, content] of managed) await this.writeManaged(packageDirectory, relativePath, content);
    }
    return { outputDirectory: outputRoot, packageDirectory, bundleFingerprint, reused, manifest };
  }

  private characterBook(
    project: ProjectRow,
    entry: { id: string; title: string; narrativeOrdinal: number },
    relationshipEntries: Record<string, SillyTavernWorldInfoEntry>,
    placeEntries: Record<string, SillyTavernPlaceWorldInfoEntry>,
    graphFingerprint: string,
    mapFingerprint: string,
    scanDepth: number,
    tokenBudget: number,
  ): TavernCharacterBook {
    const entries: TavernCharacterBookEntry[] = [];
    for (const source of Object.values(relationshipEntries)) entries.push(embeddedWorldInfoEntry(source, 'relationship', entries.length));
    for (const source of Object.values(placeEntries)) entries.push(embeddedWorldInfoEntry(source, 'place', entries.length));
    const source = {
      name: `${project.name} · 进入点共享世界书 P${entry.narrativeOrdinal}`,
      description: `只包含进入事件“${entry.title}”处已审核并揭示的人物关系与地点信息。审核通过不代表传闻已证实；此书为进入点共享资料，不代表每个人物均已知情。`,
      scan_depth: scanDepth,
      token_budget: tokenBudget,
      recursive_scanning: false,
      extensions: { novel_world_compiler: {
        playable_bundle_spec_version: PLAYABLE_BUNDLE_SPEC_VERSION,
        schema_version: SCHEMA_VERSION,
        project_id: project.id,
        revision_id: project.revisionId,
        entry_event_id: entry.id,
        entry_ordinal: entry.narrativeOrdinal,
        graph_source_fingerprint: graphFingerprint,
        map_source_fingerprint: mapFingerprint,
      } },
      entries,
    } satisfies TavernCharacterBook;
    const sourceFingerprint = hash(JSON.stringify(source));
    return {
      ...source,
      extensions: { novel_world_compiler: {
        ...asRecord(source.extensions.novel_world_compiler),
        source_fingerprint: sourceFingerprint,
      } },
    };
  }

  private bindBundleMetadata(
    card: TavernCardV2,
    bundleFingerprint: string,
    runtimePolicy: PlayableRuntimePolicy,
    runtimePolicyFingerprint: string,
  ): TavernCardV2 {
    const boundCard: TavernCardV2 = {
      ...card,
      data: {
        ...card.data,
        extensions: {
          ...card.data.extensions,
          novel_world_compiler: {
            ...asRecord(card.data.extensions.novel_world_compiler),
            playable_bundle_spec_version: PLAYABLE_BUNDLE_SPEC_VERSION,
            playable_bundle_source_fingerprint: bundleFingerprint,
          },
        },
      },
    };
    return bindPlayableRuntimePolicy(boundCard, runtimePolicy, runtimePolicyFingerprint);
  }

  private async matches(packageDirectory: string, managed: Map<string, string>): Promise<boolean> {
    for (const [relativePath, expected] of managed) {
      const target = this.managedPath(packageDirectory, relativePath);
      const actual = await fs.readFile(target, 'utf8').catch(() => null);
      if (actual !== expected) return false;
    }
    return true;
  }

  private async writeManaged(packageDirectory: string, relativePath: string, content: string): Promise<void> {
    const target = this.managedPath(packageDirectory, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private managedPath(packageDirectory: string, relativePath: string): string {
    const root = path.resolve(packageDirectory);
    const target = path.resolve(root, ...relativePath.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('整合包文件路径越界');
    return target;
  }
}
