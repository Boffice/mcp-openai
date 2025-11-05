import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serverConfig, apiConfig, securityConfig } from './config.js';
import {
  loadOpenApiSpec,
  buildOperationsFromSpec,
  buildToolInputSchema,
  buildOperationsSummary,
} from './utils/openapi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const swaggerPath = process.env.BACKOFFICE_SWAGGER_PATH
    ? path.resolve(process.env.BACKOFFICE_SWAGGER_PATH)
    : path.resolve(__dirname, '..', 'swagger.json');

  const spec = await loadOpenApiSpec(swaggerPath);
  const operations = buildOperationsFromSpec(spec);

  if (operations.length === 0) {
    throw new Error('No operations discovered in swagger.json.');
  }

  const mcpServer = new McpServer({
    name: serverConfig.name,
    version: serverConfig.version,
    description: spec.info?.description,
  });

  registerResources(mcpServer, spec, operations);
  registerTools(mcpServer, operations, spec);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.log(
    `${serverConfig.name} ready on stdio with ${operations.length} registered tools.`
  );
}

function registerResources(mcpServer, spec, operations) {
  mcpServer.registerResource(
    'backoffice-openapi',
    'openapi://backoffice/swagger',
    {
      title: 'BackOffice Swagger Specification',
      description: 'Full OpenAPI document for the BackOffice ERP API.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'openapi://backoffice/swagger',
          mimeType: 'application/json',
          text: JSON.stringify(spec, null, 2),
        },
      ],
    })
  );

  mcpServer.registerResource(
    'backoffice-operations',
    'openapi://backoffice/operations',
    {
      title: 'API Operations Summary',
      description: 'High-level overview of the API operations exposed as tools.',
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [
        {
          uri: 'openapi://backoffice/operations',
          mimeType: 'text/plain',
          text: buildOperationsSummary(operations),
        },
      ],
    })
  );
}

function registerTools(mcpServer, operations, spec) {
  for (const operation of operations) {
    const inputShape = buildToolInputSchema(operation, spec);
    const validationSchema = z.object(inputShape).strict();

    const descriptionParts = [
      operation.summary || operation.description || `${operation.method} ${operation.path}`,
    ];

    if (operation.requiresAuth) {
      descriptionParts.push(
        `Requires \`${securityConfig.headerName}\` header. Defaults to BACKOFFICE_AUTHTOKEN env or token input.`
      );
    }

    const annotations = {
      title: `${operation.method} ${operation.path}`,
      description: descriptionParts.join(' '),
      inputSchema: inputShape,
    };

    mcpServer.registerTool(operation.id, annotations, async (rawInput = {}) => {
      const parsed = validationSchema.safeParse(rawInput);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Input validation failed: ${parsed.error.message}`,
            },
          ],
        };
      }

      return executeOperation(operation, parsed.data);
    });
  }
}

async function executeOperation(operation, input) {
  const baseUrl = input.baseUrl ?? apiConfig.baseUrl;
  if (!baseUrl) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'No API base URL configured. Provide baseUrl in the tool input or set BACKOFFICE_BASE_URL env.',
        },
      ],
    };
  }

  const headers = {
    ...(input.headers ?? {}),
  };

  if (input.accept) {
    headers.Accept = input.accept;
  } else if (!headers.Accept) {
    headers.Accept = 'application/json';
  }

  const token = input.token ?? securityConfig.token;
  if (token) {
    headers[securityConfig.headerName] = token;
  }

  const pathParams = input.pathParams ?? {};
  const missingPathParams = (operation.parameters.path ?? [])
    .filter((param) => param.required)
    .map((param) => param.name)
    .filter((name) => typeof pathParams[name] === 'undefined');

  if (missingPathParams.length > 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Missing required path parameters: ${missingPathParams.join(', ')}`,
        },
      ],
    };
  }

  const url = buildRequestUrl(baseUrl, operation.path, pathParams);

  const requiresBody = Boolean(operation.requestBody?.required);
  if (requiresBody && typeof input.body === 'undefined') {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'This operation requires a request body payload, but none was provided.',
        },
      ],
    };
  }

  if (operation.requestBody) {
    const contentType =
      input.contentType ?? operation.requestBody.contentTypes[0] ?? 'application/json';
    headers['Content-Type'] = contentType;
  }

  try {
    const response = await axios.request({
      method: operation.method,
      url,
      headers,
      params: input.query,
      data: input.body,
      timeout: apiConfig.timeoutMs,
    });

    return {
      content: [
        {
          type: 'text',
          text: formatJson(response.data),
        },
      ],
      structuredContent: {
        status: response.status,
        statusText: response.statusText,
        data: response.data,
        headers: response.headers,
      },
    };
  } catch (error) {
    return formatAxiosError(error, {
      method: operation.method,
      url,
      headers,
      params: input.query,
      body: input.body,
    });
  }
}

function buildRequestUrl(baseUrl, apiPath, pathParams) {
  let resolvedPath = apiPath;
  for (const [key, value] of Object.entries(pathParams)) {
    resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(String(value)));
  }
  return `${baseUrl.replace(/\/$/, '')}/${resolvedPath.replace(/^\//, '')}`;
}

function formatJson(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function formatAxiosError(error, requestContext) {
  if (!axios.isAxiosError(error)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const status = error.response?.status;
  const statusText = error.response?.statusText;
  const responseData = error.response?.data;
  const errorMessage =
    status !== undefined
      ? `Request failed with status ${status}${statusText ? ` (${statusText})` : ''}.`
      : `Request failed: ${error.message}`;

  const responseContent =
    responseData !== undefined ? formatJson(responseData) : undefined;

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: responseContent ? `${errorMessage}\n${responseContent}` : errorMessage,
      },
    ],
    structuredContent: {
      request: requestContext,
      response: error.response
        ? {
            status,
            statusText,
            headers: error.response.headers,
            data: responseData,
          }
        : undefined,
    },
  };
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
