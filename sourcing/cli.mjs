#!/usr/bin/env node
process.argv.splice(2, 0, 'source-photo');
await import('../dist/cli.js');
