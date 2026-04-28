import type { DbConfig } from '../../../src/app';
import { getMongooseModule } from '../../../src/lib/mongo';

const EXPECTED_MONGO_DB = 'slingshot_test';
const DEFAULT_MONGO_URL = 'mongodb://localhost:27018/slingshot_test';

type MongoStore = NonNullable<DbConfig['sessions']>;

function storeUsesMongo(store: MongoStore | undefined): boolean {
  return store === 'mongo';
}

export function dbConfigUsesMongo(db: DbConfig): boolean {
  return (
    db.mongo !== false ||
    db.auth === 'mongo' ||
    storeUsesMongo(db.sessions) ||
    storeUsesMongo(db.oauthState) ||
    storeUsesMongo(db.cache)
  );
}

export function resolveTestMongoUrl(): string {
  return process.env.MONGO_URL || DEFAULT_MONGO_URL;
}

export async function resetMongoE2eState(url = resolveTestMongoUrl()): Promise<void> {
  const mg = getMongooseModule();
  const conn = await mg.createConnection(url, { autoIndex: false }).asPromise();
  try {
    const dbName = conn.db?.databaseName;
    if (dbName !== EXPECTED_MONGO_DB) {
      throw new Error(
        `SAFETY: Expected MongoDB database "${EXPECTED_MONGO_DB}", got "${dbName}". Refusing to reset E2E state.`,
      );
    }
    const collections = await conn.db!.listCollections().toArray();
    await Promise.all(collections.map(c => conn.db!.collection(c.name).deleteMany({})));
  } finally {
    await conn.close();
  }
}
