// The EO builder has no raw shell-script loader; npm run build bundles these first.
import handleRequest from '../../worker/dist/edgeone-entry.js';
import type { EdgeOneContext } from '../../worker/src/edgeone-entry';

// Keep this declaration: the EO CLI discovers handlers by their function names.
export function onRequest(context: EdgeOneContext) {
  return handleRequest(context);
}
