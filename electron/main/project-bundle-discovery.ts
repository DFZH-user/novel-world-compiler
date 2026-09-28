import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  playableBundleManifestSchema, sillyTavernPlaceWorldInfoExportSchema, sillyTavernWorldInfoExportSchema,
  tavernCardV2Schema, tavernCharacterBookSchema,
  type PlayableBundleFileRecord, type ProjectBundleAvailability, type ProjectSummary,
} from '../../src/shared/contracts';

const missing = (state: ProjectBundleAvailability['state'], message: string): ProjectBundleAvailability => ({
  state, message, packageDirectory: null, specVersion: null, characterCount: 0,
});

function safeAssetPath(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath || relativePath.split('/').includes('..')) return null;
  const resolved = path.resolve(root, ...relativePath.split('/'));
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function validAsset(kind: PlayableBundleFileRecord['kind'], value: unknown, specVersion: '1.0' | '2.0'): boolean {
  if (kind === 'character-card') {
    const card = tavernCardV2Schema.safeParse(value);
    if (!card.success) return false;
    return specVersion === '1.0' ? Boolean(card.data.data.character_book) : card.data.data.character_book === undefined;
  }
  if (kind === 'character-book') return tavernCharacterBookSchema.safeParse(value).success;
  if (kind === 'relationship-world-info') return sillyTavernWorldInfoExportSchema.safeParse(value).success;
  if (kind === 'place-world-info') return sillyTavernPlaceWorldInfoExportSchema.safeParse(value).success;
  const entry = value as Record<string, unknown> | null;
  return Boolean(entry && entry.format === 'novel-world-entry-point' && entry.spec_version === specVersion);
}

/** Read-only discovery; it does not open/migrate a .novelworld database or import anything into SillyTavern. */
export async function inspectProjectBundle(project: ProjectSummary, entryEventId?: string): Promise<ProjectBundleAvailability> {
  if (!project.activeRevisionId) return missing('no-source', '尚未导入原文，请先进入编译工作台。');
  const root = path.resolve(project.rootPath);
  const exportsRoot = path.join(root, 'exports');
  let directoryEntries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    directoryEntries = await fs.readdir(exportsRoot, { withFileTypes: true });
  } catch {
    return missing('not-exported', '当前工程尚未找到可游玩整合包。');
  }
  const candidates = (await Promise.all(directoryEntries.filter(entry => entry.isDirectory()).map(async entry => {
    const directory = path.join(exportsRoot, entry.name);
    try { const stat = await fs.stat(directory); return { directory, modified: stat.mtimeMs }; }
    catch { return null; }
  }))).filter((value): value is { directory: string; modified: number } => value !== null);
  candidates.sort((a, b) => b.modified - a.modified);
  let foundMatchingManifest = false;
  for (const candidate of candidates.slice(0, 100)) {
    try {
      const packageRoot = await fs.realpath(candidate.directory);
      const exportsReal = await fs.realpath(exportsRoot);
      if (!packageRoot.startsWith(`${exportsReal}${path.sep}`)) continue;
      const manifestRaw = await fs.readFile(path.join(packageRoot, 'manifest.json'), 'utf8');
      const parsed = playableBundleManifestSchema.safeParse(JSON.parse(manifestRaw));
      if (!parsed.success) continue;
      const manifest = parsed.data;
      if (manifest.project.id !== project.id || manifest.project.revision_id !== project.activeRevisionId) continue;
      if (entryEventId && manifest.entry_point.event_id !== entryEventId) continue;
      foundMatchingManifest = true;
      if (manifest.files.filter(file => file.kind === 'character-card').length !== manifest.character_count) continue;
      if (['character-book', 'relationship-world-info', 'place-world-info', 'entry-point']
        .some(kind => manifest.files.filter(file => file.kind === kind).length !== 1)) continue;
      const seen = new Set<string>();
      let valid = true;
      for (const file of manifest.files) {
        const expected = safeAssetPath(packageRoot, file.path);
        if (!expected || seen.has(file.path)) { valid = false; break; }
        seen.add(file.path);
        const linkState = await fs.lstat(expected);
        if (linkState.isSymbolicLink()) { valid = false; break; }
        const actual = await fs.realpath(expected);
        if (!actual.startsWith(`${packageRoot}${path.sep}`)) { valid = false; break; }
        const stat = await fs.stat(actual);
        if (!stat.isFile() || stat.size !== file.bytes) { valid = false; break; }
        const content = await fs.readFile(actual);
        if (createHash('sha256').update(content).digest('hex') !== file.checksum) { valid = false; break; }
        if (!validAsset(file.kind, JSON.parse(content.toString('utf8')) as unknown, manifest.spec_version)) { valid = false; break; }
      }
      if (!valid) continue;
      return {
        state: 'ready-for-assembly', message: '当前修订的整合包已通过文件和格式初检；还需完成严格校验与自动装配，才能进入沉浸阅读。',
        packageDirectory: packageRoot, specVersion: manifest.spec_version, characterCount: manifest.character_count,
      };
    } catch {
      // Ignore incomplete or unrelated exports. No files are changed.
    }
  }
  return foundMatchingManifest
    ? missing('invalid', '发现当前修订的整合包，但文件不完整或校验未通过；请在工作台检查导出。')
    : missing('not-exported', '当前工程尚未找到当前修订的可游玩整合包。');
}

/** Lists only bundles that pass the same file checks used by the library entry. */
export async function listProjectPlayableEntries(project: ProjectSummary): Promise<Array<{ eventId: string; title: string; ordinal: number }>> {
  if (!project.activeRevisionId) return [];
  const exportsRoot = path.join(path.resolve(project.rootPath), 'exports');
  const folders = await fs.readdir(exportsRoot, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(folders.filter(folder => folder.isDirectory()).map(async folder => {
    try {
      const directory = path.join(exportsRoot, folder.name);
      const value = playableBundleManifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')));
      if (value.project.id !== project.id || value.project.revision_id !== project.activeRevisionId) return null;
      return value.entry_point;
    } catch { return null; }
  }));
  const result: Array<{ eventId: string; title: string; ordinal: number }> = [];
  for (const candidate of candidates) {
    if (!candidate || result.some(item => item.eventId === candidate.event_id)) continue;
    if ((await inspectProjectBundle(project, candidate.event_id)).state !== 'ready-for-assembly') continue;
    result.push({ eventId: candidate.event_id, title: candidate.title, ordinal: candidate.narrative_ordinal });
  }
  return result.sort((a, b) => a.ordinal - b.ordinal || a.eventId.localeCompare(b.eventId));
}
