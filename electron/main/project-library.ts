import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSummary } from '../../src/shared/contracts';

/** Local index only. Project files remain in their original directories. */
export class ProjectLibrary {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async read(): Promise<ProjectSummary[]> {
    try {
      const data: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return Array.isArray(data) ? data.filter((p): p is ProjectSummary => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.rootPath === 'string' && path.isAbsolute(p.rootPath)) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async list(): Promise<ProjectSummary[]> { await this.queue; return this.read(); }
  remember(project: ProjectSummary): Promise<void> {
    const update = this.queue.then(async () => {
      const entries = await this.read();
      const normalized = path.resolve(project.rootPath).toLowerCase();
      const next = [project, ...entries.filter(p => p.id !== project.id && path.resolve(p.rootPath).toLowerCase() !== normalized)].slice(0, 200);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file + '.tmp', JSON.stringify(next, null, 2), 'utf8');
      await fs.rename(this.file + '.tmp', this.file);
    });
    this.queue = update.catch(() => undefined);
    return update;
  }
  async resolve(id: string): Promise<string> {
    const entry = (await this.list()).find(p => p.id === id);
    if (!entry) throw new Error('书库中没有这个工程，请重新打开工程文件夹。');
    return entry.rootPath;
  }
}
