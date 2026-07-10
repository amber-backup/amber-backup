import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Serves the built client SPA. In the Docker image the client dist is copied
 * next to the server; in dev the client runs via Vite and this resolves to a
 * (possibly absent) path, which ServeStatic tolerates.
 */
const candidates = [
  join(__dirname, '..', 'client'), // Docker layout: /app/client
  join(__dirname, '..', '..', 'client', 'dist'), // monorepo dev build
];
const clientRoot = candidates.find((p) => existsSync(p)) ?? candidates[0];

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: clientRoot,
      // Let the API and Swagger keep their routes; SPA handles the rest.
      exclude: ['/api/{*splat}'],
      serveStaticOptions: { fallthrough: true },
    }),
  ],
})
export class StaticModule {}
