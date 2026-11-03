import { Transform } from "class-transformer";
import { IsNotEmpty, IsString } from "class-validator";
import type { CreateReportFormFields } from "@field-reporting/types";

export class CreateReportDto implements CreateReportFormFields {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  description!: string;
}
