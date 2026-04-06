/**
 * Runtime path alias registration for compiled server output.
 * This file is compiled to .server-dist/_path-register.js
 * At runtime, __dirname === .server-dist/
 * So @/* → .server-dist/* resolves compiled JS files correctly.
 */
import { register } from 'tsconfig-paths';

register({
  baseUrl: __dirname, // .server-dist/ at runtime
  paths: { '@/*': ['./*'] },
});
