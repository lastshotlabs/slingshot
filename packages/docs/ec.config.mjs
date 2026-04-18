import { defineEcConfig } from '@astrojs/starlight/expressive-code';
import logql from './src/shiki/logql.mjs';

export default defineEcConfig({
  shiki: {
    langs: [logql],
  },
});
