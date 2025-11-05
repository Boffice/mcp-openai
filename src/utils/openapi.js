import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

export async function loadOpenApiSpec(filePath = 'swagger.json') {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(getProjectRoot(), filePath);
  const contents = await fs.readFile(resolvedPath, 'utf-8');
  return JSON.parse(contents);
}

export function buildOperationsFromSpec(spec) {
  const operations = [];
  const seen = new Map();

  for (const [apiPath, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const commonParameters = normalizeParameters(pathItem.parameters, spec);

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!operation || typeof operation !== 'object') continue;

      const combinedParameters = [
        ...commonParameters,
        ...normalizeParameters(operation.parameters, spec),
      ];

      const groupedParameters = groupParametersByLocation(combinedParameters);

      const requestBody = normalizeRequestBody(operation.requestBody, spec);

      const baseName = sanitizeOperationId(operation.operationId ?? `${method}_${apiPath}`);
      const uniqueId = getUniqueOperationId(baseName, seen);

      const requiresAuth = Boolean(
        (operation.security ?? spec.security ?? []).length > 0
      );

      operations.push({
        id: uniqueId,
        method: method.toUpperCase(),
        path: apiPath,
        summary: operation.summary ?? '',
        description: operation.description ?? '',
        parameters: groupedParameters,
        requestBody,
        requiresAuth,
      });
    }
  }

  return operations;
}

export function buildToolInputSchema(operation, spec) {
  const inputSchema = {
    baseUrl: z
      .string()
      .url()
      .describe('Optional override for the API base URL (defaults to configured baseUrl).')
      .optional(),
    token: z
      .string()
      .describe('Override the authtoken header value for this call (defaults to BACKOFFICE_AUTHTOKEN env).')
      .optional(),
    headers: z
      .record(z.string())
      .describe('Additional HTTP headers to send with the request.')
      .optional(),
  };

  if (operation.parameters.path.length > 0) {
    inputSchema.pathParams = createParametersObject(
      operation.parameters.path,
      spec,
      'path',
      `Path parameters for ${operation.method} ${operation.path}.`
    );
  }

  if (operation.parameters.query.length > 0) {
    inputSchema.query = createParametersObject(
      operation.parameters.query,
      spec,
      'query',
      `Query string parameters for ${operation.method} ${operation.path}.`
    )
      .catchall(z.union([z.string(), z.number(), z.boolean()]).optional())
      .optional();
  }

  if (operation.requestBody) {
    const requestSchema = convertSchemaToZod(operation.requestBody.schema, spec);
    const describedSchema = requestSchema.describe(
      buildRequestBodyDescription(operation)
    );
    inputSchema.body = operation.requestBody.required
      ? describedSchema
      : describedSchema.optional();
    inputSchema.contentType = z
      .string()
      .describe(
        `Content-Type override. Defaults to ${operation.requestBody.contentTypes[0] ?? 'application/json'}.`
      )
      .optional();
  }

  return inputSchema;
}

export function buildOperationsSummary(operations) {
  return operations
    .map(
      (operation) =>
        `${operation.id}: [${operation.method}] ${operation.path} - ${
          operation.summary || 'No summary provided'
        }`
    )
    .join('\n');
}

function normalizeParameters(parameters = [], spec) {
  if (!Array.isArray(parameters)) return [];
  return parameters
    .map((parameter) => resolveReference(parameter, spec))
    .filter(Boolean);
}

function groupParametersByLocation(parameters) {
  const grouped = {
    path: [],
    query: [],
    header: [],
    cookie: [],
  };

  for (const parameter of parameters) {
    const location = parameter.in ?? 'query';
    if (!grouped[location]) {
      grouped[location] = [];
    }
    grouped[location].push(parameter);
  }

  return grouped;
}

function normalizeRequestBody(requestBody, spec) {
  if (!requestBody) return undefined;
  const resolvedBody = resolveReference(requestBody, spec);
  if (!resolvedBody) return undefined;

  const content = resolvedBody.content ?? {};
  const contentTypes = Object.keys(content);
  const preferredContentType =
    contentTypes.find((type) => type.includes('json')) ?? contentTypes[0];

  const schema =
    preferredContentType && content[preferredContentType]
      ? resolveReference(content[preferredContentType].schema, spec)
      : undefined;

  return {
    required: Boolean(resolvedBody.required),
    contentTypes,
    schema,
  };
}

function sanitizeOperationId(operationId) {
  return operationId
    .replace(/[^\w\s]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function getUniqueOperationId(baseName, seen) {
  const currentCount = seen.get(baseName) ?? 0;
  seen.set(baseName, currentCount + 1);
  if (currentCount === 0) return baseName;
  return `${baseName}_${currentCount + 1}`;
}

function resolveReference(item, spec, visited = new Set()) {
  if (!item) return undefined;
  if (!item.$ref) return item;

  if (visited.has(item.$ref)) {
    return undefined;
  }
  visited.add(item.$ref);

  const refPath = item.$ref.replace(/^#\//, '').split('/');
  let current = spec;
  for (const segment of refPath) {
    if (current && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      current = undefined;
      break;
    }
  }
  if (!current) return undefined;
  if (current.$ref) {
    return resolveReference(current, spec, visited);
  }
  return current;
}

function createParametersObject(parameters, spec, location, description) {
  const shape = {};

  for (const parameter of parameters) {
    if (!parameter?.name) continue;

    const resolvedSchema = resolveReference(parameter.schema, spec);
    const schema = convertSchemaToZod(resolvedSchema, spec);
    const describedSchema = schema.describe(
      buildParameterDescription(parameter, location)
    );

    shape[parameter.name] = parameter.required ? describedSchema : describedSchema.optional();
  }

  return z.object(shape).describe(description);
}

function convertSchemaToZod(schema, spec, visitedRefs = new Set()) {
  if (!schema) {
    return z.any();
  }

  if (schema.$ref) {
    if (visitedRefs.has(schema.$ref)) {
      return z.any();
    }
    visitedRefs.add(schema.$ref);
    const resolved = resolveReference(schema, spec);
    if (!resolved) {
      visitedRefs.delete(schema.$ref);
      return z.any();
    }
    const result = convertSchemaToZod(resolved, spec, visitedRefs);
    visitedRefs.delete(schema.$ref);
    return result;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return buildEnumSchema(schema.enum);
  }

  const nullable = schema.nullable === true || schema.type === 'null';
  let type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (!type) {
    if (schema.properties) {
      type = 'object';
    } else if (schema.items) {
      type = 'array';
    }
  }

  let zodType;

  switch (type) {
    case 'string':
      zodType = buildStringSchema(schema);
      break;
    case 'integer':
      zodType = buildNumberSchema(schema, true);
      break;
    case 'number':
      zodType = buildNumberSchema(schema, false);
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    case 'array':
      zodType = buildArraySchema(schema, spec, visitedRefs);
      break;
    case 'object':
      zodType = buildObjectSchema(schema, spec, visitedRefs);
      break;
    default:
      zodType = z.any();
      break;
  }

  if (nullable) {
    zodType = zodType.nullable();
  }

  return zodType;
}

function buildEnumSchema(values) {
  if (values.every((value) => typeof value === 'string')) {
    return z.enum(values);
  }
  const literals = values.map((value) => z.literal(value));
  if (literals.length === 1) {
    return literals[0];
  }
  return z.union(literals);
}

function buildStringSchema(schema) {
  let stringSchema = z.string();

  if (schema.format === 'date-time' || schema.format === 'date') {
    stringSchema = stringSchema.describe(`Expected format: ${schema.format}`);
  }
  if (typeof schema.minLength === 'number') {
    stringSchema = stringSchema.min(schema.minLength);
  }
  if (typeof schema.maxLength === 'number') {
    stringSchema = stringSchema.max(schema.maxLength);
  }
  if (schema.pattern) {
    stringSchema = stringSchema.regex(new RegExp(schema.pattern));
  }

  return stringSchema;
}

function buildNumberSchema(schema, isInteger) {
  let numberSchema = z.number();
  if (isInteger) {
    numberSchema = numberSchema.int();
  }
  if (typeof schema.minimum === 'number') {
    numberSchema = numberSchema.min(schema.minimum);
  }
  if (typeof schema.maximum === 'number') {
    numberSchema = numberSchema.max(schema.maximum);
  }
  if (typeof schema.exclusiveMinimum === 'number') {
    numberSchema = numberSchema.gt(schema.exclusiveMinimum);
  }
  if (typeof schema.exclusiveMaximum === 'number') {
    numberSchema = numberSchema.lt(schema.exclusiveMaximum);
  }
  return numberSchema;
}

function buildArraySchema(schema, spec, visitedRefs) {
  const itemSchema = schema.items
    ? convertSchemaToZod(schema.items, spec, visitedRefs)
    : z.any();
  let arraySchema = z.array(itemSchema);
  if (typeof schema.minItems === 'number') {
    arraySchema = arraySchema.min(schema.minItems);
  }
  if (typeof schema.maxItems === 'number') {
    arraySchema = arraySchema.max(schema.maxItems);
  }
  return arraySchema;
}

function buildObjectSchema(schema, spec, visitedRefs) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape = {};

  for (const [key, value] of Object.entries(properties)) {
    const propertySchema = convertSchemaToZod(value, spec, visitedRefs);
    shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
  }

  let objectSchema = z.object(shape);

  if (schema.additionalProperties) {
    const additionalSchema =
      schema.additionalProperties === true
        ? z.any()
        : convertSchemaToZod(schema.additionalProperties, spec, visitedRefs);
    objectSchema = objectSchema.catchall(additionalSchema);
  } else {
    objectSchema = objectSchema.strict();
  }

  return objectSchema;
}

function buildParameterDescription(parameter, location) {
  const segments = [
    `[${location}]`,
    parameter.name,
    parameter.required ? '(required)' : '(optional)',
  ];
  if (parameter.description) {
    segments.push(`- ${parameter.description}`);
  }
  return segments.join(' ');
}

function buildRequestBodyDescription(operation) {
  const parts = [
    `Request body for ${operation.method} ${operation.path}.`,
  ];
  if (operation.requestBody?.contentTypes?.length) {
    parts.push(`Supported content types: ${operation.requestBody.contentTypes.join(', ')}.`);
  }
  if (operation.requestBody?.required) {
    parts.push('This body is required.');
  } else {
    parts.push('This body is optional.');
  }
  return parts.join(' ');
}

function getProjectRoot() {
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), '..', '..');
}
