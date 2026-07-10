import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { loadConfig } from '../config/configuration';
import { Database } from './database.types';

export const KYSELY = 'KYSELY_INSTANCE';
export type Db = Kysely<Database>;

/** Closes the connection pool on shutdown so the process can exit promptly. */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Db) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/** Global module exposing the typed Kysely instance to the whole app. */
@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      useFactory: (): Db => {
        const config = loadConfig();
        const dialect = new PostgresDialect({
          pool: new Pool({ connectionString: config.databaseUrl, max: 10 }),
        });
        return new Kysely<Database>({ dialect });
      },
    },
    DatabaseLifecycle,
  ],
  exports: [KYSELY],
})
export class DatabaseModule {}
