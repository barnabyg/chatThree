import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

// A build that warns is a failed build, so verification cannot pass with
// unresolved warnings in its output.
const logger = createLogger();
const fail = (message: string): never => {
  throw new Error(`Build warning treated as an error: ${message}`);
};
logger.warn = fail;
logger.warnOnce = fail;

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
  },
});
