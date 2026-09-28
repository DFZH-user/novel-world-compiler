import type { SQLiteDatabase } from './sqlite-db';

export function withTransaction<T>(db: SQLiteDatabase, operation: () => T): T {
  return db.transaction(operation);
}
