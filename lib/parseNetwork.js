import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/**
 * Build a relevance classifier from the provided signals config.
 * @param {object} signals - { apiDomains: string[], flagUrlPatterns: string[] }
 */
function makeClassifier(signals) {
  const apiDomains = signals.apiDomains || [];
  const flagPatterns = signals.flagUrlPatterns || [];

  return function classifyRelevance(url) {
    if (apiDomains.some(d => url.includes(d))) return 'app-api';
    if (flagPatterns.length > 0 && flagPatterns.every(p => url.includes(p))) return 'feature-flags';
    return 'third-party';
  };
}

/**
 * Parse .network NDJSON files and return structured network data.
 *
 * @param {string} traceDir - path to the unzipped trace folder
 * @param {object} [signals] - optional signal extraction config
 * @param {string[]} [signals.apiDomains] - URL substrings identifying app API calls (e.g. ['myapp.com/api', 'localhost'])
 * @param {string[]} [signals.flagUrlPatterns] - URL substrings that must ALL match to detect feature flag eval requests
 * @param {string} [signals.requestIdHeader] - response header name to extract request IDs from on 4xx/5xx (e.g. 'x-request-id')
 * @returns {{ calls: Array, failures: Array, failuresWithRequestIds: Array, flagEvals: Array, apiBodyRefs: Array, warnings: string[] }}
 */
export async function parseNetwork(traceDir, signals = {}) {
  const files = await readdir(traceDir);
  const networkFiles = files.filter(f => f.endsWith('.network')).sort();
  const warnings = [];

  const emptyResult = { calls: [], failures: [], failuresWithRequestIds: [], flagEvals: [], apiBodyRefs: [], warnings };
  if (networkFiles.length === 0) {
    warnings.push('No .network files found; network output will be empty');
    return emptyResult;
  }

  const classifyRelevance = makeClassifier(signals);
  const requestIdHeader = signals.requestIdHeader || null;
  const apiDomains = signals.apiDomains || [];
  const flagPatterns = signals.flagUrlPatterns || [];

  const calls = [];
  let seqCounter = 0;

  for (const nf of networkFiles) {
    const rl = createInterface({
      input: createReadStream(join(traceDir, nf), 'utf-8'),
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        warnings.push(`Skipped malformed line in ${nf}`);
        continue;
      }

      if (entry.type !== 'resource-snapshot') continue;

      const snapshot = entry.snapshot;
      if (!snapshot) continue;

      seqCounter++;
      const callId = `req-${String(seqCounter).padStart(4, '0')}`;
      const request = snapshot.request || {};
      const response = snapshot.response || {};
      const responseContent = response.content || {};

      // Extract query string params
      const queryString = {};
      for (const qs of (request.queryString || [])) {
        queryString[qs.name] = qs.value;
      }

      // Extract POST body summary
      let body = null;
      if (request.postData) {
        const pd = request.postData;
        const mimeType = pd.mimeType || '';
        if (mimeType.includes('json') || mimeType.includes('form')) {
          const text = pd.text || '';
          if (text.length > 500) {
            body = { summary: text.slice(0, 500), _truncated: true };
          } else {
            body = text;
            // Try to parse as JSON for cleaner output
            try { body = JSON.parse(text); } catch { /* keep as string */ }
          }
        }
      }

      const status = response.status || 0;
      const durationMs = snapshot.time != null ? Math.round(snapshot.time) : null;
      const url = request.url || '';

      const call = {
        callId,
        method: request.method || 'GET',
        url,
        status,
        startedAt: snapshot.startedDateTime || null,
        duration_ms: durationMs,
        frameRef: snapshot.pageref || null,
        relevance: classifyRelevance(url),
        requestParams: {
          queryString,
          body,
        },
        // Internal: full data for payload file
        _request: request,
        _response: response,
        _responseSha1: responseContent._sha1 || null,
        _responseMimeType: responseContent.mimeType || null,
        _responseSize: responseContent.size || 0,
      };

      // Extract request ID header from 4xx/5xx responses
      if (requestIdHeader && status >= 400) {
        const hdr = (response.headers || []).find(h => h.name === requestIdHeader);
        if (hdr) {
          const parts = hdr.value.split(';');
          call.requestId = parts.length > 1 ? parts[1] : hdr.value;
        }
      }

      // Feature flag service eval detection
      if (flagPatterns.length > 0 && flagPatterns.every(p => url.includes(p))) {
        call.isFlagEval = true;
        call.flagBodyRef = responseContent._sha1 || null;
        call.flagResponseSize = responseContent.size || 0;
      }

      // App API 200 body refs for response structure analysis
      if (status === 200 && apiDomains.some(d => url.includes(d)) && responseContent._sha1) {
        call.isAppApi = true;
        call.apiBodyRef = responseContent._sha1;
      }

      calls.push(call);
    }
  }

  // Build failures list, sorted by relevance (app-api first, third-party last)
  const relevanceOrder = { 'app-api': 0, 'feature-flags': 1, 'third-party': 2 };
  const failures = calls
    .filter(c => c.status >= 400 || c.status === 0)
    .sort((a, b) => (relevanceOrder[a.relevance] ?? 2) - (relevanceOrder[b.relevance] ?? 2));

  // Signal arrays (only populated when signals config is provided)
  const failuresWithRequestIds = failures
    .filter(c => c.requestId)
    .map(c => ({ callId: c.callId, url: c.url, status: c.status, requestId: c.requestId }));

  // A mocked flag eval response is {} (~2 bytes); a real one has all flag values (1000+ bytes)
  const flagEvals = calls
    .filter(c => c.isFlagEval)
    .map(c => ({
      callId: c.callId,
      url: c.url,
      status: c.status,
      bodyRef: c.flagBodyRef,
      responseSize: c.flagResponseSize,
      mocked: c.flagResponseSize < 100,
    }));

  const apiBodyRefs = calls
    .filter(c => c.isAppApi)
    .map(c => ({ callId: c.callId, url: c.url, bodyRef: c.apiBodyRef }));

  return { calls, failures, failuresWithRequestIds, flagEvals, apiBodyRefs, warnings };
}

/**
 * Build the public network index entry (strip internal fields).
 */
export function toNetworkIndexEntry(call) {
  const entry = {
    callId: call.callId,
    method: call.method,
    url: call.url,
    status: call.status,
    startedAt: call.startedAt,
    duration_ms: call.duration_ms,
    frameRef: call.frameRef,
    relevance: call.relevance,
    requestParams: call.requestParams,
    payloadFile: `network/${call.callId}.json`,
  };
  if (call.requestId) entry.requestId = call.requestId;
  if (call.isFlagEval) entry.isFlagEval = true;
  if (call.apiBodyRef) entry.apiBodyRef = call.apiBodyRef;
  return entry;
}

/**
 * Redact sensitive headers (Cookie, Set-Cookie, Authorization, Proxy-Authorization).
 *
 * @param {Array<{name: string, value: string}>} headers
 * @returns {Array<{name: string, value: string}>}
 */
export function redactHeaders(headers) {
  if (!Array.isArray(headers)) return headers;
  const sensitive = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
  return headers.map(h => {
    if (sensitive.has(h.name.toLowerCase())) {
      return { ...h, value: '[REDACTED]' };
    }
    return h;
  });
}

/**
 * Build the full payload for a single network call file.
 */
export function toNetworkPayload(call) {
  const payload = {
    callId: call.callId,
    method: call.method,
    url: call.url,
    status: call.status,
    startedAt: call.startedAt,
    duration_ms: call.duration_ms,
    frameRef: call.frameRef,
    relevance: call.relevance,
    request: {
      method: call._request.method,
      url: call._request.url,
      headers: redactHeaders(call._request.headers),
      queryString: call._request.queryString,
      postData: call._request.postData || null,
    },
    response: {
      status: call._response.status,
      statusText: call._response.statusText,
      headers: redactHeaders(call._response.headers),
      content: {
        mimeType: call._responseMimeType,
        size: call._responseSize,
        sha1: call._responseSha1,
      },
    },
  };
  if (call.requestId) payload.requestId = call.requestId;
  if (call.isFlagEval) { payload.isFlagEval = true; payload.flagBodyRef = call.flagBodyRef; }
  if (call.apiBodyRef) payload.apiBodyRef = call.apiBodyRef;
  return payload;
}
