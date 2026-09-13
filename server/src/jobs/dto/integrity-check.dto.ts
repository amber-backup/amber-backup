import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IntegrityLevel } from '../../database/database.types';

const LEVELS: IntegrityLevel[] = ['quick', 'rotating', 'full'];

export class StartCheckDto {
  @ApiProperty({
    enum: LEVELS,
    description:
      "quick: structure only · rotating: also reads the next part of the data · full: reads all data",
  })
  @IsIn(LEVELS)
  level!: IntegrityLevel;
}

export class IntegrityCheckConfigDto {
  @ApiProperty({ description: 'Run checks on the schedule' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ example: '0 4 * * 0', description: 'Required while enabled' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  cronExpr?: string;

  @ApiProperty({ enum: LEVELS })
  @IsIn(LEVELS)
  level!: IntegrityLevel;

  @ApiPropertyOptional({
    description: "For 'rotating': number of parts the data is split into, one read per run",
    minimum: 2,
    maximum: 100,
    default: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  subsetParts?: number;
}
