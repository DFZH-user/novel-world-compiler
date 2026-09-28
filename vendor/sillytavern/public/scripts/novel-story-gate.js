
let guard = null;
export function setNovelActionGuard(callback) { guard=callback; }
export async function checkNovelAction(action) {
  return guard ? guard(action) : true;
}
