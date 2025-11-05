## BackOffice ERP MCP Server

This project exposes every operation from the BackOffice ERP REST API (as described in `swagger.json`) as Model Context Protocol (MCP) tools. The server is implemented in Node.js using the official MCP TypeScript SDK and is ready to be consumed by MCP-capable clients such as **n8n**.

### Prerequisites

- Node.js 18+
- A reachable BackOffice ERP REST API instance
- An API token (or credentials) for the `authtoken` header

### Install

```bash
npm install
```

### Environment variables

| Variable | Description |
| --- | --- |
| `BACKOFFICE_BASE_URL` | Base URL for the BackOffice ERP API, e.g. `https://erp.example.com/`. Optional if you supply `baseUrl` per tool invocation. |
| `BACKOFFICE_AUTHTOKEN` | Default value for the `authtoken` header. Optional - tools accept a `token` argument that overrides it. |
| `BACKOFFICE_SWAGGER_PATH` | Absolute or relative path to an alternative OpenAPI document. Defaults to `./swagger.json`. |
| `BACKOFFICE_TIMEOUT_MS` | Request timeout in milliseconds (defaults to `15000`). |
| `BACKOFFICE_SERVER_NAME` | Override the MCP server name advertised to clients. |
| `BACKOFFICE_SERVER_VERSION` | Override the MCP server version advertised to clients. |

### Run the MCP server

```bash
BACKOFFICE_BASE_URL="https://erp.example.com/" \
BACKOFFICE_AUTHTOKEN="your-token" \
npm start
```

The process listens on **stdio** (the default transport for MCP). When started manually you will see:

```
BackOffice ERP MCP server ready with <n> tools
```

### Tool shape

Each OpenAPI operation registers as a tool whose name is derived from the `operationId` (falling back to `METHOD_path`). The tool arguments follow this structure:

- `baseUrl`, `token`, `headers`, `accept`: optional overrides for URL and HTTP headers (token populates the `authtoken` header).
- `pathParams`: required path variables generated from the OpenAPI document.
- `query`: structured query string parameters (generated from the spec; extra keys are allowed).
- `body`, `contentType`: payload and content type when the operation defines a request body.

Responses include both plain JSON output and `structuredContent` containing status, headers, and data.

### Using the server from n8n

1. Ensure `npm start` is running (or deploy the server somewhere persistent).
2. In n8n, open **Settings → AI → Tools** and create a new **Model Context Protocol** tool.
3. Configure the MCP tool:
   - **Command**: `node`
   - **Arguments**: `["/absolute/path/to/src/server.js"]`
   - **Environment variables**: provide `BACKOFFICE_BASE_URL` and (optionally) `BACKOFFICE_AUTH_TOKEN`.
4. Enable the tool for your preferred AI agent or workflow (e.g. via the AI Agent node).
5. When the agent runs, every API operation from the swagger file is now directly callable.

### Customising the OpenAPI source

- Replace `swagger.json` with an updated spec, or
- Point `BACKOFFICE_SWAGGER_PATH` to another OpenAPI document. Tools are regenerated automatically on startup.

### Development notes

- The server relies on `axios` for outbound requests. It forwards response bodies, status codes, and headers to clients so you can inspect failures.
- Query, header, and body schemas are validated using `zod`, derived from the OpenAPI spec.
- Unsupported / circular references fallback to `z.any()` to prevent schema generation from blocking startup.

### Next steps

- Add automated smoke tests that call representative tools against a staging ERP instance.
- Layer caching or rate limiting if exposing the server publicly.

