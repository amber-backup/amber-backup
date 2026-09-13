import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig, validateConfig } from './config/configuration';
import { httpLogger } from './common/middleware/http-logger.middleware';
import { runMigrations } from './database/migrator';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  validateConfig(config);

  // Apply pending migrations before the app initializes, so the schema exists
  // before module init (e.g. bootstrap-admin creation).
  const migrationLogger = new Logger('Migrations');
  await runMigrations('up', (m) => migrationLogger.log(m));

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Honour X-Forwarded-For only as far as the deployment declares (default: not
  // at all), so the audit log and rate limiter see a client IP that cannot be
  // spoofed by an arbitrary caller sending its own X-Forwarded-For header.
  app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxy);

  app.setGlobalPrefix('api', { exclude: ['/'] });

  // Security headers (CSP, HSTS, X-Frame-Options: DENY, nosniff, no-referrer,
  // etc.). The CSP is tuned for the self-hosted SPA: everything comes from the
  // same origin; inline *styles* are allowed (React style attributes + the
  // design system) but inline scripts are not; framing is denied to prevent
  // clickjacking of destructive actions. The interactive Swagger UI at
  // /api/explorer ships inline scripts, so it is exempted from the CSP.
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  const secureHeaders = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        // Would force https on plain-HTTP deployments; leave to the operator.
        'upgrade-insecure-requests': null,
      },
    },
    // Not needed for this app and can block same-origin asset loading.
    crossOriginEmbedderPolicy: false,
  });
  app.use((req: { path?: string; url: string }, res: unknown, next: () => void) => {
    if ((req.path ?? req.url).startsWith('/api/explorer')) return next();
    return (secureHeaders as (a: unknown, b: unknown, c: unknown) => void)(
      req,
      res,
      next,
    );
  });

  app.use(cookieParser());
  // Access log for every HTTP request (before guards/routing so 401/403 and 404
  // are logged too). Disable with HTTP_LOGGING=false.
  if (config.httpLogging) app.use(httpLogger);
  // Same-origin SPA needs no cross-origin access; a reflected `origin: true`
  // with credentials would let any site read authenticated responses. Allow
  // only the configured public URL and any explicit WebAuthn origins (e.g. the
  // Vite dev origin), so credentialed cross-origin reads are impossible.
  const allowedOrigins = Array.from(
    new Set(
      [
        (() => {
          try {
            return new URL(config.publicBaseUrl).origin;
          } catch {
            return undefined;
          }
        })(),
        ...config.webauthnOrigins,
      ].filter((o): o is string => !!o),
    ),
  );
  app.enableCors({ origin: allowedOrigins, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // The Swagger UI and JSON are unauthenticated (they sit outside the Nest
  // guards), so exposing them in production discloses the full API surface.
  // Register them only outside production; opt back in with SWAGGER_ENABLED=true.
  const swaggerEnabled =
    process.env.SWAGGER_ENABLED !== undefined
      ? ['1', 'true', 'yes', 'on'].includes(
          process.env.SWAGGER_ENABLED.toLowerCase(),
        )
      : config.nodeEnv !== 'production';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Amber Backup API')
      .setDescription('Central management of Restic backups')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/explorer',
      app,
      SwaggerModule.createDocument(app, swaggerConfig),
    );
  }

  // Gracefully close the HTTP server, DB pool and in-flight runs on SIGTERM/
  // SIGINT. Without an explicit handler, Node as PID 1 in a container ignores
  // SIGTERM and `docker stop` waits the full grace period before SIGKILL.
  app.enableShutdownHooks();

  // Failsafe: if a shutdown hook ever hangs, don't hold the container hostage.
  const failsafe = (signal: string) => {
    setTimeout(() => {
      new Logger('Shutdown').error(`Forced exit after ${signal} timed out`);
      process.exit(1);
    }, 8000).unref();
  };
  process.on('SIGTERM', () => failsafe('SIGTERM'));
  process.on('SIGINT', () => failsafe('SIGINT'));

  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `Amber Backup server listening on port ${config.port}`,
  );
}

void bootstrap();
