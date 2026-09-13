import { ApiProperty } from '@nestjs/swagger';

export class UpdateStatusDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Newest published release (without "v"); null until checked',
    example: '1.29.0',
  })
  latestVersion!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'GitHub release page of latestVersion',
  })
  releaseUrl!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the release feed was last read successfully',
  })
  checkedAt!: string | null;
}
