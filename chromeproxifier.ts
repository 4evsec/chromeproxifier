#!/usr/bin/env node
/*******************************************************************************
 * ChromeProxifier
 *
 * HTTP proxy server that proxify requests though Google DevTools Protocol via
 * `fetch` function calls.
 *******************************************************************************
 *
 * Usage:
 *  chromeproxifier -p 9090 --remote-debugging-host 127.0.0.1 \
 *                          --remote-debugging-port 9222
 *
 */
import c from 'chalk';
import CDP from 'chrome-remote-interface';
import type { Headers } from 'mockttp';
import { generateCACertificate, getLocal } from 'mockttp';
import { pickBy } from 'remeda';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
// A list of headers pattern to omit in `fetch` calls.
// https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function getTargetKey(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

class FetchService {
  static payloadTemplate: string;
  static headersIgnoreReg: RegExp;

  static {
    this.payloadTemplate = readFileSync(
      resolve(import.meta.dirname, 'payload.template.js'),
      'utf-8',
    );
    this.headersIgnoreReg = new RegExp(FORBIDDEN_HEADERS.join('|'));
  }

  targets: Map<string, TargetInfos>;

  constructor(private client: CDP.Client) {
    this.targets = new Map();
  }

  static readonly filterHeaders = pickBy<Record<string, string>>(
    (_, key) => !this.headersIgnoreReg.test(key),
  );

  static getFetchPayload({ url, ...options }: FetchConfig): string {
    if (options.headers) {
      options.headers = this.filterHeaders(options.headers);
    }
    options.credentials = 'include';

    return this.payloadTemplate
      .replace('{{URL}}', url.href)
      .replace('{{OPTIONS_JSON}}', JSON.stringify(options));
  }

  async loadBrowserTargets(): Promise<void> {
    const { targetInfos } = await this.client.Target.getTargets();
    const filteredTargets = targetInfos
      .filter(({ url }) => isHttpUrl(url))
      .map(
        ({ url, targetId }) =>
          [getTargetKey(new URL(url)), { targetId }] as [string, TargetInfos],
      );

    this.targets = new Map(filteredTargets);
  }

  /**
   * Given the specified URL, return the associated target and session IDs.
   */
  private async getTarget(url: URL): Promise<TargetInfos> {
    const targetKey = getTargetKey(url);
    let { targetId, sessionId } = this.targets.get(targetKey) || {};

    if (!targetId) {
      ({ targetId } = await this.client.Target.createTarget({ url: url.href }));
      await new Promise(r => setTimeout(r, 1000));
      // Wait a few seconds for the target to be created on the browser's side.
    }
    if (!sessionId) {
      ({ sessionId } = await this.client.Target.attachToTarget({
        targetId,
        flatten: true,
      }));
      this.targets.set(targetKey, { targetId, sessionId });
      // Cache the target's information.
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
    const url = new URL(request.url);
    if (!url) {
      return { statusCode: 500, body: 'URL parsing error.' };
    }

    const { method } = request;
    const requestRepr = `--> [${method}] ${url.origin}${url.pathname}`;
    try {
      const requestBody = (await request.body.getText()) || undefined;
      const requestHeaders = Object.fromEntries(request.rawHeaders);
      const {
        status: statusCode,
        statusText: statusMessage,
        headers: responseHeaders,
        body: responseBody,
      } = await fetchService.fetch({
        url,
        method,
        headers: requestHeaders,
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

  console.log(c.green(`Proxy server starting on port ${proxyPort}`));
  await proxyServer.start(proxyPort);
}
