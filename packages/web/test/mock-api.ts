import { vi } from 'vitest';

/**
 * Route-map fetch mock: keys are "METHOD /api/path" (query string included
 * when the code under test sends one). Values are the JSON payload, or
 * { status, json } to simulate an API error body.
 */

export type MockRoute = unknown | { status: number; json: unknown };

export function mockApi(routes: Record<string, MockRoute>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const route = routes[`${method} ${url}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: `No mock for ${method} ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const { status, json } =
      typeof route === 'object' && route !== null && 'status' in route && 'json' in route
        ? (route as { status: number; json: unknown })
        : { status: 200, json: route };
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}
