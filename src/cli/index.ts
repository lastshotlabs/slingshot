import { Errors, flush, run } from '@oclif/core';

await run(process.argv.slice(2), import.meta.url).catch(async err => {
  // Print clean message for expected CLIErrors; full stack only for unexpected.
  await Errors.handle(err);
});
await flush();
