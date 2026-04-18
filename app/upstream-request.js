const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const DEFAULT_PORTS = {
  'http:': 80,
  'https:': 443,
};

function shouldBypassProxy(targetUrl, noProxyValue) {
  if (!noProxyValue) {
    return false;
  }

  const hostname = targetUrl.hostname.toLowerCase();
  const port = String(targetUrl.port || DEFAULT_PORTS[targetUrl.protocol] || '');
  const entries = String(noProxyValue)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  return entries.some(entry => {
    if (entry === '*') {
      return true;
    }

    const [entryHost, entryPort] = entry.split(':');
    if (entryPort && entryPort !== port) {
      return false;
    }

    if (entryHost.startsWith('.')) {
      return hostname === entryHost.slice(1) || hostname.endsWith(entryHost);
    }

    return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
  });
}

function resolveProxyUrl(targetUrl) {
  const noProxy = process.env.no_proxy || process.env.NO_PROXY;
  if (shouldBypassProxy(targetUrl, noProxy)) {
    return null;
  }

  const directProxy = targetUrl.protocol === 'https:'
    ? process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
    : process.env.http_proxy || process.env.HTTP_PROXY;
  const fallbackProxy = process.env.all_proxy || process.env.ALL_PROXY;
  const proxyValue = directProxy || fallbackProxy;

  if (!proxyValue) {
    return null;
  }

  const proxyUrl = new URL(proxyValue);
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new Error(`unsupported proxy protocol: ${proxyUrl.protocol}`);
  }

  return proxyUrl;
}

function buildProxyAuthorization(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) {
    return null;
  }

  const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

function createConnectTunnel(proxyUrl, targetUrl) {
  return new Promise((resolve, reject) => {
    const proxyModule = proxyUrl.protocol === 'https:' ? https : http;
    const tunnelTarget = `${targetUrl.hostname}:${targetUrl.port || DEFAULT_PORTS[targetUrl.protocol]}`;
    const headers = {
      Host: tunnelTarget,
    };
    const proxyAuthorization = buildProxyAuthorization(proxyUrl);

    if (proxyAuthorization) {
      headers['Proxy-Authorization'] = proxyAuthorization;
    }

    const request = proxyModule.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || DEFAULT_PORTS[proxyUrl.protocol],
      method: 'CONNECT',
      path: tunnelTarget,
      headers,
    });

    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed with status ${response.statusCode}`));
        return;
      }

      if (head && head.length > 0) {
        socket.unshift(head);
      }

      resolve(socket);
    });

    request.once('response', response => {
      response.resume();
      reject(new Error(`proxy CONNECT failed with status ${response.statusCode}`));
    });

    request.once('error', reject);
    request.end();
  });
}

function createDirectRequestOptions(targetUrl, method, headers) {
  return {
    module: targetUrl.protocol === 'https:' ? https : http,
    options: {
      protocol: targetUrl.protocol,
      host: targetUrl.hostname,
      port: targetUrl.port || DEFAULT_PORTS[targetUrl.protocol],
      method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
    },
  };
}

function createHttpProxyRequestOptions(proxyUrl, targetUrl, method, headers) {
  const proxyHeaders = { ...headers };
  const proxyAuthorization = buildProxyAuthorization(proxyUrl);

  if (!proxyHeaders.host) {
    proxyHeaders.host = targetUrl.host;
  }

  if (proxyAuthorization) {
    proxyHeaders['Proxy-Authorization'] = proxyAuthorization;
  }

  return {
    module: proxyUrl.protocol === 'https:' ? https : http,
    options: {
      protocol: proxyUrl.protocol,
      host: proxyUrl.hostname,
      port: proxyUrl.port || DEFAULT_PORTS[proxyUrl.protocol],
      method,
      path: targetUrl.toString(),
      headers: proxyHeaders,
    },
  };
}

function createHttpsProxyRequestOptions(proxyUrl, targetUrl, method, headers) {
  return {
    module: https,
    options: {
      protocol: 'https:',
      host: targetUrl.hostname,
      port: targetUrl.port || DEFAULT_PORTS[targetUrl.protocol],
      method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      createConnection: (_options, callback) => {
        createConnectTunnel(proxyUrl, targetUrl)
          .then(proxySocket => {
            const secureSocket = tls.connect({
              socket: proxySocket,
              servername: targetUrl.hostname,
            });

            secureSocket.once('secureConnect', () => callback(null, secureSocket));
            secureSocket.once('error', callback);
          })
          .catch(callback);
      },
    },
  };
}

function createRequestOptions(method, targetUrl, headers = {}) {
  const parsedUrl = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  const proxyUrl = resolveProxyUrl(parsedUrl);

  if (!proxyUrl) {
    return createDirectRequestOptions(parsedUrl, method, headers);
  }

  if (parsedUrl.protocol === 'http:') {
    return createHttpProxyRequestOptions(proxyUrl, parsedUrl, method, headers);
  }

  return createHttpsProxyRequestOptions(proxyUrl, parsedUrl, method, headers);
}

function createUpstreamRequest({ method, targetUrl, headers = {}, body }) {
  let request = null;
  let response = null;

  const responsePromise = new Promise((resolve, reject) => {
    let requestConfig;

    try {
      requestConfig = createRequestOptions(method, targetUrl, headers);
    } catch (error) {
      reject(error);
      return;
    }

    request = requestConfig.module.request(requestConfig.options, incomingMessage => {
      response = incomingMessage;
      resolve(incomingMessage);
    });

    request.once('error', reject);

    if (Buffer.isBuffer(body) && body.length > 0) {
      request.end(body);
      return;
    }

    request.end();
  });

  return {
    responsePromise,
    abort(error) {
      if (response && !response.destroyed) {
        response.destroy(error);
      }

      if (request && !request.destroyed) {
        request.destroy(error);
      }
    },
  };
}

function isRedirectStatus(statusCode) {
  return [301, 302, 303, 307, 308].includes(Number(statusCode));
}

async function consumeResponseBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    response.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    response.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    response.on('error', reject);
  });
}

async function requestBuffered(options, redirectCount = 0) {
  const upstream = createUpstreamRequest(options);
  const response = await upstream.responsePromise;
  const statusCode = Number(response.statusCode || 0);

  if (isRedirectStatus(statusCode) && response.headers.location && redirectCount < (options.maxRedirects || 0)) {
    response.resume();
    await new Promise(resolve => response.on('end', resolve));

    const nextUrl = new URL(response.headers.location, options.targetUrl).toString();
    const nextMethod = statusCode === 303 ? 'GET' : options.method;
    const nextBody = nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : options.body;

    return requestBuffered({
      ...options,
      method: nextMethod,
      targetUrl: nextUrl,
      body: nextBody,
    }, redirectCount + 1);
  }

  const responseBody = await consumeResponseBody(response);
  return {
    statusCode,
    headers: response.headers,
    body: responseBody,
    bodyText: responseBody.toString('utf8'),
  };
}

module.exports = {
  createUpstreamRequest,
  requestBuffered,
};
