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

  @ApiProperty({
    description:
      'Flat connection field values (target-scoped, secret + non-secret)',
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

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
