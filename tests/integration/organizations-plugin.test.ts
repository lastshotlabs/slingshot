import { addUserRole } from '@auth/lib/roles';
import { describe, expect, test } from 'bun:test';
import { createOrganizationsPlugin } from '@lastshotlabs/slingshot-organizations';
import { authHeader, createMemoryAuthAdapter, createTestApp } from '../setup';

type OpenApiSpec = {
  paths?: Record<string, Record<string, unknown>>;
};

describe('organizations plugin bootstrap', () => {
  test('auto-exempts org routes from tenant resolution and registers them in OpenAPI', async () => {
    const authAdapter = createMemoryAuthAdapter();
    const app = await createTestApp(
      {
        tenancy: {
          resolution: 'header',
          headerName: 'x-ledger-id',
          onResolve: async tenantId => ({ id: tenantId }),
        },
        plugins: [
          createOrganizationsPlugin({
            organizations: { enabled: true },
            groups: { managementRoutes: true },
          }),
        ],
      },
      {
        auth: { adapter: authAdapter },
      },
    );

    const registerRes = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'org-admin@example.com', password: 'password123' }),
    });
    expect(registerRes.status).toBe(201);
    const { token, userId } = (await registerRes.json()) as { token: string; userId: string };
    await addUserRole(userId, 'admin', undefined, authAdapter);

    const orgsResponse = await app.request('/orgs', {
      headers: authHeader(token),
    });
    expect(orgsResponse.status).toBe(200);

    const openApiResponse = await app.request('/openapi.json');
    expect(openApiResponse.status).toBe(200);
    const spec = (await openApiResponse.json()) as OpenApiSpec;
    expect(spec.paths).toHaveProperty('/orgs');
    expect(spec.paths).toHaveProperty('/groups');
  });
});
