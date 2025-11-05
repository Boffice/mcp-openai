const {
  BACKOFFICE_SERVER_NAME,
  BACKOFFICE_SERVER_VERSION,
  BACKOFFICE_BASE_URL,
  BACKOFFICE_TIMEOUT_MS,
  BACKOFFICE_AUTHTOKEN,
} = process.env;

const parsedTimeout = BACKOFFICE_TIMEOUT_MS ? Number(BACKOFFICE_TIMEOUT_MS) : NaN;

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
