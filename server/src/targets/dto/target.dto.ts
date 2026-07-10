import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTargetDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ example: 's3', description: 'Backend type from the catalog' })
  @IsString()
  backendType!: string;

  @ApiProperty({ description: 'Restic repository password' })
  @IsString()
  @MinLength(1)
  repoPassword!: string;

  @ApiProperty({
    description: 'Flat backend field values (secret + non-secret combined)',
    type: Object,
  })
  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateTargetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'New repository password' })
  @IsOptional()
  @IsString()
  repoPassword?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
