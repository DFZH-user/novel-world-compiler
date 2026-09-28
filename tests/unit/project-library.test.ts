import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectLibrary } from '../../electron/main/project-library';
import type { ProjectSummary } from '../../src/shared/contracts';
describe('local project library', () => {
  it('persists concurrent registrations without duplicates and resolves only indexed projects', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-library-'));
    try {
      const file = path.join(directory, 'library.json');
      const library = new ProjectLibrary(file);
      const book = (id: string): ProjectSummary => ({ id, name: id, rootPath: path.join(directory, id), activeRevisionId: null, createdAt: '2026-09-12', updatedAt: '2026-09-12' });
      await Promise.all([library.remember(book('one')), library.remember(book('two')), library.remember({ ...book('one'), name: 'Renamed' })]);
      const reopened = new ProjectLibrary(file);
      expect((await reopened.list()).map(p => p.name)).toEqual(['Renamed', 'two']);
      expect(await reopened.resolve('one')).toBe(path.join(directory, 'one'));
      await reopened.remember({ ...book('one'), rootPath: path.join(directory, 'restored') });
      expect(await reopened.list()).toHaveLength(2);
      expect(await reopened.resolve('one')).toBe(path.join(directory, 'restored'));
      await expect(reopened.resolve('../unknown')).rejects.toThrow('书库中没有这个工程');
      expect(await fs.stat(path.join(directory, 'one')).catch(() => null)).toBeNull();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
