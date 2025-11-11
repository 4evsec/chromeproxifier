#!/usr/bin/env tsx
/*******************************************************************************
 * ChromeProxifier
 *
 * HTTP proxy server that proxify requests though Google DevTools Protocol via
 * `fetch` function calls.
 *******************************************************************************
 *
 * Usage:
 *      chromeproxifier -p 9090 --remote-debugging-host 127.0.0.1 \
 *        --remote-debugging-port 9222
 *
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import c from 'chalk';
import CDP from 'chrome-remote-interface';
import type { Headers } from 'mockttp';
import { generateCACertificate, getLocal } from 'mockttp';
import { pickBy } from 'remeda';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('proxy-port', {
    alias: 'p',
    describe: `The proxy server's port`,
    type: 'number',
    default: 9090,
  })
  .option('chrome-port', {
    alias: ['dp', 'remote-debugging-port'],
    describe: 'The chrome remote debugging port',
    type: 'number',
    default: 9222,
  })
  .option('chrome-host', {
    alias: ['h', 'remote-debugging-host'],
    describe: 'The chrome remote debugging host',
    type: 'string',
    default: '127.0.0.1',
  });

interface TargetInfos {
  targetId: string;
  sessionId?: string;
}

type FetchConfig = Omit<RequestInit, 'headers'> & {
  headers: Record<string, string>;
  url: URL;
};

interface FetchResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: ArrayBuffer;
}

// A list of headers pattern to omit in `fetch` calls.
// https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
const FORBIDDEN_HEADERS = [
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'permissions-policy',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'proxy-.*',
  'sec-.*',
];

/**
 * A wrapper around `URL.parse` that doesn't return null values, and throws an
 * error instead.
 * @param url an URL to parse,
 * @returns the corresponding `URL` object.
 */
function parseUrl(url: string): URL {
  const parsed = URL.parse(url);
  if (!parsed) {
    throw Error('Url parsing error.');
  }
  return parsed;
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

class FetchService {
  static payloadTemplate: string;
  static headersIgnoreReg: RegExp;

  targets: Map<string, TargetInfos>;

  static {
    this.payloadTemplate = readFileSync(
      resolve(import.meta.dirname, 'payload.template.js'),
      'utf-8',
    );
    this.headersIgnoreReg = new RegExp(FORBIDDEN_HEADERS.join('|'));
  }

  constructor(private client: CDP.Client) {
    this.targets = new Map();
  }

  static filterForbiddenHeaders<T extends Record<string, string>>(headers: T) {
    return pickBy(headers, (_, key) => !this.headersIgnoreReg.test(key));
  }

  static getFetchPayload({ url, ...options }: FetchConfig): string {
    options.credentials = 'include';
    if (options.headers) {
      options.headers = this.filterForbiddenHeaders(options.headers);
    }
    return this.payloadTemplate
      .replace('{{URL}}', url.href)
      .replace('{{OPTIONS_JSON}}', JSON.stringify(options));
  }

  async loadBrowserTargets(): Promise<void> {
    const { targetInfos } = await this.client.Target.getTargets();
    this.targets = new Map<string, TargetInfos>(
      targetInfos
        .filter(({ url }) => isHttpUrl(url))
        .map(({ url, targetId }) => [parseUrl(url).host, { targetId }]),
    );
  }

  /**
   * Given the specified url, return the associated target and session IDs.
   */
  private async getTarget(url: URL): Promise<TargetInfos> {
    let { targetId, sessionId } = this.targets.get(url.host) || {};
    if (!targetId) {
      ({ targetId } = await this.client.Target.createTarget({ url: url.href }));
      // Wait a few seconds for the target to be created on the browser's side.
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!sessionId) {
      ({ sessionId } = await this.client.Target.attachToTarget({
        targetId,
        flatten: true,
      }));
      // Cache the target's information.
      this.targets.set(url.host, { targetId, sessionId });
    }
    return { targetId, sessionId };
  }

  async fetch(config: FetchConfig): Promise<FetchResponse> {
    const { sessionId } = await this.getTarget(config.url);
    const { result } = await this.client.send(
      'Runtime.evaluate',
      {
        expression: FetchService.getFetchPayload(config),
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.subtype === 'error') {
      throw new Error(
        `An error has occured during payload execution: ${result.description}`,
      );
    }
    return result.value;
  }
}

if (import.meta.main) {
  const { proxyPort, chromePort, chromeHost } = await argv.parse();

  const debugClient = await CDP({ host: chromeHost, port: chromePort });
  const fetchService = new FetchService(debugClient);
  await fetchService.loadBrowserTargets();

  const https = await generateCACertificate();
  const proxyServer = getLocal({ https });
  proxyServer.forAnyRequest().thenCallback(async request => {
    const url = parseUrl(request.url);
    const { method } = request;
    const requestRepr = `--> [${method}] ${url.origin}${url.pathname}`;
    try {
      const requestBody = (await request.body.getText()) || undefined;
      const {
        status: statusCode,
        statusText: statusMessage,
        headers: responseHeaders,
        body: responseBody,
      } = await fetchService.fetch({
        url,
        method,
        headers: Object.fromEntries(request.rawHeaders),
        body: requestBody,
      });
      console.log(c.green(requestRepr));
      return {
        statusCode,
        statusMessage,
        headers: responseHeaders,
        rawBody: new Uint8Array(responseBody),
      };
    } catch (err) {
      console.log(c.red(requestRepr));
      console.error(err);
      return { statusCode: 500, body: String(err) };
    }
  });

  console.log(c.green(`Proxy server will listen on port ${proxyPort}`));
  await proxyServer.start(proxyPort);
}
