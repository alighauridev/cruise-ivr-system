/**
 * Runtime path alias registration for compiled server output.
 * Compiled by tsconfig.server.json into .server-dist/_path-register.js
 * and loaded via `node -r .server-dist/_path-register.js` at startup.
 *
 * Maps @/* → project root so compiled JS can resolve @/lib/db etc.
 */
import { register } from 'tsconfig-paths';
import * as path from 'path';

// __dirname will be .server-dist/ when this file runs as compiled JS
// The project root is one level up
const projectRoot = path.resolve(__dirname, '..');

register({
  baseUrl: projectRoot,
  paths: { '@/*': ['./*'] },
});
