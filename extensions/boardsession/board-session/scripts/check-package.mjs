import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require(`../prebuilds/${process.platform}-${process.arch}/board_session.node`);
console.log(`Native artifact and bundled dynamic libraries load on ${process.platform}-${process.arch}`);
