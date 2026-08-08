import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';

export type ValidationIssue = {
  message: string;
  path: string;
};

export const isSchemaValueValid = (schema: TSchema, value: unknown): boolean =>
  Value.Check(schema, value);

export const listSchemaIssues = (
  schema: TSchema,
  value: unknown,
): ValidationIssue[] =>
  [...Value.Errors(schema, value)].map((error) => ({
    message: error.message,
    path: error.path,
  }));
