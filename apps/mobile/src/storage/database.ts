import { open, type DB } from '@op-engineering/op-sqlite';

const DATABASE_NAME = 'field-reporting.sqlite';

const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE reports (
        local_id TEXT PRIMARY KEY NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'uploading', 'retrying', 'uploaded', 'failed')),
        last_error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        server_report_id TEXT,
        uploaded_at TEXT,
        CHECK (
          (status = 'uploaded' AND server_report_id IS NOT NULL AND uploaded_at IS NOT NULL)
          OR (status != 'uploaded' AND uploaded_at IS NULL)
        )
      )`,
      `CREATE TABLE report_images (
        local_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL REFERENCES reports(local_id) ON DELETE CASCADE,
        file_path TEXT NOT NULL UNIQUE,
        original_file_name TEXT,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        content_hash TEXT,
        order_index INTEGER NOT NULL CHECK (order_index >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (report_id, order_index)
      )`,
      'CREATE INDEX reports_status_created_idx ON reports(status, created_at DESC)',
      'CREATE INDEX report_images_report_id_idx ON report_images(report_id)',
    ],
  },
] as const;

export async function migrateDatabase(database: DB): Promise<void> {
  await database.execute('PRAGMA foreign_keys = ON');
  const versionResult = await database.execute('PRAGMA user_version');
  const currentVersion = Number(versionResult.rows[0]?.user_version ?? 0);

  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error('The local database has an invalid schema version.');
  }
  const latestVersion = migrations[migrations.length - 1]?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new Error(
      `The local database version ${currentVersion} is newer than this app supports.`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    await database.transaction(async transaction => {
      for (const statement of migration.statements) {
        await transaction.execute(statement);
      }
      await transaction.execute(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

let databasePromise: Promise<DB> | undefined;

export function getLocalDatabase(): Promise<DB> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const database = open({ name: DATABASE_NAME });
      await migrateDatabase(database);
      return database;
    })().catch(error => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}
