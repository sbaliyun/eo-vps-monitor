import handleRequest from '../../worker/dist/edgeone-entry.js';
import type { EdgeOneContext } from '../../worker/src/edgeone-entry';

export function onRequest(context: EdgeOneContext) {
  return handleRequest(context);
}
