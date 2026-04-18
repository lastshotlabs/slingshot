export { createM2MPlugin } from './plugin';
export { requireScope } from './middleware/requireScope';
export { createM2MClient, deleteM2MClient, listM2MClients, getM2MClient } from './lib/m2m';
export { createM2MRouter } from './routes/m2m';
export type { M2MClientRecord } from '@lastshotlabs/slingshot-core';
