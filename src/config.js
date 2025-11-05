const {
  BACKOFFICE_SERVER_NAME,
  BACKOFFICE_SERVER_VERSION,
  BACKOFFICE_BASE_URL,
  BACKOFFICE_TIMEOUT_MS,
  BACKOFFICE_AUTHTOKEN,
  BACKOFFICE_HTTP_PORT,
  BACKOFFICE_HTTP_HOST,
  BACKOFFICE_HTTP_PATH,
  BACKOFFICE_HTTP_ENABLE_JSON_RESPONSE,
  BACKOFFICE_HTTP_ALLOWED_HOSTS,
  BACKOFFICE_HTTP_ALLOWED_ORIGINS,
  BACKOFFICE_HTTP_ENABLE_DNS_REBINDING,
} = process.env;

const parsedTimeout = BACKOFFICE_TIMEOUT_MS ? Number(BACKOFFICE_TIMEOUT_MS) : NaN;
const parsedPort = BACKOFFICE_HTTP_PORT ? Number(BACKOFFICE_HTTP_PORT) : NaN;

function parseList(value) {
  return value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;
}

export const serverConfig = {
  name: BACKOFFICE_SERVER_NAME ?? 'backoffice-erp-mcp',
  version: BACKOFFICE_SERVER_VERSION ?? '1.0.0',
};

export const apiConfig = {
  baseUrl: BACKOFFICE_BASE_URL ?? 'https://redis.bo.ge',
  timeoutMs: Number.isFinite(parsedTimeout) ? parsedTimeout : 15000,
};

export const securityConfig = {
  headerName: 'authtoken',
  token: BACKOFFICE_AUTHTOKEN ?? '',
};

export const httpConfig = {
  host: BACKOFFICE_HTTP_HOST ?? '0.0.0.0',
  port: Number.isFinite(parsedPort) ? parsedPort : 3333,
  path: BACKOFFICE_HTTP_PATH ?? '/mcp',
  enableJsonResponse: BACKOFFICE_HTTP_ENABLE_JSON_RESPONSE === 'true',
  enableDnsRebindingProtection: BACKOFFICE_HTTP_ENABLE_DNS_REBINDING === 'true',
  allowedHosts: parseList(BACKOFFICE_HTTP_ALLOWED_HOSTS),
  allowedOrigins: parseList(BACKOFFICE_HTTP_ALLOWED_ORIGINS),
};
