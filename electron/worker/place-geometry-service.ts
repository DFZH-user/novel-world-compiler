import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  PlaceGeoJson,
  PlaceGeoJsonExportResult,
  PlaceGeometryInput,
  PlaceGeometryRecord,
  PlaceReviewStatus,
} from '../../src/shared/contracts';
import { PLACE_GEOJSON_SPEC_VERSION, placeGeoJsonSchema } from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import { PlaceService } from './place-service';
import { SCHEMA_VERSION } from './schema';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function now(): string { return new Date().toISOString(); }

function activeRevision(db: ReturnType<ProjectStore['get']>['db'], projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS revisionId FROM projects WHERE id = ?').get(projectId) as { revisionId: string | null } | undefined;
  if (!row?.revisionId) throw new Error('请先导入小说');
  return row.revisionId;
}

function normalizeInput(input: PlaceGeometryInput): PlaceGeometryInput {
  const longitude = Number(input.longitude);
  const latitude = Number(input.latitude);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('经度必须是 -180 到 180 之间的数字');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error('纬度必须是 -90 到 90 之间的数字');
  if (!['manual', 'gazetteer'].includes(input.sourceKind)) throw new Error('未知的坐标来源类型');
  if (!['certain', 'less_certain', 'uncertain'].includes(input.certainty)) throw new Error('未知的坐标确定性');
  const sourceLabel = input.sourceLabel.trim().slice(0, 200);
  const sourceUri = input.sourceUri?.trim() || null;
  if (input.sourceKind === 'gazetteer' && !sourceLabel) throw new Error('地名库坐标必须填写来源名称');
  if (sourceUri) {
    let parsed: URL;
    try { parsed = new URL(sourceUri); } catch { throw new Error('来源链接不是有效 URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('来源链接只允许 http 或 https');
  }
  return {
    placeId: input.placeId.trim(),
    longitude,
    latitude,
    sourceKind: input.sourceKind,
    sourceLabel,
    sourceUri,
    certainty: input.certainty,
    note: input.note.trim().slice(0, 1000),
  };
}

export class PlaceGeometryService {
  private readonly places: PlaceService;

  constructor(private readonly store: ProjectStore) {
    this.places = new PlaceService(store);
  }

  list(status?: PlaceReviewStatus): PlaceGeometryRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT g.id, g.place_id AS placeId, i.canonical_name AS placeName,
      g.longitude, g.latitude, g.coordinate_system AS coordinateSystem, g.geometry_type AS geometryType,
      g.source_kind AS sourceKind, g.source_label AS sourceLabel, g.source_uri AS sourceUri,
      g.certainty, g.review_status AS reviewStatus, g.note, g.created_at AS createdAt, g.updated_at AS updatedAt
      FROM place_geometries g JOIN place_identities i ON i.id = g.place_id
      WHERE g.revision_id = ? ${status ? 'AND g.review_status = ?' : ''}
      ORDER BY i.first_revealed_ordinal, i.canonical_name`)
      .all(...(status ? [revisionId, status] : [revisionId])) as unknown as PlaceGeometryRecord[];
  }

  upsert(rawInput: PlaceGeometryInput): PlaceGeometryRecord {
    const input = normalizeInput(rawInput);
    if (!input.placeId) throw new Error('地点不能为空');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const place = db.prepare(`SELECT id, review_status AS reviewStatus FROM place_identities
      WHERE id = ? AND revision_id = ?`).get(input.placeId, revisionId) as { id: string; reviewStatus: PlaceReviewStatus } | undefined;
    if (!place) throw new Error('地点不存在或不属于当前小说版本');
    if (place.reviewStatus !== 'confirmed') throw new Error('请先确认地点身份，再登记真实坐标');
    const existing = db.prepare('SELECT id FROM place_geometries WHERE revision_id = ? AND place_id = ?')
      .get(revisionId, input.placeId) as { id: string } | undefined;
    const id = existing?.id ?? `plg_${randomUUID().replaceAll('-', '')}`;
    const timestamp = now();
    db.prepare(`INSERT INTO place_geometries
      (id, revision_id, place_id, longitude, latitude, source_kind, source_label, source_uri,
       certainty, review_status, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(revision_id, place_id) DO UPDATE SET
        longitude = excluded.longitude, latitude = excluded.latitude, source_kind = excluded.source_kind,
        source_label = excluded.source_label, source_uri = excluded.source_uri, certainty = excluded.certainty,
        review_status = 'pending', note = excluded.note, updated_at = excluded.updated_at`)
      .run(id, revisionId, input.placeId, input.longitude, input.latitude, input.sourceKind,
        input.sourceLabel, input.sourceUri, input.certainty, input.note, timestamp, timestamp);
    return this.getById(id);
  }

  review(geometryId: string, status: PlaceReviewStatus): PlaceGeometryRecord[] {
    if (!['pending', 'confirmed', 'rejected'].includes(status)) throw new Error('未知的审核状态');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const geometry = db.prepare(`SELECT g.id, g.source_kind AS sourceKind, g.source_label AS sourceLabel,
      g.source_uri AS sourceUri, i.review_status AS placeReviewStatus
      FROM place_geometries g JOIN place_identities i ON i.id = g.place_id
      WHERE g.id = ? AND g.revision_id = ?`).get(geometryId, revisionId) as {
        id: string; sourceKind: PlaceGeometryRecord['sourceKind']; sourceLabel: string;
        sourceUri: string | null; placeReviewStatus: PlaceReviewStatus;
      } | undefined;
    if (!geometry) throw new Error('坐标记录不存在');
    if (status === 'confirmed' && geometry.placeReviewStatus !== 'confirmed') throw new Error('地点身份未确认，不能确认坐标');
    if (status === 'confirmed' && geometry.sourceKind === 'gazetteer' && (!geometry.sourceLabel || !geometry.sourceUri)) {
      throw new Error('地名库坐标需要来源名称和可访问链接才能确认');
    }
    db.prepare('UPDATE place_geometries SET review_status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), geometryId);
    return this.list();
  }

  buildGeoJson(entryOrdinal: number): PlaceGeoJson {
    const summary = this.store.getSummary();
    if (!summary?.activeRevisionId) throw new Error('请先导入小说');
    const projection = this.places.getNarrativeMapProjection(entryOrdinal);
    const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
    const geometryRows = this.list('confirmed').filter((geometry) => nodeById.has(geometry.placeId));
    const features = geometryRows.map((geometry) => {
      const node = nodeById.get(geometry.placeId)!;
      return {
        type: 'Feature' as const,
        id: node.id,
        geometry: { type: 'Point' as const, coordinates: [geometry.longitude, geometry.latitude] as [number, number] },
        properties: {
          name: node.name,
          aliases: [...node.aliases].sort((left, right) => left.localeCompare(right, 'zh-CN')),
          place_type: node.placeType,
          first_revealed_ordinal: node.firstRevealedOrdinal,
          coordinate_system: 'WGS84' as const,
          certainty: geometry.certainty,
          provenance: { kind: geometry.sourceKind, label: geometry.sourceLabel, uri: geometry.sourceUri, note: geometry.note },
        },
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
    const longitudes = features.map((feature) => feature.geometry.coordinates[0]);
    const latitudes = features.map((feature) => feature.geometry.coordinates[1]);
    const bbox = features.length > 0
      ? [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)] as [number, number, number, number]
      : undefined;
    const source = {
      type: 'FeatureCollection' as const,
      ...(bbox ? { bbox } : {}),
      features,
    };
    const sourceFingerprint = hash(JSON.stringify({
      project_id: summary.id,
      revision_id: summary.activeRevisionId,
      entry_ordinal: projection.entryOrdinal,
      ...source,
    }));
    return placeGeoJsonSchema.parse({
      ...source,
      novel_world_compiler: {
        format: 'novel-world-place-geojson',
        spec_version: PLACE_GEOJSON_SPEC_VERSION,
        schema_version: SCHEMA_VERSION,
        generated_at: now(),
        project_id: summary.id,
        project_name: summary.name,
        revision_id: summary.activeRevisionId,
        entry_ordinal: projection.entryOrdinal,
        maximum_ordinal: projection.maximumOrdinal,
        coordinate_semantics: 'earth-wgs84-confirmed-only',
        source_fingerprint: sourceFingerprint,
      },
    });
  }

  async exportGeoJson(entryOrdinal: number, outputPath: string): Promise<PlaceGeoJsonExportResult> {
    const geoJson = this.buildGeoJson(entryOrdinal);
    const serialized = `${JSON.stringify(geoJson, null, 2)}\n`;
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, serialized, 'utf8');
      await fs.rename(temporaryPath, outputPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { outputPath, checksum: hash(serialized), geoJson };
  }

  private getById(geometryId: string): PlaceGeometryRecord {
    const record = this.list().find((geometry) => geometry.id === geometryId);
    if (!record) throw new Error('坐标记录不存在');
    return record;
  }
}
