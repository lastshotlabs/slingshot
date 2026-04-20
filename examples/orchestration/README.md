# Orchestration Example

Code-first orchestration example for Slingshot.

What it demonstrates:

- `defineTask()` and `defineWorkflow()` authoring
- `createOrchestrationPlugin()` with protected HTTP routes
- runtime lookup with `getOrchestration()`
- app-owned routes that start workflows directly
- in-memory adapter setup that can later be swapped to SQLite or BullMQ
