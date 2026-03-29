import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/**
 * Parse .network NDJSON files and return structured network data.
 *
 * @param {string} traceDir - path to the unzipped trace folder
 * @returns {{ calls: Array, failures: Array, warnings: string[] }}
 */
export async function parseNetwork(traceDir) {
  const files = await readdir(traceDir);
  const networkFiles = files.filter(f => f.endsWith('.network')).sort();
  const warnings = [];

  if (networkFiles.length === 0) {
    warnings.push('No .network files found; network output will be empty');
    return { calls: [], failures: [], warnings };
  }

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

      const call = {
        callId,
        method: request.method || 'GET',
        url: request.url || '',
        status,
        startedAt: snapshot.startedDateTime || null,
        duration_ms: durationMs,
        frameRef: snapshot.pageref || null,
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

      calls.push(call);
    }
  }

  // Build failures list (4xx, 5xx, status 0 = timeout/error)
  const failures = calls.filter(c =>
    c.status >= 400 || c.status === 0
  );

  return { calls, failures, warnings };
}

/**
 * Build the public network index entry (strip internal fields).
 */
export function toNetworkIndexEntry(call) {
  return {
    callId: call.callId,
    method: call.method,
    url: call.url,
    status: call.status,
    startedAt: call.startedAt,
    duration_ms: call.duration_ms,
    frameRef: call.frameRef,
    requestParams: call.requestParams,
    payloadFile: `network/${call.callId}.json`,
  };
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
  return {
    callId: call.callId,
    method: call.method,
    url: call.url,
    status: call.status,
    startedAt: call.startedAt,
    duration_ms: call.duration_ms,
    frameRef: call.frameRef,
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
}
