import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

const SQLITE_MODULE_SPECIFIER = ['node', 'sqlite'].join(':');
let sqliteModulePromise: Promise<typeof import('node:sqlite')> | null = null;

function loadNodeSqlite(): Promise<typeof import('node:sqlite')> {
  sqliteModulePromise ??= import(SQLITE_MODULE_SPECIFIER);
  return sqliteModulePromise;
}

export type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

export type IntegrityReport = {
  integrity: string[];
  foreignKeyViolations: SqlRow[];
};

export type IntegrityCheckMode = 'quick' | 'full';

function bindValues(values: unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value === null || value instanceof Uint8Array) {
      return value;
    }
    throw new TypeError('SQLite 不支持的绑定参数类型：' + typeof value);
  });
}

class StatementFacade {
  constructor(private readonly statement: StatementSync) {}

  run(...values: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.statement.run(...bindValues(values));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get(...values: unknown[]): SqlRow | undefined {
    return this.statement.get(...bindValues(values)) as SqlRow | undefined;
  }

  all(...values: unknown[]): SqlRow[] {
    return this.statement.all(...bindValues(values)) as SqlRow[];
  }
}

export class SQLiteDatabase {
  private constructor(private readonly database: DatabaseSync, readonly filePath: string) {}

  static async open(filePath: string): Promise<SQLiteDatabase> {
    const { DatabaseSync } = await loadNodeSqlite();
    const database = new DatabaseSync(filePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA busy_timeout = 5000');
    return new SQLiteDatabase(database, filePath);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): StatementFacade {
    return new StatementFacade(this.database.prepare(sql));
  }

  transaction<T>(operation: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.exec('ROLLBACK');
      throw error;
    }
  }

  async backup(destinationPath: string): Promise<void> {
    const { backup } = await loadNodeSqlite();
    await backup(this.database, destinationPath, { rate: 100 });
  }

  integrityReport(mode: IntegrityCheckMode = 'full'): IntegrityReport {
    const pragma = mode === 'quick' ? 'quick_check' : 'integrity_check';
    const integrity = this.prepare('PRAGMA ' + pragma).all()
      .map((row) => String(Object.values(row)[0] ?? ''));
    const foreignKeyViolations = this.prepare('PRAGMA foreign_key_check').all();
    return { integrity, foreignKeyViolations };
  }

  assertIntegrity(mode: IntegrityCheckMode = 'full'): void {
    const report = this.integrityReport(mode);
    if (report.integrity.length !== 1 || report.integrity[0]?.toLowerCase() !== 'ok') {
      throw new Error('工程数据库完整性检查失败：' + (report.integrity.join('；') || '未知错误'));
    }
    if (report.foreignKeyViolations.length > 0) {
      throw new Error('工程数据库存在 ' + report.foreignKeyViolations.length + ' 条外键错误');
    }
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): void {
    this.prepare('PRAGMA wal_checkpoint(' + mode + ')').all();
  }

  close(): void {
    if (this.database.isTransaction) this.exec('ROLLBACK');
    this.database.close();
  }
}
