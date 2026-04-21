import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  defineTask,
  defineWorkflow,
  parallel,
  step,
  stepResult,
} from '@lastshotlabs/slingshot-orchestration';

type ProcessInvoiceWorkflowInput = {
  invoiceId: string;
  customerEmail: string;
  amountCents: number;
};

export const capturePayment = defineTask({
  name: 'capture-payment',
  input: z.object({
    invoiceId: z.string(),
    amountCents: z.number().int().positive(),
  }),
  output: z.object({
    captured: z.boolean(),
    paymentId: z.string(),
  }),
  retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 250, maxDelayMs: 2_000 },
  timeout: 5_000,
  async handler(input, ctx) {
    ctx.reportProgress({ percent: 25, message: 'authorizing payment' });
    return {
      captured: true,
      paymentId: `pay_${input.invoiceId}_${ctx.runId}`,
    };
  },
});

export const generateInvoice = defineTask({
  name: 'generate-invoice',
  input: z.object({
    invoiceId: z.string(),
  }),
  output: z.object({
    invoiceUrl: z.string().url(),
  }),
  timeout: 5_000,
  async handler(input) {
    return {
      invoiceUrl: `https://example.invalid/invoices/${input.invoiceId}.pdf`,
    };
  },
});

export const recordLedgerEntry = defineTask({
  name: 'record-ledger-entry',
  input: z.object({
    invoiceId: z.string(),
    amountCents: z.number().int().positive(),
  }),
  output: z.object({
    recorded: z.boolean(),
  }),
  timeout: 5_000,
  async handler() {
    return { recorded: true };
  },
});

export const sendReceipt = defineTask({
  name: 'send-receipt',
  input: z.object({
    customerEmail: z.string().email(),
    invoiceUrl: z.string().url(),
  }),
  output: z.object({
    delivered: z.boolean(),
  }),
  retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 500 },
  timeout: 5_000,
  async handler() {
    return { delivered: true };
  },
});

export const processInvoiceWorkflow = defineWorkflow({
  name: 'process-invoice',
  description: 'Capture payment, generate an invoice PDF, and send the receipt email.',
  input: z.object({
    invoiceId: z.string(),
    customerEmail: z.string().email(),
    amountCents: z.number().int().positive(),
  }),
  output: z.object({
    payment: z.object({
      captured: z.boolean(),
      paymentId: z.string(),
    }),
    invoice: z.object({
      invoiceUrl: z.string().url(),
    }),
    ledger: z.object({
      recorded: z.boolean(),
    }),
    receipt: z.object({
      delivered: z.boolean(),
    }),
  }),
  outputMapper(results) {
    const payment = stepResult<{ captured: boolean; paymentId: string }>(
      results,
      'capture-payment',
      capturePayment,
    );
    const invoice = stepResult<{ invoiceUrl: string }>(
      results,
      'generate-invoice',
      generateInvoice,
    );
    const ledger = stepResult<{ recorded: boolean }>(
      results,
      'record-ledger-entry',
      recordLedgerEntry,
    );
    const receipt = stepResult<{ delivered: boolean }>(results, 'send-receipt', sendReceipt);

    return {
      payment: payment!,
      invoice: invoice!,
      ledger: ledger!,
      receipt: receipt!,
    };
  },
  steps: [
    step('capture-payment', capturePayment, {
      input: ({ workflowInput }: { workflowInput: ProcessInvoiceWorkflowInput }) => ({
        invoiceId: workflowInput.invoiceId,
        amountCents: workflowInput.amountCents,
      }),
    }),
    parallel([
      step('generate-invoice', generateInvoice, {
        input: ({ workflowInput }: { workflowInput: ProcessInvoiceWorkflowInput }) => ({
          invoiceId: workflowInput.invoiceId,
        }),
      }),
      step('record-ledger-entry', recordLedgerEntry, {
        input: ({ workflowInput }: { workflowInput: ProcessInvoiceWorkflowInput }) => {
          return {
            invoiceId: workflowInput.invoiceId,
            amountCents: workflowInput.amountCents,
          };
        },
      }),
    ]),
    step('send-receipt', sendReceipt, {
      input: ({
        workflowInput,
        results,
      }: {
        workflowInput: ProcessInvoiceWorkflowInput;
        results: Record<string, unknown>;
      }) => {
        const invoice = stepResult<{ invoiceUrl: string }>(
          results,
          'generate-invoice',
          generateInvoice,
        );
        return {
          customerEmail: workflowInput.customerEmail,
          invoiceUrl: invoice!.invoiceUrl,
        };
      },
    }),
  ],
});

export const orchestrationTasks = [capturePayment, generateInvoice, recordLedgerEntry, sendReceipt];
export const orchestrationWorkflows = [processInvoiceWorkflow];

export const requireOperationsKey: MiddlewareHandler = async (c, next) => {
  if (c.req.header('x-ops-key') !== 'dev-ops-key') {
    return c.json({ error: 'forbidden' }, 403);
  }

  c.set('tenantId', 'tenant-demo');
  await next();
};
