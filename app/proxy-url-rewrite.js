const TOKEN_CODEX_ROUTE_OVERRIDES = new Map([
  ['/v1/images/edits', '/images/edits'],
  ['/v1/images/generations', '/images/generations'],
]);

function buildIncomingUrl(req, proxyPath = '') {
  const combinedUrl = `${req.baseUrl || ''}${req.url || ''}`;
  if (!proxyPath || !combinedUrl.startsWith(proxyPath)) {
    return combinedUrl || '/';
  }

  const strippedUrl = combinedUrl.slice(proxyPath.length);
  return strippedUrl.startsWith('/') ? strippedUrl : `/${strippedUrl}`;
}

function rewriteTokenProxyUrl(parsedUrl, config) {
  const incomingPath = parsedUrl.pathname || '/';
  let upstreamPath;

  if (TOKEN_CODEX_ROUTE_OVERRIDES.has(incomingPath)) {
    upstreamPath = `${config.apiBasePath}${TOKEN_CODEX_ROUTE_OVERRIDES.get(incomingPath)}`;
  } else if (incomingPath === '/v1' || incomingPath.startsWith('/v1/')) {
    const suffix = incomingPath === '/v1' ? '' : incomingPath.slice('/v1'.length);
    upstreamPath = `${config.apiBasePath}${suffix}`;
  } else if (incomingPath === '/wham' || incomingPath.startsWith('/wham/')) {
    const suffix = incomingPath === '/wham' ? '' : incomingPath.slice('/wham'.length);
    upstreamPath = `/backend-api/wham${suffix}`;
  } else {
    upstreamPath = `${config.apiBasePath}${incomingPath === '/' ? '' : incomingPath}`;
  }

  parsedUrl.pathname = upstreamPath;
  return `${parsedUrl.pathname}${parsedUrl.search}`;
}

function rewriteProxyUrl(incomingUrl, config) {
  const parsedUrl = new URL(incomingUrl, 'http://localhost');
  if (config.type === 'apikey') {
    if (!parsedUrl.searchParams.has('client_version')) {
      parsedUrl.searchParams.set('client_version', '1');
    }
    return `${parsedUrl.pathname}${parsedUrl.search}`;
  }

  return rewriteTokenProxyUrl(parsedUrl, config);
}

module.exports = {
  buildIncomingUrl,
  rewriteProxyUrl,
};
