import { type SlingshotPlugin, getContext } from '@lastshotlabs/slingshot';
import {
  ORCHESTRATION_PLUGIN_KEY,
  getOrchestration,
} from '@lastshotlabs/slingshot-orchestration-plugin';
import { processInvoiceWorkflow } from './orchestration.ts';

export function createBillingApiPlugin(): SlingshotPlugin {
  return {
    name: 'billing-api',
    dependencies: [ORCHESTRATION_PLUGIN_KEY],
    setupRoutes({ app }) {
      app.post('/billing/invoices/:invoiceId/process', async c => {
        const runtime = getOrchestration(getContext(app));
        const invoiceId = c.req.param('invoiceId');
        const handle = await runtime.runWorkflow(
          processInvoiceWorkflow,
          {
            invoiceId,
            customerEmail: 'customer@example.com',
            amountCents: 4_200,
          },
          {
            idempotencyKey: `invoice:${invoiceId}`,
            tags: { domain: 'billing' },
            metadata: { source: 'billing-api' },
          },
        );

        return c.json({ runId: handle.id }, 202);
      });

      app.get('/billing/runs/:runId', async c => {
        const runtime = getOrchestration(getContext(app));
        const run = await runtime.getRun(c.req.param('runId'));
        if (!run) {
          return c.json({ error: 'run not found' }, 404);
        }
        return c.json(run);
      });
    },
  };
}
