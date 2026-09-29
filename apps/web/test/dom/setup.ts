/**
 * React needs telling that it is inside a test that understands `act`, or every render warns.
 * Only the DOM tests need it; the node-environment ones never mount anything.
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
