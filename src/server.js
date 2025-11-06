import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  serverConfig,
  apiConfig,
  securityConfig,
  httpConfig,
  debugConfig,
} from './config.js';
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

  const specText = JSON.stringify(spec, null, 2);
  const operationsSummary = buildOperationsSummary(operations);

  const sessions = new Map();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.post(httpConfig.path, async (req, res) => {
    const sessionId = extractSessionId(req);

    try {
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          respondWithJsonError(res, 404, 'Unknown session. Reinitialize your MCP client.');
          return;
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        respondWithJsonError(res, 400, 'Initialization request required before other calls.');
        return;
      }

      const session = await createSession({
        spec,
        specText,
        operations,
        operationsSummary,
        sessions,
      });

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      handleTransportError(res, error);
    }
  });

  const handleSessionRequest = async (req, res) => {
    const sessionId = extractSessionId(req);
    if (!sessionId) {
      respondWithJsonError(res, 400, 'Missing Mcp-Session-Id header.');
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      respondWithJsonError(res, 404, 'Unknown session. Reinitialize your MCP client.');
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      handleTransportError(res, error);
    }
  };

  app.get(httpConfig.path, handleSessionRequest);
  app.delete(httpConfig.path, handleSessionRequest);

  const server = app.listen(httpConfig.port, httpConfig.host, () => {
    const hostLabel = httpConfig.host === '0.0.0.0' ? 'localhost' : httpConfig.host;
    console.log(
      `${serverConfig.name} listening on http://${hostLabel}:${httpConfig.port}${httpConfig.path}`
    );
  });

  server.on('error', (error) => {
    console.error('Failed to start MCP HTTP server:', error);
    process.exit(1);
  });
}

async function createSession({
  spec,
  specText,
  operations,
  operationsSummary,
  sessions,
}) {
  const serverInstance = buildServerInstance(spec, specText, operations, operationsSummary);
  let transport;

  const sessionRecord = {
    server: serverInstance,
    transport: undefined,
  };

  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: httpConfig.enableJsonResponse,
    enableDnsRebindingProtection: httpConfig.enableDnsRebindingProtection,
    allowedHosts: httpConfig.allowedHosts,
    allowedOrigins: httpConfig.allowedOrigins,
    onsessioninitialized: async (sessionId) => {
      sessions.set(sessionId, sessionRecord);
    },
    onsessionclosed: async (sessionId) => {
      sessions.delete(sessionId);
      await safeCloseServer(sessionRecord.server);
    },
  });

  sessionRecord.transport = transport;

  transport.onclose = async () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
    await safeCloseServer(sessionRecord.server);
  };

  await serverInstance.connect(transport);

  return sessionRecord;
}

function buildServerInstance(spec, specText, operations, operationsSummary) {
  const mcpServer = new McpServer({
    name: serverConfig.name,
    version: serverConfig.version,
    description: spec.info?.description,
  });

  registerResources(mcpServer, specText, operationsSummary);
  registerTools(mcpServer, operations, spec);

  return mcpServer;
}

function registerResources(mcpServer, specText, operationsSummary) {
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
          text: specText,
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
          text: operationsSummary,
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

    mcpServer.registerTool(
      operation.id,
      {
        title: `${operation.method} ${operation.path}`,
        description: descriptionParts.join(' '),
        inputSchema: inputShape,
      },
      async (rawInput = {}) => {
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
      }
    );
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

  if (operation.requestBody?.required && typeof input.body === 'undefined') {
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
    if (debugConfig.http) {
      console.log(
        '[MCP DEBUG] Outbound request',
        JSON.stringify(
          {
            method: operation.method,
            url,
            headers,
            params: input.query,
            body: input.body,
          },
          null,
          2
        )
      );
    }

    const response = await axios.request({
      method: operation.method,
      url,
      headers,
      params: input.query,
      data: input.body,
      timeout: apiConfig.timeoutMs,
    });

    if (debugConfig.http) {
      console.log(
        '[MCP DEBUG] Response received',
        JSON.stringify(
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            data: response.data,
          },
          null,
          2
        )
      );
    }

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
    if (debugConfig.http) {
      console.error('[MCP DEBUG] Request error', error);
    }
    return formatAxiosError(error, {
      method: operation.method,
      url,
      headers,
      params: input.query,
      body: input.body,
    });
  }
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

function buildRequestUrl(baseUrl, apiPath, pathParams) {
  let resolvedPath = apiPath;
  for (const [key, value] of Object.entries(pathParams)) {
    resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(String(value)));
  }
  return `${baseUrl.replace(/\/$/, '')}/${resolvedPath.replace(/^\//, '')}`;
}

function extractSessionId(req) {
  const headerValue = req.headers['mcp-session-id'];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }
  return headerValue ?? undefined;
}

function respondWithJsonError(res, statusCode, message) {
  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

function handleTransportError(res, error) {
  console.error('MCP transport error:', error);
  respondWithJsonError(res, 500, error instanceof Error ? error.message : String(error));
}

async function safeCloseServer(server) {
  try {
    await server.close();
  } catch (error) {
    if (error) {
      console.error('Failed to close MCP server session cleanly:', error);
    }
  }
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
