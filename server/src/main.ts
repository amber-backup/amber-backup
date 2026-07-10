import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { loadConfig, validateConfig } from './config/configuration';
import { runMigrations } from './database/migrator';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  validateConfig(config);

  // Apply pending migrations before the app initializes, so the schema exists
  // before module init (e.g. bootstrap-admin creation).
  const migrationLogger = new Logger('Migrations');
  await runMigrations('up', (m) => migrationLogger.log(m));

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.setGlobalPrefix('api', { exclude: ['/'] });
  app.use(cookieParser());
  app.enableCors({ origin: true, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

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
