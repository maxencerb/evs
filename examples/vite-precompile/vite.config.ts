import { defineConfig } from 'vite';

import { evs } from '@maxencerb/vite-plugin-evs';

export default defineConfig({
  plugins: [evs()],
});
