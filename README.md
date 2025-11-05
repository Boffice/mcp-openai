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
| `BACKOFFICE_HTTP_PORT` | HTTP port for the MCP endpoint (defaults to `3333`). |
| `BACKOFFICE_HTTP_HOST` | Interface to bind the HTTP server to (defaults to `0.0.0.0`). |
| `BACKOFFICE_HTTP_PATH` | Path segment for the MCP endpoint (defaults to `/mcp`). |
| `BACKOFFICE_HTTP_ENABLE_JSON_RESPONSE` | Set to `true` to return JSON responses instead of SSE streams (mainly for debugging). |
| `BACKOFFICE_HTTP_ALLOWED_HOSTS` | Comma-separated list of allowed `Host` headers when DNS rebinding protection is enabled. |
| `BACKOFFICE_HTTP_ALLOWED_ORIGINS` | Comma-separated list of allowed `Origin` headers when DNS rebinding protection is enabled. |
| `BACKOFFICE_HTTP_ENABLE_DNS_REBINDING` | Set to `true` to enable Host/Origin validation for the HTTP transport. |

### Run the MCP server

```bash
BACKOFFICE_BASE_URL="https://erp.example.com/" \
BACKOFFICE_AUTHTOKEN="your-token" \
npm start
```

On startup the server exposes a **Streamable HTTP** MCP endpoint. You will see a log similar to:

```
backoffice-erp-mcp listening on http://localhost:3333/mcp
```

### Tool shape

Each OpenAPI operation registers as a tool whose name is derived from the `operationId` (falling back to `METHOD_path`). The tool arguments follow this structure:

- `baseUrl`, `token`, `headers`, `accept`: optional overrides for URL and HTTP headers (token populates the `authtoken` header).
- `pathParams`: required path variables generated from the OpenAPI document.
- `query`: structured query string parameters (generated from the spec; extra keys are allowed).
- `body`, `contentType`: payload and content type when the operation defines a request body.

Responses include both plain JSON output and `structuredContent` containing status, headers, and data.

### Using the server from n8n

1. Ensure `npm start` is running on the machine that hosts this repository (Docker, VM, or bare metal).
2. In n8n, add an **AI Agent** (LangChain) to your workflow and open its **Tools** panel.
3. Drop in an **MCP Client Tool** node and configure it:
   - **SSE Endpoint**: `http://<host>:<port>/mcp` (for example `http://localhost:3333/mcp`).
   - **Authentication**: `None` (unless you add protections on the MCP server).
   - **Tools to Include**: `All` (or specify the subset of API operations you want to expose).
4. Connect the MCP Client Tool node to the AI Agent node so the agent can invoke it.
5. Trigger the workflow. When the agent decides to call the MCP server it can invoke any of the generated API tools, passing structured parameters derived from the OpenAPI spec.

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


